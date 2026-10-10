/**
 * ReadingProgress — suivi de progression par manga/chapitre.
 * Persisté dans localStorage (données légères), synchronisable avec IndexedDB.
 */
const KEY = 'mangareader.progress.v1';

/** { [mangaId]: { chapterId, chapterNumber, page, pages, updatedAt } } */
let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    cache = raw ? JSON.parse(raw) : {};
    if (typeof cache !== 'object' || cache === null) cache = {};
  } catch {
    cache = {};
  }
  return cache;
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* stockage plein : la progression reste en mémoire pour la session */
  }
}

export function getProgress(mangaId) {
  return load()[mangaId] || null;
}

/** Enregistre la position de lecture d'un manga. */
export function saveProgress(mangaId, { chapterId, chapterNumber = null, page = 0, pages = 0 }) {
  if (!mangaId) return;
  const p = {
    chapterId: chapterId || null,
    chapterNumber: Number.isFinite(chapterNumber) ? chapterNumber : null,
    page: Math.max(0, Math.floor(page) || 0),
    pages: Math.max(0, Math.floor(pages) || 0),
    updatedAt: Date.now(),
  };
  load()[mangaId] = p;
  persist();
  return p;
}

export function clearProgress(mangaId) {
  delete load()[mangaId];
  persist();
}

/** Progression globale d'un manga : chapitres lus / total (estimation). */
export function overallProgress(readCount, totalChapters) {
  if (!Number.isFinite(totalChapters) || totalChapters <= 0) return 0;
  const r = Number.isFinite(readCount) ? readCount : 0;
  return Math.min(100, Math.round((r / totalChapters) * 100));
}

/** Historique des dernières lectures (ordre décroissant). */
export function recentReads() {
  const entries = Object.entries(load());
  entries.sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
  return entries.map(([mangaId, p]) => ({ mangaId, ...p }));
}
