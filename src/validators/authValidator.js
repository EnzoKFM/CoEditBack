import { HttpError } from '../errors/HttpError.js';

const EMAIL_MAX_LENGTH = 255;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_BYTES = 72;

// Normalise l'email en supprimant les espaces et en le mettant en minuscules
export function normalizeEmail(rawEmail) {
  return rawEmail.trim().toLowerCase();
}

// Vérifie que l'email est valide et le renvoie normalisé
export function validateEmail(rawEmail) {
  if (typeof rawEmail !== 'string' || !rawEmail.trim()) {
    throw new HttpError(400, "L'email est obligatoire");
  }

  const email = normalizeEmail(rawEmail);
  if (email.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(email)) {
    throw new HttpError(400, "Format d'email invalide");
  }
  return email;
}

// Vérifie qu'un mot de passe est fourni
export function validatePassword(rawPassword) {
  if (typeof rawPassword !== 'string' || !rawPassword) {
    throw new HttpError(400, 'Le mot de passe est obligatoire');
  }
  if (Buffer.byteLength(rawPassword, 'utf8') > PASSWORD_MAX_BYTES) {
    throw new HttpError(400, 'Mot de passe trop long');
  }
  return rawPassword;
}

// Vérifie la robustesse d'un nouveau mot de passe (création de compte, changement de mot de passe)
export function validateNewPassword(rawPassword) {
  const password = validatePassword(rawPassword);

  const isStrong =
    password.length >= PASSWORD_MIN_LENGTH &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /\d/.test(password) &&
    /[^a-zA-Z\d]/.test(password);

  if (!isStrong) {
    throw new HttpError(
      400,
      `Le mot de passe doit contenir au moins ${PASSWORD_MIN_LENGTH} caractères, dont une minuscule, une majuscule, un chiffre et un caractère spécial`,
    );
  }
  return password;
}

// Vérifie un code 2FA : 6 chiffres, les espaces sont tolérés ("123 456")
export function validateTotpCode(rawCode) {
  if (typeof rawCode !== 'string') {
    throw new HttpError(400, 'Le code est obligatoire');
  }

  const code = rawCode.replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) {
    throw new HttpError(400, 'Le code doit contenir 6 chiffres');
  }
  return code;
}

// Validation du corps de la requête pour la connexion
export function validateLoginBody(requestBody) {
  const { email, password } = requestBody ?? {};
  return {
    email: validateEmail(email),
    password: validatePassword(password),
  };
}
