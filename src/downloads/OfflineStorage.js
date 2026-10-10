/**
 * OfflineStorage — gestion des images téléchargées (blobs IndexedDB)
 * et résolution des URLs de pages pour le lecteur.
 */
import * as store from '../library/LibraryStorage.js';
import { proxiedImageUrl } from '../scraper/Scraper.js';

const urlCache = new Map(); // key: `${chapterId}/${page}` -> objectURL

/** Enregistre les métadonnées de pages d'un chapitre (URLs distantes). */
export async function saveChapterPages(chapter, pages) {
  const updated = {
    ...chapter,
    pages: pages.map((p) => p.imageUrl),
    pageCount: pages.length,
  };
  await store.putChapter(updated);
  return updated;
}

/** Télécharge une image et la stocke en blob. Retourne false si échec. */
export async function downloadPageImage(chapter, pageNumber, signal) {
  const imageUrl = chapter.pages?.[pageNumber - 1];
  if (!imageUrl) return { ok: false, reason: 'missing-url' };
  try {
    const { fetchImageBlob } = await import('../scraper/Scraper.js');
    const blob = await fetchImageBlob(imageUrl, chapter.url, signal);
    await store.putImage(chapter.id, pageNumber, blob, { mangaId: chapter.mangaId, sourceUrl: imageUrl });
    return { ok: true, size: blob.size };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return { ok: false, reason: err.message || 'error' };
  }
}

/** Nombre de pages déjà stockées pour un chapitre. */
export async function countDownloadedPages(chapterId) {
  const records = await store.getChapterImageRecords(chapterId);
  return records.length;
}

/** Marque un chapitre comme téléchargé (ou partiellement). */
export async function markChapterDownloaded(chapter, fully) {
  const updated = { ...chapter, downloaded: !!fully, downloadedAt: fully ? Date.now() : chapter.downloadedAt || null };
  await store.putChapter(updated);
  return updated;
}

/**
 * Retourne une URL affichable pour une page : blob local si disponible,
 * sinon URL proxifiée distante. Appeler releasePageUrls() au fermeture du chapitre.
 */
export async function resolvePageUrl(chapter, pageNumber) {
  const cached = urlCache.get(`${chapter.id}/${pageNumber}`);
  if (cached) return cached;

  const record = await store.getImage(chapter.id, pageNumber);
  if (record?.blob) {
    const objUrl = URL.createObjectURL(record.blob);
    urlCache.set(`${chapter.id}/${pageNumber}`, objUrl);
    return objUrl;
  }
  const remote = chapter.pages?.[pageNumber - 1];
  if (remote) {
    const proxied = proxiedImageUrl(remote, chapter.url);
    if (proxied) return proxied;
  }
  return null;
}

/** Libère les object URLs d'un chapitre (anti-fuite mémoire). */
export function releaseChapterUrls(chapterId) {
  for (const [key, url] of Array.from(urlCache.entries())) {
    if (key.startsWith(`${chapterId}/`)) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
      urlCache.delete(key);
    }
  }
}

/** Supprime tous les fichiers locaux d'un chapitre. */
export async function purgeChapterDownloads(chapterId) {
  releaseChapterUrls(chapterId);
  await store.deleteChapterImages(chapterId);
}
