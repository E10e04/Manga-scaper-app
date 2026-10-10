/**
 * Parser : extraction générique d'informations depuis un document HTML.
 * Utilisé par GenericAdapter et comme repli par les adaptateurs spécifiques.
 */
import { cleanText, resolveUrl, extractChapterNumber } from '../utils/helpers.js';
import { stripHtml, safeImageUrl } from '../utils/sanitize.js';

const CHAPTER_HINTS = /chapter|chapitre|chap[-_. ]?\d|episode|ep[-_. ]?\d|tome|volume|scan|page[-_. ]?manga/i;

/** Titre du manga : og:title → h1 → <title> (nettoyé des suffixes de site). */
export function extractTitle(doc, url) {
  const og = doc.querySelector('meta[property="og:title"], meta[name="twitter:title"]');
  let title = og?.getAttribute('content') || '';

  if (!title) {
    const h1 = doc.querySelector('h1');
    title = h1?.textContent || '';
  }
  if (!title) {
    title = doc.querySelector('title')?.textContent || '';
  }

  // Retire les suffixes courants " | Site", " - Scan VF", etc.
  title = cleanText(title.split(/[|•·]\s/)[0]).replace(/\s*[-–—]\s*(?:fr|vf|scan|manga)\s*$/i, '');
  if (!title) {
    // Dernier recours : dernier segment de l'URL
    try {
      const seg = new URL(url).pathname.split('/').filter(Boolean).pop();
      title = cleanText(decodeURIComponent(seg || '').replace(/[-_]/g, ' '));
    } catch {
      title = '';
    }
  }
  return title;
}

/** Couverture : og:image → image marquée cover/poster → première image plausible. */
export function extractCover(doc, url) {
  const candidates = [];
  const push = (raw) => {
    const u = safeImageUrl(resolveUrl(raw, url));
    if (u && !candidates.includes(u)) candidates.push(u);
  };

  push(doc.querySelector('meta[property="og:image"], meta[name="twitter:image"]')?.getAttribute('content'));
  push(doc.querySelector('[itemprop="image"]')?.getAttribute('content') ||
       doc.querySelector('[itemprop="image"]')?.getAttribute('src'));
  for (const sel of [
    '.row-heading img',           // Anime-Sama
    '.book-cover img',            // MangaInu/SushiScan-like
    '.thumb img',
    '.c-image img',
    'img.cover',
    '#cover img',
    '.page-content img.img-responsive',
  ]) {
    doc.querySelectorAll(sel).forEach((img) => push(img.getAttribute('src') || img.getAttribute('data-src')));
  }
  return candidates[0] || null;
}

/** Description : og:description puis blocs texte dédiés. */
export function extractDescription(doc) {
  const og = doc.querySelector('meta[property="og:description"], meta[name="description"]');
  let desc = og?.getAttribute('content') || '';
  if (!desc) {
    for (const sel of ['.term-description', '.description', '.summary', '.story', '#synopsis', '.card-text']) {
      const el = doc.querySelector(sel);
      if (el?.textContent && el.textContent.trim().length > 20) {
        desc = el.innerHTML;
        break;
      }
    }
  }
  return desc ? stripHtml(desc) : '';
}

/** Auteur(s), quand la source l'expose. */
export function extractAuthor(doc) {
  for (const sel of ['[rel="author"]', '.author a', '.a-card-author', 'a[href*="/auteur"]', '[itemprop="author"]']) {
    const el = doc.querySelector(sel);
    const t = cleanText(el?.textContent || '');
    if (t) return t;
  }
  const rows = doc.querySelectorAll('.series-info li, .info-list li, .profile-in li');
  for (const li of rows) {
    const text = li.textContent || '';
    if (/auteur|author|artiste/i.test(text)) {
      const val = cleanText(text.replace(/^\s*(?:auteur|author|artiste)\s*:?\s*/i, ''));
      if (val) return val;
    }
  }
  return '';
}

/** Statut éditorial ("En cours", "Terminé"…) si exposé. */
export function extractStatus(doc) {
  for (const sel of ['.current', '.status', '.serie-state', '[class*="statut"]']) {
    const el = doc.querySelector(sel);
    const t = cleanText(el?.textContent || '');
    if (/en cours|termin|complete|completed|hiatus|stop/i.test(t)) {
      return /termin|complete/i.test(t) ? 'completed' : 'ongoing';
    }
  }
  return 'ongoing';
}

/**
 * Chapitres : liens dont le texte ou l'URL évoque chapitre/episode/tome.
 * Retourne une liste normalisée, triée du plus récent au plus ancien.
 */
export function extractChapters(doc, baseUrl) {
  const map = new Map(); // url -> chapter

  for (const a of doc.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    if (/^(javascript:|#|mailto:)/i.test(href)) continue;
    const label = cleanText(a.textContent || '') || cleanText(a.getAttribute('title') || '');
    const haystack = `${label} ${href}`;
    if (!CHAPTER_HINTS.test(haystack)) continue;
    // Ignore les liens de navigation de site (catégories vagues type /categories/chapitre)
    if (/\/(categories|genres|tags|list-manga)\b/i.test(href) && !/\d/.test(haystack)) continue;

    const abs = resolveUrl(href, baseUrl);
    if (!abs || abs === baseUrl) continue;
    if (map.has(abs)) {
      // Garde le libellé le plus informatif
      const prev = map.get(abs);
      if (label.length > prev.title.length) prev.title = label;
      continue;
    }
    const number = extractChapterNumber(label) ?? extractChapterNumber(new URL(abs).pathname);
    map.set(abs, {
      url: abs,
      title: label || (number != null ? `Chapitre ${number}` : 'Chapitre'),
      number: number ?? null,
    });
  }

  const chapters = Array.from(map.values());
  // Numérotation implicite : si beaucoup n'ont pas de numéro, attribue selon l'ordre DOM
  chapters.forEach((c, i) => {
    if (c.number == null) c.number = chapters.length - i;
  });
  chapters.sort((a, b) => b.number - a.number);
  return chapters.map((c, i) => ({ ...c, index: i }));
}

/**
 * Pages d'un chapitre : images dans le conteneur de lecture, avec repli sur
 * toutes les images plausibles de la page.
 */
export function extractChapterImages(doc, chapterUrl) {
  const containers = [
    '#readerarea', '.rdv', '.reading-content', '.chapter-content', '.container-chapter-reader',
    '.read-container', '#images', '.images', '.entry-content', '.main-reading-area',
    'div[class*="reader"]', 'section[class*="reader"]',
  ];
  const imgs = [];
  const seen = new Set();
  const collect = (el) => {
    for (const img of el.querySelectorAll('img')) {
      const src =
        img.getAttribute('src') ||
        img.getAttribute('data-src') ||
        img.getAttribute('data-lazy-src') ||
        img.getAttribute('data-original') ||
        '';
      const abs = safeImageUrl(resolveUrl(src, chapterUrl));
      if (!abs || seen.has(abs)) continue;
      // Ignore logos, avatars, petites images décoratives (sur la base de classes)
      const cls = `${img.className || ''} ${img.parentElement?.className || ''}`.toLowerCase();
      if (/logo|avatar|icon|ads|banner|thumb(-|s)?\b|flag/i.test(cls)) continue;
      seen.add(abs);
      imgs.push({ url: abs, alt: cleanText(img.getAttribute('alt') || '') });
    }
  };
  for (const sel of containers) {
    const els = doc.querySelectorAll(sel);
    if (els.length) {
      els.forEach(collect);
      if (imgs.length >= 2) break;
    }
  }
  if (imgs.length < 2) {
    // Repli global : grandes images du corps
    collect(doc.body);
  }
  return imgs.map((im, i) => ({ pageNumber: i + 1, imageUrl: im.url, alt: im.alt }));
}
