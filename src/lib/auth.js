import jwt from 'jsonwebtoken';

// Nom du cookie qui contient le token JWT
export const AUTH_COOKIE = 'token';

// Durée de vie du cookie (en ms)
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000; // 8 h

// Options du cookie pour le token JWT
const cookieOptions = {
  httpOnly: true,
  sameSite: 'strict',
  secure: process.env.NODE_ENV === 'production',
  path: '/',
};

// Clé secrète pour le token JWT
function getJwtSecret() {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET manquant dans le .env');
  }
  return process.env.JWT_SECRET;
}

// Génère un token JWT pour l'utilisateur
export function signToken(user) {
  return jwt.sign({ userId: user.id, tv: user.token_version }, getJwtSecret(), {
    expiresIn: SESSION_DURATION_MS / 1000,
  });
}

// Vérifie le token JWT et retourne son contenu si valide, sinon lance une erreur
export function verifyToken(token) {
  return jwt.verify(token, getJwtSecret());
}

// Gestion du cookie
export function setAuthCookie(response, user) {
  response.cookie(AUTH_COOKIE, signToken(user), { ...cookieOptions, maxAge: SESSION_DURATION_MS });
}

// Supprime le cookie d'authentification
export function clearAuthCookie(response) {
  response.clearCookie(AUTH_COOKIE, cookieOptions);
}
