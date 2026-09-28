import bcrypt from 'bcryptjs';
import { HttpError } from '../errors/HttpError.js';
import { setAuthCookie } from '../lib/sessionCookie.js';
import { findUserById, toUserResponse, updateUserPassword, updateUserProfile } from '../services/userService.js';
import { validatePasswordChangeBody, validateProfileBody } from '../validators/userValidator.js';

const PASSWORD_HASH_COST = 12;

// Modification du profil (prénom, nom, email)
export async function updateProfile(request, response) {
  const { profileChanges, currentPassword } = validateProfileBody(request.body);
  const user = await findUserById(request.user.id);

  const isEmailChanged = profileChanges.email !== undefined && profileChanges.email !== user.email;
  if (isEmailChanged) {
    if (!currentPassword) {
      throw new HttpError(400, "Le mot de passe actuel est obligatoire pour changer l'email");
    }
    if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
      throw new HttpError(400, 'Mot de passe actuel incorrect');
    }
  }

  try {
    await updateUserProfile(user.id, profileChanges);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      throw new HttpError(409, 'Cet email est déjà utilisé');
    }
    throw error;
  }

  response.json({ user: toUserResponse(await findUserById(user.id)) });
}

// Changement de mot de passe : toutes les sessions sont révoquées (token_version + 1),
// puis un nouveau cookie est posé pour que l'utilisateur reste connecté sur cet appareil
export async function changePassword(request, response) {
  const { currentPassword, newPassword } = validatePasswordChangeBody(request.body);
  const user = await findUserById(request.user.id);

  if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
    throw new HttpError(400, 'Mot de passe actuel incorrect');
  }

  await updateUserPassword(user.id, await bcrypt.hash(newPassword, PASSWORD_HASH_COST));

  const updatedUser = await findUserById(user.id);
  setAuthCookie(response, updatedUser);
  response.json({ user: toUserResponse(updatedUser) });
}
