/**
 * Library — logique métier de la bibliothèque.
 *
 * - ajout d'un manga via analyse (adaptateur choisi automatiquement)
 * - mise à jour ("Actualiser les chapitres") : n'ajoute que les nouveaux,
 *   conserve la progression existante
 * - recherche / filtres / tri
 * - enrichissement des mangas avec stats (progression, téléchargés…)
 */
import { findAdapter, getGenericAdapter } from '../adapters/index.js';
import { fetchPage } from '../scraper/Scraper.js';
import { ValidationError, NotFoundError, humanizeError } from '../utils/errors.js';
import { mangaIdFromUrl, chapterIdFromUrl, isValidHttpUrl } from '../utils/helpers.js';
import * as store from './LibraryStorage.js';
import { getProgress, overallProgress, recentReads } from './ReadingProgress.js';

/**
 * Analyse une URL de manga et retourne un aperçu complet (sans ajouter).
 * @param {string} url
 * @param {(step: {label:string, status:'run'|'ok'|'fail', detail?:string}) => void} onProgress
 */
export async function analyzeManga(url, onProgress = () => {}) {
  const valid = isValidHttpUrl(url);
  if (!valid) throw new ValidationError('Cette URL n’est pas valide. Exemple attendu : https://site.fr/manga/titre');

  const step = (label, status, detail) => onProgress({ label, status, detail });

  step('Analyse de l’URL…', 'run');
  const specific = findAdapter(valid);
  const adapter = specific || getGenericAdapter();
  step(specific ? `Source reconnue : ${adapter.name}` : 'Source non reconnue — mode générique', 'ok', adapter.name);

  step('Récupération de la page…', 'run');
  // Récupère la page UNE fois, puis délègue au try-with-fallback spécifique→générique
  let info;
  let chapters;
  try {
    info = await adapter.getMangaInfo(valid);
    step('Page trouvée', 'ok');
    step(`Manga identifié : ${info.title}`, 'ok');
    chapters = await adapter.getChapters(info.sourceUrl || valid);
  } catch (err) {
    if (adapter === specific && !(err instanceof ValidationError)) {
      // L'adaptateur spécifique a échoué (site modifié) → repli générique
      step('Adaptateur spécifique insuffisant, essai du mode générique…', 'run');
      const gen = getGenericAdapter();
      info = await gen.getMangaInfo(valid);
      chapters = await gen.getChapters(info.sourceUrl || valid);
      adapter.displayName = info.sourceName || gen.name;
    } else {
      step('Échec de l’analyse', 'fail');
      throw err;
    }
  }

  if (!chapters.length) {
    step('Aucun chapitre trouvé', 'fail');
    throw new NotFoundError('Aucun chapitre n’a été détecté sur cette page.');
  }
  step(`${chapters.length} chapitre${chapters.length > 1 ? 's' : ''} détecté${chapters.length > 1 ? 's' : ''}`, 'ok');
  step('Manga prêt à être ajouté', 'ok');

  return {
    id: mangaIdFromUrl(info.sourceUrl || valid),
    sourceName: info.sourceName || adapter.name,
    title: info.title,
    cover: info.cover,
    description: info.description || '',
    author: info.author || '',
    status: info.status || 'ongoing',
    sourceUrl: info.sourceUrl || valid,
    chapters, // [{url, number, title}] triés du plus récent
  };
}

/**
 * Ajoute le manga analysé à la bibliothèque (manga + chapitres persistés).
 * Si le manga existe déjà (même source+URL), met à jour ses métadonnées.
 */
export async function addManga(analysis) {
  const now = Date.now();
  const existing = await store.getManga(analysis.id);
  const manga = {
    id: analysis.id,
    title: analysis.title,
    cover: analysis.cover || null,
    source: analysis.sourceName,
    sourceUrl: analysis.sourceUrl,
    description: analysis.description || '',
    author: analysis.author || '',
    status: analysis.status || 'ongoing',
    chapterCount: analysis.chapters.length,
    latestChapterNumber: analysis.chapters[0]?.number ?? null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    addedAt: existing?.addedAt || now,
  };
  await store.putManga(manga);

  const records = analysis.chapters.map((c, i) => ({
    id: chapterIdFromUrl(c.url),
    mangaId: manga.id,
    number: Number.isFinite(c.number) ? c.number : analysis.chapters.length - i,
    title: c.title || `Chapitre ${c.number ?? i + 1}`,
    url: c.url,
    pages: [], // URLs des images, remplies à la lecture/téléchargement
    pageCount: 0,
    downloaded: false,
    read: false,
    progress: 0,
    lastReadAt: null,
    index: i,
  }));
  await store.putChaptersBulk(records);
  return manga;
}

/**
 * Actualise les chapitres depuis la source : ajoute uniquement les nouveaux,
 * conserve progression/statut de lecture des chapitres existants.
 */
export async function refreshChapters(mangaId) {
  const manga = await store.getManga(mangaId);
  if (!manga) throw new NotFoundError('Ce manga n’est plus dans votre bibliothèque.');

  const adapter = findAdapter(manga.sourceUrl) || getGenericAdapter();
  let remoteChapters;
  try {
    remoteChapters = await adapter.getChapters(manga.sourceUrl);
  } catch (err) {
    if (findAdapter(manga.sourceUrl)) {
      remoteChapters = await getGenericAdapter().getChapters(manga.sourceUrl);
    } else {
      throw new ValidationError(humanizeError(err));
    }
  }

  const local = await store.getChaptersForManga(mangaId);
  const localByUrl = new Map(local.map((c) => [c.url, c]));
  const newOnes = [];
  for (const rc of remoteChapters) {
    if (!localByUrl.has(rc.url)) {
      newOnes.push({
        id: chapterIdFromUrl(rc.url),
        mangaId,
        number: rc.number ?? remoteChapters.length,
        title: rc.title || `Chapitre ${rc.number ?? '?'}`,
        url: rc.url,
        pages: [],
        pageCount: 0,
        downloaded: false,
        read: false,
        progress: 0,
        lastReadAt: null,
        index: 0,
      });
    }
  }

  if (newOnes.length) {
    // Recalcule l'index global (tri décroissant par numéro)
    const all = [...remoteChapters].sort((a, b) => (b.number ?? -1) - (a.number ?? -1));
    const indexOf = new Map(all.map((c, i) => [c.url, i]));
    newOnes.forEach((c) => (c.index = indexOf.get(c.url) ?? 0));
    await store.putChaptersBulk(newOnes);
  }

  const updated = {
    ...manga,
    chapterCount: local.length + newOnes.length,
    latestChapterNumber: Math.max(
      manga.latestChapterNumber ?? -1,
      ...remoteChapters.map((c) => (Number.isFinite(c.number) ? c.number : -1))
    ),
    updatedAt: Date.now(),
  };
  if (updated.latestChapterNumber === -1) updated.latestChapterNumber = null;
  await store.putManga(updated);

  return { added: newOnes.length, total: updated.chapterCount };
}

/** Supprime un manga, ses chapitres, ses images et sa progression. */
export async function removeManga(mangaId) {
  const chapters = await store.getChaptersForManga(mangaId);
  for (const c of chapters) {
    if (c.downloaded) await store.deleteChapterImages(c.id);
  }
  await store.deleteManga(mangaId);
  const { clearProgress } = await import('./ReadingProgress.js');
  clearProgress(mangaId);
}

// ---------------------------------------------------------------------------
// Lecture enrichie
// ---------------------------------------------------------------------------

/** Statistiques agrégées pour un manga (progression, downloads…). */
export async function getMangaStats(mangaId) {
  const chapters = await store.getChaptersForManga(mangaId);
  const total = chapters.length;
  const read = chapters.filter((c) => c.read).length;
  const downloaded = chapters.filter((c) => c.downloaded).length;
  const progress = getProgress(mangaId);
  const pct = overallProgress(read, total);
  const sortedByNumber = [...chapters].sort((a, b) => (b.number ?? -1) - (a.number ?? -1));
  return {
    total,
    read,
    downloaded,
    percent: pct,
    progress,
    lastReadChapter: sortedByNumber.find((c) => c.lastReadAt) || null,
    latestChapter: sortedByNumber[0] || null,
    chapters: sortedByNumber,
  };
}

/** Liste complète enrichie pour l'affichage bibliothèque/home. */
export async function getLibraryEntries() {
  const mangas = await store.getAllMangas();
  const entries = await Promise.all(
    mangas.map(async (m) => {
      const stats = await getMangaStats(m.id);
      return { manga: m, ...stats };
    })
  );
  return entries;
}

// ---------------------------------------------------------------------------
// Recherche / tri / filtres
// ---------------------------------------------------------------------------

export function searchEntries(entries, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return entries;
  const norm = (s) =>
    String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  const nq = norm(q);
  return entries.filter(
    (e) =>
      norm(e.manga.title).includes(nq) ||
      norm(e.manga.author).includes(nq) ||
      norm(e.manga.source).includes(nq)
  );
}

export function filterEntries(entries, filter) {
  switch (filter) {
    case 'reading':
      return entries.filter((e) => e.percent > 0 && e.percent < 100);
    case 'completed':
      return entries.filter((e) => e.percent >= 100 && e.total > 0);
    case 'downloaded':
      return entries.filter((e) => e.downloaded > 0);
    case 'not-downloaded':
      return entries.filter((e) => e.downloaded === 0);
    default:
      return entries;
  }
}

export function sortEntries(entries, sortBy) {
  const arr = [...entries];
  switch (sortBy) {
    case 'title-asc':
      arr.sort((a, b) => a.manga.title.localeCompare(b.manga.title, 'fr'));
      break;
    case 'title-desc':
      arr.sort((a, b) => b.manga.title.localeCompare(a.manga.title, 'fr'));
      break;
    case 'progress':
      arr.sort((a, b) => b.percent - a.percent);
      break;
    case 'chapters':
      arr.sort((a, b) => b.total - a.total);
      break;
    case 'recently-read':
      arr.sort((a, b) => {
        const pa = getProgress(a.manga.id)?.updatedAt || 0;
        const pb = getProgress(b.manga.id)?.updatedAt || 0;
        return pb - pa;
      });
      break;
    case 'recently-added':
    default:
      arr.sort((a, b) => (b.manga.addedAt || 0) - (a.manga.addedAt || 0));
  }
  return arr;
}

export { recentReads };
