import { HttpError } from '../errors/HttpError.js';

export function errorHandler(error, request, response, next) {
  if (error instanceof HttpError) {
    return response.status(error.status).json({ error: error.message, ...error.details });
  }

  if (error.code === 'ER_DUP_ENTRY') {
    return response.status(409).json({ error: 'Un élément portant ce nom existe déjà dans ce dossier' });
  }

  if (error.type === 'entity.parse.failed') {
    return response.status(400).json({ error: 'Corps de requête JSON invalide' });
  }

  if (error.type === 'entity.too.large') {
    return response.status(413).json({ error: 'Contenu trop volumineux' });
  }

  console.error(error);
  return response.status(500).json({ error: 'Erreur interne du serveur' });
}
