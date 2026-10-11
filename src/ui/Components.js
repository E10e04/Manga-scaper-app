/**
 * Components — briques d'UI réutilisables (rendu HTML en chaînes échappées).
 */
import { escapeHtml, formatBytes, timeAgo } from '../utils/helpers.js';

/** Icônes SVG inline (stroke, cohérentes, 24px viewBox). */
export const icons = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
  library: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="16" rx="1"/><path d="m17.6 5.3 3.1 15.2-4.9-1"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 20h16"/></svg>',
  history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3.5 2"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 5-7 7 7 7"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="m6 7 1 13h10l1-13"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 12.5 5 5 10-11"/></svg>',
  offline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 20h16"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4H6.5A2.5 2.5 0 0 0 4 6.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>',
};

export function icon(name, cls = '') {
  return `<span class="icon ${cls}" aria-hidden="true">${icons[name] || ''}</span>`;
}

/** Progression fine (barre + %). */
export function progressBar(percent, label = '') {
  const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  return `
    <div class="progress" role="progressbar" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100" aria-label="${escapeHtml(label || `Progression : ${p}%`)}">
      <div class="progress__track"><div class="progress__fill" style="width:${p}%"></div></div>
      ${label ? `<span class="progress__label">${escapeHtml(label)}</span>` : `<span class="progress__pct">${p}%</span>`}
    </div>`;
}

/** Badge compact. */
export function badge(text, kind = 'neutral') {
  return `<span class="badge badge--${kind}">${escapeHtml(text)}</span>`;
}

/** Couverture avec lazy loading + squelette + repli typographique. */
export function coverImage(src, alt, { eager = false, cls = '' } = {}) {
  const safeSrc = src && /^(https?:|data:image)/.test(src) ? src : '';
  const initial = eager ? 'loading="eager"' : 'loading="lazy" decoding="async"';
  if (!safeSrc) return fallbackCover(alt, cls);
  return `<img class="cover-img ${cls}" src="${escapeHtml(safeSrc)}" alt="${escapeHtml(alt)}" ${initial} onload="this.closest('.cover-wrap')?.classList.add('is-loaded')" onerror="this.closest('.cover-wrap')?.classList.add('is-broken')">`;
}

function fallbackCover(title, cls) {
  const initials = String(title || '?')
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return `<div class="cover-fallback ${cls}" role="img" aria-label="${escapeHtml(title || 'Sans couverture')}"><span>${escapeHtml(initials)}</span></div>`;
}

/** Carte de manga pour les grilles bibliothèque/accueil. */
export function mangaCard(entry) {
  const m = entry.manga;
  const pct = entry.percent || 0;
  const continueLabel = entry.progress?.chapterNumber != null ? `Ch. ${entry.progress.chapterNumber}` : 'Non commencé';
  return `
  <article class="card" data-manga-id="${escapeHtml(m.id)}" tabindex="0" role="link" aria-label="${escapeHtml(m.title)}">
    <div class="cover-wrap">
      ${coverImage(m.cover, m.title)}
      <div class="card__scrim"></div>
      ${entry.downloaded > 0 ? `<span class="card__offline" title="${entry.downloaded} chapitre(s) hors ligne">${icon('offline')}</span>` : ''}
      <button class="card__continue" data-action="continue" data-manga="${escapeHtml(m.id)}" aria-label="Continuer la lecture de ${escapeHtml(m.title)}" title="Continuer">
        ${icon('play')}
      </button>
    </div>
    <div class="card__body">
      <h3 class="card__title">${escapeHtml(m.title)}</h3>
      <p class="card__meta">${escapeHtml(continueLabel)} · ${entry.total} chapitres</p>
      ${progressBar(pct)}
    </div>
  </article>`;
}

/** Skeleton : carte placeholder. */
export function skeletonCard() {
  return `
  <div class="card card--skeleton" aria-hidden="true">
    <div class="cover-wrap"><div class="sk sk--cover"></div></div>
    <div class="card__body">
      <div class="sk sk--title"></div>
      <div class="sk sk--line"></div>
      <div class="sk sk--bar"></div>
    </div>
  </div>`;
}

export function skeletonGrid(count = 8) {
  return Array.from({ length: count }, skeletonCard).join('');
}

export function skeletonLines(n = 3) {
  return Array.from({ length: n }, () => `<div class="sk sk--line"></div>`).join('');
}

/** État vide générique. */
export function emptyState({ title, text, actionLabel = '', actionIcon = 'plus', id = '' }) {
  return `
  <div class="empty" ${id ? `id="${id}"` : ''}>
    <div class="empty__glyph">${icon('book')}</div>
    <h3 class="empty__title">${escapeHtml(title)}</h3>
    <p class="empty__text">${escapeHtml(text)}</p>
    ${actionLabel ? `<button type="button" class="btn btn--primary" data-action="${escapeHtml(id || 'add')}">${icon(actionIcon)} ${escapeHtml(actionLabel)}</button>` : ''}
  </div>`;
}

/** Ligne de chapitre (page détail manga). */
export function chapterRow(chapter, opts = {}) {
  const num = chapter.number ?? '?';
  const status = chapter.read
    ? `<span class="chap-status chap-status--read">${icon('check')} Lu</span>`
    : chapter.progress > 0 && opts.showProgress !== false
      ? `<span class="chap-status chap-status--partial">${Math.round(chapter.progress * 100)}%</span>`
      : '';
  const dl = chapter.downloaded
    ? `<span class="chap-dl" title="Disponible hors ligne">${icon('offline')}</span>`
    : '';
  const downloadAction = chapter.downloaded
    ? `<button class="icon-btn chap__remove" data-action="delete-chapter-download" data-chapter="${escapeHtml(chapter.id)}" aria-label="Supprimer le téléchargement du chapitre ${escapeHtml(String(num))}" title="Supprimer le téléchargement">${icon('trash')}</button>`
    : `<button class="icon-btn" data-action="download-chapter" data-chapter="${escapeHtml(chapter.id)}" aria-label="Télécharger le chapitre ${escapeHtml(String(num))}" title="Télécharger">${icon('download')}</button>`;
  return `
  <li class="chap" data-chapter-id="${escapeHtml(chapter.id)}">
    <button class="chap__main" data-action="open-chapter" data-chapter="${escapeHtml(chapter.id)}">
      <span class="chap__num">Chapitre ${escapeHtml(String(num))}</span>
      <span class="chap__title">${escapeHtml(chapter.title && chapter.title !== `Chapitre ${num}` ? chapter.title : '')}</span>
    </button>
    <div class="chap__side">
      ${status}${dl}
      ${downloadAction}
    </div>
  </li>`;
}

/** Élément d'état d'une étape d'analyse. */
export function analysisStep({ label, status, detail }) {
  const mark = status === 'ok' ? '✓' : status === 'fail' ? '✕' : '';
  const spin = status === 'run' ? '<span class="spin" aria-hidden="true"></span>' : '';
  return `<li class="astep astep--${status}">${spin}<span class="astep__mark" aria-hidden="true">${mark}</span><span class="astep__label">${escapeHtml(label)}</span></li>`;
}

/** Résumé de stockage. */
export function storageBar(total, used, label) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : Math.min(100, used / 10_000_000);
  return `
  <div class="storage-row">
    <div class="storage-row__head"><span>${escapeHtml(label)}</span><span>${escapeHtml(formatBytes(used))}</span></div>
    <div class="progress__track"><div class="progress__fill" style="width:${pct}%"></div></div>
  </div>`;
}

export { timeAgo };
