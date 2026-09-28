import { HttpError } from '../errors/HttpError.js';
import { AUTH_COOKIE, clearAuthCookie, verifySessionToken } from '../lib/sessionCookie.js';
import { findUserById, toUserResponse } from '../services/userService.js';

// Retrouve l'utilisateur d'un token de session, ou null si le token est invalide, expiré,
// révoqué (token_version différent) ou si le compte est bloqué.
// Partagé par les routes REST (requireAuth) et la connexion Socket.IO (authenticateSocket).
async function findSessionUser(token) {
  let tokenPayload;
  try {
    tokenPayload = verifySessionToken(token);
  } catch {
    return null;
  }

  const user = await findUserById(tokenPayload.userId);
  if (!user || user.is_blocked || user.token_version !== tokenPayload.tv) {
    return null;
  }
  return user;
}

// Vérification si l'utilisateur est authentifié, compte non bloqué et token version valide
export async function requireAuth(request, response, next) {
  const token = request.cookies[AUTH_COOKIE];
  if (!token) {
    throw new HttpError(401, 'Non authentifié');
  }

  const user = await findSessionUser(token);
  if (!user) {
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

// Équivalent de requireAuth pour Socket.IO : vérifié une fois, à l'ouverture de la connexion.
// Les cookies de la requête d'ouverture sont lus par cookie-parser (io.engine.use dans collaborationServer.js).
export async function authenticateSocket(socket, next) {
  try {
    const user = await findSessionUser(socket.request.cookies?.[AUTH_COOKIE]);
    if (!user) {
      return next(new Error('Non authentifié'));
    }
    socket.data.user = toUserResponse(user);
    next();
  } catch (error) {
    next(error);
  }
}
