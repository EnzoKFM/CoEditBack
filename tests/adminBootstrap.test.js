import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { ensureAdminAccount } from '../src/database/ensureAdminAccount.js';
import { pool } from '../src/db.js';
import { createTestUser, deleteTestUser } from './authHelper.js';
import { closeDatabase } from './databaseHelper.js';

const BOOTSTRAP_ADMIN_EMAIL = 'premier-admin@coedit.test';
const BOOTSTRAP_ADMIN_PASSWORD = 'Initial123!';
const EXISTING_ADMIN_EMAIL = 'admin-existant@coedit.test';

async function countUsersByEmail(email) {
  const [countRows] = await pool.execute('SELECT COUNT(*) AS userCount FROM users WHERE email = ?', [email]);
  return Number(countRows[0].userCount);
}

beforeEach(async () => {
  await pool.execute("DELETE FROM users WHERE role = 'admin'");
});

afterEach(async () => {
  await deleteTestUser(BOOTSTRAP_ADMIN_EMAIL);
  await deleteTestUser(EXISTING_ADMIN_EMAIL);
});

afterAll(closeDatabase);

describe('ensureAdminAccount', () => {
  it("crée l'administrateur décrit par l'environnement quand il n'en existe aucun", async () => {
    const isAdminCreated = await ensureAdminAccount({
      email: BOOTSTRAP_ADMIN_EMAIL,
      password: BOOTSTRAP_ADMIN_PASSWORD,
    });

    expect(isAdminCreated).toBe(true);
    const loginResponse = await request(app)
      .post('/api/auth/login')
      .send({ email: BOOTSTRAP_ADMIN_EMAIL, password: BOOTSTRAP_ADMIN_PASSWORD });
    expect(loginResponse.status).toBe(200);
    expect(loginResponse.body.user.role).toBe('admin');
  });

  it("ne crée rien quand un administrateur existe déjà", async () => {
    await createTestUser(EXISTING_ADMIN_EMAIL, 'admin');

    const isAdminCreated = await ensureAdminAccount({
      email: BOOTSTRAP_ADMIN_EMAIL,
      password: BOOTSTRAP_ADMIN_PASSWORD,
    });

    expect(isAdminCreated).toBe(false);
    expect(await countUsersByEmail(BOOTSTRAP_ADMIN_EMAIL)).toBe(0);
  });

  it("signale l'absence d'ADMIN_EMAIL ou d'ADMIN_PASSWORD quand il n'existe aucun administrateur", async () => {
    await expect(ensureAdminAccount({ email: BOOTSTRAP_ADMIN_EMAIL, password: undefined })).rejects.toThrow(
      'ADMIN_EMAIL et ADMIN_PASSWORD',
    );
    await expect(ensureAdminAccount({ email: undefined, password: BOOTSTRAP_ADMIN_PASSWORD })).rejects.toThrow(
      'ADMIN_EMAIL et ADMIN_PASSWORD',
    );
  });

  it('refuse un mot de passe administrateur faible', async () => {
    await expect(ensureAdminAccount({ email: BOOTSTRAP_ADMIN_EMAIL, password: 'admin' })).rejects.toThrow(
      'au moins 8 caractères',
    );
    expect(await countUsersByEmail(BOOTSTRAP_ADMIN_EMAIL)).toBe(0);
  });
});
