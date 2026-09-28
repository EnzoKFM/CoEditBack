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
