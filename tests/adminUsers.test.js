import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { pool } from '../src/db.js';
import { TEST_PASSWORD, createAuthenticatedAgent, createTestUser, deleteTestUser } from './authHelper.js';
import { closeDatabase } from './databaseHelper.js';

const ADMIN_EMAIL = 'admin-test@coedit.test';
const MEMBER_EMAIL = 'membre@coedit.test';
const CREATED_EMAIL = 'cree-par-admin@coedit.test';

const NEW_ACCOUNT = {
  email: CREATED_EMAIL,
  firstName: 'Claire',
  lastName: 'Dupont',
  password: 'Provisoire123!',
};

let adminAgent;

beforeEach(async () => {
  adminAgent = await createAuthenticatedAgent(ADMIN_EMAIL, 'admin');
});

afterEach(async () => {
  await deleteTestUser(ADMIN_EMAIL);
  await deleteTestUser(MEMBER_EMAIL);
  await deleteTestUser(CREATED_EMAIL);
});

afterAll(closeDatabase);

async function findUserId(email) {
  const [userRows] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
  return userRows[0].id;
}

describe('accès à /api/admin/users', () => {
  it('renvoie 401 sans session', async () => {
    const listResponse = await request(app).get('/api/admin/users');
    expect(listResponse.status).toBe(401);
  });

  it('renvoie 403 pour un utilisateur qui n\'est pas admin', async () => {
    const memberAgent = await createAuthenticatedAgent(MEMBER_EMAIL);

    const listResponse = await memberAgent.get('/api/admin/users');
    const createResponse = await memberAgent.post('/api/admin/users').send(NEW_ACCOUNT);
    expect(listResponse.status).toBe(403);
    expect(createResponse.status).toBe(403);
  });
});

describe('GET /api/admin/users', () => {
  it('liste les comptes sans hash ni secret 2FA', async () => {
    const listResponse = await adminAgent.get('/api/admin/users');
    expect(listResponse.status).toBe(200);

    const adminAccount = listResponse.body.users.find((user) => user.email === ADMIN_EMAIL);
    expect(adminAccount).toMatchObject({ role: 'admin', isBlocked: false, totpEnabled: false });
    for (const user of listResponse.body.users) {
      expect(user).not.toHaveProperty('password_hash');
      expect(user).not.toHaveProperty('totp_secret');
    }
  });
});

describe('POST /api/admin/users', () => {
  it('crée un compte qui peut ensuite se connecter', async () => {
    const createResponse = await adminAgent.post('/api/admin/users').send(NEW_ACCOUNT);
    expect(createResponse.status).toBe(201);
    expect(createResponse.body.user).toMatchObject({ email: CREATED_EMAIL, role: 'user', isBlocked: false });

    const loginResponse = await request(app)
      .post('/api/auth/login')
      .send({ email: CREATED_EMAIL, password: NEW_ACCOUNT.password });
    expect(loginResponse.status).toBe(200);
  });

  it('crée un compte administrateur si demandé', async () => {
    const createResponse = await adminAgent.post('/api/admin/users').send({ ...NEW_ACCOUNT, role: 'admin' });
    expect(createResponse.body.user.role).toBe('admin');
  });

  it('refuse un email déjà utilisé', async () => {
    await createTestUser(CREATED_EMAIL);

    const createResponse = await adminAgent.post('/api/admin/users').send(NEW_ACCOUNT);
    expect(createResponse.status).toBe(409);
  });

  it.each([
    ['un mot de passe faible', { password: 'faible' }],
    ['un email invalide', { email: 'pas-un-email' }],
    ['un prénom manquant', { firstName: undefined }],
    ['un rôle inconnu', { role: 'superadmin' }],
  ])('refuse %s', async (_, invalidFields) => {
    const createResponse = await adminAgent.post('/api/admin/users').send({ ...NEW_ACCOUNT, ...invalidFields });
    expect(createResponse.status).toBe(400);
  });
});

describe('blocage des comptes', () => {
  it('bloque un compte : sa session est coupée et il ne peut plus se connecter', async () => {
    const memberAgent = await createAuthenticatedAgent(MEMBER_EMAIL);
    const memberId = await findUserId(MEMBER_EMAIL);

    const blockResponse = await adminAgent.patch(`/api/admin/users/${memberId}/block`);
    expect(blockResponse.status).toBe(200);
    expect(blockResponse.body.user.isBlocked).toBe(true);

    expect((await memberAgent.get('/api/auth/me')).status).toBe(401);
    const loginResponse = await request(app).post('/api/auth/login').send({ email: MEMBER_EMAIL, password: TEST_PASSWORD });
    expect(loginResponse.status).toBe(403);
  });

  it('débloque un compte : il peut à nouveau se connecter', async () => {
    await createTestUser(MEMBER_EMAIL);
    const memberId = await findUserId(MEMBER_EMAIL);
    await adminAgent.patch(`/api/admin/users/${memberId}/block`);

    const unblockResponse = await adminAgent.patch(`/api/admin/users/${memberId}/unblock`);
    expect(unblockResponse.body.user.isBlocked).toBe(false);

    const loginResponse = await request(app).post('/api/auth/login').send({ email: MEMBER_EMAIL, password: TEST_PASSWORD });
    expect(loginResponse.status).toBe(200);
  });

  it('refuse qu\'un admin bloque son propre compte', async () => {
    const adminId = await findUserId(ADMIN_EMAIL);

    const blockResponse = await adminAgent.patch(`/api/admin/users/${adminId}/block`);
    expect(blockResponse.status).toBe(400);
  });

  it('renvoie 404 pour un compte inexistant et 400 pour un identifiant invalide', async () => {
    expect((await adminAgent.patch('/api/admin/users/999999/block')).status).toBe(404);
    expect((await adminAgent.patch('/api/admin/users/abc/block')).status).toBe(400);
  });
});
