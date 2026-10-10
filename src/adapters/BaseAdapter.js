/**
 * Contrat commun de tous les adaptateurs de sources.
 *
 * Un adaptateur expose :
 *   name        : nom affiché de la source
 *   matches(url): booléen — ce site est-il géré par cet adaptateur ?
 *   getMangaInfo(url)     → { title, cover, description, author, status, sourceUrl }
 *   getChapters(mangaUrl) → [{ url, number, title }] (trié du plus récent au plus ancien)
 *   getChapterPages(chapter, mangaUrl) → [{ pageNumber, imageUrl }]
 *   normalizeChapter(raw) → chapitre normalisé
 */
import { AdapterError } from '../utils/errors.js';
import { extractChapterNumber, resolveUrl, cleanText } from '../utils/helpers.js';

export class BaseAdapter {
  constructor(name) {
    if (new.target === BaseAdapter) {
      throw new Error('BaseAdapter est une classe abstraite.');
    }
    this.name = name;
  }

  /** @param {string} _url */
  matches(_url) {
    return false;
  }

  async getMangaInfo(_url) {
    throw new AdapterError(`${this.name} : récupération d’informations non implémentée.`);
  }

  async getChapters(_mangaUrl) {
    throw new AdapterError(`${this.name} : récupération des chapitres non implémentée.`);
  }

  async getChapterPages(_chapter, _mangaUrl) {
    throw new AdapterError(`${this.name} : récupération des pages non implémentée.`);
  }

  /** Normalise un chapitre brut { url, title?, number? }. */
  normalizeChapter(raw, baseUrl) {
    if (!raw || !raw.url) return null;
    const url = resolveUrl(raw.url, baseUrl || raw.url);
    const title = cleanText(raw.title || '') || 'Chapitre';
    let number = Number.isFinite(raw.number) ? raw.number : null;
    if (number == null) number = extractChapterNumber(title) ?? extractChapterNumber(url);
    return { url, title, number };
  }

  /** Hostname d'une URL, ou chaîne vide. */
  host(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      return '';
    }
  }
}
