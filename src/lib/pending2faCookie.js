import { TOKEN_TYPES, cookieOptions, signJwt, verifyJwt } from './jwt.js';


// Nom du cookie temporaire posé entre le mot de passe et le code 2FA
export const PENDING_2FA_COOKIE = 'pending_2fa';

// Durée de vie du cookie (en ms)
const PENDING_2FA_DURATION_MS = 5 * 60 * 1000; // 5 min pour saisir le code

// Vérifie un token 2FA en attente et retourne son contenu, sinon lance une erreur
export function verifyPending2faToken(token) {
  return verifyJwt(token, TOKEN_TYPES.pending2fa);
}

// Cookie temporaire : mot de passe validé, en attente du code 2FA
export function setPending2faCookie(response, user) {
  const token = signJwt({ userId: user.id }, TOKEN_TYPES.pending2fa, PENDING_2FA_DURATION_MS);
  response.cookie(PENDING_2FA_COOKIE, token, { ...cookieOptions, maxAge: PENDING_2FA_DURATION_MS });
}

export function clearPending2faCookie(response) {
  response.clearCookie(PENDING_2FA_COOKIE, cookieOptions);
}
