import { HttpError } from '../errors/HttpError.js';
import { validateEmail, validateNewPassword, validatePassword } from './authValidator.js';

const NAME_MAX_LENGTH = 100;
const USER_ROLES = ['user', 'admin'];
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;

// Vérifie un prénom ou un nom : texte non vide, 100 caractères maximum
export function validateName(rawName, fieldLabel) {
  if (typeof rawName !== 'string' || !rawName.trim()) {
    throw new HttpError(400, `Le ${fieldLabel} est obligatoire`);
  }

  const name = rawName.trim();
  if (name.length > NAME_MAX_LENGTH) {
    throw new HttpError(400, `Le ${fieldLabel} ne doit pas dépasser ${NAME_MAX_LENGTH} caractères`);
  }
  return name;
}

// Vérifie l'identifiant d'un utilisateur passé dans l'URL
export function parseUserId(rawUserId) {
  if (typeof rawUserId !== 'string' || !POSITIVE_INTEGER_PATTERN.test(rawUserId)) {
    throw new HttpError(400, 'Identifiant invalide');
  }
  return Number(rawUserId);
}

// Modification du profil : chaque champ est facultatif, mais au moins un doit être fourni.
// currentPassword n'est exigé que pour changer l'email (l'identifiant de connexion) :
// sinon, avec une session volée, un attaquant pourrait changer l'email et bloquer le vrai propriétaire.
export function validateProfileBody(requestBody) {
  const { firstName, lastName, email, currentPassword } = requestBody ?? {};
  const profileChanges = {};

  if (firstName !== undefined) {
    profileChanges.firstName = validateName(firstName, 'prénom');
  }
  if (lastName !== undefined) {
    profileChanges.lastName = validateName(lastName, 'nom');
  }
  if (email !== undefined) {
    profileChanges.email = validateEmail(email);
  }

  if (Object.keys(profileChanges).length === 0) {
    throw new HttpError(400, 'Aucune modification fournie');
  }

  return {
    profileChanges,
    currentPassword: currentPassword === undefined || currentPassword === '' ? null : validatePassword(currentPassword),
  };
}

// Changement de mot de passe : l'ancien (simple présence) et le nouveau (robustesse)
export function validatePasswordChangeBody(requestBody) {
  const { currentPassword, newPassword } = requestBody ?? {};
  return {
    currentPassword: validatePassword(currentPassword),
    newPassword: validateNewPassword(newPassword),
  };
}

// Création d'un compte par un administrateur
export function validateCreateUserBody(requestBody) {
  const { email, firstName, lastName, password, role = 'user' } = requestBody ?? {};

  if (!USER_ROLES.includes(role)) {
    throw new HttpError(400, 'Le rôle doit être "user" ou "admin"');
  }

  return {
    email: validateEmail(email),
    firstName: validateName(firstName, 'prénom'),
    lastName: validateName(lastName, 'nom'),
    password: validateNewPassword(password),
    role,
  };
}
