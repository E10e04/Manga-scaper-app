/**
 * ReaderSettings — préférences du lecteur (localStorage).
 */
const KEY = 'mangareader.readerSettings.v1';

export const DEFAULT_SETTINGS = {
  maxWidth: 820, // largeur max des pages en px
  fullwidth: false,
  gap: 8, // espacement vertical entre pages (px)
  showUi: true,
  autoHideControls: true,
  fullscreen: false,
  zoom: 100, // %
  fitMode: 'width', // width | original
};

let cache = null;

export function getSettings() {
  if (!cache) {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
      cache = { ...DEFAULT_SETTINGS, ...raw };
      // Validation stricte des valeurs
      cache.maxWidth = clamp(cache.maxWidth, 360, 1600, DEFAULT_SETTINGS.maxWidth);
      cache.gap = clamp(cache.gap, 0, 48, DEFAULT_SETTINGS.gap);
      cache.zoom = clamp(cache.zoom, 50, 200, 100);
      if (!['width', 'original'].includes(cache.fitMode)) cache.fitMode = 'width';
      ['fullwidth', 'showUi', 'autoHideControls', 'fullscreen'].forEach((k) => {
        cache[k] = !!cache[k];
      });
    } catch {
      cache = { ...DEFAULT_SETTINGS };
    }
  }
  return cache;
}

function clamp(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

export function setSetting(key, value) {
  const s = getSettings();
  s[key] = value;
  cache = s;
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent('reader-settings-changed', { detail: s }));
  return s;
}

export function resetSettings() {
  cache = { ...DEFAULT_SETTINGS };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent('reader-settings-changed', { detail: cache }));
}
