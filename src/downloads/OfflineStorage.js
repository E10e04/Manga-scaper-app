/**
 * OfflineStorage — gestion des images téléchargées (blobs IndexedDB)
 * et résolution des URLs de pages pour le lecteur.
 */
import * as store from '../library/LibraryStorage.js';
import { fetchImageBlob } from '../scraper/Scraper.js';

const urlCache = new Map(); // key: `${chapterId}/${page}` -> objectURL
const pendingUrlCache = new Map();

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
  const key = `${chapter.id}/${pageNumber}`;
  const cached = urlCache.get(key);
  if (cached) return cached;
  if (pendingUrlCache.has(key)) return pendingUrlCache.get(key);

  const pending = (async () => {
    const record = await store.getImage(chapter.id, pageNumber);
    let blob = record?.blob;
    if (!blob) {
      const remote = chapter.pages?.[pageNumber - 1];
      if (!remote) return null;
      // Charger en blob passe par fetch (donc par CapacitorHttp dans l'APK),
      // ce qui évite les limites CORS et permet d'envoyer le referer du chapitre.
      blob = await fetchImageBlob(remote, chapter.url);
    }
    const objectUrl = URL.createObjectURL(blob);
    urlCache.set(key, objectUrl);
    return objectUrl;
  })();
  pendingUrlCache.set(key, pending);
  try {
    return await pending;
  } finally {
    pendingUrlCache.delete(key);
  }
}

/** Libère l'image d'une page quand le lecteur la démonte hors écran. */
export function releasePageUrl(chapterId, pageNumber) {
  const key = `${chapterId}/${pageNumber}`;
  const url = urlCache.get(key);
  if (url) URL.revokeObjectURL(url);
  urlCache.delete(key);
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
  for (const key of pendingUrlCache.keys()) {
    if (key.startsWith(`${chapterId}/`)) pendingUrlCache.delete(key);
  }
}

/** Supprime tous les fichiers locaux d'un chapitre. */
export async function purgeChapterDownloads(chapterId) {
  releaseChapterUrls(chapterId);
  await store.deleteChapterImages(chapterId);
}
