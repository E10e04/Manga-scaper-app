/**
 * Router — navigation par hash (#/accueil, #/bibliotheque, #/manga/<id>,
 * #/lecture/<chapterId>, #/telechargements, #/historique, #/stockage).
 */
const routes = [];

export function addRoute(pattern, handler) {
  // pattern : '/manga/:id' → regex nommée
  const names = [];
  const rx = new RegExp(
    '^' +
      pattern
        .split('/')
        .map((seg) => {
          if (seg.startsWith(':')) {
            names.push(seg.slice(1));
            return '([^/]+)';
          }
          return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('/') +
      '$'
  );
  routes.push({ rx, names, handler, pattern });
}

export function currentPath() {
  const h = location.hash.replace(/^#/, '') || '/';
  return h;
}

export function navigate(path, { replace = false } = {}) {
  const target = `#${path}`;
  if (location.hash === target) {
    dispatch(); // re-render si même route
    return;
  }
  if (replace) history.replaceState(null, '', target);
  else location.hash = path;
}

export function back(fallback = '/') {
  if (history.length > 1 && document.referrer !== '' ) history.back();
  else navigate(fallback, { replace: true });
}

let notFoundHandler = null;
export function setNotFound(fn) {
  notFoundHandler = fn;
}

async function dispatch() {
  const path = currentPath();
  for (const r of routes) {
    const m = path.match(r.rx);
    if (m) {
      const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      try {
        await r.handler(params, path);
      } catch (err) {
        console.error('[router]', err);
        if (notFoundHandler) notFoundHandler(err);
      }
      return;
    }
  }
  if (notFoundHandler) notFoundHandler(null);
}

export function startRouter() {
  window.addEventListener('hashchange', dispatch);
  dispatch();
}

export { dispatch as reroute };
