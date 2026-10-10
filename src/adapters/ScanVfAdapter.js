/**
 * Adaptateur Scan-VF (scan-vf.org / scanvf.co…).
 *
 * Structures HTML courantes du site :
 *  - Fiche manga : .serie-header / h1, image .serie-image, liste de chapitres
 *    dans .chapters-list ou un <select> d'episodes.
 *  - Page chapitre : images dans #chapter-images / .reading-content.
 */
import { BaseAdapter } from './BaseAdapter.js';
import { fetchPage, parseHtml } from '../scraper/Scraper.js';
import {
  extractTitle,
  extractCover,
  extractDescription,
  extractAuthor,
  extractStatus,
  extractChapters,
  extractChapterImages,
} from '../scraper/Parser.js';
import { AdapterError } from '../utils/errors.js';
import { resolveUrl, cleanText } from '../utils/helpers.js';
import { safeImageUrl } from '../utils/sanitize.js';

/** Certaines pages Scan-VF concatènent deux URL complètes dans l'attribut src. */
function scanVfImageUrl(raw, baseUrl) {
  const value = String(raw || '').trim();
  const absoluteUrls = value.match(/https?:\/\/[^\s"'<>]+/gi) || [];
  const candidate = absoluteUrls.length ? absoluteUrls[absoluteUrls.length - 1] : value;
  return safeImageUrl(resolveUrl(candidate, baseUrl));
}

export class ScanVfAdapter extends BaseAdapter {
  constructor() {
    super('Scan-VF');
  }

  matches(url) {
    return /scan[-_.]?vf\./i.test(this.host(url));
  }

  async getMangaInfo(url) {
    const { html, finalUrl } = await fetchPage(url);
    const doc = parseHtml(html);
    let title =
      cleanText(doc.querySelector('.serie-header h1, .series-title, h1.page-title')?.textContent) ||
      extractTitle(doc, finalUrl);
    if (!title || /^scanonepiece$/i.test(title) || /^lecture en ligne/i.test(title)) {
      const slug = new URL(finalUrl).pathname.split('/').filter(Boolean).pop() || '';
      title = decodeURIComponent(slug).replace(/[-_]+/g, ' ').replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
    }
    if (!title) throw new AdapterError('Aucun manga identifiable sur cette page Scan-VF.');

    let cover = null;
    const coverImg = doc.querySelector('.serie-image img, .series-cover img, .book img, .row-heading img');
    if (coverImg) cover = resolveUrl(coverImg.getAttribute('src') || coverImg.getAttribute('data-src'), finalUrl);
    if (!cover) cover = extractCover(doc, finalUrl);

    return {
      sourceName: this.name,
      title,
      cover,
      description: extractDescription(doc),
      author: extractAuthor(doc),
      status: extractStatus(doc),
      sourceUrl: finalUrl,
    };
  }

  async getChapters(mangaUrl) {
    const { html, finalUrl } = await fetchPage(mangaUrl);
    const doc = parseHtml(html);

    const chapters = [];
    const seen = new Set();

    // 1) Liste HTML classique
    for (const sel of ['.chapters-list a', '.list-chapter a', 'ul.chapitres a', '.episode-list a', '.list-episodes a']) {
      for (const a of doc.querySelectorAll(sel)) {
        const href = a.getAttribute('href');
        if (!href || /^(javascript|#)/i.test(href)) continue;
        const abs = resolveUrl(href, finalUrl);
        if (seen.has(abs)) continue;
        seen.add(abs);
        chapters.push({ url: abs, title: cleanText(a.textContent) || 'Chapitre' });
      }
      if (chapters.length) break;
    }

    // 2) Repli : <select> d'épisodes (<option value="...">)
    if (!chapters.length) {
      for (const opt of doc.querySelectorAll('select option[value]')) {
        const v = opt.getAttribute('value');
        if (!v || /^(0|-1|)$/i.test(v)) continue;
        const abs = resolveUrl(v, finalUrl);
        if (seen.has(abs)) continue;
        seen.add(abs);
        chapters.push({ url: abs, title: cleanText(opt.textContent) || 'Chapitre' });
      }
    }

    // 3) Repli générique
    if (!chapters.length) {
      return extractChapters(doc, finalUrl).length
        ? extractChapters(doc, finalUrl).map((c) => this.normalizeChapter(c, finalUrl)).filter(Boolean)
        : (() => {
            throw new AdapterError('Aucun chapitre trouvé sur ce manga Scan-VF.');
          })();
    }

    const normalized = chapters.map((c) => this.normalizeChapter(c, finalUrl)).filter(Boolean);
    if (!normalized.length) throw new AdapterError('Aucun chapitre exploitable sur ce manga Scan-VF.');
    const base = new URL(finalUrl);
    const seriesPath = base.pathname.replace(/\/+$/, '');
    const seriesChapters = normalized.filter((c) => {
      try {
        const u = new URL(c.url);
        return u.origin === base.origin && u.pathname.startsWith(`${seriesPath}/`) && /\/(?:chapitre|chapter)[^/]*\d+\/?$/i.test(u.pathname);
      } catch {
        return false;
      }
    });
    const result = seriesChapters.length ? seriesChapters : normalized;
    result.sort((a, b) => (b.number ?? -1) - (a.number ?? -1));
    return result.map((c, i) => ({ ...c, index: i }));
  }

  async getChapterPages(chapter, mangaUrl) {
    const url = typeof chapter === 'string' ? chapter : chapter?.url;
    if (!url) throw new AdapterError('Chapitre invalide : URL manquante.');
    const referer = mangaUrl || url;
    const { html, finalUrl } = await fetchPage(url, { referer });
    const doc = parseHtml(html);

    let pages = [];
    const seenImageUrls = new Set();
    for (const sel of ['img[alt*=" - Page "]', 'img[data-src*="/uploads/manga/"]', 'img.scan-page', '#chapter-images img', '.chapter-images img', '.reading-content img', '#images_lecture img', '.page-break img']) {
      const els = doc.querySelectorAll(sel);
      if (els.length > 0) {
        els.forEach((img, i) => {
          const src = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original') || img.getAttribute('src');
          const imageUrl = scanVfImageUrl(src, finalUrl);
          if (imageUrl && !seenImageUrls.has(imageUrl)) {
            seenImageUrls.add(imageUrl);
            pages.push({ pageNumber: pages.length + 1, imageUrl });
          }
        });
        if (pages.length) break;
      }
    }
    if (pages.length < 2) pages = extractChapterImages(doc, finalUrl);
    if (!pages.length) {
      throw new AdapterError('Les images de ce chapitre Scan-VF n’ont pas pu être localisées.');
    }
    return pages;
  }
}
