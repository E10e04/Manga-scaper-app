/**
 * Reader — lecteur immersif vertical (webtoon-style).
 *
 * - lazy loading via IntersectionObserver : seules les pages proches du
 *   viewport sont montées dans le DOM ;
 * - préchargement intelligent des pages suivantes ;
 * - sauvegarde automatique de la progression (scroll + visibilité) ;
 * - navigation chapitre précédent/suivant, indicateur page X/Y ;
 * - paramètres live (largeur, espacement, zoom, plein écran, auto-hide UI).
 */
import * as store from '../library/LibraryStorage.js';
import { findAdapter, getGenericAdapter } from '../adapters/index.js';
import { saveChapterPages, resolvePageUrl, releasePageUrl, releaseChapterUrls } from '../downloads/OfflineStorage.js';
import { enqueueChapter } from '../downloads/DownloadManager.js';
import { getSettings, setSetting } from './ReaderSettings.js';
import { saveProgress, getProgress } from '../library/ReadingProgress.js';
import { humanizeError } from '../utils/errors.js';
import { escapeHtml } from '../utils/helpers.js';
import { toast, toastError, toastSuccess, toastWarning } from '../ui/Toast.js';
import { navigate } from '../ui/Router.js';

const PREFETCH = 3; // pages préchargées autour du viewport

export class Reader {
  /**
   * @param {HTMLElement} host conteneur plein écran
   * @param {{chapterId:string}} params
   */
  constructor(host, chapterId) {
    this.host = host;
    this.chapterId = chapterId;
    this.chapter = null;
    this.manga = null;
    this.pages = []; // [{pageNumber, imageUrl}]
    this.total = 0;
    this.observer = null;
    this.hideTimer = null;
    this.saveTimer = null;
    this.lastVisible = 1;
    this.destroyed = false;
    this._onScroll = this._onScroll.bind(this);
    this._onKey = this._onKey.bind(this);
    this._onVis = this._onVis.bind(this);
    this._onSettings = this._onSettings.bind(this);
  }

  async mount() {
    this.host.innerHTML = `
      <div class="reader" aria-busy="true">
        <header class="reader__topbar" id="readerTop">
          <button class="icon-btn" id="rdBack" aria-label="Retour au manga">${'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 5-7 7 7 7"/></svg>'}</button>
          <div class="reader__title-wrap">
            <p class="reader__manga" id="rdMangaTitle">…</p>
            <p class="reader__chap" id="rdChapterLabel">Chargement…</p>
          </div>
          <div class="reader__actions">
            <span class="reader__pager" id="rdPager">— / —</span>
            <button class="icon-btn" id="rdDownload" aria-label="Télécharger ce chapitre" title="Télécharger pour lecture hors ligne"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 20h16"/></svg></button>
            <button class="icon-btn" id="rdSettings" aria-label="Paramètres du lecteur" title="Paramètres"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M4 7h16M4 12h16M4 17h16" opacity="0"/></svg></button>
          </div>
        </header>
        <div class="reader__settings" id="rdSettingsPanel" hidden></div>
        <main class="reader__scroll" id="rdScroll" tabindex="-1">
          <div class="reader__pages" id="rdPages"></div>
          <div class="reader__loading" id="rdLoading">${Array.from({ length: 3 }, () => '<div class="sk sk--page"></div>').join('')}</div>
        </main>
        <nav class="reader__bottombar" id="readerBottom">
          <button class="btn btn--ghost" id="rdPrev" disabled>← Chapitre précédent</button>
          <button class="btn btn--ghost" id="rdNext" disabled>Chapitre suivant →</button>
        </nav>
      </div>`;

    this.el = {
      root: this.host.querySelector('.reader'),
      top: this.host.querySelector('#readerTop'),
      bottom: this.host.querySelector('#readerBottom'),
      scroll: this.host.querySelector('#rdScroll'),
      pages: this.host.querySelector('#rdPages'),
      loading: this.host.querySelector('#rdLoading'),
      pager: this.host.querySelector('#rdPager'),
      mangaTitle: this.host.querySelector('#rdMangaTitle'),
      chapLabel: this.host.querySelector('#rdChapterLabel'),
      settingsPanel: this.host.querySelector('#rdSettingsPanel'),
      prev: this.host.querySelector('#rdPrev'),
      next: this.host.querySelector('#rdNext'),
    };

    this.el.root.addEventListener('click', (e) => {
      // clic en dehors des barres : toggle UI si autoHide
      if (!e.target.closest('.reader__topbar, .reader__bottombar, .reader__settings')) {
        this.toggleUi();
      }
    });
    this.el.scroll.addEventListener('scroll', this._onScroll, { passive: true });
    this.host.querySelector('#rdBack').addEventListener('click', () => this.close());
    this.host.querySelector('#rdDownload').addEventListener('click', () => this.downloadCurrent());
    this.host.querySelector('#rdSettings').addEventListener('click', () => this.toggleSettings());
    this.el.prev.addEventListener('click', () => this.goSibling(-1));
    this.el.next.addEventListener('click', () => this.goSibling(1));
    document.addEventListener('keydown', this._onKey);
    document.addEventListener('visibilitychange', this._onVis);
    window.addEventListener('reader-settings-changed', this._onSettings);

    await this.loadChapter(this.chapterId);
  }

  async loadChapter(chapterId) {
    try {
      const chapter = await store.getChapter(chapterId);
      if (!chapter) throw new Error('Ce chapitre est introuvable dans votre bibliothèque.');
      const manga = await store.getManga(chapter.mangaId);
      if (!manga) throw new Error('Le manga associé est introuvable.');
      this.chapter = chapter;
      this.manga = manga;

      this.el.mangaTitle.textContent = manga.title;
      this.el.chapLabel.textContent = `Chapitre ${chapter.number ?? '?'}`;
      document.title = `Ch. ${chapter.number ?? '?'} — ${manga.title}`;

      // Récupère les URLs de pages si nécessaire
      let working = chapter;
      if (!working.pages || working.pages.length === 0) {
        const adapter = findAdapter(manga.sourceUrl) || getGenericAdapter();
        let pages;
        try {
          pages = await adapter.getChapterPages(working, manga.sourceUrl);
        } catch (err) {
          if (findAdapter(manga.sourceUrl)) {
            pages = await getGenericAdapter().getChapterPages(working, manga.sourceUrl);
          } else {
            throw new Error(humanizeError(err));
          }
        }
        if (!pages.length) throw new Error('Ce chapitre ne contient aucune page lisible.');
        working = await saveChapterPages(working, pages);
        this.chapter = working;
      }

      this.pages = working.pages.map((u, i) => ({ pageNumber: i + 1, imageUrl: u }));
      this.total = this.pages.length;
      this.renderSkeletons();
      this.setupObserver();
      this.applySettings();

      // Siblings
      const siblings = await this.getSiblings();
      this.el.prev.disabled = !siblings.prev;
      this.el.next.disabled = !siblings.next;
      this.siblings = siblings;

      // Reprise de position si même chapitre
      const progress = getProgress(manga.id);
      const startPage = progress?.chapterId === chapterId && progress.page > 0 ? progress.page : 1;
      requestAnimationFrame(() => this.scrollToPage(startPage, false));
      this.updatePager(startPage);
    } catch (err) {
      toastError(humanizeError(err));
      this.el.loading.innerHTML = `<div class="reader__error"><p>${escapeHtml(humanizeError(err))}</p><button class="btn btn--primary" id="rdRetry">Réessayer</button></div>`;
      this.el.loading.querySelector('#rdRetry')?.addEventListener('click', () => this.loadChapter(this.chapterId));
    }
  }

  renderSkeletons() {
    this.el.pages.innerHTML = '';
    for (let i = 1; i <= this.total; i++) {
      const slot = document.createElement('div');
      slot.className = 'page-slot';
      slot.dataset.page = String(i);
      slot.style.minHeight = '60vh';
      this.el.pages.appendChild(slot);
    }
    this.el.loading.hidden = true;
    this.host.setAttribute('aria-busy', 'false');
  }

  setupObserver() {
    this.observer?.disconnect();
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const slot = entry.target;
          const pageNum = Number(slot.dataset.page);
          if (entry.isIntersecting) {
            this.mountPage(slot, pageNum);
            this.preloadNear(pageNum);
          } else if (slot.__mounted && Math.abs(entry.boundingClientRect.top) > window.innerHeight * 4) {
            this.unmountPage(slot); // libère la mémoire des pages très éloignées
          }
        }
      },
      { root: this.el.scroll, rootMargin: `${window.innerHeight}px 0px` }
    );
    this.el.pages.querySelectorAll('.page-slot').forEach((s) => this.observer.observe(s));
  }

  /** Insère l'<img> dans un slot (une seule fois). */
  async mountPage(slot, pageNum) {
    if (slot.__mounted || slot.__mounting) return;
    slot.__mounting = true;
    try {
      const url = await resolvePageUrl(this.chapter, pageNum);
      if (this.destroyed) return;
      if (!url) throw new Error('no-url');
      const img = document.createElement('img');
      img.className = 'page-img';
      img.alt = `Page ${pageNum}`;
      img.decoding = 'async';
      img.src = url;
      img.addEventListener('load', () => {
        slot.classList.add('is-loaded');
        slot.style.minHeight = '';
      });
      img.addEventListener('error', () => {
        slot.classList.add('is-failed');
        slot.innerHTML = `<div class="page-fail"><span>Image indisponible (page ${pageNum})</span><button data-retry="${pageNum}">Réessayer</button></div>`;
        slot.querySelector('button')?.addEventListener('click', () => {
          slot.innerHTML = '';
          slot.classList.remove('is-failed');
          slot.__mounted = false;
          this.mountPage(slot, pageNum);
        });
      });
      slot.innerHTML = '';
      slot.appendChild(img);
      slot.__mounted = true;
      slot.__img = img;
    } catch {
      slot.classList.add('is-failed');
      slot.innerHTML = `<div class="page-fail"><span>Impossible d’afficher la page ${pageNum}</span></div>`;
    } finally {
      slot.__mounting = false;
    }
  }

  unmountPage(slot) {
    if (slot.__img) {
      slot.__img.removeAttribute('src');
    }
    releasePageUrl(this.chapter.id, Number(slot.dataset.page));
    slot.innerHTML = '';
    slot.__mounted = false;
    slot.style.minHeight = '60vh';
  }

  preloadNear(pageNum) {
    for (let p = pageNum + 1; p <= Math.min(this.total, pageNum + PREFETCH); p++) {
      const slot = this.el.pages.children[p - 1];
      if (slot && !slot.__mounted) this.warmUrl(p);
    }
  }

  async warmUrl(pageNum) {
    try {
      await resolvePageUrl(this.chapter, pageNum);
    } catch {
      /* best effort */
    }
  }

  _onScroll() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.recordPosition(), 400);
    this.updateActivePager();
    this.nudgeUi();
  }

  updateActivePager() {
    const page = this.computeCurrentPage();
    if (page !== this.lastVisible) {
      this.lastVisible = page;
      this.updatePager(page);
    }
  }

  computeCurrentPage() {
    const rect = this.el.scroll.getBoundingClientRect();
    const mid = rect.top + rect.height * 0.35;
    let current = 1;
    for (const slot of this.el.pages.children) {
      if (slot.getBoundingClientRect().top <= mid) current = Number(slot.dataset.page) || current;
      else break;
    }
    return current;
  }

  updatePager(page) {
    this.el.pager.textContent = `${Math.max(1, page)} / ${this.total}`;
  }

  scrollToPage(page, smooth = true) {
    const slot = this.el.pages.children[page - 1];
    if (slot) slot.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  }

  recordPosition() {
    if (!this.chapter || this.destroyed) return;
    const page = this.computeCurrentPage();
    const pct = this.total > 0 ? Math.min(1, page / this.total) : 0;
    saveProgress(this.manga.id, {
      chapterId: this.chapter.id,
      chapterNumber: this.chapter.number,
      page,
      pages: this.total,
    });
    // statut lu quand quasi-fin + maj progression chapitre
    const done = pct >= 0.95;
    store
      .putChapter({ ...this.chapter, progress: pct, read: this.chapter.read || done, lastReadAt: Date.now() })
      .then((c) => (this.chapter = c))
      .catch(() => {});
  }

  _onVis() {
    if (document.hidden) this.recordPosition();
  }

  _onKey(e) {
    if (e.target.matches('input, textarea, select')) return;
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        this.scrollBy(0.85);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        this.scrollBy(-0.85);
        break;
      case 'n':
        this.goSibling(1);
        break;
      case 'p':
        this.goSibling(-1);
        break;
      case 'f':
        this.toggleFullscreen();
        break;
      case 'Escape':
        this.close();
        break;
      default:
    }
  }

  scrollBy(factor) {
    this.el.scroll.scrollBy({ top: this.el.scroll.clientHeight * factor, behavior: 'smooth' });
  }

  async goSibling(dir) {
    const target = dir === 1 ? this.siblings?.next : this.siblings?.prev;
    if (!target) {
      toastInfoNoop(dir);
      return;
    }
    this.recordPosition();
    releaseChapterUrls(this.chapter.id);
    navigate(`/lecture/${encodeURIComponent(target.id)}`);
  }

  async getSiblings() {
    const chapters = await store.getChaptersForManga(this.manga.id);
    const sorted = [...chapters].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
    const idx = sorted.findIndex((c) => c.id === this.chapter.id);
    return { prev: idx > 0 ? sorted[idx - 1] : null, next: idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : null };
  }

  downloadCurrent() {
    if (!this.chapter) return;
    enqueueChapter(this.chapter, { label: `${this.manga.title} — Ch. ${this.chapter.number ?? '?'}` });
    toastSuccess('Chapitre ajouté aux téléchargements');
  }

  // ------------------------------------------------------------------ UI chrome
  toggleUi(force) {
    const show = force ?? !(this.el.top.classList.contains('is-hidden'));
    this.el.top.classList.toggle('is-hidden', !show);
    this.el.bottom.classList.toggle('is-hidden', !show);
    this.el.root.classList.toggle('ui-hidden', !show);
  }

  nudgeUi() {
    const s = getSettings();
    if (!s.autoHideControls || !s.showUi) return;
    this.toggleUi(true);
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.toggleUi(false), 2600);
  }

  toggleSettings() {
    const panel = this.el.settingsPanel;
    if (panel.hidden) {
      this.renderSettingsPanel();
      panel.hidden = false;
    } else {
      panel.hidden = true;
    }
  }

  renderSettingsPanel() {
    const s = getSettings();
    this.el.settingsPanel.innerHTML = `
      <div class="rs-row">
        <label for="rsWidth">Largeur max. des pages</label>
        <div class="rs-control"><input type="range" id="rsWidth" min="360" max="1600" step="20" value="${s.maxWidth}"><output>${s.maxWidth}px</output></div>
      </div>
      <div class="rs-row">
        <label for="rsGap">Espacement entre pages</label>
        <div class="rs-control"><input type="range" id="rsGap" min="0" max="48" step="2" value="${s.gap}"><output>${s.gap}px</output></div>
      </div>
      <div class="rs-row">
        <label for="rsZoom">Zoom</label>
        <div class="rs-control"><input type="range" id="rsZoom" min="50" max="200" step="5" value="${s.zoom}"><output>${s.zoom}%</output></div>
      </div>
      <div class="rs-row rs-row--switches">
        <label><input type="checkbox" id="rsFull" ${s.fullwidth ? 'checked' : ''}> Pleine largeur</label>
        <label><input type="checkbox" id="rsAuto" ${s.autoHideControls ? 'checked' : ''}> Masquer auto. les contrôles</label>
        <label><input type="checkbox" id="rsFs" ${s.fullscreen ? 'checked' : ''}> Mode plein écran</label>
      </div>
      <div class="rs-row rs-row--select">
        <label for="rsOrient">Orientation</label>
        <select id="rsOrient">
          <option value="auto">Automatique</option>
          <option value="portrait">Portrait</option>
          <option value="landscape">Paysage</option>
        </select>
      </div>`;

    const bind = (id, evt, fn) => this.el.settingsPanel.querySelector(id)?.addEventListener(evt, fn);
    bind('#rsWidth', 'input', (e) => {
      setSetting('maxWidth', Number(e.target.value));
      e.target.nextElementSibling.value = `${e.target.value}px`;
    });
    bind('#rsGap', 'input', (e) => {
      setSetting('gap', Number(e.target.value));
      e.target.nextElementSibling.value = `${e.target.value}px`;
    });
    bind('#rsZoom', 'input', (e) => {
      setSetting('zoom', Number(e.target.value));
      e.target.nextElementSibling.value = `${e.target.value}%`;
    });
    bind('#rsFull', 'change', (e) => setSetting('fullwidth', e.target.checked));
    bind('#rsAuto', 'change', (e) => setSetting('autoHideControls', e.target.checked));
    bind('#rsFs', 'change', (e) => {
      setSetting('fullscreen', e.target.checked);
      this.toggleFullscreen(e.target.checked);
    });
    bind('#rsOrient', 'change', async (e) => {
      try {
        if (screen.orientation?.lock && e.target.value !== 'auto') {
          await screen.orientation.lock(e.target.value);
        } else if (screen.orientation?.unlock) {
          screen.orientation.unlock();
        }
      } catch {
        toastWarning('Orientation non supportée par cet appareil.');
      }
    });
  }

  _onSettings() {
    this.applySettings();
  }

  applySettings() {
    const s = getSettings();
    const root = this.el.root;
    root.style.setProperty('--page-max', s.fullwidth ? '100%' : `${s.maxWidth}px`);
    root.style.setProperty('--page-gap', `${s.gap}px`);
    root.style.setProperty('--page-zoom', String(s.zoom / 100));
    root.classList.toggle('fit-original', s.fitMode === 'original');
    if (!s.showUi) this.toggleUi(false);
    else this.toggleUi(true);
  }

  toggleFullscreen(force) {
    const want = force ?? !document.fullscreenElement;
    try {
      if (want) document.documentElement.requestFullscreen?.();
      else document.exitFullscreen?.();
    } catch {
      toastWarning('Le mode plein écran n’est pas disponible ici.');
    }
  }

  close() {
    this.recordPosition();
    this.destroy();
    navigate(`/manga/${encodeURIComponent(this.manga?.id || '')}`);
  }

  destroy() {
    this.destroyed = true;
    this.recordPosition();
    clearTimeout(this.hideTimer);
    clearTimeout(this.saveTimer);
    this.observer?.disconnect();
    document.removeEventListener('keydown', this._onKey);
    document.removeEventListener('visibilitychange', this._onVis);
    window.removeEventListener('reader-settings-changed', this._onSettings);
    if (this.chapter) releaseChapterUrls(this.chapter.id);
    document.title = 'Manga Reader';
  }
}

function toastInfoNoop(dir) {
  toast(dir === 1 ? 'Ceci est le dernier chapitre.' : 'Ceci est le premier chapitre.', 'info', 2200);
}
