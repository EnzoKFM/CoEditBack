import bcrypt from 'bcryptjs';
import { HttpError } from '../errors/HttpError.js';
import { createUser, findUserById, listUsers, setUserBlocked, toAdminUserResponse } from '../services/userService.js';
import { parseUserId, validateCreateUserBody } from '../validators/userValidator.js';

const PASSWORD_HASH_COST = 12;

// Liste de tous les comptes
export async function listAllUsers(request, response) {
  const userRows = await listUsers();
  response.json({ users: userRows.map(toAdminUserResponse) });
}

// Création d'un compte
export async function createUserAccount(request, response) {
  const { email, firstName, lastName, password, role } = validateCreateUserBody(request.body);

  let userId;
  try {
    userId = await createUser({
      email,
      passwordHash: await bcrypt.hash(password, PASSWORD_HASH_COST),
      firstName,
      lastName,
      role,
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      throw new HttpError(409, 'Cet email est déjà utilisé');
    }
    throw error;
  }

  response.status(201).json({ user: toAdminUserResponse(await findUserById(userId)) });
}

// Bloque ou débloque un compte. Un blocage prend effet immédiatement :
// requireAuth relit l'utilisateur à chaque requête et refuse un compte bloqué.
async function updateBlockedStatus(request, response, isBlocked) {
  const userId = parseUserId(request.params.userId);
  if (isBlocked && userId === request.user.id) {
    throw new HttpError(400, 'Vous ne pouvez pas bloquer votre propre compte');
  }

  if (!(await setUserBlocked(userId, isBlocked))) {
    throw new HttpError(404, 'Utilisateur introuvable');
  }
  response.json({ user: toAdminUserResponse(await findUserById(userId)) });
}

export function blockUser(request, response) {
  return updateBlockedStatus(request, response, true);
}

export function unblockUser(request, response) {
  return updateBlockedStatus(request, response, false);
}
