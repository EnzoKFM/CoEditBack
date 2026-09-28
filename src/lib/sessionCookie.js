import { TOKEN_TYPES, cookieOptions, signJwt, verifyJwt } from './jwt.js';

// Nom du cookie qui contient le token JWT
export const AUTH_COOKIE = 'token';

// Durée de vie du cookie (en ms)
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000; // 8 h

// Génère un token JWT de session pour l'utilisateur
function signSessionToken(user) {
  return signJwt({ userId: user.id, tv: user.token_version }, TOKEN_TYPES.session, SESSION_DURATION_MS);
}

// Vérifie un token de session et retourne son contenu, sinon lance une erreur
export function verifySessionToken(token) {
  return verifyJwt(token, TOKEN_TYPES.session);
}

// Gestion du cookie
export function setAuthCookie(response, user) {
  response.cookie(AUTH_COOKIE, signSessionToken(user), { ...cookieOptions, maxAge: SESSION_DURATION_MS });
}

// Supprime le cookie d'authentification
export function clearAuthCookie(response) {
  response.clearCookie(AUTH_COOKIE, cookieOptions);
}
