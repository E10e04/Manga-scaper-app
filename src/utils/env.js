/**
 * Environnement d'exécution : Web (avec proxy server.js) vs natif Capacitor.
 * Centralisé ici pour éviter la duplication entre Scraper et DownloadManager.
 */

/** Vrai si l'app tourne dans un WebView Capacitor (Android). */
export function isNativeApp() {
  return typeof window !== 'undefined' && !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

/**
 * Base du proxy distant.
 * - Web : même origine que l'app (server.js sert /api/*).
 * - Natif (APK) : server.js ne tourne pas dans l'application.
 *   - Si l'utilisateur a configuré localStorage("mr_proxy_url")
 *     (ex. http://192.168.1.10:8080), on l'utilise.
 *   - Sinon, on retourne '' => les adaptateurs doivent passer en
 *     requêtes DIRECTES depuis le WebView (pas de proxy relatif,
 *     qui renverrait le HTML de l'app et casserait le JSON).
 */
export function proxyBase() {
  if (typeof window === 'undefined') return ''; // Node (tests) : appel direct
  if (isNativeApp()) {
    const custom = (window.localStorage?.getItem('mr_proxy_url') || '').trim().replace(/\/+$/, '');
    return custom; // vide => mode direct
  }
  return window.location.origin; // même origine que l'app web
}
