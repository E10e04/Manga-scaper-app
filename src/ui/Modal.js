/**
 * Modal — fenêtre modale accessible (focus trap, Échap, aria).
 */
import { escapeHtml } from '../utils/helpers.js';

let activeModal = null;

/**
 * Ouvre une modal.
 * @param {{title:string, content:Node|string, actions?:Array<{label:string, kind?:'primary'|'ghost'|'danger', onClick?:(m)=>any, close?:boolean}>, size?:'sm'|'md'|'lg', dismissible?:boolean}} opts
 * @returns {{close:()=>void, el:HTMLElement, body:HTMLElement}}
 */
export function openModal(opts) {
  closeModal(); // une seule modal à la fois

  const title = String(opts.title ?? '').slice(0, 120);
  const wrap = document.createElement('div');
  wrap.className = 'modal-overlay';
  wrap.innerHTML = `
    <div class="modal modal--${opts.size || 'md'}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <header class="modal__head">
        <h2 class="modal__title">${escapeHtml(title)}</h2>
        ${opts.dismissible === false ? '' : '<button class="modal__close" type="button" aria-label="Fermer">✕</button>'}
      </header>
      <div class="modal__body"></div>
      <footer class="modal__actions"></footer>
    </div>`;

  const bodyEl = wrap.querySelector('.modal__body');
  if (typeof opts.content === 'string') bodyEl.innerHTML = opts.content;
  else bodyEl.appendChild(opts.content);

  const actionsEl = wrap.querySelector('.modal__actions');
  const m = {
    el: wrap,
    body: bodyEl,
    close: () => closeModal(),
  };

  for (const a of opts.actions || []) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn btn--${a.kind || 'ghost'}`;
    btn.textContent = a.label;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const r = a.onClick ? await a.onClick(m) : undefined;
        if (a.close !== false && r !== false) closeModal();
      } finally {
        btn.disabled = false;
      }
    });
    actionsEl.appendChild(btn);
  }
  if (!actionsEl.children.length) actionsEl.remove();

  const closeBtn = wrap.querySelector('.modal__close');
  closeBtn?.addEventListener('click', () => closeModal());
  wrap.addEventListener('mousedown', (e) => {
    if (e.target === wrap && opts.dismissible !== false) closeModal();
  });

  const onKey = (e) => {
    if (e.key === 'Escape' && opts.dismissible !== false) {
      closeModal();
      return;
    }
    if (e.key === 'Tab') trapFocus(e, wrap);
  };
  document.addEventListener('keydown', onKey);
  wrap.__onKey = onKey;

  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('is-open'));

  // Focus initial
  const focusable =
    wrap.querySelector('input, textarea, select') ||
    wrap.querySelector('.btn--primary') ||
    closeBtn ||
    wrap.querySelector('.modal__body');
  setTimeout(() => focusable?.focus(), 60);

  activeModal = m;
  document.body.classList.add('no-scroll');
  return m;
}

export function closeModal() {
  if (!activeModal) return;
  const el = activeModal.el;
  document.removeEventListener('keydown', el.__onKey);
  el.classList.remove('is-open');
  setTimeout(() => el.remove(), 240);
  activeModal = null;
  document.body.classList.remove('no-scroll');
}

export function isModalOpen() {
  return !!activeModal;
}

function trapFocus(e, root) {
  const sel = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
  const items = Array.from(root.querySelectorAll(sel)).filter((i) => i.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/** Confirmation simple avec bouton danger. */
export function confirmDialog({ title, message, confirmLabel = 'Confirmer', danger = true }) {
  return new Promise((resolve) => {
    const div = document.createElement('div');
    div.innerHTML = `<p class="confirm-text">${escapeHtml(message)}</p>`;
    openModal({
      title,
      size: 'sm',
      content: div,
      actions: [
        {
          label: 'Annuler',
          kind: 'ghost',
          onClick: () => resolve(false),
        },
        {
          label: confirmLabel,
          kind: danger ? 'danger' : 'primary',
          onClick: () => resolve(true),
        },
      ],
    });
    // Si fermée sans choix → false
    const obs = new MutationObserver(() => {
      if (!document.body.contains(div)) {
        resolve(false);
        obs.disconnect();
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 15000);
  });
}
