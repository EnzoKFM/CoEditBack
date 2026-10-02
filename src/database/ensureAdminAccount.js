import bcrypt from 'bcryptjs';
import { createUser, hasAdminUser } from '../services/userService.js';
import { validateEmail, validateNewPassword } from '../validators/authValidator.js';

const PASSWORD_HASH_COST = 12;
const ADMIN_FIRST_NAME = 'Admin';
const ADMIN_LAST_NAME = 'Coedit';

export async function ensureAdminAccount({ email, password }) {
  if (await hasAdminUser()) {
    return false;
  }
  if (!email || !password) {
    throw new Error('aucun administrateur en base : définir ADMIN_EMAIL et ADMIN_PASSWORD pour en créer un');
  }

  await createUser({
    email: validateEmail(email),
    passwordHash: await bcrypt.hash(validateNewPassword(password), PASSWORD_HASH_COST),
    firstName: ADMIN_FIRST_NAME,
    lastName: ADMIN_LAST_NAME,
    role: 'admin',
  });
  return true;
}
