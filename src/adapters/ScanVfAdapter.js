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
    const title =
      cleanText(doc.querySelector('.serie-header h1, .series-title, h1.page-title')?.textContent) ||
      extractTitle(doc, finalUrl);
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
    normalized.sort((a, b) => (b.number ?? -1) - (a.number ?? -1));
    return normalized.map((c, i) => ({ ...c, index: i }));
  }

  async getChapterPages(chapter, mangaUrl) {
    const url = typeof chapter === 'string' ? chapter : chapter?.url;
    if (!url) throw new AdapterError('Chapitre invalide : URL manquante.');
    const referer = mangaUrl || url;
    const { html, finalUrl } = await fetchPage(url, { referer });
    const doc = parseHtml(html);

    let pages = [];
    for (const sel of ['#chapter-images img', '.chapter-images img', '.reading-content img', '#images_lecture img', '.page-break img']) {
      const els = doc.querySelectorAll(sel);
      if (els.length >= 2) {
        els.forEach((img, i) => {
          const src = img.getAttribute('src') || img.getAttribute('data-src');
          if (src) pages.push({ pageNumber: i + 1, imageUrl: resolveUrl(src, finalUrl) });
        });
        break;
      }
    }
    if (pages.length < 2) pages = extractChapterImages(doc, finalUrl);
    if (!pages.length) {
      throw new AdapterError('Les images de ce chapitre Scan-VF n’ont pas pu être localisées.');
    }
    return pages;
  }
}
