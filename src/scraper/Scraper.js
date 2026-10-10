/**
 * Scraping : récupération de pages distantes.
 *
 * Deux modes :
 * - Web / proxy configuré : requêtes via /api/page du proxy Node (server.js),
 *   qui contourne les restrictions CORS.
 * - APK sans proxy : requêtes DIRECTES depuis le WebView. Si le site distant
 *   bloque CORS, une erreur claire et actionnable est affichée.
 */
import { NetworkError, ValidationError } from '../utils/errors.js';
import { isValidHttpUrl } from '../utils/helpers.js';
import { isNativeApp, proxyBase } from '../utils/env.js';

/**
 * Liste des proxys publics de contournement CORS, essayés en dernier recours
 * (uniquement quand aucun proxy local n'est configuré). Chaque entrée est
 * une fonction (url) -> URL de requête. Ils sont notoirement instables :
 * on les teste dans l'ordre et on passe au suivant en cas d'échec.
 */
const PUBLIC_CORS_PROXIES = [
  { name: 'allorigins', build: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
  { name: 'corsproxy.io', build: (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}` },
  { name: 'codetabs', build: (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}` },
];

/**
 * Récupère le HTML brut d'une page distante via un proxy public de secours.
 * @returns {Promise<string>}
 */
async function fetchViaPublicProxy(valid, signal) {
  let lastErr = null;
  for (const p of PUBLIC_CORS_PROXIES) {
    try {
      const res = await fetch(p.build(valid), { signal, redirect: 'follow' });
      if (!res.ok) throw new NetworkError(`Le relais public a répondu HTTP ${res.status}.`);
      const text = await res.text();
      // Un relais renvoie parfois du JSON ou une page d'erreur à la place du contenu.
      if (text && text.length > 200 && !/^\s*[{[]/.test(text)) return text;
      throw new NetworkError('Réponse invalide du relais public.');
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      lastErr = err;
    }
  }
  throw lastErr instanceof NetworkError
    ? lastErr
    : new NetworkError('Les relais publics sont indisponibles actuellement.');
}

/**
 * Récupère le HTML d'une page distante.
 * @param {string} url
 * @param {{ referer?: string, signal?: AbortSignal }} opts
 * @returns {Promise<{ html: string, finalUrl: string }>}
 */
export async function fetchPage(url, opts = {}) {
  const valid = isValidHttpUrl(url);
  if (!valid) throw new ValidationError('Cette URL n’est pas valide. Vérifiez le lien collé.');

  const { referer, signal } = opts;

  if (typeof fetch !== 'function') {
    throw new NetworkError('Fonction réseau indisponible dans cet environnement.');
  }

  const base = proxyBase();

  // ---- Mode direct (APK sans proxy configuré) ----
  if (!base) {
    try {
      const res = await fetch(valid, { signal, redirect: 'follow' });
      if (!res.ok) throw new NetworkError(`Le site distant a répondu HTTP ${res.status}.`);
      const html = await res.text();
      return { html, finalUrl: res.url || valid };
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      if (err?.name === 'AbortError') throw err;
      // CORS bloqué par le site : on tente des relais publics avant d'abandonner.
      try {
        const html = await fetchViaPublicProxy(valid, signal);
        return { html, finalUrl: valid };
      } catch (relayErr) {
        if (relayErr?.name === 'AbortError') throw relayErr;
        throw new NetworkError(
          `${relayErr?.message || 'Connexion impossible.'} (astuce : lancez « node server.js » sur un PC du même Wi‑Fi et indiquez son adresse IP dans Réglages › Proxy)`
        );
      }
    }
  }

  // ---- Mode proxy (/api/page) ----
  let res;
  try {
    const params = new URLSearchParams({ url: valid });
    if (referer) params.set('referer', referer);
    res = await fetch(`${base}/api/page?${params}`, { signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new NetworkError('Impossible de contacter le proxy local. Vérifiez que server.js tourne et que son adresse est correcte.');
  }

  // Le proxy doit répondre en JSON ; s'il renvoie du HTML, c'est qu'il ne
  // tourne pas à cette adresse (ex. page 404 d'un autre serveur).
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* réponse non-JSON */ }

  if (json && json.success && typeof json.html === 'string') {
    return { html: json.html, finalUrl: json.finalUrl || valid };
  }
  if (json && json.error) {
    throw new NetworkError(json.error);
  }
  if (!json) {
    throw new NetworkError(res.ok
      ? 'Le proxy a renvoyé une réponse invalide (non-JSON).'
      : `Erreur du proxy local (HTTP ${res.status}).`);
  }
  throw new NetworkError('Réponse inattendue du proxy local.');
}

/**
 * Récupère un JSON distant via /api/data (proxy uniquement).
 */
export async function fetchDataJson(url, opts = {}) {
  const valid = isValidHttpUrl(url);
  if (!valid) throw new ValidationError('URL invalide.');
  const base = proxyBase();

  // ---- Mode direct (APK sans proxy configuré) ----
  if (!base) {
    try {
      const res = await fetch(valid, { signal: opts.signal });
      if (!res.ok) throw new NetworkError(`La source distante a répondu HTTP ${res.status}.`);
      const data = await res.json().catch(() => null);
      if (data === null) throw new NetworkError('Réponse invalide de la source distante.');
      return data;
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      // CORS bloqué : relais publics en secours.
      try {
        const text = await fetchViaPublicProxy(valid, opts.signal);
        const data = JSON.parse(text);
        return data;
      } catch (relayErr) {
        if (relayErr?.name === 'AbortError') throw relayErr;
        throw err instanceof NetworkError ? err
          : new NetworkError('Connexion impossible avec la source distante.');
      }
    }
  }
  const params = new URLSearchParams({ url: valid });
  let res;
  try {
    res = await fetch(`${base}/api/data?${params}`, { signal: opts.signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new NetworkError('Connexion impossible avec le serveur local.');
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  if (json && json.success && json.data !== undefined) return json.data;
  throw new NetworkError(json?.error || (json ? 'Impossible de récupérer les données distantes.' : `Réponse invalide du proxy (HTTP ${res.status}).`));
}

/**
 * Construit l'URL proxy pour afficher/télécharger une image distante.
 * data: et URLs relatives passent tels quels.
 * En mode direct (APK sans proxy), retourne l'URL telle quelle.
 */
export function proxiedImageUrl(imageUrl, referer) {
  if (!imageUrl) return null;
  if (imageUrl.startsWith('data:')) return imageUrl;
  const valid = isValidHttpUrl(imageUrl);
  if (!valid) return null;
  const base = proxyBase();
  if (!base) return valid; // mode direct : URL distante utilisée telle quelle
  const params = new URLSearchParams({ url: valid });
  if (referer) params.set('referer', referer);
  return `${base}/api/image?${params}`;
}

/**
 * Télécharge une image et retourne son Blob (via proxy ou direct).
 */
export async function fetchImageBlob(imageUrl, referer, signal) {
  const target = proxiedImageUrl(imageUrl, referer);
  if (!target) throw new ValidationError('URL d’image invalide.');
  let res;
  try {
    res = await fetch(target, { signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new NetworkError('Téléchargement de l’image interrompu.');
  }
  if (!res.ok) {
    throw new NetworkError(`Image inaccessible (HTTP ${res.status}).`);
  }
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    throw new NetworkError('L’image n’a pas pu être chargée (le serveur a renvoyé une page web).');
  }
  const blob = await res.blob();
  if (!blob || blob.size < 64) {
    throw new NetworkError('L’image téléchargée semble vide ou corrompue.');
  }
  return blob;
}

/** Parse du HTML de façon inert (aucun script exécuté). */
export function parseHtml(html) {
  return new DOMParser().parseFromString(String(html || ''), 'text/html');
}
