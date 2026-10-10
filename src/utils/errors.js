/**
 * Erreurs applicatives normalisées.
 * Chaque erreur porte un message humain (jamais "undefined"/"TypeError").
 */
export class AppError extends Error {
  constructor(message, code = 'APP_ERROR', detail = null) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.detail = detail;
  }
}

export class ValidationError extends AppError {
  constructor(message, detail) {
    super(message, 'VALIDATION', detail);
    this.name = 'ValidationError';
  }
}

export class NetworkError extends AppError {
  constructor(message = 'Connexion impossible. Vérifiez votre réseau ou le statut du site.', detail) {
    super(message, 'NETWORK', detail);
    this.name = 'NetworkError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Le contenu demandé est introuvable.', detail) {
    super(message, 'NOT_FOUND', detail);
    this.name = 'NotFoundError';
  }
}

export class StorageError extends AppError {
  constructor(message = 'Erreur de stockage local.', detail) {
    super(message, 'STORAGE', detail);
    this.name = 'StorageError';
  }
}

export class AdapterError extends AppError {
  constructor(message = 'Cette source n’est pas compatible ou a changé de structure.', detail) {
    super(message, 'ADAPTER', detail);
    this.name = 'AdapterError';
  }
}

/** Convertit n'importe quoi en message humain sûr. */
export function humanizeError(err) {
  if (err instanceof AppError) return err.message;
  if (err && typeof err.message === 'string' && !/TypeError|undefined|null|NaN/i.test(err.message)) {
    // Message navigateur potentiellement utile ("Failed to fetch" → français)
    if (/failed to fetch|networkerror/i.test(err.message)) {
      return 'Connexion impossible. Le site est peut-être inaccessible ou hors ligne.';
    }
    return err.message;
  }
  return 'Une erreur inattendue est survenue. Veuillez réessayer.';
}
