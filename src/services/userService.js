import { pool } from '../db.js';

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

// Enregistre un secret 2FA en attente de confirmation (la 2FA reste désactivée)
export async function saveTotpSecret(userId, secret) {
  await pool.execute('UPDATE users SET totp_secret = ?, totp_enabled = FALSE WHERE id = ?', [secret, userId]);
}

// Active la 2FA
export async function enableTotp(userId) {
  await pool.execute('UPDATE users SET totp_enabled = TRUE WHERE id = ?', [userId]);
}

// Désactive la 2FA
export async function disableTotp(userId) {
  await pool.execute('UPDATE users SET totp_secret = NULL, totp_enabled = FALSE WHERE id = ?', [userId]);
}
