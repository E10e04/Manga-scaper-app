/**
 * Adaptateur générique : fonctionne avec la plupart des sites publics de scans.
 *
 * - Titre : og:title → h1 → <title>
 * - Chapitres : liens contenant chapter / chapitre / episode / volume / tome…
 * - Pages : images dans les conteneurs de lecture standards.
 * Si aucun chapitre n'est détecté, l'erreur est explicite (jamais d'écran vide).
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
import { AdapterError, NotFoundError } from '../utils/errors.js';

export class GenericAdapter extends BaseAdapter {
  constructor() {
    super('Source générique');
  }

  /** L'adaptateur générique accepte toute URL http(s) valide (en dernier recours). */
  matches(_url) {
    return true;
  }

  async getMangaInfo(url) {
    const { html, finalUrl } = await fetchPage(url);
    const doc = parseHtml(html);
    const title = extractTitle(doc, finalUrl);
    if (!title) {
      throw new NotFoundError(
        'Aucun titre trouvé sur cette page. Le lien pointe peut-être vers une catégorie ou une page qui n’est pas une fiche de manga.'
      );
    }
    return {
      sourceName: this.detectSourceName(finalUrl),
      title,
      cover: extractCover(doc, finalUrl),
      description: extractDescription(doc),
      author: extractAuthor(doc),
      status: extractStatus(doc),
      sourceUrl: finalUrl,
    };
  }

  /** Nom de source lisible dérivé du domaine (ex. "mangakakalot.com"). */
  detectSourceName(url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      const base = host.split('.')[0];
      return base.charAt(0).toUpperCase() + base.slice(1);
    } catch {
      return 'Source externe';
    }
  }

  async getChapters(mangaUrl) {
    const { html, finalUrl } = await fetchPage(mangaUrl);
    const doc = parseHtml(html);
    const chapters = extractChapters(doc, finalUrl).map((c) => this.normalizeChapter(c, finalUrl)).filter(Boolean);

    if (!chapters.length) {
      throw new AdapterError(
        'Aucun chapitre détecté sur cette page. Assurez-vous que l’URL est bien la fiche complète du manga (pas un chapitre isolé ou une recherche).'
      );
    }
    return chapters.map((c, i) => ({ ...c, index: i }));
  }

  async getChapterPages(chapter, mangaUrl) {
    const url = typeof chapter === 'string' ? chapter : chapter?.url;
    if (!url) throw new AdapterError('Chapitre invalide : URL manquante.');
    const referer = mangaUrl || url;
    const { html, finalUrl } = await fetchPage(url, { referer });
    const doc = parseHtml(html);

    let pages = extractChapterImages(doc, finalUrl);

    // Repli : scripts de type `pages = [...]`
    if (pages.length < 2) {
      const urls = [];
      for (const s of doc.querySelectorAll('script')) {
        const code = s.textContent || '';
        for (const m of code.matchAll(/(["'])(https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp|gif)[^"']*)\1/gi)) {
          if (!urls.includes(m[2])) urls.push(m[2]);
        }
      }
      pages = urls.map((u, i) => ({ pageNumber: i + 1, imageUrl: u }));
    }

    if (!pages.length) {
      throw new AdapterError(
        'Impossible d’extraire les images de ce chapitre. Le lecteur du site utilise peut-être une technologie non supportée.'
      );
    }
    return pages;
  }
}
