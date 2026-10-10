/**
 * Adaptateur Anime-Sama (anime-sama.fr).
 *
 * Spécificités du site :
 *  - Page manga : /manga/<slug>/ avec titre dans .row-heading, couverture en img.
 *  - Les chapitres sont listés dans #episode-list (liens "Chapitre X" / "épisode X").
 *  - Les pages de lecture ne contiennent PAS d'images directement : elles
 *    injectent un tableau JavaScript `sc高度`/`chapter_imgs` (variables dont le
 *    nom peut varier) via un <script>. On analyse donc les scripts de la page
 *    pour extraire la liste des URLs d'images — sans jamais les exécuter.
 */
import { BaseAdapter } from './BaseAdapter.js';
import { fetchPage, parseHtml } from '../scraper/Scraper.js';
import { extractTitle, extractCover, extractDescription, extractAuthor, extractStatus } from '../scraper/Parser.js';
import { AdapterError, NotFoundError } from '../utils/errors.js';
import { cleanText, resolveUrl, extractChapterNumber } from '../utils/helpers.js';
import { safeImageUrl } from '../utils/sanitize.js';

export class AnimeSamaAdapter extends BaseAdapter {
  constructor() {
    super('Anime-Sama');
  }

  matches(url) {
    return /anime-sama\./i.test(this.host(url));
  }

  async getMangaInfo(url) {
    const { html, finalUrl } = await fetchPage(url);
    const doc = parseHtml(html);
    const title = extractTitle(doc, finalUrl);
    if (!title) throw new NotFoundError('Impossible d’identifier un manga sur cette page Anime-Sama.');

    // Couverture spécifique : .row-heading img ou l'image principale du header
    let cover = null;
    const headImg = doc.querySelector('.row-heading img, .col-div-over img, .col-div-header img');
    if (headImg) cover = safeImageUrl(resolveUrl(headImg.getAttribute('src') || headImg.getAttribute('data-src'), finalUrl));
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
    const push = (href, label) => {
      if (!href || /^(javascript|#|mailto)/i.test(href)) return;
      const abs = resolveUrl(href, finalUrl);
      if (!abs || seen.has(abs)) return;
      const number = extractChapterNumber(label) ?? extractChapterNumber(abs);
      seen.add(abs);
      chapters.push({ url: abs, title: cleanText(label) || `Chapitre ${number ?? '?'}`, number });
    };

    // Structure typique : #episode-list > li > a ("Chapitre 12")
    const list = doc.querySelector('#episode-list, .ep-dtl, .list-ep, .col-div-eps');
    const scope = list || doc;
    for (const a of scope.querySelectorAll('a[href]')) {
      const label = cleanText(a.textContent || '');
      if (/^(chapitre|episode|ep|ch\.?|vol|tome)\b/i.test(label) || /\/(?:manga|saison)-[^/]+\/[^\d]*\d+/i.test(a.getAttribute('href') || '')) {
        if (/chapitre|episode|ep\b|scan/i.test(label) || /chapitre|episode/i.test(a.getAttribute('href') || '')) {
          push(a.getAttribute('href'), label);
        }
      }
    }

    if (!chapters.length) {
      throw new AdapterError(
        'Aucun chapitre détecté sur cette page Anime-Sama. Le lien pointe peut-être vers une fiche sans épisodes publiés.'
      );
    }

    chapters.sort((a, b) => (b.number ?? -1) - (a.number ?? -1));
    return chapters.map((c, i) => ({ ...c, index: i }));
  }

  /**
   * Récupère les images d'un chapitre. Anime-Sama les expose dans un script :
   *   sc高度 = ["https://...jpg", ...];  (ou window.chapImages = [...])
   * On extrait les URLs par regex sur le contenu des <script> — aucun JS n'est exécuté.
   */
  async getChapterPages(chapter, mangaUrl) {
    const url = typeof chapter === 'string' ? chapter : chapter?.url;
    if (!url) throw new AdapterError('Chapitre invalide : URL manquante.');
    const referer = mangaUrl || url;
    const { html, finalUrl } = await fetchPage(url, { referer });
    const doc = parseHtml(html);

    const urls = [];
    const addUrl = (u) => {
      const valid = safeImageUrl(u);
      if (valid && !urls.includes(valid)) urls.push(valid);
    };

    // 1) Analyse des <script> : tableaux littéraux d'URLs d'images
    for (const s of doc.querySelectorAll('script')) {
      const code = s.textContent || '';
      if (!/\.(jpg|jpeg|png|webp|gif)/i.test(code)) continue;
      // Variable type `xxx = [ "url1", "url2" ]`
      const arrayMatches = code.matchAll(/=\s*\[\s*((?:"[^"]+"|'[^']+')\s*(?:,\s*(?:"[^"]+"|'[^']+')\s*)*)\]/g);
      for (const m of arrayMatches) {
        const items = m[1].match(/(["'])((?:https?:\/\/|\/)[^"']+)\1/g) || [];
        for (const it of items) {
          const raw = it.slice(1, -1);
          addUrl(resolveUrl(raw, finalUrl));
        }
      }
      // URLs directes dans le script (hors tableaux)
      const direct = code.matchAll(/(["'])(https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp|gif))\1/gi);
      for (const m of direct) addUrl(m[2]);
    }

    // 2) Repli : balises <img> classiques d'une page de lecture
    if (urls.length < 2) {
      for (const sel of ['#readerarea img', '.entry-content img', '#content img', '.player iframe']) {
        doc.querySelectorAll(sel).forEach((img) => {
          const src = img.getAttribute('src') || img.getAttribute('data-src');
          if (!src || /\.iframe\./i.test(src)) return; // players vidéo, non gérés ici
          addUrl(resolveUrl(src, finalUrl));
        });
        if (urls.length >= 2) break;
      }
    }

    if (!urls.length) {
      throw new AdapterError(
        'Ce contenu Anime-Sama semble être une vidéo (AMV/fanmade) et non un scan d’images, ou le format a changé.'
      );
    }

    return urls.map((u, i) => ({ pageNumber: i + 1, imageUrl: u }));
  }
}
