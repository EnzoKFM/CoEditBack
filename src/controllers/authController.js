import bcrypt from 'bcryptjs';
import { HttpError } from '../errors/HttpError.js';
import { clearAuthCookie, setAuthCookie } from '../lib/auth.js';
import { findUserByEmail, toUserResponse } from '../services/userService.js';
import { validateLoginBody } from '../validators/authValidator.js';

// Hash factice comparé quand l'email est inconnu : le temps de réponse est le
// même que pour un vrai compte, ce qui empêche de deviner les emails existants.
const DUMMY_PASSWORD_HASH = '$2b$12$JNnbKxuRSG7eaI.HM4oU1Op2AxLh0enPmvkaVBbCMmISTYl9HUUOS';


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

  setAuthCookie(response, user);
  response.json({ user: toUserResponse(user) });
}


// Déconnexion d'un utilisateur
export function logout(request, response) {
  clearAuthCookie(response);
  response.status(204).end();
}


// Récupère l'utilisateur actuel
export function getCurrentUser(request, response) {
  response.json({ user: request.user });
}
