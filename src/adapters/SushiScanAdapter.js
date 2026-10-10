/**
 * Adaptateur SushiScan (sushiscan.net / sushiscan.fr).
 *
 * Le site expose généralement une page manga avec un sélecteur de chapitres
 * et des pages de lecture dont les images peuvent être injectées par un
 * script de configuration (mangaReaderConfig / WDParams). L'adaptateur :
 *  - normalise les URLs (le site a changé de schéma plusieurs fois) ;
 *  - analyse les <script> de config sans les exécuter ;
 *  - se replie sur l'extraction générique si besoin.
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

export class SushiScanAdapter extends BaseAdapter {
  constructor() {
    super('SushiScan');
  }

  matches(url) {
    return /sushiscan\./i.test(this.host(url));
  }

  /** Normalise l'URL d'un chapitre (le site utilise ?wpm-u-… ou des query strings). */
  normalizeChapterUrl(url) {
    try {
      const u = new URL(url);
      // Conserve uniquement le chemin canonique ; les paramètres de pagination
      // internes (type `?style=...`) ne changent pas le contenu.
      u.hash = '';
      return u.toString();
    } catch {
      return url;
    }
  }

  async getMangaInfo(url) {
    const { html, finalUrl } = await fetchPage(url);
    const doc = parseHtml(html);
    const title = extractTitle(doc, finalUrl);
    if (!title) throw new AdapterError('Aucun manga identifiable sur cette page SushiScan.');
    return {
      sourceName: this.name,
      title,
      cover: extractCover(doc, finalUrl),
      description: extractDescription(doc),
      author: extractAuthor(doc),
      status: extractStatus(doc),
      sourceUrl: finalUrl,
    };
  }

  async getChapters(mangaUrl) {
    const { html, finalUrl } = await fetchPage(mangaUrl);
    const doc = parseHtml(html);

    // Structures typiques du site (WP Manga Reader / thème custom)
    let chapters = [];
    const seen = new Set();
    for (const sel of ['.list-manga-chapter a', '.chapter-link', 'div.chapter a', '.wp-manga-chapter a']) {
      for (const a of doc.querySelectorAll(sel)) {
        const href = a.getAttribute('href');
        if (!href) continue;
        const abs = this.normalizeChapterUrl(resolveUrl(href, finalUrl));
        if (seen.has(abs)) continue;
        seen.add(abs);
        chapters.push({ url: abs, title: cleanText(a.textContent) || 'Chapitre' });
      }
      if (chapters.length) break;
    }

    // Repli générique
    if (!chapters.length) {
      chapters = extractChapters(doc, finalUrl).map((c) => ({
        url: this.normalizeChapterUrl(c.url),
        title: c.title,
        number: c.number,
      }));
    }

    chapters = chapters.map((c) => this.normalizeChapter(c, finalUrl)).filter(Boolean);
    if (!chapters.length) {
      throw new AdapterError('Aucun chapitre trouvé sur ce manga SushiScan. La page a peut-être changé de structure.');
    }
    chapters.sort((a, b) => (b.number ?? -1) - (a.number ?? -1));
    return chapters.map((c, i) => ({ ...c, index: i }));
  }

  async getChapterPages(chapter, mangaUrl) {
    const url = typeof chapter === 'string' ? chapter : chapter?.url;
    if (!url) throw new AdapterError('Chapitre invalide : URL manquante.');
    const referer = mangaUrl || url;
    const { html, finalUrl } = await fetchPage(url, { referer });
    const doc = parseHtml(html);

    const urls = [];
    const add = (u) => {
      const v = safeImageUrl(u);
      if (v && !urls.includes(v)) urls.push(v);
    };

    // 1) Images classiques (conteneur de lecture)
    const domImages = extractChapterImages(doc, finalUrl);
    domImages.forEach((p) => add(p.imageUrl));

    // 2) Configuration JS du lecteur (mangaReaderConfig.pages = [...] / WDParams)
    if (urls.length < 2) {
      for (const s of doc.querySelectorAll('script')) {
        const code = s.textContent || '';
        if (!/pages|WDParams|mangaReader/i.test(code)) continue;
        for (const m of code.matchAll(/(["'])(https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp|gif)[^"']*)\1/gi)) {
          add(m[2]);
        }
        // Tableaux relatifs : pages: ["01.jpg","02.jpg"] + baseUrl dans la config
        const baseMatch = code.match(/(?:base_?url|baseUrl|url_?root)\s*[:=]\s*(["'])([^"']+)\1/i);
        const arrMatch = code.match(/pages\s*[:=]\s*\[([^\]]*)\]/i);
        if (baseMatch && arrMatch) {
          const base = resolveUrl(baseMatch[2], finalUrl);
          for (const it of arrMatch[1].match(/(["'])((?:https?:\/\/|\/)?[^"']+)\1/g) || []) {
            add(resolveUrl(it.slice(1, -1), base));
          }
        }
      }
    }

    if (!urls.length) {
      throw new AdapterError('Les pages de ce chapitre SushiScan n’ont pas pu être extraites (lecteur incompatible).');
    }
    return urls.map((u, i) => ({ pageNumber: i + 1, imageUrl: u }));
  }
}
