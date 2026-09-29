import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { TEST_PASSWORD, createAuthenticatedAgent, createTestUser, deleteTestUser } from './authHelper.js';
import { closeDatabase } from './databaseHelper.js';

const PROFILE_TEST_EMAIL = 'profil@coedit.test';
const OTHER_TEST_EMAIL = 'autre-profil@coedit.test';
const CHANGED_TEST_EMAIL = 'nouveau-profil@coedit.test';
const NEW_PASSWORD = 'NouveauMotDePasse1!';

let agent;

beforeEach(async () => {
  agent = await createAuthenticatedAgent(PROFILE_TEST_EMAIL);
});

afterEach(async () => {
  await deleteTestUser(PROFILE_TEST_EMAIL);
  await deleteTestUser(OTHER_TEST_EMAIL);
  await deleteTestUser(CHANGED_TEST_EMAIL);
});

afterAll(closeDatabase);

describe('PATCH /api/users/me', () => {
  it('exige une session', async () => {
    const updateResponse = await request(app).patch('/api/users/me').send({ firstName: 'Alice' });
    expect(updateResponse.status).toBe(401);
  });

  it('modifie le prénom et le nom', async () => {
    const updateResponse = await agent.patch('/api/users/me').send({ firstName: '  Alice ', lastName: 'Martin' });
    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body.user).toMatchObject({ firstName: 'Alice', lastName: 'Martin' });

    const meResponse = await agent.get('/api/auth/me');
    expect(meResponse.body.user.firstName).toBe('Alice');
  });

  it('refuse une requête sans modification', async () => {
    const updateResponse = await agent.patch('/api/users/me').send({});
    expect(updateResponse.status).toBe(400);
  });

  it('refuse un prénom vide', async () => {
    const updateResponse = await agent.patch('/api/users/me').send({ firstName: '   ' });
    expect(updateResponse.status).toBe(400);
  });

  it("exige le mot de passe actuel pour changer l'email", async () => {
    const withoutPasswordResponse = await agent.patch('/api/users/me').send({ email: CHANGED_TEST_EMAIL });
    const wrongPasswordResponse = await agent
      .patch('/api/users/me')
      .send({ email: CHANGED_TEST_EMAIL, currentPassword: 'mauvais' });
    expect(withoutPasswordResponse.status).toBe(400);
    expect(wrongPasswordResponse.status).toBe(400);
  });

  it("renvoie un message explicite quand le mot de passe est laissé vide pour changer l'email", async () => {
    const emptyPasswordResponse = await agent
      .patch('/api/users/me')
      .send({ email: CHANGED_TEST_EMAIL, currentPassword: '' });
    expect(emptyPasswordResponse.status).toBe(400);
    expect(emptyPasswordResponse.body.error).toBe("Le mot de passe actuel est obligatoire pour changer l'email");
  });

  it("change l'email avec le mot de passe actuel", async () => {
    const updateResponse = await agent
      .patch('/api/users/me')
      .send({ email: CHANGED_TEST_EMAIL, currentPassword: TEST_PASSWORD });
    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body.user.email).toBe(CHANGED_TEST_EMAIL);

    const loginResponse = await request(app)
      .post('/api/auth/login')
      .send({ email: CHANGED_TEST_EMAIL, password: TEST_PASSWORD });
    expect(loginResponse.status).toBe(200);
  });

  it('refuse un email déjà utilisé par un autre compte', async () => {
    await createTestUser(OTHER_TEST_EMAIL);

    const updateResponse = await agent
      .patch('/api/users/me')
      .send({ email: OTHER_TEST_EMAIL, currentPassword: TEST_PASSWORD });
    expect(updateResponse.status).toBe(409);
    expect(updateResponse.body.error).toBe('Cet email est déjà utilisé');
  });
});

describe('PATCH /api/users/me/password', () => {
  it('refuse un mot de passe actuel incorrect', async () => {
    const changeResponse = await agent
      .patch('/api/users/me/password')
      .send({ currentPassword: 'mauvais', newPassword: NEW_PASSWORD });
    expect(changeResponse.status).toBe(400);
  });

  it('refuse un nouveau mot de passe trop faible', async () => {
    const changeResponse = await agent
      .patch('/api/users/me/password')
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'faible' });
    expect(changeResponse.status).toBe(400);
  });

  it('change le mot de passe : le nouveau fonctionne, pas l\'ancien', async () => {
    const changeResponse = await agent
      .patch('/api/users/me/password')
      .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });
    expect(changeResponse.status).toBe(200);

    const oldPasswordLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: PROFILE_TEST_EMAIL, password: TEST_PASSWORD });
    const newPasswordLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: PROFILE_TEST_EMAIL, password: NEW_PASSWORD });
    expect(oldPasswordLogin.status).toBe(401);
    expect(newPasswordLogin.status).toBe(200);
  });

  it('déconnecte les autres appareils mais garde la session courante', async () => {
    const otherDevice = request.agent(app);
    await otherDevice.post('/api/auth/login').send({ email: PROFILE_TEST_EMAIL, password: TEST_PASSWORD });

    await agent.patch('/api/users/me/password').send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

    expect((await agent.get('/api/auth/me')).status).toBe(200);
    expect((await otherDevice.get('/api/auth/me')).status).toBe(401);
  });
});
