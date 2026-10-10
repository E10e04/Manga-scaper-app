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
          // Certificats : validation stricte par défaut. En mode --dev, on
          // accepte les certs auto-signés pour tester contre des serveurs
          // locaux ; jamais en production.
          rejectUnauthorized: !DEV,
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

/**
 * Valide qu'une URL est récupérable par le proxy.
 * Sécurité (anti-SSRF) : http/https uniquement + blocage des adresses
 * locales, privées et réservées — le proxy ne doit pas servir à solliciter
 * arbitrairement n'importe quelle machine du réseau de l'utilisateur.
 * Exception en mode --dev : localhost est autorisé pour tester l'API
 * (ex. tests automatisés contre un serveur local).
 */
const PRIVATE_NETS = [
  // IPv4 réservées / privées
  /^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64/10
];

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[(?:::1|0:0:0:0:0:0:0:1)\]$/, '::1');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  if (/^0+$/.test(h.replace(/\./g, ''))) return true; // 0.0.0.0 etc.
  // IPv6 privées/réservées (ULA fc00::/7, link-local fe80::/10, v4-mapped)
  if (/^(?:f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/.test(h)) return true;
  if (h.startsWith('::ffff:') || h.includes('.')) {
    // forme IPv4 (avec ou sans mappage ::ffff:a.b.c.d)
    const v4 = h.includes(':') ? h.split(':').pop() : h;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(v4) && PRIVATE_NETS.some((re) => re.test(v4))) return true;
  }
  return false;
}

function parseTargetUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (isPrivateHost(u.hostname) && !DEV) return null;
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
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

/**
 * Relais publics de secours (même liste que le client web), essayés par le
 * serveur quand la source directe échoue (403/429/challenge anti-bot ou
 * erreur réseau). Ils sortent du datacenter vers l'origine des relais, ce
 * qui peut débloquer certaines situations où l'IP locale est bannie.
 */
const RELAY_FETCHERS = [
  { name: 'codetabs', build: (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}` },
  { name: 'allorigins', build: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
];

/** Récupère une page via un relais public ; renvoie null si indisponible. */
async function fetchViaRelay(target) {
  for (const relay of RELAY_FETCHERS) {
    try {
      const r = await fetchRemote(relay.build(target), {
        timeout: 25000,
        maxBytes: 12 * 1024 * 1024,
        headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'], Accept: '*/*' },
      });
      if (r.statusCode !== 200) continue;
      const text = r.body.toString('utf8');
      // Le relais doit renvoyer du contenu exploitable, pas sa propre page d'erreur.
      if (!text || text.length < 500) continue;
      if (/id="challenge-form"|cf_chl_|Just a moment|__cf_chl|Attention Required!/.test(text.slice(0, 60000))) continue;
      console.log(`[proxy] relais ${relay.name} OK pour ${target}`);
      return { statusCode: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(text, 'utf8'), via: relay.name };
    } catch {
      /* relais suivant */
    }
  }
  return null;
}

/** Tentative de récupération avec repli automatique sur les relais publics. */
async function fetchPageResilient(target, referer) {
  let direct = null;
  let directErr = null;
  try {
    direct = await fetchRemote(target, {
      timeout: 25000,
      maxBytes: 12 * 1024 * 1024,
      headers: { ...BROWSER_HEADERS, Referer: referer },
    });
    const blocked =
      direct.statusCode === 403 ||
      direct.statusCode === 429 ||
      /id="challenge-form"|cf_chl_|Just a moment|__cf_chl|Attention Required!/.test(direct.body.toString('utf8').slice(0, 60000));
    if (!blocked && direct.statusCode >= 400) {
      const e = new Error('HTTP_' + direct.statusCode);
      e.result = direct;
      throw e;
    }
    if (!blocked) return direct;
  } catch (err) {
    if (err && err.result) throw err; // 4xx réel (hors blocage) : on remonte
    directErr = err;
  }
  // Source directe bloquée (anti-bot / débit / réseau) : relais publics.
  const relayed = await fetchViaRelay(target);
  if (relayed) return relayed;
  if (direct) return direct; // on renvoie la réponse bloquée pour diagnostic
  const e = new Error(directErr?.message || 'REACH_FAIL');
  e.cause = directErr;
  throw e;
}

async function handleApiPage(req, res, query) {
  const target = parseTargetUrl(query.get('url'));
  if (!target) return apiError(res, 400, 'URL invalide ou protocole non supporté.');

  const referer = query.get('referer') || new URL(target).origin + '/';
  try {
    const result = await fetchPageResilient(target, referer);
    if (result.statusCode === 404) {
      return apiError(res, 404, 'Page introuvable sur le site distant (404).');
    }
    // 403 / 429 : protection anti-bot ou limitation de débit du site distant.
    if (result.statusCode === 403) {
      return apiError(
        res, 502,
        'Le site distant refuse les requêtes automatiques (HTTP 403). Le proxy ne peut pas contourner un blocage actif : réessayez plus tard.'
      );
    }
    if (result.statusCode === 429) {
      const retryAfter = result.headers['retry-after'];
      return sendJson(res, 429, {
        success: false,
        error: `Le site distant limite le débit des requêtes (HTTP 429). Patientez${retryAfter ? ` environ ${retryAfter} s` : ' quelques instants'} puis réessayez.`,
        retryAfter: retryAfter || null,
      });
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
      // Certains CDN n'autorisent l'image que si le referer correspond à la
      // page du chapitre (et non à l'URL même de l'image).
      headers: { ...BROWSER_HEADERS, Referer: referer, Accept: 'image/avif,image/webp,image/png,image/*,*/*' },
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
