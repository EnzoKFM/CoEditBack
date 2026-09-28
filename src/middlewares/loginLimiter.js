import rateLimit from 'express-rate-limit';

// Limiteur de tentatives de connexion pour éviter le bruteforce
// Ici : 10 essais ratés par IP toutes les 15 min.
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  message: { error: 'Trop de tentatives, réessayez dans quelques minutes' },
});
