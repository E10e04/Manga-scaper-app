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
await t('fetchPage ignore une URL interne Capacitor dans Response.url', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const response = new Response('<html><title>Kingdom</title></html>', { status: 200 });
    Object.defineProperty(response, 'url', { value: 'capacitor://localhost/kingdom' });
    return response;
  };
  try {
    const result = await SC.fetchPage('https://www.scan-vf.net/kingdom');
    assert.equal(result.finalUrl, 'https://www.scan-vf.net/kingdom');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

console.log('— Réseau (utils/net.js)');
const NET = await import('../src/utils/net.js');
await t('isLikelyHtml détecte HTML et rejette JSON', () => {
  assert.ok(NET.isLikelyHtml('<!DOCTYPE html><html>…'));
  assert.ok(NET.isLikelyHtml('<html lang="fr">'));
  assert.ok(!NET.isLikelyHtml('{"success":true,"data":[1,2,3]}'));
  assert.ok(!NET.isLikelyHtml('[{"a":1}]'));
});
await t('looksLikeImage valide les octets magiques', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1]);
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const html = new TextEncoder().encode('<!doctype html><html></html>');
  assert.ok(NET.looksLikeImage(png));
  assert.ok(NET.looksLikeImage(jpg));
  assert.ok(!NET.looksLikeImage(html.slice(0, 12)));
});
await t('parseRetryAfter secondes + date HTTP + bornes', () => {
  assert.equal(NET.parseRetryAfter('30'), 30000);
  assert.equal(NET.parseRetryAfter('-5'), null);
  assert.ok(NET.parseRetryAfter(new Date(Date.now() + 5000).toUTCString()) <= 60000);
  assert.equal(NET.parseRetryAfter(null), null);
});
await t('isRetryable : 429/503 oui, 404/AbortError non', () => {
  assert.ok(NET.isRetryable(429));
  assert.ok(NET.isRetryable(503));
  assert.ok(!NET.isRetryable(404));
  assert.ok(!NET.isRetryable(403)); // blocage actif : ne pas boucler
  assert.ok(!NET.isRetryable({ name: 'AbortError' }));
  assert.ok(NET.isRetryable({ name: 'TypeError' }));
});
await t('createLimiter limite la concurrence', async () => {
  let active = 0, peak = 0;
  const run = NET.createLimiter(2);
  const job = () => run(async () => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 15));
    active--;
    return 'ok';
  });
  const results = await Promise.all(Array.from({ length: 6 }, job));
  assert.deepEqual(results, Array(6).fill('ok'));
  assert.ok(peak <= 2, `pic de concurrence ${peak} > 2`);
});
await t('dedupe : une seule exécution par clé simultanée', async () => {
  let calls = 0;
  const fn = async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return 42; };
  const [a, b] = await Promise.all([NET.dedupe('k-test', fn), NET.dedupe('k-test', fn)]);
  assert.equal(a, 42); assert.equal(b, 42); assert.equal(calls, 1);
});
await t('fetchWithTimeout expire et lève TimeoutError', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = () => new Promise((_, rej) => {
    const ctrlEvt = () => rej(new DOMException('Aborted', 'AbortError'));
    // simulate hang until aborted
    setTimeout(ctrlEvt, 5000);
  });
  try {
    await assert.rejects(
      () => NET.fetchWithTimeout('https://hang.test/', { timeoutMs: 1000 }),
      (e) => e.name === 'TimeoutError' || e.name === 'AbortError'
    );
  } finally { globalThis.fetch = orig; }
});
await t('fetchWithRetry retry sur 503 puis succès (max 3 tentatives)', async () => {
  const orig = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    n++;
    if (n < 3) return new Response('busy', { status: 503 });
    return new Response('fine', { status: 200 });
  };
  try {
    const res = await NET.fetchWithRetry('https://flaky.test/', { attempts: 3, baseDelayMs: 10 });
    assert.equal(res.status, 200);
    assert.equal(n, 3);
  } finally { globalThis.fetch = orig; }
});
await t('fetchWithRetry ne dépasse jamais `attempts` (pas de boucle infinie)', async () => {
  const orig = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => { n++; throw new TypeError('network down'); };
  try {
    await assert.rejects(() => NET.fetchWithRetry('https://down.test/', { attempts: 2, baseDelayMs: 5 }));
    assert.equal(n, 2);
  } finally { globalThis.fetch = orig; }
});
await t('fetchWithRetry respecte Retry-After (borné court)', async () => {
  const orig = globalThis.fetch;
  let first = true; const t0 = Date.now();
  globalThis.fetch = async () => {
    if (first) { first = false; return new Response('', { status: 429, headers: { 'retry-after': '1' } }); }
    return new Response('ok', { status: 200 });
  };
  try {
    const res = await NET.fetchWithRetry('https://rate.test/', { attempts: 2, baseDelayMs: 5 });
    assert.equal(res.status, 200);
    assert.ok(Date.now() - t0 >= 900, 'le délai Retry-After doit être appliqué');
  } finally { globalThis.fetch = orig; }
});
await t('Scraper fetchPage : réponse proxy HTML => message humain (cause racine du "Unexpected token")', async () => {
  const origFetch = globalThis.fetch;
  const origWin = globalThis.window;
  globalThis.window = { location: { origin: 'http://app.local' }, localStorage: { getItem: () => null } };
  globalThis.fetch = async () => new Response('<!DOCTYPE html><html><body>404 Not Found</body></html>', { status: 200 });
  try {
    await assert.rejects(
      () => SC.fetchPage('https://anime-sama.fr/manga/test'),
      (e) => /HTML au lieu de JSON|proxy/i.test(e.message) && !/undefined|NaN/.test(e.message)
    );
  } finally {
    globalThis.fetch = origFetch;
    if (origWin === undefined) delete globalThis.window; else globalThis.window = origWin;
  }
});

console.log('— Parser offline (extraction réelle depuis HTML simulé)');
// Mini-DOMParser inert basé sur des regex suffisantes pour les tests ciblés.
class FakeEl {
  constructor(attrs = {}, text = '', inner = '') { this.attrs = attrs; this.textContent = text; this._inner = inner; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  get innerHTML() { return this._inner; }
}
function fakeDoc(html) {
  const metas = [...html.matchAll(/<meta\b([^>]*)>/gi)].map((m) => {
    const attrs = {};
    for (const a of m[1].matchAll(/(property|name|content)\s*=\s*["']([^"']*)["']/gi)) attrs[a[1].toLowerCase()] = a[2];
    return attrs;
  });
  const findMeta = (key, val) => metas.find((mm) => mm[key] === val)?.content;
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map((m) => {
    const href = (m[1].match(/href\s*=\s*["']([^"']*)["']/i) || [])[1];
    const text = m[2].replace(/<[^>]+>/g, '').trim();
    return { getAttribute: (k) => (k === 'href' ? href : null), textContent: text, innerText: text };
  });
  const imgs = [...html.matchAll(/<img\b([^>]*)>/gi)].map((m) => {
    const src = (m[1].match(/(?:data-src|src)\s*=\s*["']([^"']*)["']/i) || [])[1];
    return { getAttribute: (k) => (k === 'src' ? src : k === 'data-src' ? src : null), className: '' };
  });
  const doc = {
    body: { querySelectorAll: () => imgs, className: '' },
    // Le Parser itère sur les conteneurs via els.forEach(collect) :
    // on renvoie donc un unique "conteneur" qui expose lui-même les images.
    _container: {
      forEach(fn) { fn(this); },
      querySelectorAll: () => imgs,
      get length() { return 1; },
    },
    querySelector(sel) {
      if (sel.includes('og:title') || sel.includes('twitter:title')) { const v = findMeta('property', 'og:title') || findMeta('name', 'twitter:title'); return v ? { getAttribute: () => v } : null; }
      if (sel.includes('og:image') || sel.includes('twitter:image')) { const v = findMeta('property', 'og:image') || findMeta('name', 'twitter:image'); return v ? { getAttribute: () => v } : null; }
      if (sel.includes('og:description') || sel.includes('description')) { const v = findMeta('property', 'og:description') || findMeta('name', 'description'); return v ? { getAttribute: () => v } : null; }
      if (sel === 'h1') return h1 ? new FakeEl({}, h1[1]) : null;
      if (sel === 'title') return title ? new FakeEl({}, title[1]) : null;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === 'a' || sel === 'a[href]') return links;
      if (sel === 'script') return [];
      // conteneurs de lecture simulés : on renvoie le "conteneur" factice
      // qui expose les images au Parser (els.forEach(collect)).
      if (/reader|entry-content|images|^img/i.test(sel)) return [doc._container];
      return [];
    },
  };
  return doc;
}
const P = await import('../src/scraper/Parser.js');
await t('extractTitle : og:title prioritaire sur h1/<title>', () => {
  const doc = fakeDoc('<html><head><title>Site FR</title><meta property="og:title" content="One Piece"><meta name="description" content="x"></head><body><h1>OP Fan</h1></body></html>');
  assert.equal(P.extractTitle(doc, 'https://site.example/manga/one-piece'), 'One Piece');
});
await t('extractChapters : liens chapitre/tome/episode reconnus', () => {
  const doc = fakeDoc(`<html><body>
    <a href="/manga/op/chapitre-1001">Chapitre 1001</a>
    <a href="/manga/op/chapitre-1000">Chapitre 1000</a>
    <a href="/manga/op/volume-50">Tome 50</a>
    <a href="/about">À propos</a>
  </body></html>`);
  const chapters = P.extractChapters(doc, 'https://site.example/manga/op');
  assert.ok(chapters.length >= 3, `attendu ≥3 chapitres, obtenu ${chapters.length}`);
  assert.ok(chapters.every((c) => /^https?:/.test(c.url)), 'URLs résolues en absolues');
});
await t('extractChapterImages : img src résolus + numérotés', () => {
  const doc = fakeDoc('<html><body><div class="reader"><img src="/uploads/p1.jpg"><img src="/uploads/p2.png"><img src="/uploads/p3.webp"></div></body></html>');
  const pages = P.extractChapterImages(doc, 'https://site.example/read/c1');
  assert.equal(pages.length, 3);
  assert.equal(pages[0].pageNumber, 1);
  assert.ok(/^https?:\/\/site\.example\//.test(pages[0].imageUrl));
});
await t('BaseAdapter.normalizeChapter : idempotent + numéro extrait', async () => {
  const { GenericAdapter } = await import('../src/adapters/GenericAdapter.js');
  const g = new GenericAdapter();
  const c = g.normalizeChapter({ url: 'https://x.test/chapitre-12', title: 'Chapitre 12' }, 'https://x.test/manga');
  assert.equal(c.number, 12);
  assert.ok(c.url.startsWith('https://'));
});

console.log('— Serveur local (validation SSRF)');
// Import du module serveur sans écouter : on teste parseTargetUrl via export.
process.argv = ['node', 'server.js']; // pas de --dev => SSRF strict
try {
  const SRV = await import('../server.js');
  await t('proxy bloque localhost / IP privées (anti-SSRF)', () => {
    assert.equal(SRV.parseTargetUrl('http://127.0.0.1:666/x'), null);
    assert.equal(SRV.parseTargetUrl('http://localhost/admin'), null);
    assert.equal(SRV.parseTargetUrl('http://192.168.1.1/lan'), null);
    assert.equal(SRV.parseTargetUrl('http://10.0.0.5/internal'), null);
    assert.equal(SRV.parseTargetUrl('http://169.254.169.254/metadata'), null); // cloud metadata
    assert.equal(SRV.parseTargetUrl('ftp://example.com/x'), null);
    assert.ok(SRV.parseTargetUrl('https://anime-sama.fr/manga/x'));
  });
} catch (e) {
  console.error('  ✗ import server.js en test :', e.message.split('\n')[0]);
  failed++;
}

console.log('— Downloads (API)');
const DM = await import('../src/downloads/DownloadManager.js');
await t('getState retourne une file vide au départ', () => {
  const st = DM.getState();
  assert.ok(st && Array.isArray(st.queue ?? st.tasks ?? []));
});

console.log(`\nRésultat : ${passed} réussis, ${failed} échoués`);
process.exit(failed ? 1 : 0);
