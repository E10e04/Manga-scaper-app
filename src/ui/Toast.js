/**
 * Toast — notifications élégantes et non intrusives.
 * Types : success | warning | error | info. Empilées en bas (mobile) / haut-droite (desktop).
 */
const ICONS = {
  success: '✓',
  warning: '⚠',
  error: '✕',
  info: 'ℹ',
};

let container = null;

function ensureContainer() {
  if (container && document.body.contains(container)) return container;
  container = document.createElement('div');
  container.className = 'toast-stack';
  container.setAttribute('role', 'status');
  container.setAttribute('aria-live', 'polite');
  document.body.appendChild(container);
  return container;
}

/**
 * @param {string} message texte humain
 * @param {'success'|'warning'|'error'|'info'} type
 * @param {number} duration ms (0 = persistant jusqu'à dismissal manuel)
 */
export function toast(message, type = 'info', duration = 3800) {
  const c = ensureContainer();
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  const safe = String(message ?? '').slice(0, 240) || 'Opération effectuée.';
  el.innerHTML = `<span class="toast__icon" aria-hidden="true">${ICONS[type] || ICONS.info}</span><span class="toast__msg"></span>`;
  el.querySelector('.toast__msg').textContent = safe;
  c.appendChild(el);
  requestAnimationFrame(() => el.classList.add('is-visible'));

  let timer = null;
  const dismiss = () => {
    clearTimeout(timer);
    el.classList.remove('is-visible');
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 320);
  };
  el.addEventListener('click', dismiss);
  if (duration > 0) timer = setTimeout(dismiss, duration);

  // Limite la pile à 5 toasts
  while (c.children.length > 5) c.firstChild.remove();
  return dismiss;
}

export const toastSuccess = (m, d) => toast(m, 'success', d);
export const toastError = (m, d) => toast(m, 'error', d || 5200);
export const toastWarning = (m, d) => toast(m, 'warning', d || 4600);
export const toastInfo = (m, d) => toast(m, 'info', d);
