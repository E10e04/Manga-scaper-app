/**
 * Utilitaires réseau communs — centralisés ici pour éviter la duplication
 * entre Scraper, DownloadManager et les adaptateurs.
 *
 * Fournit :
 *  - fetchWithTimeout : délai d'expiration configurable + annulation externe ;
 *  - fetchWithRetry   : tentatives limitées avec temporisation progressive
 *                       (backoff), respect de Retry-After, uniquement sur les
 *                       erreurs temporaires (5xx, 408, 429, erreurs réseau) ;
 *  - createLimiter    : limitation de la concurrence des requêtes simultanées ;
 *  - dedupe           : déduplication des requêtes identiques en vol ;
 *  - isLikelyHtml     : détection robuste d'une réponse HTML (le fameux
 *                       « Unexpected token '<' » vient toujours de là).
 */

/** Erreur réseau typée, exposée pour les tests et le contrôle du flux. */
export class TimeoutError extends Error {
  constructor(message = 'La requête a expiré.') {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * fetch() avec délai d'expiration, compatible avec un AbortSignal externe.
 * Ne provoque jamais de fuite : le timer est toujours nettoyé.
 */
export async function fetchWithTimeout(url, opts = {}) {
  const { timeoutMs = 20000, signal, ...rest } = opts;
  const ctrl = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, Math.max(1000, timeoutMs));

  const onExternalAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      ctrl.abort();
    } else {
      signal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  try {
    return await fetch(url, { ...rest, signal: ctrl.signal });
  } catch (err) {
    if (err?.name === 'AbortError') {
      if (timedOut) throw new TimeoutError();
      if (signal?.aborted) throw err; // annulation volontaire de l'appelant
      throw new TimeoutError();
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Détermine si une erreur/état mérite une nouvelle tentative. */
export function isRetryable(errOrStatus) {
  if (typeof errOrStatus === 'number') return RETRYABLE_STATUS.has(errOrStatus);
  const name = errOrStatus?.name;
  if (name === 'AbortError') return false; // annulation volontaire
  if (name === 'TypeError' || name === 'NetworkError' || name === 'TimeoutError') return true;
  const status = errOrStatus?.status;
  return typeof status === 'number' && RETRYABLE_STATUS.has(status);
}

/** Parse `Retry-After` (secondes ou date HTTP) -> millisecondes, sinon null. */
export function parseRetryAfter(value) {
  if (!value) return null;
  const secs = Number(value);
  // Spécification : les secondes doivent être un entier non négatif ;
  // toute autre valeur numérique (négative, décimale) est ignorée et
  // peut être interprétée comme une date HTTP.
  if (Number.isInteger(secs) && secs >= 0) return Math.min(secs * 1000, 60000);
  if (/^-?\d+(\.\d+)?$/.test(String(value).trim())) return null; // nombre invalide => pas de date
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    const delta = date - Date.now();
    return delta > 0 ? Math.min(delta, 60000) : 0;
  }
  return null;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Récupère une ressource avec tentatives limitées et backoff progressif.
 * @param {string} url
 * @param {{ attempts?: number, baseDelayMs?: number, timeoutMs?: number,
 *           signal?: AbortSignal, validate?: (res: Response) => boolean,
 *           ...fetchOpts }} opts
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(url, opts = {}) {
  const {
    attempts = 3,
    baseDelayMs = 800,
    timeoutMs = 20000,
    signal,
    validate,
    ...fetchOpts
  } = opts;

  let lastErr = null;
  for (let i = 0; i < Math.max(1, attempts); i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const res = await fetchWithTimeout(url, { ...fetchOpts, timeoutMs, signal });
      const bad = !res.ok || (validate && !validate(res));
      if (bad && i < attempts - 1 && isRetryable(res.status)) {
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
        const delay = retryAfter ?? baseDelayMs * 2 ** i + Math.random() * 250;
        await sleep(delay, signal);
        continue;
      }
      return res; // renvoyé tel quel : c'est à l'appelant de traiter !res.ok
    } catch (err) {
      if (err?.name === 'AbortError' && signal?.aborted) throw err;
      lastErr = err;
      if (i < attempts - 1 && isRetryable(err)) {
        await sleep(baseDelayMs * 2 ** i + Math.random() * 250, signal);
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error('Échec de la requête.');
}

/**
 * Limiteur de concurrence : au plus `max` tâches simultanées, file FIFO.
 * Évite les rafales de requêtes susceptibles de déclencher des blocages.
 */
export function createLimiter(max = 4) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active += 1;
    const { task, resolve, reject } = queue.shift();
    task()
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return function run(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      next();
    });
  };
}

// File module-level partagée : limite globale de 5 requêtes simultanées.
const globalLimiter = createLimiter(5);
export function limitGlobal(task) {
  return globalLimiter(task);
}

// ---------------------------------------------------------------------------
// Déduplication des requêtes identiques en vol
// ---------------------------------------------------------------------------

const inflight = new Map();

/**
 * Exécute `fn` en garantissant qu'une seule exécution est en cours pour la
 * même clé (ex. deux composants qui demandent la même page simultanément).
 */
export async function dedupe(key, fn) {
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = Promise.resolve()
    .then(fn)
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------
// Validation de contenu
// ---------------------------------------------------------------------------

/**
 * Détecte si un texte est très probablement du HTML (et donc pas du JSON).
 * Cause racine de l'erreur « Unexpected token '<' » : on l'identifie ici pour
 * afficher un message humain plutôt que laisser JSON.planter exploser.
 */
export function isLikelyHtml(text) {
  if (typeof text !== 'string') return true;
  const head = text.slice(0, 512).trimStart().toLowerCase();
  if (!head) return true;
  return (
    head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    head.startsWith('<head') ||
    head.startsWith('<?xml') ||
    head.startsWith('<body') ||
    /^<(!|h|bo|he)/.test(head)
  );
}

/** Vrai si la réponse ressemble à une image (magic bytes connus). */
export function looksLikeImage(bufferSource) {
  const b = bufferSource instanceof Uint8Array
    ? bufferSource
    : new Uint8Array(bufferSource);
  if (b.length < 12) return false;
  return (
    (b[0] === 0xff && b[1] === 0xd8) || // jpeg
    (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) || // png
    (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) || // gif
    (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) || // webp (RIFF)
    (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) // avif/heic (ftyp)
  );
}
