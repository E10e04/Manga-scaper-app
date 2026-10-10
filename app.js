/**
 * app.js — bootstrap de l'application : navigation, vues, actions globales.
 *
 * Vues : accueil / bibliothèque / manga détail / lecture / téléchargements /
 * historique / stockage. La logique métier délègue aux modules src/.
 */
import { startRouter, addRoute, navigate, setNotFound } from './src/ui/Router.js';
import { openModal, closeModal, confirmDialog } from './src/ui/Modal.js';
import { toastSuccess, toastError, toastWarning, toast } from './src/ui/Toast.js';
import * as Components from './src/ui/Components.js';
import { icon, progressBar, badge, coverImage } from './src/ui/Components.js';
import { analyzeManga, addManga, refreshChapters, removeManga, getLibraryEntries, getMangaStats, searchEntries, filterEntries, sortEntries } from './src/library/Library.js';
import * as store from './src/library/LibraryStorage.js';
import { initStorage, isMemoryMode, estimateUsage, clearAllImages, purgeChapterDownloadsSafe } from './src/appStorageBridge.js';
import { getProgress, recentReads } from './src/library/ReadingProgress.js';
import * as Downloads from './src/downloads/DownloadManager.js';
import { Reader } from './src/reader/Reader.js';
import { humanizeError } from './src/utils/errors.js';
import { isValidHttpUrl, escapeHtml, formatBytes, timeAgo, debounce } from './src/utils/helpers.js';

const $app = document.getElementById('view');
let currentReader = null;
let libraryCache = []; // entrées enrichies (rafraîchies à chaque vue)

// ---------------------------------------------------------------------------
// Navigation chrome
// ---------------------------------------------------------------------------

function setActiveNav(path) {
  document.querySelectorAll('[data-nav]').forEach((el) => {
    const active = path.startsWith(el.dataset.nav) || (el.dataset.nav === '/accueil' && (path === '/' || path === '/accueil'));
    el.classList.toggle('is-active', !!active);
    if (active) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
}

// ---------------------------------------------------------------------------
// Vue : Accueil
// ---------------------------------------------------------------------------

async function viewHome() {
  $app.innerHTML = `<div class="page"><section class="home-hero">
      <h1 class="page-title">Bonjour<span class="dot">.</span></h1>
      <p class="page-sub">Plongez dans votre collection.</p>
    </section>
    <section id="secContinue"><h2 class="section-title">${icon('play')} Continuer la lecture</h2><div class="shelf" data-skeleton>${Components.skeletonGrid(4)}</div></section>
    <section id="secRecent"><h2 class="section-title">${icon('plus')} Ajouts récents</h2><div class="shelf" data-skeleton>${Components.skeletonGrid(4)}</div></section>
    <section id="secOffline"><h2 class="section-title">${icon('download')} Disponibles hors ligne</h2><div class="shelf" data-skeleton>${Components.skeletonGrid(4)}</div></section>
  </div>`;

  const entries = await loadLibrary();

  const reading = entries
    .filter((e) => e.progress)
    .sort((a, b) => (b.progress?.updatedAt || 0) - (a.progress?.updatedAt || 0))
    .slice(0, 8);
  const recent = [...entries].sort((a, b) => (b.manga.addedAt || 0) - (a.manga.addedAt || 0)).slice(0, 8);
  const offline = entries.filter((e) => e.downloaded > 0).slice(0, 8);

  renderShelf('#secContinue .shelf', reading, (e) => continueCard(e), 'Aucune lecture en cours', 'Ajoutez un manga et ouvrez votre premier chapitre.');
  renderShelf('#secRecent .shelf', recent, (e) => Components.mangaCard(e), 'Votre bibliothèque est vide', 'Ajoutez votre premier manga pour commencer votre collection.', true);
  renderShelf('#secOffline .shelf', offline, (e) => Components.mangaCard(e), 'Rien en hors ligne', 'Téléchargez des chapitres pour lire sans connexion.');
}

function continueCard(entry) {
  const m = entry.manga;
  const p = entry.progress || {};
  const pct = p.pages > 0 ? Math.round(((p.page || 0) / p.pages) * 100) : entry.percent;
  return `
  <article class="continue-card" data-manga-id="${escapeHtml(m.id)}" tabindex="0" role="link" aria-label="Continuer ${escapeHtml(m.title)}">
    <div class="cover-wrap cover-wrap--sm">${coverImage(m.cover, m.title)}</div>
    <div class="continue-card__body">
      <h3>${escapeHtml(m.title)}</h3>
      <p>${p.chapterNumber != null ? `Chapitre ${escapeHtml(String(p.chapterNumber))}` : 'Prêt à lire'}${p.page ? ` · page ${p.page}/${p.pages}` : ''}</p>
      ${progressBar(pct)}
      <button class="icon-btn continue-card__play" data-action="continue" data-manga="${escapeHtml(m.id)}" aria-label="Continuer la lecture de ${escapeHtml(m.title)}" title="Continuer">${icon('play')}</button>
    </div>
  </article>`;
}

function renderShelf(sel, items, cardFn, emptyTitle, emptyText, withAdd = false) {
  const el = document.querySelector(sel);
  if (!el) return;
  if (!items.length) {
    el.innerHTML = Components.emptyState({ title: emptyTitle, text: emptyText, actionLabel: withAdd ? 'Ajouter un manga' : '', id: 'add' });
    el.classList.add('shelf--empty-inline');
    return;
  }
  el.innerHTML = items.map(cardFn).join('');
}

// ---------------------------------------------------------------------------
// Vue : Bibliothèque
// ---------------------------------------------------------------------------

const libState = { query: '', filter: 'all', sort: 'recently-added' };

async function viewLibrary() {
  $app.innerHTML = `
  <div class="page">
    <header class="page-head">
      <h1 class="page-title">Bibliothèque</h1>
      <div class="toolbar">
        <label class="search">
          ${icon('search')}
          <input type="search" id="libSearch" placeholder="Rechercher un titre, un auteur…" aria-label="Rechercher dans la bibliothèque" value="${escapeHtml(libState.query)}">
        </label>
        <select id="libSort" class="select" aria-label="Trier par">
          <option value="recently-added">Récemment ajouté</option>
          <option value="recently-read">Récemment lu</option>
          <option value="title-asc">Titre A → Z</option>
          <option value="title-desc">Titre Z → A</option>
          <option value="progress">Progression</option>
          <option value="chapters">Nombre de chapitres</option>
        </select>
        <div class="chips" role="group" aria-label="Filtres">
          ${[
            ['all', 'Tous'],
            ['reading', 'En cours'],
            ['completed', 'Terminés'],
            ['downloaded', 'Téléchargés'],
            ['not-downloaded', 'Non téléchargés'],
          ]
            .map(
              ([v, l]) =>
                `<button class="chip ${libState.filter === v ? 'is-active' : ''}" data-filter="${v}" aria-pressed="${libState.filter === v}">${l}</button>`
            )
            .join('')}
        </div>
      </div>
    </header>
    <div class="grid" id="libGrid">${Components.skeletonGrid(10)}</div>
  </div>`;

  const sortSel = document.querySelector('#libSort');
  sortSel.value = libState.sort;
  sortSel.addEventListener('change', () => {
    libState.sort = sortSel.value;
    renderGrid();
  });
  const search = document.querySelector('#libSearch');
  search.addEventListener(
    'input',
    debounce(() => {
      libState.query = search.value;
      renderGrid();
    }, 160)
  );
  document.querySelectorAll('.chip[data-filter]').forEach((c) =>
    c.addEventListener('click', () => {
      libState.filter = c.dataset.filter;
      document.querySelectorAll('.chip[data-filter]').forEach((x) => {
        x.classList.toggle('is-active', x === c);
        x.setAttribute('aria-pressed', String(x === c));
      });
      renderGrid();
    })
  );

  const entries = await loadLibrary();
  renderGrid(entries);

  function renderGrid(pre) {
    const base = pre || libraryCache;
    let list = searchEntries(base, libState.query);
    list = filterEntries(list, libState.filter);
    list = sortEntries(list, libState.sort);
    const grid = document.querySelector('#libGrid');
    if (!grid) return;
    if (!base.length) {
      grid.outerHTML = Components.emptyState({
        title: 'Votre bibliothèque est vide',
        text: 'Ajoutez votre premier manga pour commencer votre collection.',
        actionLabel: 'Ajouter un manga',
        id: 'add',
      });
      return;
    }
    if (!list.length) {
      grid.innerHTML = `<div class="no-results">${icon('search')}<p>Aucun résultat pour «&nbsp;${escapeHtml(libState.query)}&nbsp;» avec ces filtres.</p></div>`;
      return;
    }
    grid.innerHTML = list.map((e) => Components.mangaCard(e)).join('');
  }
}

// ---------------------------------------------------------------------------
// Vue : Détail d'un manga
// ---------------------------------------------------------------------------

async function viewManga({ id }) {
  $app.innerHTML = `<div class="page"><div class="detail-sk">${heroSkeleton()}<div class="sk sk--line"></div><div class="sk sk--line"></div></div></div>`;
  const manga = await store.getManga(id);
  if (!manga) {
    $app.innerHTML = Components.emptyState({ title: 'Manga introuvable', text: 'Il a peut-être été supprimé de votre bibliothèque.' });
    return;
  }
  const stats = await getMangaStats(id);
  const progress = getProgress(id);
  const lastNum = progress?.chapterNumber ?? null;

  $app.innerHTML = `
  <div class="page detail">
    <header class="hero">
      <div class="hero__back"><button class="icon-btn" data-action="back" aria-label="Retour">${icon('back')}</button></div>
      <div class="hero__cover cover-wrap cover-wrap--lg">${coverImage(manga.cover, manga.title, { eager: true })}</div>
      <div class="hero__info">
        <h1 class="hero__title">${escapeHtml(manga.title)}</h1>
        <div class="hero__badges">
          ${badge(manga.source || 'Source', 'source')}
          ${badge(stats.total + ' chapitres', 'neutral')}
          ${manga.status === 'completed' ? badge('Terminé', 'ok') : badge('En cours', 'live')}
          ${stats.downloaded > 0 ? badge(`${stats.downloaded} hors ligne`, 'dl') : ''}
        </div>
        ${manga.author ? `<p class="hero__author">par ${escapeHtml(manga.author)}</p>` : ''}
        ${progressBar(stats.percent, `${stats.read}/${stats.total} chapitres lus`)}
        <p class="hero__last">Dernière lecture : ${lastNum != null ? `Chapitre ${escapeHtml(String(lastNum))}` : '—'}${progress?.page ? ` · page ${progress.page}/${progress.pages}` : ''}${progress?.updatedAt ? ` · ${timeAgo(progress.updatedAt)}` : ''}</p>
        <div class="hero__actions">
          <button class="btn btn--primary" data-action="continue" data-manga="${escapeHtml(id)}">${icon('play')} Continuer</button>
          <button class="btn btn--ghost" data-action="read-from-start" data-manga="${escapeHtml(id)}">Lire depuis le début</button>
          <button class="btn btn--ghost" data-action="download-range" data-manga="${escapeHtml(id)}">${icon('download')} Télécharger…</button>
          <button class="btn btn--ghost" data-action="refresh" data-manga="${escapeHtml(id)}">${icon('refresh')} Actualiser</button>
          <button class="btn btn--danger-ghost" data-action="delete-manga" data-manga="${escapeHtml(id)}">${icon('trash')} Supprimer</button>
        </div>
      </div>
    </header>
    ${manga.description ? `<section class="synopsis"><h2 class="section-title">Synopsis</h2><p>${escapeHtml(manga.description)}</p></section>` : ''}
    <section class="chapters">
      <div class="chapters__head">
        <h2 class="section-title">Chapitres</h2>
        <div class="chapters__tools">
          <label class="check"><input type="checkbox" id="selAll"> <span>Tout sélectionner</span></label>
          <button class="btn btn--sm btn--ghost" data-action="download-selected" data-manga="${escapeHtml(id)}">Télécharger la sélection</button>
        </div>
      </div>
      <ul class="chap-list" id="chapList">${stats.chapters.slice(0, 60).map((c) => Components.chapterRow(c)).join('')}</ul>
      ${stats.chapters.length > 60 ? `<button class="btn btn--ghost btn--wide" id="showMore">Afficher les ${stats.chapters.length - 60} restants</button>` : ''}
    </section>
  </div>`;

  const shown = 60;
  document.querySelector('#showMore')?.addEventListener('click', () => {
    document.querySelector('#chapList').innerHTML = stats.chapters.map((c) => Components.chapterRow(c)).join('');
  });
  document.querySelector('#selAll')?.addEventListener('change', (e) => {
    document.querySelectorAll('.chap input[type="checkbox"]').forEach((cb) => (cb.checked = e.target.checked));
  });
  // ajoute les checkboxes de sélection sur chaque ligne
  document.querySelectorAll('.chap').forEach((li) => {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'chap__check';
    box.setAttribute('aria-label', 'Sélectionner ce chapitre');
    li.prepend(box);
  });
}

function heroSkeleton() {
  return `<div class="hero hero--skeleton"><div class="sk sk--hero-cover"></div><div style="flex:1"><div class="sk sk--title"></div><div class="sk sk--line"></div><div class="sk sk--bar"></div></div></div>`;
}

// ---------------------------------------------------------------------------
// Vue : Lecture (Reader)
// ---------------------------------------------------------------------------

async function viewRead({ chapterId }) {
  destroyReader();
  $app.innerHTML = '<div class="reader-host" id="readerHost"></div>';
  const host = document.getElementById('readerHost');
  currentReader = new Reader(host, decodeURIComponent(chapterId));
  await currentReader.mount();
}

function destroyReader() {
  if (currentReader) {
    currentReader.destroy();
    currentReader = null;
  }
}

// ---------------------------------------------------------------------------
// Vue : Téléchargements
// ---------------------------------------------------------------------------

async function viewDownloads() {
  $app.innerHTML = `
  <div class="page">
    <header class="page-head"><h1 class="page-title">Téléchargements</h1></header>
    <section id="dlActive"></section>
    <section id="dlLibrary"><h2 class="section-title">${icon('offline')} Hors ligne</h2><div class="shelf" data-skeleton>${Components.skeletonGrid(4)}</div></section>
  </div>`;
  renderDownloadState(Downloads.getState());
  const entries = await loadLibrary();
  const offline = entries.filter((e) => e.downloaded > 0);
  const shelf = document.querySelector('#dlLibrary .shelf');
  if (shelf) {
    shelf.innerHTML = offline.length
      ? offline.map((e) => Components.mangaCard(e)).join('')
      : Components.emptyState({ title: 'Aucun contenu hors ligne', text: 'Téléchargez des chapitres depuis la page d’un manga.' });
  }
}

function renderDownloadState(state) {
  const host = document.getElementById('dlActive');
  if (!host) return;
  const tasks = state.queue.filter((t) => !['done'].includes(t.status) || Date.now() - (t.createdAt || 0) < 60_000);
  if (!tasks.length && !state.current) {
    host.innerHTML = '';
    return;
  }
  host.innerHTML = `
    <h2 class="section-title">${icon('download')} File d’attente ${state.pending ? badge(state.pending + ' en attente', 'live') : ''}</h2>
    <ul class="dlist">${tasks
      .map((t) => {
        const pct = t.total > 0 ? Math.round(((t.done + t.failed) / t.total) * 100) : 0;
        const statusBadge =
          t.status === 'running'
            ? badge('En cours', 'live')
            : t.status === 'error'
              ? badge('Erreur', 'err')
              : t.status === 'partial'
                ? badge('Partiel', 'warn')
                : t.status === 'paused'
                  ? badge('En pause', 'warn')
                  : t.status === 'cancelled'
                    ? badge('Annulé', 'neutral')
                    : badge('Terminé', 'ok');
        return `<li class="ditem">
          <div class="ditem__head"><span>${escapeHtml(t.label)}</span>${statusBadge}</div>
          ${progressBar(pct, `${t.done} / ${t.total || '?'} pages`)}
          ${t.error ? `<p class="ditem__err">${escapeHtml(t.error)}</p>` : ''}
          ${['queued', 'running', 'paused'].includes(t.status) ? `<button class="icon-btn ditem__cancel" data-action="cancel-download" data-task="${escapeHtml(t.id)}" aria-label="Annuler">${icon('trash')}</button>` : ''}
        </li>`;
      })
      .join('')}</ul>
    ${tasks.some((t) => ['queued', 'running', 'paused'].includes(t.status)) ? `<button class="btn btn--danger-ghost" data-action="cancel-all-downloads">Tout annuler</button>` : ''}`;
}

Downloads.onStateChange((state) => {
  renderDownloadState(state);
  // Badge nav téléchargements
  const n = state.queue.filter((t) => ['queued', 'running', 'paused'].includes(t.status)).length;
  const dot = document.getElementById('navDlDot');
  if (dot) dot.hidden = n === 0;
});

// ---------------------------------------------------------------------------
// Vue : Historique
// ---------------------------------------------------------------------------

async function viewHistory() {
  $app.innerHTML = `
  <div class="page">
    <header class="page-head"><h1 class="page-title">Historique</h1></header>
    <div id="histList">${Components.skeletonLines(6)}</div>
  </div>`;
  const entries = await loadLibrary();
  const byId = new Map(entries.map((e) => [e.manga.id, e]));
  const reads = recentReads().filter((r) => byId.has(r.mangaId));
  const host = document.getElementById('histList');
  if (!host) return;
  if (!reads.length) {
    host.innerHTML = Components.emptyState({ title: 'Aucune lecture', text: 'Votre historique apparaîtra ici dès que vous ouvrirez un chapitre.' });
    return;
  }
  host.innerHTML = `<ul class="hlist">${reads
    .map((r) => {
      const e = byId.get(r.mangaId);
      return `<li class="hitem" data-manga-id="${escapeHtml(r.mangaId)}" tabindex="0">
        <div class="cover-wrap cover-wrap--xs">${coverImage(e.manga.cover, e.manga.title)}</div>
        <div class="hitem__body">
          <p class="hitem__title">${escapeHtml(e.manga.title)}</p>
          <p class="hitem__meta">${r.chapterNumber != null ? `Chapitre ${escapeHtml(String(r.chapterNumber))}` : '—'}${r.page ? ` · page ${r.page}/${r.pages}` : ''}</p>
        </div>
        <span class="hitem__when">${escapeHtml(timeAgo(r.updatedAt))}</span>
      </li>`;
    })
    .join('')}</ul>`;
}

// ---------------------------------------------------------------------------
// Vue : Stockage
// ---------------------------------------------------------------------------

async function viewStorage() {
  $app.innerHTML = `
  <div class="page">
    <header class="page-head"><h1 class="page-title">Stockage</h1></header>
    <div id="storageBody">${Components.skeletonLines(4)}</div>
  </div>`;
  const { downloads, quota } = await estimateUsage();
  const entries = await loadLibrary();
  const host = document.getElementById('storageBody');
  if (!host) return;
  host.innerHTML = `
    <div class="storage-total">
      <p class="storage-total__num">${formatBytes(downloads)}</p>
      <p class="storage-total__lbl">utilisés${quota ? ` sur ${formatBytes(quota)} disponibles` : ''}</p>
    </div>
    ${Components.storageBar(quota, downloads, 'Téléchargements')}
    ${isMemoryMode() ? `<p class="warn-note">⚠ IndexedDB indisponible : les données sont temporairement en mémoire et seront perdues à la fermeture.</p>` : ''}
    <h2 class="section-title">Par manga</h2>
    <ul class="slist">${entries
      .filter((e) => e.downloaded > 0)
      .map(
        (e) => `<li class="sitem">
          <span>${escapeHtml(e.manga.title)}</span>
          <span class="sitem__meta">${e.downloaded} chapitre(s)</span>
          <button class="btn btn--sm btn--danger-ghost" data-action="purge-manga" data-manga="${escapeHtml(e.manga.id)}">${icon('trash')} Supprimer les fichiers</button>
        </li>`
      )
      .join('') || '<li class="sitem sitem--none">Aucun téléchargement.</li>'}</ul>
    <div class="storage-actions">
      <button class="btn btn--danger-ghost" data-action="clear-cache">${icon('trash')} Vider tout le cache images</button>
    </div>`;
}

// ---------------------------------------------------------------------------
// Vue : Réglages
// ---------------------------------------------------------------------------

async function viewSettings() {
  const native = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const current = native ? '' : (localStorage.getItem('mr_proxy_url') || '').trim();
  $app.innerHTML = `
  <div class="page">
    <header class="page-head"><h1 class="page-title">Réglages</h1></header>
    <section>
      <h2 class="section-title">${icon('download')} ${native ? 'Réseau de l’application' : 'Proxy réseau (optionnel)'}</h2>
      <p class="page-sub" style="margin-bottom:14px">
        ${native
          ? 'Android utilise son accès réseau natif. Aucun ordinateur, serveur externe ou réglage de proxy n’est nécessaire.'
          : 'Sur le Web, le proxy est intégré au serveur local (même origine). Vous pouvez indiquer une autre adresse si l’application est servie autrement.'}
      </p>
      ${native ? '' : `<form id="proxyForm" class="proxy-form">
        <input type="url" id="proxyInput" class="input" inputmode="url" autocomplete="off" spellcheck="false"
               placeholder="(vide = même origine)" value="${escapeHtml(current)}" aria-label="Adresse du proxy" />
        <button class="btn btn--primary" type="submit">Enregistrer</button>
        <button class="btn btn--ghost" type="button" id="proxyClear">Effacer</button>
      </form>`}
      ${native ? '' : `<p class="page-sub" style="margin-top:10px">État actuel : <strong>${current ? escapeHtml(current) : 'proxy intégré'}</strong></p>`}
    </section>
  </div>`;

  const form = document.getElementById('proxyForm');
  const input = document.getElementById('proxyInput');
  form?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const val = (input.value || '').trim().replace(/\/+$/, '');
    if (val && !isValidHttpUrl(val)) return toastError('Adresse invalide. Exemple : http://192.168.1.10:8080');
    if (val) localStorage.setItem('mr_proxy_url', val);
    else localStorage.removeItem('mr_proxy_url');
    toastSuccess(val ? 'Proxy enregistré — vous pouvez relancer une analyse' : 'Proxy retiré');
    viewSettings();
  });
  document.getElementById('proxyClear')?.addEventListener('click', () => {
    localStorage.removeItem('mr_proxy_url');
    toast('Proxy retiré — requêtes directes.');
    viewSettings();
  });
}

// ---------------------------------------------------------------------------
// Actions globales (délégation)
// ---------------------------------------------------------------------------

document.body.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-action], .card, .continue-card, .hitem, [data-manga-id]');
  if (!t) return;

  const action = t.dataset?.action;

  try {
    switch (action) {
      case 'add':
        openAddModal();
        return;
      case 'continue': {
        ev.preventDefault();
        ev.stopPropagation();
        await continueReading(t.dataset.manga || t.closest('[data-manga-id]')?.dataset.mangaId);
        return;
      }
      case 'read-from-start': {
        const chapters = await store.getChaptersForManga(t.dataset.manga);
        const first = [...chapters].sort((a, b) => (a.number ?? 0) - (b.number ?? 0))[0];
        if (!first) return toastWarning('Ce manga n’a pas encore de chapitres lisibles.');
        navigate(`/lecture/${encodeURIComponent(first.id)}`);
        return;
      }
      case 'open-chapter': {
        navigate(`/lecture/${encodeURIComponent(t.dataset.chapter)}`);
        return;
      }
      case 'download-chapter': {
        ev.stopPropagation();
        const ch = await store.getChapter(t.dataset.chapter);
        if (!ch) return toastError('Chapitre introuvable.');
        await Downloads.enqueueChapter(ch);
        toastSuccess('Chapitre ajouté aux téléchargements');
        return;
      }
      case 'download-selected': {
        const mangaId = t.dataset.manga;
        const ids = Array.from(document.querySelectorAll('.chap'))
          .filter((li) => li.querySelector('.chap__check')?.checked)
          .map((li) => li.dataset.chapterId);
        if (!ids.length) return toastWarning('Sélectionnez au moins un chapitre.');
        const chapters = await store.getChaptersForManga(mangaId);
        const picked = chapters.filter((c) => ids.includes(c.id));
        await Downloads.enqueueChapters(picked, (c) => `Chapitre ${c.number ?? '?'}`);
        toastSuccess(`${picked.length} chapitre(s) en file de téléchargement`);
        return;
      }
      case 'download-range': {
        openDownloadRangeModal(t.dataset.manga);
        return;
      }
      case 'refresh': {
        t.disabled = true;
        try {
          const r = await refreshChapters(t.dataset.manga);
          toastSuccess(r.added ? `Actualisation terminée — ${r.added} nouveau(x) chapitre(s)` : 'Déjà à jour — aucun nouveau chapitre');
          libraryCache = null;
          viewManga({ id: t.dataset.manga });
        } catch (err) {
          toastError(humanizeError(err));
        } finally {
          t.disabled = false;
        }
        return;
      }
      case 'delete-manga': {
        const ok = await confirmDialog({
          title: 'Supprimer ce manga ?',
          message: 'Le manga, ses chapitres, ses téléchargements et sa progression seront définitivement supprimés.',
          confirmLabel: 'Supprimer',
        });
        if (!ok) return;
        await removeManga(t.dataset.manga);
        toastSuccess('Manga supprimé de la bibliothèque');
        navigate('/bibliotheque');
        return;
      }
      case 'cancel-download': {
        Downloads.cancel(t.dataset.task);
        toast('Téléchargement annulé', 'info', 2200);
        return;
      }
      case 'cancel-all-downloads': {
        Downloads.cancel();
        toast('File d’attente vidée', 'info', 2200);
        return;
      }
      case 'purge-manga': {
        const ok = await confirmDialog({ title: 'Supprimer les fichiers ?', message: 'Les chapitres téléchargés de ce manga seront retirés du stockage local.' });
        if (!ok) return;
        await purgeChapterDownloadsSafe(t.dataset.manga);
        toastSuccess('Téléchargements supprimés');
        viewStorage();
        return;
      }
      case 'clear-cache': {
        const ok = await confirmDialog({ title: 'Vider tout le cache ?', message: 'Toutes les images téléchargées seront supprimées. Les mangas resteront dans la bibliothèque.' });
        if (!ok) return;
        await clearAllImages();
        await markAllNotDownloaded();
        toastSuccess('Cache vidé');
        viewStorage();
        return;
      }
      case 'back': {
        history.length > 1 ? history.back() : navigate('/');
        return;
      }
      default: {
        // clic carte -> détail
        const mangaId = t.dataset?.mangaId || t.closest('[data-manga-id]')?.dataset.mangaId;
        if (mangaId && !ev.target.closest('button')) {
          navigate(`/manga/${encodeURIComponent(mangaId)}`);
        }
      }
    }
  } catch (err) {
    console.error('[action]', err);
    toastError(humanizeError(err));
  }
});

document.body.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && currentPathIsReader()) return;
  if (e.key !== 'Enter') return;
  const t = e.target.closest('[data-manga-id]');
  if (t) navigate(`/manga/${encodeURIComponent(t.dataset.mangaId)}`);
});

function currentPathIsReader() {
  return location.hash.startsWith('#/lecture/');
}

async function markAllNotDownloaded() {
  const mangas = await store.getAllMangas();
  for (const m of mangas) {
    const chapters = await store.getChaptersForManga(m.id);
    for (const c of chapters) if (c.downloaded) await store.putChapter({ ...c, downloaded: false });
  }
}

async function continueReading(mangaId) {
  if (!mangaId) return;
  const progress = getProgress(mangaId);
  if (progress?.chapterId) {
    const ch = await store.getChapter(progress.chapterId);
    if (ch) return navigate(`/lecture/${encodeURIComponent(ch.id)}`);
  }
  const chapters = await store.getChaptersForManga(mangaId);
  const latest = [...chapters].sort((a, b) => (b.number ?? -1) - (a.number ?? -1))[0];
  if (!latest) return toastWarning('Aucun chapitre disponible pour ce manga.');
  navigate(`/lecture/${encodeURIComponent(latest.id)}`);
}

// ---------------------------------------------------------------------------
// Modal "Ajouter un manga"
// ---------------------------------------------------------------------------

function openAddModal(prefill = '') {
  const form = document.createElement('form');
  form.className = 'add-form';
  form.innerHTML = `
    <label class="field">
      <span class="field__label">Collez l’URL de la page du manga</span>
      <input type="url" name="url" required inputmode="url" autocomplete="off" spellcheck="false"
        placeholder="https://exemple.fr/manga/naruto" value="${escapeHtml(prefill)}">
    </label>
    <p class="field__hint">Sources optimisées : Anime-Sama, SushiScan, Scan-VF — et toute page publique via le mode générique.</p>
    <ol class="asteps" id="asteps" hidden></ol>
    <div class="apreview" id="apreview" hidden></div>
    <button type="submit" class="btn btn--primary btn--wide" id="analyzeBtn">${icon('search')} Analyser</button>`;

  const stepsEl = form.querySelector('#asteps');
  const previewEl = form.querySelector('#apreview');
  const submitBtn = form.querySelector('#analyzeBtn');
  let analysis = null;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = form.url.value.trim();
    if (!isValidHttpUrl(url)) {
      return toastError('Cette URL n’est pas valide. Exemple : https://site.fr/manga/titre');
    }
    analysis = null;
    stepsEl.hidden = false;
    stepsEl.innerHTML = '';
    previewEl.hidden = true;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spin"></span> Analyse en cours…';
    try {
      analysis = await analyzeManga(url, (step) => {
        const li = document.createElement('li');
        li.innerHTML = Components.analysisStep(step);
        // remplace la dernière étape "run" équivalente si même label
        const prev = Array.from(stepsEl.children).find((c) => c.textContent.includes(step.label) && c.querySelector('.astep--run'));
        if (prev) prev.innerHTML = Components.analysisStep(step).replace(/^<li[^>]*>|<\/li>/g, '');
        else stepsEl.insertAdjacentHTML('beforeend', Components.analysisStep(step));
      });
      renderPreview();
    } catch (err) {
      stepsEl.insertAdjacentHTML('beforeend', Components.analysisStep({ label: humanizeError(err), status: 'fail' }));
    } finally {
      // Chaque étape "run" est remplacée par une étape de résultat distincte.
      // Les retirer ici évite de laisser leurs spinners visibles après l'analyse.
      stepsEl.querySelectorAll('.astep--run').forEach((step) => step.remove());
      submitBtn.disabled = false;
      if (analysis) {
        // Le bouton reste dans le formulaire : après l'analyse, il doit agir
        // uniquement comme action d'ajout et ne pas soumettre une 2e analyse.
        submitBtn.type = 'button';
        submitBtn.innerHTML = `${icon('plus')} Ajouter à ma bibliothèque`;
      } else {
        submitBtn.type = 'submit';
        submitBtn.innerHTML = `${icon('search')} Analyser à nouveau`;
      }
    }
  });

  function renderPreview() {
    previewEl.hidden = false;
    previewEl.innerHTML = `
      <div class="apreview__row">
        <div class="cover-wrap cover-wrap--sm">${coverImage(analysis.cover, analysis.title, { eager: true })}</div>
        <div>
          <h3>${escapeHtml(analysis.title)}</h3>
          <p>${badge(analysis.sourceName, 'source')} · ${analysis.chapters.length} chapitre(s) · dernier : Ch. ${escapeHtml(String(analysis.chapters[0]?.number ?? '?'))}</p>
          ${analysis.author ? `<p>Auteur : ${escapeHtml(analysis.author)}</p>` : ''}
        </div>
      </div>
      <p class="apreview__ok">✓ Manga prêt à être ajouté.</p>`;
    submitBtn.innerHTML = `${icon('plus')} Ajouter à ma bibliothèque`;
    submitBtn.type = 'button';
    submitBtn.onclick = async (e) => {
      e.preventDefault();
      submitBtn.disabled = true;
      try {
        await addManga(analysis);
        libraryCache = null;
        closeModal();
        toastSuccess('Manga ajouté à votre bibliothèque');
        navigate(`/manga/${encodeURIComponent(analysis.id)}`);
      } catch (err) {
        toastError(humanizeError(err));
      } finally {
        submitBtn.disabled = false;
      }
    };
  }

  openModal({ title: 'Ajouter un manga', content: form, size: 'md' });
}

// ---------------------------------------------------------------------------
// Modal "Télécharger plusieurs chapitres"
// ---------------------------------------------------------------------------

function openDownloadRangeModal(mangaId) {
  const div = document.createElement('div');
  div.innerHTML = `
    <p class="modal-intro">Choisissez quels chapitres télécharger pour la lecture hors ligne.</p>
    <div class="range-row">
      <label>Depuis le chapitre <input type="number" id="fromNum" min="1" step="1" placeholder="ex. 120" class="input-num"></label>
      <label>jusqu’au <input type="number" id="toNum" min="1" step="1" placeholder="dernier" class="input-num"></label>
    </div>
    <div class="quick-row">
      <button class="btn btn--sm btn--ghost" data-n="5">Les 5 derniers</button>
      <button class="btn btn--sm btn--ghost" data-n="10">Les 10 derniers</button>
      <button class="btn btn--sm btn--ghost" data-n="all">Tous</button>
    </div>`;
  const modal = openModal({
    title: 'Télécharger des chapitres',
    content: div,
    actions: [
      { label: 'Annuler', kind: 'ghost', onClick: () => {} },
      {
        label: 'Lancer le téléchargement',
        kind: 'primary',
        onClick: async () => {
          const chapters = await store.getChaptersForManga(mangaId);
          const sorted = [...chapters].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
          const from = Number(div.querySelector('#fromNum').value) || -Infinity;
          const to = Number(div.querySelector('#toNum').value) || Infinity;
          const picked = sorted.filter((c) => (c.number ?? 0) >= from && (c.number ?? 0) <= to && !c.downloaded);
          if (!picked.length) return toastWarning('Aucun nouveau chapitre dans cette plage.');
          await Downloads.enqueueChapters(picked, (c) => `Chapitre ${c.number ?? '?'}`);
          toastSuccess(`${picked.length} chapitre(s) ajoutés à la file`);
        },
      },
    ],
  });
  div.querySelectorAll('[data-n]').forEach((b) =>
    b.addEventListener('click', async () => {
      const chapters = await store.getChaptersForManga(mangaId);
      const sorted = [...chapters].sort((a, b2) => (b2.number ?? 0) - (a.number ?? 0));
      const picked = (b.dataset.n === 'all' ? sorted : sorted.slice(0, Number(b.dataset.n))).filter((c) => !c.downloaded);
      if (!picked.length) return toastWarning('Tout est déjà téléchargé.');
      await Downloads.enqueueChapters(picked, (c) => `Chapitre ${c.number ?? '?'}`);
      toastSuccess(`${picked.length} chapitre(s) en file`);
      closeModal();
    })
  );
  return modal;
}

// ---------------------------------------------------------------------------
// Cache bibliothèque
// ---------------------------------------------------------------------------

async function loadLibrary() {
  if (!libraryCache) libraryCache = await getLibraryEntries();
  return libraryCache;
}

export function invalidateLibrary() {
  libraryCache = null;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function boot() {
  const res = await initStorage();
  if (res.memoryMode) {
    toastWarning('Stockage persistant indisponible : vos données ne seront pas conservées après fermeture.', 6000);
  }

  // Bouton global "+ Ajouter un manga"
  document.querySelectorAll('[data-open-add]').forEach((b) => b.addEventListener('click', () => openAddModal()));

  // Recherche globale (topbar desktop)
  const gq = document.getElementById('globalSearch');
  gq?.addEventListener(
    'input',
    debounce(() => {
      libState.query = gq.value;
      navigate('/bibliotheque');
    }, 300)
  );

  addRoute('/', viewHome);
  addRoute('/accueil', viewHome);
  addRoute('/bibliotheque', viewLibrary);
  addRoute('/manga/:id', viewManga);
  addRoute('/lecture/:chapterId', viewRead);
  addRoute('/telechargements', viewDownloads);
  addRoute('/historique', viewHistory);
  addRoute('/stockage', viewStorage);
  addRoute('/reglages', viewSettings);
  setNotFound(() => {
    $app.innerHTML = Components.emptyState({ title: 'Page introuvable', text: 'Ce chemin n’existe pas dans l’application.' });
  });

  // Quitte le lecteur proprement quand on navigue ailleurs
  window.addEventListener('hashchange', () => {
    const path = location.hash.replace(/^#/, '') || '/';
    setActiveNav(path);
    if (!path.startsWith('/lecture/')) destroyReader();
  });

  Downloads.resume(); // reprend la file sauvegardée
  startRouter();
  setActiveNav(location.hash.replace(/^#/, '') || '/');

  // PWA
  if ('serviceWorker' in navigator && !window.Capacitor) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /* PWA optionnelle */
      });
    });
  }
}

// Filet de sécurité global : jamais de crash visible.
window.addEventListener('error', (e) => {
  console.error('[app]', e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[app]', e.reason);
  toastError(humanizeError(e.reason));
});

boot();
