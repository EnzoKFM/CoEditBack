import { HttpError } from '../errors/HttpError.js';
import { AUTH_COOKIE, clearAuthCookie, verifySessionToken } from '../lib/sessionCookie.js';
import { findUserById, toUserResponse } from '../services/userService.js';

// Vérification si l'utilisateur est authentifié, compte non bloqué et token version valide
export async function requireAuth(request, response, next) {
  const token = request.cookies[AUTH_COOKIE];
  if (!token) {
    throw new HttpError(401, 'Non authentifié');
  }

  let tokenPayload;
  try {
    tokenPayload = verifySessionToken(token);
  } catch {
    clearAuthCookie(response);
    throw new HttpError(401, 'Session invalide ou expirée');
  }

  const user = await findUserById(tokenPayload.userId);
  if (!user || user.is_blocked || user.token_version !== tokenPayload.tv) {
    clearAuthCookie(response);
    throw new HttpError(401, 'Session invalide ou expirée');
  }

  request.user = toUserResponse(user);
  next();
}

// Vérification si l'utilisateur est administrateur
export function requireAdmin(request, response, next) {
  if (request.user?.role !== 'admin') {
    throw new HttpError(403, 'Accès réservé aux administrateurs');
  }
  next();
}
