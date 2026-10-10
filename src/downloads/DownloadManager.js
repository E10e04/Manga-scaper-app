/**
 * DownloadManager — file d'attente de téléchargements persistante.
 *
 * - sérialise la progression dans localStorage → reprise après fermeture ;
 * - traite les tâches séquentiellement (une à la fois, pages en parallèle limité) ;
 * - émet des événements pour l'UI : onStateChange(callback) ;
 * - annulation via AbortController ; validation des images côté proxy ;
 * - gestion d'espace insuffisant (QuotaExceeded → stop + message).
 */
import * as store from '../library/LibraryStorage.js';
import { findAdapter, getGenericAdapter } from '../adapters/index.js';
import { saveChapterPages, downloadPageImage, markChapterDownloaded } from './OfflineStorage.js';
import { mapWithConcurrency, sleep } from '../utils/helpers.js';
import { StorageError, humanizeError } from '../utils/errors.js';

const QUEUE_KEY = 'mangareader.downloadQueue.v1';
const CONCURRENCY = 3;

/** file = [{ id, mangaId, chapterId, label, status, done, total, failed }] */
let queue = [];
let current = null;
let aborter = null;
let listeners = new Set();
let loadedFromDisk = false;

// ---------------------------------------------------------------------------
// Persistance de la file
// ---------------------------------------------------------------------------

function loadQueue() {
  if (loadedFromDisk) return;
  loadedFromDisk = true;
  try {
    const raw = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    if (Array.isArray(raw)) {
      queue = raw.filter((t) => t && t.id && t.chapterId);
      // Les tâches "running" interrompues redeviennent "queued" (reprise)
      for (const t of queue) {
        if (t.status === 'running') t.status = 'queued';
      }
    }
  } catch {
    queue = [];
  }
}

function saveQueue() {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    /* non bloquant */
  }
}

function emit() {
  saveQueue();
  for (const cb of listeners) {
    try {
      cb(snapshot());
    } catch (err) {
      console.warn('[downloads] listener:', err.message);
    }
  }
}

function snapshot() {
  return {
    current: current ? { ...current } : null,
    queue: queue.map((t) => ({ ...t })),
    pending: queue.filter((t) => t.status === 'queued').length,
    active: queue.filter((t) => t.status === 'running').length,
  };
}

export function onStateChange(cb) {
  listeners.add(cb);
  cb(snapshot());
  return () => listeners.delete(cb);
}

export function getState() {
  loadQueue();
  return snapshot();
}

// ---------------------------------------------------------------------------
// API publique
// ---------------------------------------------------------------------------

/**
 * Ajoute un chapitre à la file de téléchargement.
 * @param {{id:string}} chapter
 * @param {{label?:string}} opts
 */
export async function enqueueChapter(chapter, opts = {}) {
  loadQueue();
  if (!chapter?.id) return { skipped: true };
  if (queue.some((t) => t.chapterId === chapter.id && (t.status === 'queued' || t.status === 'running'))) {
    return { skipped: true, reason: 'already-queued' };
  }
  const task = {
    id: `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    mangaId: chapter.mangaId,
    chapterId: chapter.id,
    label: opts.label || `Chapitre ${chapter.number ?? '?'}`,
    status: 'queued',
    done: 0,
    total: chapter.pageCount || 0,
    failed: 0,
    error: null,
    createdAt: Date.now(),
  };
  queue.push(task);
  emit();
  pump();
  return task;
}

/** Ajoute plusieurs chapitres d'un coup. */
export async function enqueueChapters(chapters, labelFn) {
  const added = [];
  for (const c of chapters) {
    const r = await enqueueChapter(c, { label: labelFn ? labelFn(c) : undefined });
    if (!r.skipped) added.push(r);
  }
  return added;
}

/** Annule une tâche (ou toutes si id absent). */
export function cancel(taskId) {
  if (taskId) {
    queue = queue.filter((t) => t.id !== taskId);
    if (current?.id === taskId) {
      aborter?.abort();
      current = null;
    }
  } else {
    queue = queue.filter((t) => t.status === 'running');
    aborter?.abort();
  }
  emit();
  pump();
}

/** Relance le traitement (utile au démarrage : reprend la file sauvegardée). */
export function resume() {
  loadQueue();
  emit();
  pump();
}

// ---------------------------------------------------------------------------
// Moteur
// ---------------------------------------------------------------------------

let pumping = false;

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (true) {
      loadQueue();
      const next = queue.find((t) => t.status === 'queued');
      if (!next) break;
      current = next;
      next.status = 'running';
      emit();
      try {
        await runTask(next);
        next.status = next.failed > 0 ? 'partial' : 'done';
      } catch (err) {
        if (err?.name === 'AbortError') {
          next.status = 'cancelled';
        } else if (err instanceof StorageError) {
          next.status = 'error';
          next.error = err.message;
          // Space issue : stoppe toute la file proprement
          queue.forEach((t) => {
            if (t.status === 'queued') t.status = 'paused';
          });
        } else {
          next.status = 'error';
          next.error = humanizeError(err);
        }
      }
      current = null;
      emit();
      await sleep(150); // ménage la source entre chapitres
    }
    // Nettoyage : retire les tâches terminées il y a plus de 30 s (garde l'historique récent visible)
    setTimeout(() => {
      queue = queue.filter((t) => !['done', 'cancelled'].includes(t.status) || Date.now() - (t.createdAt || 0) < 60_000);
      emit();
    }, 30_000);
  } finally {
    pumping = false;
  }
}

/** Exécute le téléchargement complet d'un chapitre. */
async function runTask(task) {
  const chapter = await store.getChapter(task.chapterId);
  if (!chapter) throw new Error('Le chapitre est introuvable dans la bibliothèque.');
  const manga = await store.getManga(chapter.mangaId);
  if (!manga) throw new Error('Le manga associé est introuvable.');

  // 1) S'assurer que les URLs de pages sont connues
  let working = chapter;
  if (!working.pages || working.pages.length === 0) {
    const adapter = findAdapter(manga.sourceUrl) || getGenericAdapter();
    let pages;
    try {
      pages = await adapter.getChapterPages(working, manga.sourceUrl);
    } catch (err) {
      if (findAdapter(manga.sourceUrl)) {
        pages = await getGenericAdapter().getChapterPages(working, manga.sourceUrl);
      } else throw err;
    }
    if (!pages.length) throw new Error('Ce chapitre ne contient aucune page téléchargeable.');
    working = await saveChapterPages(working, pages);
  }

  task.total = working.pages.length;

  // 2) Pages déjà présentes (reprise fine)
  const existing = await store.getChapterImageRecords(working.id);
  const have = new Set(existing.map((r) => r.pageNumber));
  task.done = have.size;
  emit();

  aborter = new AbortController();
  const missing = working.pages.map((_, i) => i + 1).filter((n) => !have.has(n));

  let failed = 0;
  await mapWithConcurrency(missing, CONCURRENCY, async (pageNumber) => {
    if (aborter.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const res = await downloadPageImage(working, pageNumber, aborter.signal);
    if (res.ok) task.done += 1;
    else failed += 1;
    task.failed = failed;
    emit();
  });

  const fully = failed === 0 && task.done >= task.total;
  await markChapterDownloaded({ ...working }, fully || task.done > 0);
  if (failed > 0 && task.done === 0) {
    throw new Error(`Aucune page n’a pu être téléchargée (${failed} échec(s)).`);
  }
}

/** Nombre total de fichiers/images stockés par manga (pour l'UI). */
export async function downloadsByManga() {
  const mangas = await store.getAllMangas();
  const out = new Map();
  await Promise.all(
    mangas.map(async (m) => {
      const chapters = await store.getChaptersForManga(m.id);
      out.set(m.id, chapters.filter((c) => c.downloaded).length);
    })
  );
  return out;
}
