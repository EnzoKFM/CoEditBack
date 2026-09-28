import bcrypt from 'bcryptjs';
import { HttpError } from '../errors/HttpError.js';
import { AUTH_COOKIE, clearAuthCookie, setAuthCookie, verifySessionToken } from '../lib/sessionCookie.js';
import {
  PENDING_2FA_COOKIE,
  clearPending2faCookie,
  setPending2faCookie,
  verifyPending2faToken,
} from '../lib/pending2faCookie.js';
import {
  consumeTotpCode,
  findUserByEmail,
  findUserById,
  revokeUserSessions,
  toUserResponse,
} from '../services/userService.js';
import { validateLoginBody, validateTotpCode } from '../validators/authValidator.js';

// Hash factice comparé quand l'email est inconnu : le temps de réponse est le
// même que pour un vrai compte, ce qui empêche de deviner les emails existants.
const DUMMY_PASSWORD_HASH = '$2b$12$umFTmtB2I659an.uxEBqxeF9LQAw1b1WLZd464iZoHH5Amqhm58e.';


// Connexion d'un utilisateur
export async function login(request, response) {
  const { email, password } = validateLoginBody(request.body);

  const user = await findUserByEmail(email);
  const passwordMatches = await bcrypt.compare(password, user?.password_hash ?? DUMMY_PASSWORD_HASH);

  if (!user || !passwordMatches) {
    throw new HttpError(401, 'Email ou mot de passe incorrect');
  }
  if (user.is_blocked) {
    throw new HttpError(403, 'Ce compte est bloqué');
  }

  // 2FA activée : le mot de passe ne suffit pas, on attend le code avant d'ouvrir la session
  if (user.totp_enabled) {
    setPending2faCookie(response, user);
    return response.json({ twoFactorRequired: true });
  }

  setAuthCookie(response, user);
  response.json({ user: toUserResponse(user) });
}


// Deuxième étape de connexion : vérification du code 2FA
export async function loginWithTwoFactor(request, response) {
  const code = validateTotpCode(request.body?.code);

  const pendingToken = request.cookies[PENDING_2FA_COOKIE];
  let tokenPayload;
  try {
    tokenPayload = verifyPending2faToken(pendingToken);
  } catch {
    clearPending2faCookie(response);
    throw new HttpError(401, 'Délai dépassé, reconnectez-vous');
  }

  const user = await findUserById(tokenPayload.userId);
  if (!user || user.is_blocked || !user.totp_enabled || user.token_version !== tokenPayload.tv) {
    clearPending2faCookie(response);
    throw new HttpError(401, 'Délai dépassé, reconnectez-vous');
  }

  if (!(await consumeTotpCode(user, code))) {
    throw new HttpError(401, 'Code incorrect');
  }

  clearPending2faCookie(response);
  setAuthCookie(response, user);
  response.json({ user: toUserResponse(user) });
}


// Déconnexion d'un utilisateur.
// Effacer le cookie ne suffit pas : une copie du token resterait valable 8 h.
// On incrémente donc token_version, ce qui invalide tous les tokens déjà émis (sur tous les appareils).
export async function logout(request, response) {
  let tokenPayload = null;
  try {
    tokenPayload = verifySessionToken(request.cookies[AUTH_COOKIE]);
  } catch {
    tokenPayload = null;
  }
  if (tokenPayload) {
    await revokeUserSessions(tokenPayload.userId, tokenPayload.tv);
  }

  clearAuthCookie(response);
  clearPending2faCookie(response);
  response.status(204).end();
}


// Récupère l'utilisateur actuel
export function getCurrentUser(request, response) {
  response.json({ user: request.user });
}
