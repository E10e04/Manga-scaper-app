/**
 * Utilitaires divers : identifiants stables, formatage, validation d'URLs.
 */

/** Génère un identifiant unique lisible (timestamp + aléa). */
export function uid(prefix = '') {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}${Date.now().toString(36)}-${rand}`;
}

/** Hash stable d'une chaîne (FNV-1a 32 bits, en hexadécimal). */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Identifiant stable dérivé de l'URL source du manga. */
export function mangaIdFromUrl(sourceUrl) {
  try {
    const u = new URL(sourceUrl);
    const key = `${u.host}${u.pathname.replace(/\/+$/, '').toLowerCase()}`;
    return `m-${hashString(key)}`;
  } catch {
    return `m-${hashString(String(sourceUrl))}`;
  }
}

/** Identifiant stable dérivé de l'URL du chapitre. */
export function chapterIdFromUrl(chapterUrl) {
  return `c-${hashString(chapterUrl || '')}`;
}

/** Valide une URL http/https. Retourne l'URL normalisée ou null. */
export function isValidHttpUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    // Certains claviers Android ajoutent des séparateurs invisibles ou des
    // retours à la ligne lors du collage d'un lien.
    let value = raw
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/[\r\n\t\u00A0\u202F]/g, '')
      .trim();
    if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname.includes('.')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Résout une URL relative par rapport à une base, avec repli sûr. */
export function resolveUrl(maybeRelative, baseUrl) {
  if (!maybeRelative) return '';
  try {
    if (/^(data|blob):/i.test(maybeRelative)) return maybeRelative;
    return new URL(maybeRelative, baseUrl).toString();
  } catch {
    return String(maybeRelative);
  }
}

/** Formate une taille en octets de façon lisible (fr-FR). */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString('fr-FR', { maximumFractionDigits: v >= 100 ? 0 : 1 })} ${units[i]}`;
}

/** Formate une date relative (« il y a 3 jours »). */
export function timeAgo(ts) {
  if (!Number.isFinite(ts)) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "à l'instant";
  const m = s / 60;
  if (m < 60) return `il y a ${Math.floor(m)} min`;
  const h = m / 60;
  if (h < 24) return `il y a ${Math.floor(h)} h`;
  const d = h / 24;
  if (d < 30) return `il y a ${Math.floor(d)} j`;
  const mo = d / 30;
  if (mo < 12) return `il y a ${Math.floor(mo)} mois`;
  return `il y a ${Math.floor(mo / 12)} an(s)`;
}

/** Échappe une chaîne pour insertion HTML sûre. */
export function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Nettoie un titre/texte venant d'une source externe. */
export function cleanText(text) {
  if (text == null) return '';
  return String(text)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

/** Extrait le numéro d'un chapitre depuis un texte/URL ("Chapter 12.5" → 12.5). */
export function extractChapterNumber(text) {
  if (text == null) return null;
  const s = String(text);
  let m = s.match(/(?:chapter|chapitre|chap|episode|ep|tome|volume)[\s._-]*(\d+(?:[.,]\d+)?)/i);
  if (m) return parseFloat(m[1].replace(',', '.'));
  m = s.match(/(\d+(?:[.,]\d+)?)(?!.*\d)/);
  if (m) return parseFloat(m[1].replace(',', '.'));
  return null;
}

/** Debounce simple. */
export function debounce(fn, wait = 200) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

/** Sleep promisifié. */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Limite de concurrence pour l'exécution parallèle de tâches async. */
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}
