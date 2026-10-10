/**
 * Sanitisation des données externes (sécurité).
 *
 * - Aucune exécution de scripts distants : parse en mode " inert document ".
 * - Seuls quelques éléments inline sont conservés pour les descriptions.
 * - Les URLs sont validées (http/https/data:image uniquement).
 */
import { escapeHtml, isValidHttpUrl } from './helpers.js';

const ALLOWED_TAGS = new Set(['b', 'strong', 'i', 'em', 'br', 'p', 'span', 'small', 'u']);

/**
 * Nettoie une chaîne HTML distante : ne conserve que des balises inline sûres,
 * supprime tout attribut, script, style, iframe… Retourne du texte échappé si
 * le contenu est trop dangereux/complexe.
 */
export function sanitizeHtml(html) {
  if (html == null) return '';
  const raw = String(html);
  try {
    // Document inerte : les <script> ne s'exécutent jamais dans DOMParser.
    const doc = new DOMParser().parseFromString(`<body>${raw}</body>`, 'text/html');
    // Supprime tout ce qui n'est pas autorisé.
    doc.body.querySelectorAll('script,style,iframe,object,embed,link,meta,form,input,svg').forEach((n) => n.remove());
    const walk = (node) => {
      const out = [];
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) {
          out.push(escapeHtml(child.textContent));
        } else if (child.nodeType === 1) {
          const tag = child.tagName.toLowerCase();
          if (ALLOWED_TAGS.has(tag)) {
            if (tag === 'br') out.push('<br>');
            else {
              walk(child);
              out.push(`<${tag}>${child.innerHTML ? sanitizeInner(child) : escapeHtml(child.textContent)}</${tag}>`);
            }
          } else {
            out.push(escapeHtml(child.textContent));
          }
        }
      }
      node.innerHTML = out.join('');
      return node.innerHTML;
    };
    return walk(doc.body).slice(0, 4000);
  } catch {
    // Repli : texte brut échappé
    return escapeHtml(raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')).slice(0, 4000);
  }
}

function sanitizeInner(el) {
  const out = [];
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3) out.push(escapeHtml(child.textContent));
    else if (child.nodeType === 1 && ALLOWED_TAGS.has(child.tagName.toLowerCase())) {
      const t = child.tagName.toLowerCase();
      out.push(t === 'br' ? '<br>' : `<${t}>${sanitizeInner(child)}</${t}>`);
    } else if (child.nodeType === 1) out.push(escapeHtml(child.textContent));
  }
  return out.join('');
}

/**
 * Nettoie un texte simple (strip complet des balises).
 */
export function stripHtml(html) {
  if (html == null) return '';
  try {
    const doc = new DOMParser().parseFromString(String(html), 'text/html');
    doc.querySelectorAll('script,style').forEach((n) => n.remove());
    return (doc.body?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
  } catch {
    return String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
  }
}

/**
 * Valide/normalise une URL d'image : http(s) ou data:image.
 */
export function safeImageUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (/^data:image\//i.test(trimmed) && trimmed.length < 5_000_000) return trimmed;
  return isValidHttpUrl(trimmed);
}
