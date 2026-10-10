/**
 * Manga Reader — serveur local
 *
 * Rôles :
 *  1. Servir l'application web (fichiers statiques à la racine du projet).
 *  2. Fournir un proxy HTTP (/api/page, /api/data, /api/image) qui permet au
 *     navigateur de récupérer des pages distantes malgré les restrictions CORS.
 *
 * Le serveur ne dépend d'aucune librairie externe (http/https natifs uniquement)
 * afin de rester simple, robuste et rapide à déployer.
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const DEV = process.argv.includes('--dev');

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** Envoi d'une réponse JSON structurée. */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** Erreur structurée normalisée pour toutes les routes /api/*. */
function apiError(res, status, message, detail) {
  console.warn(`[api] ${status} ${message}${detail ? ' — ' + detail : ''}`);
  sendJson(res, status, { success: false, error: message });
}

/**
 * Récupère une ressource distante en suivant les redirections.
 * @param {string} url
 * @param {{ timeout?: number, maxBytes?: number, headers?: object }} opts
 * @returns {Promise<{ statusCode: number, headers: Record<string,string>, body: Buffer }>}
 */
function fetchRemote(url, opts = {}) {
  const { timeout = 20000, maxBytes = 40 * 1024 * 1024, headers = {} } = opts;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    let current = url;
    let redirects = 0;

    const attempt = () => {
      let mod;
      try {
        const parsed = new URL(current);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return fail(new Error('PROTO_INVALID'));
        }
        mod = parsed.protocol === 'https:' ? https : http;
      } catch {
        return fail(new Error('URL_INVALID'));
      }

      const req = mod.get(
        current,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            Accept: '*/*',
            'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
            ...headers,
          },
          timeout,
          rejectUnauthorized: false, // certains sites de scan ont des certs imparfaits
        },
        (response) => {
          const { statusCode = 0, headers: rHeaders = {} } = response;

          // Redirections (max 6)
          if (statusCode >= 300 && statusCode < 400 && rHeaders.location) {
            redirects += 1;
            response.resume(); // draine le corps
            if (redirects > 6) return fail(new Error('TOO_MANY_REDIRECTS'));
            try {
              current = new URL(rHeaders.location, current).toString();
            } catch {
              return fail(new Error('BAD_REDIRECT'));
            }
            return attempt();
          }

          const chunks = [];
          let total = 0;
          response.on('data', (c) => {
            total += c.length;
            if (total > maxBytes) {
              response.destroy();
              return fail(new Error('TOO_LARGE'));
            }
            chunks.push(c);
          });
          response.on('end', () => {
            if (settled) return;
            settled = true;
            resolve({
              statusCode,
              headers: Object.fromEntries(
                Object.entries(rHeaders).map(([k, v]) => [k.toLowerCase(), String(v)])
              ),
              body: Buffer.concat(chunks),
            });
          });
          response.on('error', fail);
        }
      );

      req.on('timeout', () => {
        req.destroy();
        fail(new Error('TIMEOUT'));
      });
      req.on('error', fail);
    };

    attempt();
  });
}

/** Valide qu'une URL est récupérable par le proxy (http/https uniquement). */
function parseTargetUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Routes API (proxy)
// ---------------------------------------------------------------------------

/** En-têtes anti-bot : beaucoup de sites de scan bloquent les requêtes sans UA navigateur. */
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'cross-site',
  'Upgrade-Insecure-Requests': '1',
};

async function handleApiPage(req, res, query) {
  const target = parseTargetUrl(query.get('url'));
  if (!target) return apiError(res, 400, 'URL invalide ou protocole non supporté.');

  const referer = query.get('referer') || new URL(target).origin + '/';
  try {
    const result = await fetchRemote(target, {
      timeout: 25000,
      maxBytes: 12 * 1024 * 1024,
      headers: { ...BROWSER_HEADERS, Referer: referer },
    });
    if (result.statusCode === 404) {
      return apiError(res, 404, 'Page introuvable sur le site distant (404).');
    }
    // 403 / 429 / 5xx : protection anti-bot ou indisponibilité du site distant.
    if (result.statusCode === 403 || result.statusCode === 429) {
      return apiError(
        res, 502,
        `Le site distant bloque les requêtes automatiques (HTTP ${result.statusCode}). Réessayez dans quelques instants.`
      );
    }
    if (result.statusCode >= 400) {
      return apiError(res, 502, `Le site distant a répondu une erreur HTTP ${result.statusCode}.`);
    }
    const html = result.body.toString('utf8');
    // Détection d'un interstitiel anti-bot (Cloudflare « Just a moment… », challenge, etc.)
    if (/id="challenge-form"|cf_chl_|Just a moment|__cf_chl|Attention Required!/.test(html.slice(0, 60000))) {
      return apiError(res, 503, 'Le site distant exige une vérification de sécurité (anti-bot) impossible à réaliser automatiquement. Réessayez plus tard ou depuis un autre chapitre/manga.');
    }
    // Réécriture des URLs relatives en absolues + injection d'une <base>.
    // Le DOM parsé côté client n'a pas la base-URI du site distant : sans cela,
    // images et liens internes seraient résolus contre l'origine de l'app.
    try {
      const origin = new URL(target).origin;
      let out = html.replace(/(<(?:img|script|link)\b[^>]*?\s(?:src|href)\s*=\s*)(['"])(?!https?:|data:|#|\/\/)([^'"]+)\2/gi,
        (m, attr, q, rel) => `${attr}${q}${origin}/${rel.replace(/^\.?\//, '')}${q}`);
      if (/<head(\s[^>]*)?>/i.test(out)) {
        out = out.replace(/<head(\s[^>]*)?>/i, `<head$1><base href="${target}">`);
      } else {
        out = `<base href="${target}">` + out;
      }
      sendJson(res, 200, { success: true, url: target, finalUrl: target, html: out });
    } catch {
      sendJson(res, 200, { success: true, url: target, finalUrl: target, html });
    }
  } catch (err) {
    const msg =
      err.message === 'TIMEOUT'
        ? 'Le site distant met trop de temps à répondre (timeout).'
        : err.message === 'URL_INVALID' || err.message === 'PROTO_INVALID'
          ? 'URL invalide.'
          : 'Impossible de récupérer la page distante.';
    return apiError(res, 502, msg, err.message);
  }
}

async function handleApiImage(req, res, query) {
  const target = parseTargetUrl(query.get('url'));
  if (!target) return apiError(res, 400, 'URL invalide ou protocole non supporté.');

  const referer = query.get('referer') || new URL(target).origin + '/';
  try {
    const result = await fetchRemote(target, {
      timeout: 30000,
      maxBytes: 40 * 1024 * 1024,
      headers: { ...BROWSER_HEADERS, Referer: target, Accept: 'image/avif,image/webp,image/png,image/*,*/*' },
    });
    if (result.statusCode >= 400) {
      return apiError(res, 502, `Image inaccessible (HTTP ${result.statusCode}).`);
    }
    const ct = result.headers['content-type'] || 'application/octet-stream';
    // Validation minimale : une image doit commencer par des octets connus.
    const b = result.body;
    const looksLikeImage =
      (b.length > 8 &&
        (b[0] === 0xff || // jpeg
          b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) || // png
          b.subarray(0, 6).toString('ascii').startsWith('GIF8') || // gif
          b.subarray(0, 4).toString('ascii') === 'RIFF' || // webp
          b.subarray(4, 8).toString('ascii') === 'ftyp')) || // avif/heic
      ct.startsWith('image/');
    if (!looksLikeImage || b.length < 64) {
      return apiError(res, 502, 'Le fichier récupéré ne semble pas être une image valide.');
    }
    res.writeHead(200, {
      'Content-Type': ct,
      'Content-Length': b.length,
      'Cache-Control': DEV ? 'no-store' : 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(b);
  } catch (err) {
    const msg =
      err.message === 'TIMEOUT'
        ? 'Délai dépassé lors du téléchargement de l’image.'
        : err.message === 'TOO_LARGE'
          ? 'Image trop volumineuse.'
          : 'Impossible de récupérer cette image.';
    return apiError(res, 502, msg, err.message);
  }
}

async function handleApiData(req, res, query) {
  // Endpoint générique : renvoie le contenu brut d'une ressource JSON distante.
  const target = parseTargetUrl(query.get('url'));
  if (!target) return apiError(res, 400, 'URL invalide ou protocole non supporté.');
  try {
    const result = await fetchRemote(target, { timeout: 20000, maxBytes: 8 * 1024 * 1024, headers: BROWSER_HEADERS });
    if (result.statusCode >= 400) {
      return apiError(res, 502, `Le site distant a répondu une erreur HTTP ${result.statusCode}.`);
    }
    let data;
    try {
      data = JSON.parse(result.body.toString('utf8'));
    } catch {
      return apiError(res, 502, 'La réponse distante n’est pas un JSON valide.');
    }
    sendJson(res, 200, { success: true, data });
  } catch (err) {
    return apiError(res, 502, 'Impossible de récupérer les données distantes.', err.message);
  }
}

// ---------------------------------------------------------------------------
// Fichiers statiques
// ---------------------------------------------------------------------------

async function serveStatic(req, res, pathname) {
  let filePath = path.normalize(path.join(__dirname, pathname));
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    let stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = await fsp.stat(filePath);
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const isHtml = ext === '.html';
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': DEV || isHtml ? 'no-cache' : 'public, max-age=3600',
      ...(ext === '.sw.js' || filePath.endsWith('sw.js')
        ? { 'Service-Worker-Allowed': '/' }
        : {}),
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    // SPA fallback : toute route inconnue renvoie index.html
    try {
      const html = await fsp.readFile(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      res.end(html);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  }
}

// ---------------------------------------------------------------------------
// Serveur
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(u.pathname);

    // CORS large sur /api/* (le proxy est fait pour ça)
    if (pathname.startsWith('/api/')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        });
        return res.end();
      }
      if (pathname === '/api/page') return await handleApiPage(req, res, u.searchParams);
      if (pathname === '/api/image') return await handleApiImage(req, res, u.searchParams);
      if (pathname === '/api/data') return await handleApiData(req, res, u.searchParams);
      return apiError(res, 404, 'Endpoint inconnu.');
    }

    if (pathname === '/api/health') {
      return sendJson(res, 200, { success: true, status: 'ok' });
    }

    return await serveStatic(req, res, pathname);
  } catch (err) {
    console.error('[server] erreur inattendue:', err);
    try {
      if (!res.headersSent) {
        sendJson(res, 500, { success: false, error: 'Erreur interne du serveur local.' });
      } else {
        res.end();
      }
    } catch {
      /* ignore */
    }
  }
});

// Filet de sécurité : ne jamais crash silencieusement.
process.on('uncaughtException', (err) => console.error('[server] uncaughtException:', err));
process.on('unhandledRejection', (err) => console.error('[server] unhandledRejection:', err));

server.listen(PORT, () => {
  console.log(`Manga Reader — serveur local : http://localhost:${PORT} ${DEV ? '(dev)' : ''}`);
});

export { fetchRemote, parseTargetUrl };
