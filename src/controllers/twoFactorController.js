import bcrypt from 'bcryptjs';
import { HttpError } from '../errors/HttpError.js';
import { buildTotpQrCode, createTotpSecret, isTotpCodeValid } from '../lib/totp.js';
import { disableTotp, enableTotp, findUserById, saveTotpSecret, toUserResponse } from '../services/userService.js';
import { validatePassword, validateTotpCode } from '../validators/authValidator.js';

// Étape 1 de l'activation : génère un secret et renvoie le QR code à scanner.
// La 2FA n'est pas encore active tant que l'utilisateur n'a pas confirmé un code.
export async function setupTwoFactor(request, response) {
  const user = await findUserById(request.user.id);
  if (user.totp_enabled) {
    throw new HttpError(409, 'La double authentification est déjà activée');
  }

  const secret = createTotpSecret();
  await saveTotpSecret(user.id, secret);

  // Le secret est aussi renvoyé en clair pour une saisie manuelle si le scan est impossible
  response.json({ qrCode: await buildTotpQrCode(user.email, secret), secret });
}

// Étape 2 de l'activation : un code valide prouve que l'application est bien configurée
export async function enableTwoFactor(request, response) {
  const code = validateTotpCode(request.body?.code);

  const user = await findUserById(request.user.id);
  if (user.totp_enabled) {
    throw new HttpError(409, 'La double authentification est déjà activée');
  }
  if (!user.totp_secret) {
    throw new HttpError(400, "Générez d'abord le QR code");
  }
  if (!(await isTotpCodeValid(user.totp_secret, code))) {
    throw new HttpError(400, 'Code incorrect');
  }

  await enableTotp(user.id);
  response.json({ user: toUserResponse(await findUserById(user.id)) });
}

// Désactivation : mot de passe + code exigés, pour qu'une session volée ne suffise pas
export async function disableTwoFactor(request, response) {
  const password = validatePassword(request.body?.password);
  const code = validateTotpCode(request.body?.code);

  const user = await findUserById(request.user.id);
  if (!user.totp_enabled) {
    throw new HttpError(409, "La double authentification n'est pas activée");
  }

  // 400 et non 401 : l'utilisateur est bien connecté, c'est la saisie qui est fausse
  const passwordMatches = await bcrypt.compare(password, user.password_hash);
  if (!passwordMatches || !(await isTotpCodeValid(user.totp_secret, code))) {
    throw new HttpError(400, 'Mot de passe ou code incorrect');
  }

  await disableTotp(user.id);
  response.json({ user: toUserResponse(await findUserById(user.id)) });
}
