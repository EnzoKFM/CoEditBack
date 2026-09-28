import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { app } from '../src/app.js';
import { pool } from '../src/db.js';
import { closeDatabase } from './databaseHelper.js';

const TEST_USER = { email: 'alice@coedit.test', password: 'MotDePasse123!' };

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(TEST_USER.password, 4);
  await pool.execute('DELETE FROM users WHERE email = ?', [TEST_USER.email]);
  await pool.execute(
    'INSERT INTO users (email, password_hash, first_name, last_name) VALUES (?, ?, ?, ?)',
    [TEST_USER.email, passwordHash, 'Alice', 'Martin'],
  );
});

afterEach(async () => {
  await pool.execute('UPDATE users SET is_blocked = FALSE WHERE email = ?', [TEST_USER.email]);
});

afterAll(async () => {
  await pool.execute('DELETE FROM users WHERE email = ?', [TEST_USER.email]);
  await closeDatabase();
});

function loginAs(credentials) {
  return request(app).post('/api/auth/login').send(credentials);
}

describe('POST /api/auth/login', () => {
  it('connecte avec les bons identifiants et pose un cookie httpOnly SameSite=Strict', async () => {
    const loginResponse = await loginAs(TEST_USER);

    expect(loginResponse.status).toBe(200);
    expect(loginResponse.body.user).toMatchObject({ email: TEST_USER.email, role: 'user' });
    expect(loginResponse.body.user).not.toHaveProperty('password_hash');
    expect(loginResponse.body.user).not.toHaveProperty('totp_secret');

    const sessionCookie = loginResponse.headers['set-cookie'][0];
    expect(sessionCookie).toMatch(/^token=/);
    expect(sessionCookie).toMatch(/HttpOnly/);
    expect(sessionCookie).toMatch(/SameSite=Strict/);
  });

  it("normalise l'email (majuscules et espaces)", async () => {
    const loginResponse = await loginAs({ ...TEST_USER, email: '  Alice@Coedit.TEST ' });
    expect(loginResponse.status).toBe(200);
  });

  it('renvoie le même message pour un mauvais mot de passe et un email inconnu', async () => {
    const wrongPasswordResponse = await loginAs({ ...TEST_USER, password: 'faux' });
    const unknownEmailResponse = await loginAs({ email: 'inconnu@coedit.test', password: 'faux' });

    expect(wrongPasswordResponse.status).toBe(401);
    expect(unknownEmailResponse.status).toBe(401);
    expect(wrongPasswordResponse.body.error).toBe(unknownEmailResponse.body.error);
  });

  it('refuse une requête sans email ni mot de passe', async () => {
    const loginResponse = await loginAs({});
    expect(loginResponse.status).toBe(400);
  });

  it('refuse un compte bloqué', async () => {
    await pool.execute('UPDATE users SET is_blocked = TRUE WHERE email = ?', [TEST_USER.email]);
    const loginResponse = await loginAs(TEST_USER);
    expect(loginResponse.status).toBe(403);
  });
});

describe('GET /api/auth/me', () => {
  it('renvoie 401 sans cookie', async () => {
    const meResponse = await request(app).get('/api/auth/me');
    expect(meResponse.status).toBe(401);
  });

  it('renvoie 401 avec un jeton falsifié', async () => {
    const meResponse = await request(app).get('/api/auth/me').set('Cookie', 'token=faux.jeton.jwt');
    expect(meResponse.status).toBe(401);
  });

  it("renvoie l'utilisateur connecté", async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send(TEST_USER);

    const meResponse = await agent.get('/api/auth/me');
    expect(meResponse.status).toBe(200);
    expect(meResponse.body.user.email).toBe(TEST_USER.email);
  });

  it('coupe immédiatement la session quand le compte est bloqué', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send(TEST_USER);
    await pool.execute('UPDATE users SET is_blocked = TRUE WHERE email = ?', [TEST_USER.email]);

    const meResponse = await agent.get('/api/auth/me');
    expect(meResponse.status).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('supprime la session', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send(TEST_USER);

    const logoutResponse = await agent.post('/api/auth/logout');
    expect(logoutResponse.status).toBe(204);

    const meResponse = await agent.get('/api/auth/me');
    expect(meResponse.status).toBe(401);
  });
});

// En dernier : le limiteur compte aussi les échecs des tests précédents.
describe('limitation des tentatives de connexion', () => {
  it('renvoie 429 après trop d\'échecs', async () => {
    let lastStatus;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      lastStatus = (await loginAs({ ...TEST_USER, password: 'faux' })).status;
    }
    expect(lastStatus).toBe(429);
  });
});
