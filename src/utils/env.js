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
 *   - Sinon, l'APK utilise CapacitorHttp pour les requêtes réseau natives;
 *     on retourne '' pour éviter un proxy relatif qui renverrait l'app.
 */
export function proxyBase() {
  if (typeof window === 'undefined') return ''; // Node (tests) : appel direct
  // L'APK passe toujours par CapacitorHttp natif. Ignorer la valeur historique
  // évite qu'une ancienne adresse de serveur d'ordinateur casse les requêtes.
  if (isNativeApp()) return '';
  return window.location.origin; // même origine que l'app web
}
