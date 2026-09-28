import { pool } from '../db.js';
import { decryptSecret, encryptSecret } from '../lib/encryption.js';
import { findTotpTimeStep } from '../lib/totp.js';

// Données renvoyées au client
export function toUserResponse(userRow) {
  return {
    id: userRow.id,
    email: userRow.email,
    firstName: userRow.first_name,
    lastName: userRow.last_name,
    role: userRow.role,
    totpEnabled: Boolean(userRow.totp_enabled),
  };
}

export async function findUserByEmail(email) {
  const [userRows] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
  return userRows[0] ?? null;
}

export async function findUserById(userId) {
  const [userRows] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
  return userRows[0] ?? null;
}

// Invalide toutes les sessions de l'utilisateur (déconnexion, changement de mot de passe).
// La condition sur la version évite qu'un ancien token déjà révoqué ne déconnecte à nouveau l'utilisateur.
export async function revokeUserSessions(userId, currentTokenVersion) {
  await pool.execute('UPDATE users SET token_version = token_version + 1 WHERE id = ? AND token_version = ?', [
    userId,
    currentTokenVersion,
  ]);
}

// Enregistre un secret 2FA chiffré, en attente de confirmation (la 2FA reste désactivée)
export async function saveTotpSecret(userId, secret) {
  await pool.execute(
    'UPDATE users SET totp_secret = ?, totp_enabled = FALSE, totp_last_time_step = NULL WHERE id = ?',
    [encryptSecret(secret), userId],
  );
}

// Active la 2FA
export async function enableTotp(userId) {
  await pool.execute('UPDATE users SET totp_enabled = TRUE WHERE id = ?', [userId]);
}

// Désactive la 2FA
export async function disableTotp(userId) {
  await pool.execute(
    'UPDATE users SET totp_secret = NULL, totp_enabled = FALSE, totp_last_time_step = NULL WHERE id = ?',
    [userId],
  );
}

// Vérifie un code 2FA et le "consomme" : un code ne peut servir qu'une fois.
// L'UPDATE conditionnel est atomique : deux requêtes simultanées avec le même code
// ne peuvent pas réussir toutes les deux.
export async function consumeTotpCode(userRow, code) {
  if (!userRow.totp_secret) {
    return false;
  }

  let secret;
  try {
    secret = decryptSecret(userRow.totp_secret);
  } catch {
    return false;
  }

  const timeStep = await findTotpTimeStep(secret, code);
  if (timeStep === null) {
    return false;
  }

  const [updateResult] = await pool.execute(
    'UPDATE users SET totp_last_time_step = ? WHERE id = ? AND (totp_last_time_step IS NULL OR totp_last_time_step < ?)',
    [timeStep, userRow.id, timeStep],
  );
  return updateResult.affectedRows === 1;
}
