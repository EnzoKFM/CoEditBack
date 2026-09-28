import jwt from 'jsonwebtoken';

// Partie commune aux deux cookies (session et 2FA en attente) :

// Le champ "type" empêche d'utiliser un token à la place d'un autre.
// Exemple : Un token "2fa" (mot de passe validé, code pas encore saisi) ne peut pas être utilisé pour ouvrir une session.
// et inversement, un token "session" ne peut pas être utilisé pour ouvrir un "2fa".
export const TOKEN_TYPES = { session: 'session', pending2fa: '2fa' };

// Options du cookie pour le token JWT
export const cookieOptions = {
  httpOnly: true,
  sameSite: 'strict',
  secure: process.env.NODE_ENV === 'production',
  path: '/',
};

// Longueur minimale du secret JWT pour éviter les attaques par force brute
const JWT_SECRET_MIN_LENGTH = 32;

// Clé secrète pour le token JWT
function getJwtSecret() {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < JWT_SECRET_MIN_LENGTH) {
    throw new Error(`JWT_SECRET doit contenir au moins ${JWT_SECRET_MIN_LENGTH} caractères (voir .env.example)`);
  }
  return jwtSecret;
}

// Vérifié au démarrage du serveur si le secret est correct
export function checkJwtSecret() {
  getJwtSecret();
}

// Génère un token JWT du type demandé, valable durationMs
export function signJwt(payload, type, durationMs) {
  return jwt.sign({ ...payload, type }, getJwtSecret(), { expiresIn: durationMs / 1000 });
}

// Vérifie le token JWT puis si le type est correct et retourne son contenu si valide, sinon lance une erreur
export function verifyJwt(token, expectedType) {
  const tokenPayload = jwt.verify(token, getJwtSecret());
  if (tokenPayload.type !== expectedType) {
    throw new Error('Type de token inattendu');
  }
  return tokenPayload;
}
