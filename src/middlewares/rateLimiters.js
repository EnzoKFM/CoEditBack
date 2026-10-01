import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { verifyPending2faToken, PENDING_2FA_COOKIE } from '../lib/pending2faCookie.js';

// Limiteurs contre le bruteforce. Seuls les échecs sont comptés (skipSuccessfulRequests),
// et chaque route a son propre compteur : un échec sur l'une n'en bloque pas une autre.
const WINDOW_MS = 15 * 60 * 1000;
const TOO_MANY_ATTEMPTS = { error: 'Trop de tentatives, réessayez dans quelques minutes' };

function createFailureLimiter(limit, keyGenerator) {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit,
    skipSuccessfulRequests: true,
    message: TOO_MANY_ATTEMPTS,
    ...(keyGenerator && { keyGenerator }),
  });
}

function normalizeEmailForKey(rawEmail) {
  return typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
}

// Connexion, par IP : un attaquant ne peut pas essayer beaucoup de comptes depuis la même machine
const loginIpLimiter = createFailureLimiter(20);

// Connexion, par compte : un attaquant qui change d'IP ne peut pas s'acharner sur le même compte.
// Contrepartie assumée : 10 échecs bloquent ce compte 15 min, même pour son propriétaire.
const loginAccountLimiter = createFailureLimiter(
  10,
  (request) => normalizeEmailForKey(request.body?.email) || ipKeyGenerator(request.ip),
);

export const loginLimiters = [loginIpLimiter, loginAccountLimiter];

// Code 2FA de connexion : sans limite, on pourrait essayer le million de codes possibles
const twoFactorLoginIpLimiter = createFailureLimiter(10);

function buildPending2faAccountKey(request) {
  try {
    return `user:${verifyPending2faToken(request.cookies?.[PENDING_2FA_COOKIE]).userId}`;
  } catch {
    return ipKeyGenerator(request.ip);
  }
}

const twoFactorLoginAccountLimiter = createFailureLimiter(10, buildPending2faAccountKey);

export const twoFactorLoginLimiters = [twoFactorLoginIpLimiter, twoFactorLoginAccountLimiter];

// Routes du compte connecté qui vérifient le mot de passe (activation et désactivation de la 2FA),
// comptées par utilisateur : une session volée ne permet pas de deviner le mot de passe
export const passwordCheckLimiter = createFailureLimiter(10, (request) => `user:${request.user.id}`);

export const twoFactorEnableLimiter = createFailureLimiter(10, (request) => `user:${request.user.id}`);

export const BINARY_FILE_UPLOAD_LIMIT = 60;

export const binaryFileUploadLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: BINARY_FILE_UPLOAD_LIMIT,
  message: { error: "Trop d'envois de fichiers, réessayez dans quelques minutes" },
  keyGenerator: (request) => `user:${request.user.id}`,
});
