/**
 * Scraping : récupération de pages distantes via le proxy local (/api/page).
 *
 * En environnement Capacitor (Android), le proxy distant n'existe pas :
 * on tente d'abord une requête directe (le WebView autorise CORS si
 * allowMixedContent / configuration serveur le permettent), puis on replie
 * sur le proxy relatif si disponible.
 */
import { NetworkError, ValidationError } from '../utils/errors.js';
import { isValidHttpUrl } from '../utils/helpers.js';

const isNative = typeof window !== 'undefined' && !/^https?:\/\/(localhost|127)/.test(window.location?.origin || '') && !!window.Capacitor;

/**
 * Base du proxy.
 * - Web : même origine que l'app (server.js sert /api/*).
 * - Natif (Capacitor/Android) : server.js ne tourne pas dans l'APK.
 *   L'utilisateur peut renseigner l'adresse d'un proxy accessible sur son
 *   réseau via localStorage("mr_proxy_url") (ex. http://192.168.1.10:8080).
 *   Sans configuration, les requêtes partent en direct depuis le WebView.
 */
function proxyBase() {
  if (typeof window === 'undefined') return ''; // Node (tests) : appel direct
  if (isNative) {
    const custom = (window.localStorage?.getItem('mr_proxy_url') || '').trim().replace(/\/+$/, '');
    return custom; // vide => requêtes directes
  }
  return window.location.origin; // même origine que l'app web
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

  // 1) Via le proxy local (chemin le plus fiable pour les navigateurs)
  try {
    const params = new URLSearchParams({ url: valid });
    if (referer) params.set('referer', referer);
    const res = await fetch(`${proxyBase()}/api/page?${params}`, { signal });
    if (res.ok) {
      const json = await res.json();
      if (json.success && typeof json.html === 'string') {
        return { html: json.html, finalUrl: json.finalUrl || valid };
      }
      if (json.error) throw new NetworkError(json.error);
    } else if (res.status === 404) {
      const json = await res.json().catch(() => ({}));
      throw new NetworkError(json.error || 'La page demandée est introuvable sur le site distant.');
    } else if (res.status >= 500) {
      const json = await res.json().catch(() => ({}));
      throw new NetworkError(json.error || 'Le site distant est momentanément inaccessible.');
    }
    throw new NetworkError('Réponse inattendue du proxy local.');
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    if (err?.name === 'AbortError') throw err;
    // Proxy indisponible (ex. app servie sans server.js) : tentative directe
    if (err instanceof NetworkError && isNative) {
      try {
        const res = await fetch(valid, { signal, headers: referer ? { Referer: referer } : undefined });
        if (res.ok) return { html: await res.text(), finalUrl: res.url || valid };
      } catch {
        /* on remonte l'erreur d'origine, déjà humanisée */
      }
    }
    throw err;
  }
}

/**
 * Récupère un JSON distant via /api/data.
 */
export async function fetchDataJson(url, opts = {}) {
  const valid = isValidHttpUrl(url);
  if (!valid) throw new ValidationError('URL invalide.');
  const params = new URLSearchParams({ url: valid });
  let res;
  try {
    res = await fetch(`${proxyBase()}/api/data?${params}`, { signal: opts.signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new NetworkError('Connexion impossible avec le serveur local.');
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) {
    throw new NetworkError(json?.error || 'Impossible de récupérer les données distantes.');
  }
  return json.data;
}

/**
 * Construit l'URL proxy pour afficher/télécharger une image distante.
 * data: et URLs relatives passent tels quels.
 */
export function proxiedImageUrl(imageUrl, referer) {
  if (!imageUrl) return null;
  if (imageUrl.startsWith('data:')) return imageUrl;
  const valid = isValidHttpUrl(imageUrl);
  if (!valid) return null;
  const params = new URLSearchParams({ url: valid });
  if (referer) params.set('referer', referer);
  return `${proxyBase()}/api/image?${params}`;
}

/**
 * Télécharge une image et retourne son Blob (via proxy ou direct).
 */
export async function fetchImageBlob(imageUrl, referer, signal) {
  const proxied = proxiedImageUrl(imageUrl, referer);
  if (!proxied) throw new ValidationError('URL d’image invalide.');
  let res;
  try {
    res = await fetch(proxied, { signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new NetworkError('Téléchargement de l’image interrompu.');
  }
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new NetworkError(json.error || `Image inaccessible (HTTP ${res.status}).`);
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
