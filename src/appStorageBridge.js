/**
 * appStorageBridge — ré-export des fonctions de stockage + helpers métier.
 */
export { initStorage, isMemoryMode, estimateUsage, clearAllImages } from './library/LibraryStorage.js';
import * as store from './library/LibraryStorage.js';
import { purgeChapterDownloads } from './downloads/OfflineStorage.js';

/** Supprime tous les fichiers téléchargés d'un manga et met à jour ses chapitres. */
export async function purgeChapterDownloadsSafe(mangaId) {
  const chapters = await store.getChaptersForManga(mangaId);
  for (const c of chapters) {
    if (c.downloaded) {
      await purgeChapterDownloads(c.id);
      await store.putChapter({ ...c, downloaded: false });
    }
  }
}
