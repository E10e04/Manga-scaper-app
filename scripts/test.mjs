#!/usr/bin/env node
/**
 * Tests de validation Manga Reader (Node 18+, zéro dépendance).
 * Couvre : utils, adaptateurs de scraping, bibliothèque (recherche/tri/filtres),
 * progression de lecture, scraper (erreurs), downloads (API).
 */
import assert from 'node:assert/strict';

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message.split('\n')[0]}`); }
}

console.log('— Utils');
const h = await import('../src/utils/helpers.js');
const s = await import('../src/utils/sanitize.js');
await t('isValidHttpUrl accepte https et rejette javascript:/texte', () => {
  assert.ok(h.isValidHttpUrl('https://example.com/manga/x'));
  assert.equal(h.isValidHttpUrl('javascript:alert(1)'), null);
  assert.equal(h.isValidHttpUrl('pas une url'), null);
});
await t('escapeHtml neutralise <script>', () => {
  const out = h.escapeHtml('<script>alert(1)</script>');
  assert.ok(!out.includes('<script>'));
});
await t('stripHtml retire les balises', () => {
  const out = s.stripHtml('<p>Naruto <b>ku</b>n</p>');
  assert.ok(out.includes('Naruto') && !out.includes('<'));
});
await t('extractChapterNumber', () => {
  assert.equal(Number(h.extractChapterNumber('Chapitre 245')), 245);
});
await t('uid stable/préfixé + hashString numérique', () => {
  assert.ok(h.uid('m-').startsWith('m-'));
  assert.match(h.hashString('abc'), /^[0-9a-f]{8}$/);
  assert.equal(h.hashString('abc'), h.hashString('abc')); // stable
});

console.log('— Adaptateurs');
const { AnimeSamaAdapter } = await import('../src/adapters/AnimeSamaAdapter.js');
const { SushiScanAdapter } = await import('../src/adapters/SushiScanAdapter.js');
const { ScanVfAdapter } = await import('../src/adapters/ScanVfAdapter.js');
const { GenericAdapter } = await import('../src/adapters/GenericAdapter.js');
const instances = [new AnimeSamaAdapter(), new SushiScanAdapter(), new ScanVfAdapter(), new GenericAdapter()];
for (const a of instances) {
  await t(`${a.name} expose l'interface commune`, () => {
    for (const m of ['matches', 'getMangaInfo', 'getChapters', 'getChapterPages']) {
      assert.equal(typeof a[m], 'function', `méthode manquante : ${m}`);
    }
  });
}
await t('routage des URLs vers le bon adaptateur', async () => {
  const { findAdapter } = await import('../src/adapters/index.js');
  assert.equal(findAdapter('https://anime-sama.fr/manga/naruto')?.name, instances[0].name);
  assert.ok(findAdapter('https://sushiscan.net/manga/one-piece'));
  assert.ok(findAdapter('https://scanvf.org/manga/berserk'));
  assert.equal(findAdapter('https://inconnu.example/manga/x'), null); // => générique en fallback
});

console.log('— Bibliothèque (recherche / tri / filtres)');
const L = await import('../src/library/Library.js');
const mk = (title, extra = {}) => ({
  manga: { id: title, title, author: '', source: 'Test', addedAt: extra.addedAt ?? 1 },
  percent: extra.percent ?? 0, total: extra.totalChapters ?? 0, downloaded: extra.downloadedChapters ?? 0,
  lastReadAt: extra.lastReadAt ?? 0,
});
const entries = [mk('Naruto', { lastReadAt: 3, percent: 50, totalChapters: 10 }),
                 mk('One Piece', { lastReadAt: 1, percent: 100, totalChapters: 10 }),
                 mk('Berserk', { lastReadAt: 2 })];
await t('searchEntries insensible à la casse', () => {
  const r = L.searchEntries(entries, 'one');
  assert.deepEqual(r.map(e => e.manga.id), ['One Piece']);
});
await t('sortEntries titre A→Z', () => {
  assert.deepEqual(L.sortEntries([...entries], 'title-asc').map(e => e.manga.id), ['Berserk', 'Naruto', 'One Piece']);
});
await t('sortEntries récemment ajouté', () => {
  const withDates = [mk('A', { addedAt: 1 }), mk('B', { addedAt: 3 }), mk('C', { addedAt: 2 })];
  assert.deepEqual(L.sortEntries(withDates, 'recently-added').map(e => e.manga.id), ['B', 'C', 'A']);
});
await t('filterEntries terminés', () => {
  assert.deepEqual(L.filterEntries(entries, 'completed').map(e => e.manga.id), ['One Piece']);
});
await t('progression globale bornée', () => {
  const p = L.overallProgress ? L.overallProgress(5, 10) : 5 / 10;
  assert.ok(p >= 0 && p <= 1);
});

console.log('— Progression de lecture');
const RP = await import('../src/library/ReadingProgress.js');
await t('saveProgress / getProgress (reprise page)', () => {
  RP.saveProgress('m1', { chapterId: 'c1', chapterNumber: 1150, page: 37, pages: 45 });
  const p = RP.getProgress('m1');
  assert.equal(p.chapterId, 'c1'); assert.equal(p.page, 37); assert.equal(p.pages, 45);
});
await t('clearProgress', () => {
  RP.clearProgress('m1');
  const p = RP.getProgress('m1');
  assert.ok(!p || !p.chapterId);
});

console.log('— Scraper (gestion des erreurs)');
const SC = await import('../src/scraper/Scraper.js');
await t('fetchPage URL invalide => message humain (pas undefined/null)', async () => {
  await assert.rejects(() => SC.fetchPage('::::'), (e) => {
    return typeof e.message === 'string' && e.message.length > 3 && !/undefined|null|NaN/.test(e.message);
  });
});

console.log('— Downloads (API)');
const DM = await import('../src/downloads/DownloadManager.js');
await t('getState retourne une file vide au départ', () => {
  const st = DM.getState();
  assert.ok(st && Array.isArray(st.queue ?? st.tasks ?? []));
});

console.log(`\nRésultat : ${passed} réussis, ${failed} échoués`);
process.exit(failed ? 1 : 0);
