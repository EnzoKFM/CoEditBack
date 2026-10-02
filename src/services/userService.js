import { notifyAccessChanged } from '../lib/accessChanges.js';
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

// Données d'un compte vues par un administrateur (liste des utilisateurs)
export function toAdminUserResponse(userRow) {
  return {
    ...toUserResponse(userRow),
    isBlocked: Boolean(userRow.is_blocked),
    createdAt: userRow.created_at,
  };
}

// Correspondance entre les champs de l'API et les colonnes de la table :
// seules ces colonnes peuvent être modifiées par updateUserProfile
const PROFILE_COLUMNS = { firstName: 'first_name', lastName: 'last_name', email: 'email' };

export async function findUserByEmail(email) {
  const [userRows] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
  return userRows[0] ?? null;
}

export async function findUserById(userId) {
  const [userRows] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
  return userRows[0] ?? null;
}

export async function hasAdminUser() {
  const [adminRows] = await pool.execute("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1");
  return adminRows.length > 0;
}

export async function listUsers() {
  const [userRows] = await pool.execute('SELECT * FROM users ORDER BY last_name, first_name, id');
  return userRows;
}

// Crée un compte et renvoie son identifiant (ER_DUP_ENTRY si l'email existe déjà)
export async function createUser({ email, passwordHash, firstName, lastName, role }) {
  const [insertResult] = await pool.execute(
    'INSERT INTO users (email, password_hash, first_name, last_name, role) VALUES (?, ?, ?, ?, ?)',
    [email, passwordHash, firstName, lastName, role],
  );
  return insertResult.insertId;
}

// Modifie prénom, nom et/ou email. Les noms de colonnes viennent de PROFILE_COLUMNS,
// jamais de la requête : seules les valeurs sont transmises en paramètres.
export async function updateUserProfile(userId, profileChanges) {
  const changedFields = Object.keys(profileChanges);
  const setClause = changedFields.map((field) => `${PROFILE_COLUMNS[field]} = ?`).join(', ');
  const values = changedFields.map((field) => profileChanges[field]);
  await pool.execute(`UPDATE users SET ${setClause} WHERE id = ?`, [...values, userId]);
}

// Remplace le mot de passe et invalide toutes les sessions existantes
export async function updateUserPassword(userId, passwordHash) {
  await pool.execute('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', [
    passwordHash,
    userId,
  ]);
  notifyAccessChanged();
}

// Bloque ou débloque un compte ; renvoie false si le compte n'existe pas
export async function setUserBlocked(userId, isBlocked) {
  const [updateResult] = await pool.execute('UPDATE users SET is_blocked = ? WHERE id = ?', [isBlocked, userId]);
  notifyAccessChanged();
  return updateResult.affectedRows === 1;
}

// Invalide toutes les sessions de l'utilisateur (déconnexion, changement de mot de passe).
// La condition sur la version évite qu'un ancien token déjà révoqué ne déconnecte à nouveau l'utilisateur.
export async function revokeUserSessions(userId, currentTokenVersion) {
  await pool.execute('UPDATE users SET token_version = token_version + 1 WHERE id = ? AND token_version = ?', [
    userId,
    currentTokenVersion,
  ]);
  notifyAccessChanged();
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
