/**
 * LibraryStorage — accès IndexedDB.
 *
 * Bases de données :
 *  - MangaReaderLibrary : object stores `mangas`, `chapters`
 *  - MangaReaderImages  : object store `images` (blobs, volumineux)
 *
 * Toutes les promesses rejettent avec des StorageError humanisées ;
 * l'API expose aussi un mode mémoire (fallback) si IndexedDB est indisponible.
 */
import { StorageError } from '../utils/errors.js';

const LIB_DB = 'MangaReaderLibrary';
const IMG_DB = 'MangaReaderImages';
const DB_VERSION = 1;

let libraryMemoryMode = false;
let imageMemoryMode = false;
const mem = { mangas: new Map(), chapters: new Map(), images: new Map() };

function openDb(name, stores) {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new StorageError('IndexedDB n’est pas disponible dans cet environnement.'));
      return;
    }
    let req;
    try {
      req = indexedDB.open(name, DB_VERSION);
    } catch (err) {
      reject(new StorageError('Impossible d’ouvrir le stockage local.', err));
      return;
    }
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      for (const s of stores) {
        if (!db.objectStoreNames.contains(s.name)) {
          const os = db.createObjectStore(s.name, { keyPath: s.keyPath });
          (s.indexes || []).forEach(([iname, ikey, uniq]) => os.createIndex(iname, ikey, { unique: !!uniq }));
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new StorageError('Le stockage local est inaccessible (IndexedDB).', req.error));
    req.onblocked = () => reject(new StorageError('Stockage verrouillé par une autre fenêtre de l’application.'));
  });
}

let libDbP = null;
let imgDbP = null;

function libDb() {
  if (!libDbP) {
    libDbP = openDb(LIB_DB, [
      { name: 'mangas', keyPath: 'id', indexes: [['sourceUrl', 'sourceUrl', true], ['updatedAt', 'updatedAt']] },
      { name: 'chapters', keyPath: 'id', indexes: [['mangaId', 'mangaId'], ['url', 'urlHash', true]] },
    ]).catch((err) => {
      console.warn('[storage] fallback mémoire :', err.message);
      libraryMemoryMode = true;
      libDbP = null;
      throw err;
    });
  }
  return libDbP;
}

function imgDb() {
  if (!imgDbP) {
    imgDbP = openDb(IMG_DB, [{ name: 'images', keyPath: 'key' }]).catch((err) => {
      imageMemoryMode = true;
      imgDbP = null;
      throw err;
    });
  }
  return imgDbP;
}

/** Exécute une transaction et retourne une promesse du résultat. */
function tx(db, storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    try {
      const t = db.transaction(storeName, mode);
      const store = t.objectStore(storeName);
      const out = fn(store);
      t.oncomplete = () => resolve(out?.__req ? out.__req.result : undefined);
      t.onerror = () => reject(toStorageError(t.error));
      t.onabort = () => reject(toStorageError(t.error || t.abortReason));
    } catch (err) {
      reject(toStorageError(err));
    }
  });
}

function toStorageError(err) {
  if (err && /QuotaExceeded|NotSupportedError|disk full|quota/i.test(String(err.name || '') + String(err.message || ''))) {
    return new StorageError('Espace de stockage insuffisant. Supprimez des téléchargements pour libérer de la place.');
  }
  if (err instanceof StorageError) return err;
  return new StorageError('Erreur d’accès au stockage local.', err);
}

function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(toStorageError(req.error));
  });
}

// ---------------------------------------------------------------------------
// API publique
// ---------------------------------------------------------------------------

export function isMemoryMode() {
  return libraryMemoryMode;
}

/** Initialise les deux bases sans laisser une panne d'images rendre le catalogue volatile. */
export async function initStorage() {
  const [libraryResult, imageResult] = await Promise.allSettled([libDb(), imgDb()]);
  libraryMemoryMode = libraryResult.status === 'rejected';
  imageMemoryMode = imageResult.status === 'rejected';

  // Les WebView Android récents accordent généralement ce droit d'office aux
  // applications installées. Le demander évite l'éviction automatique de
  // l'IndexedDB dans les environnements qui le prennent en charge.
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
      await navigator.storage.persist();
    }
  } catch {
    /* le stockage reste utilisable même si la demande n'est pas accordée */
  }

  return { ok: true, memoryMode: libraryMemoryMode, imageMemoryMode };
}

// --- Mangas ---

export async function putManga(manga) {
  if (libraryMemoryMode) {
    mem.mangas.set(manga.id, manga);
    return manga;
  }
  const db = await libDb();
  await tx(db, 'mangas', 'readwrite', (s) => s.put(manga));
  return manga;
}

export async function getManga(id) {
  if (libraryMemoryMode) return mem.mangas.get(id) || null;
  const db = await libDb();
  const t = db.transaction('mangas', 'readonly');
  return requestToPromise(t.objectStore('mangas').get(id)).catch(() => null);
}

export async function getAllMangas() {
  if (libraryMemoryMode) return Array.from(mem.mangas.values());
  const db = await libDb();
  const t = db.transaction('mangas', 'readonly');
  return requestToPromise(t.objectStore('mangas').getAll());
}

export async function deleteManga(id) {
  if (libraryMemoryMode) {
    mem.mangas.delete(id);
    for (const [cid, c] of mem.chapters) if (c.mangaId === id) mem.chapters.delete(cid);
    return;
  }
  const db = await libDb();
  await tx(db, 'mangas', 'readwrite', (s) => s.delete(id));
  const chapters = await getChaptersForManga(id);
  for (const c of chapters) await deleteChapter(c.id, id, false);
}

// --- Chapitres ---

export async function putChapter(chapter) {
  const record = { ...chapter, urlHash: chapter.url };
  if (libraryMemoryMode) {
    mem.chapters.set(chapter.id, record);
    return record;
  }
  const db = await libDb();
  // index unique sur url : retire un doublon éventuel avant insertion
  try {
    const existing = await findChapterByUrl(chapter.url);
    if (existing && existing.id !== chapter.id) {
      await tx(db, 'chapters', 'readwrite', (s) => s.delete(existing.id));
    }
  } catch {
    /* ignore */
  }
  await tx(db, 'chapters', 'readwrite', (s) => s.put(record));
  return record;
}

export async function putChaptersBulk(chapters) {
  if (libraryMemoryMode) {
    chapters.forEach((c) => mem.chapters.set(c.id, { ...c, urlHash: c.url }));
    return;
  }
  const db = await libDb();
  await new Promise((resolve, reject) => {
    const t = db.transaction('chapters', 'readwrite');
    const s = t.objectStore('chapters');
    chapters.forEach((c) => s.put({ ...c, urlHash: c.url }));
    t.oncomplete = resolve;
    t.onerror = () => reject(toStorageError(t.error));
    t.onabort = () => reject(toStorageError(t.error));
  });
}

export async function getChapter(id) {
  if (libraryMemoryMode) return mem.chapters.get(id) || null;
  const db = await libDb();
  const t = db.transaction('chapters', 'readonly');
  return requestToPromise(t.objectStore('chapters').get(id)).catch(() => null);
}

export async function findChapterByUrl(url) {
  if (libraryMemoryMode) {
    for (const c of mem.chapters.values()) if (c.url === url) return c;
    return null;
  }
  const db = await libDb();
  const t = db.transaction('chapters', 'readonly');
  return requestToPromise(t.objectStore('chapters').index('url').get(url)).catch(() => null);
}

export async function getChaptersForManga(mangaId) {
  if (libraryMemoryMode) return Array.from(mem.chapters.values()).filter((c) => c.mangaId === mangaId);
  const db = await libDb();
  const t = db.transaction('chapters', 'readonly');
  return requestToPromise(t.objectStore('chapters').index('mangaId').getAll(mangaId));
}

export async function deleteChapter(id, mangaId, alsoImages = true) {
  if (libraryMemoryMode) {
    mem.chapters.delete(id);
  } else {
    const db = await libDb();
    await tx(db, 'chapters', 'readwrite', (s) => s.delete(id));
  }
  if (alsoImages) await deleteChapterImages(id);
}

// --- Images (blobs) ---

export async function putImage(chapterId, pageNumber, blob, meta = {}) {
  const key = `${chapterId}/${pageNumber}`;
  if (imageMemoryMode) {
    mem.images.set(key, { key, chapterId, pageNumber, blob, ...meta });
    return;
  }
  const db = await imgDb();
  await tx(db, 'images', 'readwrite', (s) => s.put({ key, chapterId, pageNumber, blob, size: blob.size || 0, ...meta }));
}

export async function getImage(chapterId, pageNumber) {
  const key = `${chapterId}/${pageNumber}`;
  if (imageMemoryMode) return mem.images.get(key) || null;
  const db = await imgDb();
  const t = db.transaction('images', 'readonly');
  return requestToPromise(t.objectStore('images').get(key)).catch(() => null);
}

export async function getChapterImageRecords(chapterId) {
  if (imageMemoryMode) {
    return Array.from(mem.images.values())
      .filter((r) => r.chapterId === chapterId)
      .sort((a, b) => a.pageNumber - b.pageNumber);
  }
  const records = [];
  const db = await imgDb();
  const t = db.transaction('images', 'readonly');
  const req = t.objectStore('images').openCursor(IDBKeyRange.bound(`${chapterId}/0`, `${chapterId}/\uffff`));
  await new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        records.push(cur.value);
        cur.continue();
      } else resolve();
    };
    req.onerror = () => reject(toStorageError(req.error));
  });
  return records.sort((a, b) => a.pageNumber - b.pageNumber);
}

export async function deleteChapterImages(chapterId) {
  if (imageMemoryMode) {
    for (const k of Array.from(mem.images.keys())) if (k.startsWith(`${chapterId}/`)) mem.images.delete(k);
    return;
  }
  const db = await imgDb();
  await new Promise((resolve, reject) => {
    const t = db.transaction('images', 'readwrite');
    const s = t.objectStore('images');
    const req = s.openCursor(IDBKeyRange.bound(`${chapterId}/0`, `${chapterId}/\uffff`));
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        cur.delete();
        cur.continue();
      } else resolve();
    };
    req.onerror = () => reject(toStorageError(req.error));
    t.onabort = () => reject(toStorageError(t.error));
  });
}

/** Estimation du stockage utilisé ({ downloads, origin }) en octets. */
export async function estimateUsage() {
  let downloads = 0;
  if (imageMemoryMode) {
    for (const r of mem.images.values()) downloads += r.blob?.size || 0;
  } else {
    try {
      const records = await allImageSizes();
      downloads = records.reduce((a, b) => a + b, 0);
    } catch {
      if (navigator.storage?.estimate) {
        try {
          const est = await navigator.storage.estimate();
          downloads = est.usage || 0;
        } catch {
          /* ignore */
        }
      }
    }
  }
  let quota = 0;
  if (navigator.storage?.estimate) {
    try {
      const est = await navigator.storage.estimate();
      quota = est.quota || 0;
    } catch {
      /* ignore */
    }
  }
  return { downloads, quota };
}

async function allImageSizes() {
  const db = await imgDb();
  const sizes = [];
  const t = db.transaction('images', 'readonly');
  const req = t.objectStore('images').openCursor();
  await new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        sizes.push(cur.value.size ?? cur.value.blob?.size ?? 0);
        cur.continue();
      } else resolve();
    };
    req.onerror = () => reject(toStorageError(req.error));
  });
  return sizes;
}

/** Vide toute la base images (nettoyage de cache, avec confirmation côté UI). */
export async function clearAllImages() {
  if (imageMemoryMode) {
    mem.images.clear();
    return;
  }
  const db = await imgDb();
  await tx(db, 'images', 'readwrite', (s) => s.clear());
}
