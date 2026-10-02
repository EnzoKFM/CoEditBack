import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { generate } from 'otplib';
import request from 'supertest';
import { app } from '../src/app.js';
import { pool } from '../src/db.js';
import { closeDatabase } from './databaseHelper.js';

const TEST_USER = { email: 'bob@coedit.test', password: 'MotDePasse123!' };

// Recrée l'utilisateur sans 2FA avant chaque test
beforeEach(async () => {
  const passwordHash = await bcrypt.hash(TEST_USER.password, 4);
  await pool.execute('DELETE FROM users WHERE email = ?', [TEST_USER.email]);
  await pool.execute(
    'INSERT INTO users (email, password_hash, first_name, last_name) VALUES (?, ?, ?, ?)',
    [TEST_USER.email, passwordHash, 'Bob', 'Durand'],
  );
});

afterAll(async () => {
  await pool.execute('DELETE FROM users WHERE email = ?', [TEST_USER.email]);
  await closeDatabase();
});

// Code du créneau de 30 s précédent : accepté grâce à la tolérance, il laisse le code
// du créneau actuel disponible pour la suite du test (un code ne sert qu'une fois)
async function generatePreviousCode(secret) {
  return generate({ secret, epoch: Math.floor(Date.now() / 1000) - 30 });
}

// Connecte un agent (qui garde ses cookies) et active la 2FA ; renvoie l'agent et le secret
async function loginAndEnableTwoFactor() {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send(TEST_USER);

  const setupResponse = await agent.post('/api/users/me/2fa/setup').send({ password: TEST_USER.password });
  const { secret } = setupResponse.body;
  await agent.post('/api/users/me/2fa/enable').send({ code: await generatePreviousCode(secret) });

  return { agent, secret };
}

describe('activation de la 2FA', () => {
  it('exige une session', async () => {
    const setupResponse = await request(app).post('/api/users/me/2fa/setup');
    expect(setupResponse.status).toBe(401);
  });

  it('exige le mot de passe pour générer le QR code', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send(TEST_USER);

    const withoutPasswordResponse = await agent.post('/api/users/me/2fa/setup').send({});
    const wrongPasswordResponse = await agent.post('/api/users/me/2fa/setup').send({ password: 'mauvais' });
    expect(withoutPasswordResponse.status).toBe(400);
    expect(wrongPasswordResponse.status).toBe(400);

    const [userRows] = await pool.execute('SELECT totp_secret FROM users WHERE email = ?', [TEST_USER.email]);
    expect(userRows[0].totp_secret).toBeNull();
  });

  it('stocke le secret chiffré, jamais en clair', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send(TEST_USER);
    const { secret } = (await agent.post('/api/users/me/2fa/setup').send({ password: TEST_USER.password })).body;

    const [userRows] = await pool.execute('SELECT totp_secret FROM users WHERE email = ?', [TEST_USER.email]);
    expect(userRows[0].totp_secret).toBeTruthy();
    expect(userRows[0].totp_secret).not.toContain(secret);
  });

  it('renvoie un QR code et un secret, sans activer la 2FA', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send(TEST_USER);

    const setupResponse = await agent.post('/api/users/me/2fa/setup').send({ password: TEST_USER.password });
    expect(setupResponse.status).toBe(200);
    expect(setupResponse.body.qrCode).toMatch(/^data:image\/png;base64,/);
    expect(setupResponse.body.secret).toMatch(/^[A-Z2-7]+$/);

    const meResponse = await agent.get('/api/auth/me');
    expect(meResponse.body.user.totpEnabled).toBe(false);
  });

  it('refuse un code incorrect', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send(TEST_USER);
    await agent.post('/api/users/me/2fa/setup').send({ password: TEST_USER.password });

    const enableResponse = await agent.post('/api/users/me/2fa/enable').send({ code: '000000' });
    expect(enableResponse.status).toBe(400);
  });

  it('refuse un code mal formé', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send(TEST_USER);
    await agent.post('/api/users/me/2fa/setup').send({ password: TEST_USER.password });

    const enableResponse = await agent.post('/api/users/me/2fa/enable').send({ code: '12ab' });
    expect(enableResponse.status).toBe(400);
    expect(enableResponse.body.error).toBe('Le code doit contenir 6 chiffres');
  });

  it("refuse d'activer sans avoir généré de QR code", async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send(TEST_USER);

    const enableResponse = await agent.post('/api/users/me/2fa/enable').send({ code: '123456' });
    expect(enableResponse.status).toBe(400);
  });

  it('active la 2FA avec un code valide', async () => {
    const { agent } = await loginAndEnableTwoFactor();

    const meResponse = await agent.get('/api/auth/me');
    expect(meResponse.body.user.totpEnabled).toBe(true);
  });

  it('refuse de régénérer un secret quand la 2FA est déjà active', async () => {
    const { agent } = await loginAndEnableTwoFactor();

    const setupResponse = await agent.post('/api/users/me/2fa/setup').send({ password: TEST_USER.password });
    expect(setupResponse.status).toBe(409);
  });
});

describe('connexion avec la 2FA', () => {
  it("n'ouvre pas de session après le mot de passe seul", async () => {
    await loginAndEnableTwoFactor();
    const agent = request.agent(app);

    const loginResponse = await agent.post('/api/auth/login').send(TEST_USER);
    expect(loginResponse.status).toBe(200);
    expect(loginResponse.body).toEqual({ twoFactorRequired: true });

    const meResponse = await agent.get('/api/auth/me');
    expect(meResponse.status).toBe(401);
  });

  it('ouvre la session avec le bon code', async () => {
    const { secret } = await loginAndEnableTwoFactor();
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send(TEST_USER);

    const codeResponse = await agent.post('/api/auth/login/2fa').send({ code: await generate({ secret }) });
    expect(codeResponse.status).toBe(200);
    expect(codeResponse.body.user.email).toBe(TEST_USER.email);

    const meResponse = await agent.get('/api/auth/me');
    expect(meResponse.status).toBe(200);
  });

  it('refuse un mauvais code', async () => {
    await loginAndEnableTwoFactor();
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send(TEST_USER);

    const codeResponse = await agent.post('/api/auth/login/2fa').send({ code: '000000' });
    expect(codeResponse.status).toBe(401);
  });

  it('refuse un code sans passer par le mot de passe', async () => {
    const { secret } = await loginAndEnableTwoFactor();

    const codeResponse = await request(app)
      .post('/api/auth/login/2fa')
      .send({ code: await generate({ secret }) });
    expect(codeResponse.status).toBe(401);
  });

  it('refuse de réutiliser un code déjà accepté', async () => {
    const { secret } = await loginAndEnableTwoFactor();
    const currentCode = await generate({ secret });

    const firstAgent = request.agent(app);
    await firstAgent.post('/api/auth/login').send(TEST_USER);
    const firstCodeResponse = await firstAgent.post('/api/auth/login/2fa').send({ code: currentCode });
    expect(firstCodeResponse.status).toBe(200);

    const replayAgent = request.agent(app);
    await replayAgent.post('/api/auth/login').send(TEST_USER);
    const replayCodeResponse = await replayAgent.post('/api/auth/login/2fa').send({ code: currentCode });
    expect(replayCodeResponse.status).toBe(401);
  });

  it('refuse le cookie temporaire si les sessions ont été révoquées entre-temps', async () => {
    const { secret } = await loginAndEnableTwoFactor();
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send(TEST_USER);

    await pool.execute('UPDATE users SET token_version = token_version + 1 WHERE email = ?', [TEST_USER.email]);

    const codeResponse = await agent.post('/api/auth/login/2fa').send({ code: await generate({ secret }) });
    expect(codeResponse.status).toBe(401);
  });

  it("refuse d'utiliser le cookie temporaire comme session", async () => {
    await loginAndEnableTwoFactor();
    const loginResponse = await request(app).post('/api/auth/login').send(TEST_USER);
    const pendingCookie = loginResponse.headers['set-cookie'][0].split(';')[0];
    const pendingToken = pendingCookie.split('=')[1];

    const meResponse = await request(app).get('/api/auth/me').set('Cookie', `token=${pendingToken}`);
    expect(meResponse.status).toBe(401);
  });
});

describe('désactivation de la 2FA', () => {
  it('exige le bon mot de passe', async () => {
    const { agent, secret } = await loginAndEnableTwoFactor();

    const disableResponse = await agent
      .post('/api/users/me/2fa/disable')
      .send({ password: 'mauvais', code: await generate({ secret }) });
    expect(disableResponse.status).toBe(400);
  });

  it('désactive avec le mot de passe et un code valide', async () => {
    const { agent, secret } = await loginAndEnableTwoFactor();

    const disableResponse = await agent
      .post('/api/users/me/2fa/disable')
      .send({ password: TEST_USER.password, code: await generate({ secret }) });
    expect(disableResponse.status).toBe(200);
    expect(disableResponse.body.user.totpEnabled).toBe(false);

    const loginResponse = await request(app).post('/api/auth/login').send(TEST_USER);
    expect(loginResponse.body.user.email).toBe(TEST_USER.email);
  });
});
