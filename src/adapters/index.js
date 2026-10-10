/**
 * Registre des adaptateurs : sélectionne l'adaptateur approprié pour une URL.
 * L'ordre compte : les adaptateurs spécifiques d'abord, le générique en dernier.
 */
import { AnimeSamaAdapter } from './AnimeSamaAdapter.js';
import { SushiScanAdapter } from './SushiScanAdapter.js';
import { ScanVfAdapter } from './ScanVfAdapter.js';
import { GenericAdapter } from './GenericAdapter.js';

const adapters = [new AnimeSamaAdapter(), new SushiScanAdapter(), new ScanVfAdapter()];
const generic = new GenericAdapter();

/** Retourne l'adaptateur spécifique correspondant à l'URL, ou null. */
export function findAdapter(url) {
  return adapters.find((a) => a.matches(url)) || null;
}

/** Adaptateur générique (toujours disponible). */
export function getGenericAdapter() {
  return generic;
}

/** Liste complète (pour l'affichage des sources supportées). */
export function listAdapters() {
  return [...adapters, generic];
}

export { generic as GenericAdapterInstance };
