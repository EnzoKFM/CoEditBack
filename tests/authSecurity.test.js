import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { generate } from 'otplib';
import request from 'supertest';
import { app } from '../src/app.js';
import { parseTrustProxy, checkClientUrl, checkTrustProxy } from '../src/config/environment.js';
import { pool } from '../src/db.js';
import { createGracefulShutdown } from '../src/lib/gracefulShutdown.js';
import { TOKEN_TYPES } from '../src/lib/jwt.js';
import { closeDatabase } from './databaseHelper.js';

const TEST_USER = { email: 'carole@coedit.test', password: 'MotDePasse123!' };
const WRONG_CODE = '000000';
const ATTEMPTS_BEFORE_BLOCK = 10;

async function recreateUser() {
  const passwordHash = await bcrypt.hash(TEST_USER.password, 4);
  await pool.execute('DELETE FROM users WHERE email = ?', [TEST_USER.email]);
  await pool.execute('INSERT INTO users (email, password_hash, first_name, last_name) VALUES (?, ?, ?, ?)', [
    TEST_USER.email,
    passwordHash,
    'Carole',
    'Martin',
  ]);
}

async function enableTwoFactorFor(agent) {
  const setupResponse = await agent.post('/api/users/me/2fa/setup').send({ password: TEST_USER.password });
  const { secret } = setupResponse.body;
  const previousCode = await generate({ secret, epoch: Math.floor(Date.now() / 1000) - 30 });
  await agent.post('/api/users/me/2fa/enable').send({ code: previousCode });
  return secret;
}

beforeEach(recreateUser);

afterEach(() => {
  app.set('trust proxy', false);
});

afterAll(async () => {
  await pool.execute('DELETE FROM users WHERE email = ?', [TEST_USER.email]);
  await closeDatabase();
});

describe('limiteur 2FA par compte', () => {
  it('bloque le compte après 10 échecs venant d IP différentes', async () => {
    app.set('trust proxy', 1);
    const setupAgent = request.agent(app);
    await setupAgent.post('/api/auth/login').send(TEST_USER).set('X-Forwarded-For', '10.0.0.1');
    const secret = await enableTwoFactorFor(setupAgent);

    const loginAgent = request.agent(app);
    await loginAgent.post('/api/auth/login').send(TEST_USER).set('X-Forwarded-For', '10.0.1.1');

    for (let attempt = 0; attempt < ATTEMPTS_BEFORE_BLOCK; attempt += 1) {
      const failedResponse = await loginAgent
        .post('/api/auth/login/2fa')
        .set('X-Forwarded-For', `10.0.2.${attempt + 1}`)
        .send({ code: WRONG_CODE });
      expect(failedResponse.status).toBe(401);
    }

    const validCode = await generate({ secret });
    const blockedResponse = await loginAgent
      .post('/api/auth/login/2fa')
      .set('X-Forwarded-For', '10.0.3.1')
      .send({ code: validCode });
    expect(blockedResponse.status).toBe(429);
  });
});

describe('limiteur de l activation 2FA', () => {
  it('bloque la vérification du code d activation après 10 échecs', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send(TEST_USER);
    await agent.post('/api/users/me/2fa/setup').send({ password: TEST_USER.password });

    for (let attempt = 0; attempt < ATTEMPTS_BEFORE_BLOCK; attempt += 1) {
      const failedResponse = await agent.post('/api/users/me/2fa/enable').send({ code: WRONG_CODE });
      expect(failedResponse.status).toBe(400);
    }

    const blockedResponse = await agent.post('/api/users/me/2fa/enable').send({ code: WRONG_CODE });
    expect(blockedResponse.status).toBe(429);
  });
});

describe('algorithme JWT', () => {
  it('refuse un jeton HS512 signé avec le bon secret', async () => {
    const [userRows] = await pool.execute('SELECT id, token_version FROM users WHERE email = ?', [TEST_USER.email]);
    const forgedToken = jwt.sign(
      { userId: userRows[0].id, tv: userRows[0].token_version, type: TOKEN_TYPES.session },
      process.env.JWT_SECRET,
      { algorithm: 'HS512', expiresIn: 60 },
    );

    const meResponse = await request(app).get('/api/auth/me').set('Cookie', `token=${forgedToken}`);
    expect(meResponse.status).toBe(401);
  });
});

describe('validation de l environnement', () => {
  const originalClientUrl = process.env.CLIENT_URL;
  const originalTrustProxy = process.env.TRUST_PROXY;

  afterEach(() => {
    process.env.CLIENT_URL = originalClientUrl;
    process.env.TRUST_PROXY = originalTrustProxy;
    if (originalTrustProxy === undefined) {
      delete process.env.TRUST_PROXY;
    }
  });

  it('refuse un CLIENT_URL absent ou qui n est pas une origine http(s)', () => {
    delete process.env.CLIENT_URL;
    expect(() => checkClientUrl()).toThrow('CLIENT_URL');
    for (const invalidUrl of ['localhost:5173', 'ftp://example.com', 'http://example.com/chemin', 'http://example.com/']) {
      process.env.CLIENT_URL = invalidUrl;
      expect(() => checkClientUrl()).toThrow('CLIENT_URL');
    }
  });

  it('accepte une origine http(s)', () => {
    process.env.CLIENT_URL = 'https://app.example.com';
    expect(() => checkClientUrl()).not.toThrow();
    process.env.CLIENT_URL = 'http://localhost:5173';
    expect(() => checkClientUrl()).not.toThrow();
  });

  it('refuse un TRUST_PROXY qui n est pas un entier positif ou nul', () => {
    for (const invalidValue of ['-1', 'true', '1.5', 'abc']) {
      process.env.TRUST_PROXY = invalidValue;
      expect(() => checkTrustProxy()).toThrow('TRUST_PROXY');
    }
  });

  it('accepte un TRUST_PROXY vide, absent ou entier', () => {
    expect(parseTrustProxy(undefined)).toBeNull();
    expect(parseTrustProxy('')).toBeNull();
    expect(parseTrustProxy('0')).toBe(0);
    expect(parseTrustProxy('2')).toBe(2);
  });
});

describe('arrêt propre', () => {
  function createFakeDependencies({ collaborationCloses = true } = {}) {
    return {
      httpServer: { close: vi.fn((onClosed) => onClosed()), closeIdleConnections: vi.fn() },
      collaboration: {
        close: collaborationCloses ? vi.fn().mockResolvedValue() : vi.fn().mockRejectedValue(new Error('échec')),
      },
      pool: { end: vi.fn().mockResolvedValue() },
      exit: vi.fn(),
    };
  }

  it('ferme le serveur HTTP puis sort en code 0', async () => {
    const dependencies = createFakeDependencies();
    await createGracefulShutdown({ ...dependencies, timeoutMs: 1000 })('SIGTERM');
    expect(dependencies.httpServer.close).toHaveBeenCalledTimes(1);
    expect(dependencies.exit).toHaveBeenCalledWith(0);
  });

  it('sort en code 1 si la fermeture échoue', async () => {
    const dependencies = createFakeDependencies({ collaborationCloses: false });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await createGracefulShutdown({ ...dependencies, timeoutMs: 1000 })('SIGTERM');
    expect(dependencies.exit).toHaveBeenCalledWith(1);
  });

  it('force la sortie en code 1 après le délai de sécurité', async () => {
    const dependencies = createFakeDependencies();
    dependencies.httpServer.close = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    createGracefulShutdown({ ...dependencies, timeoutMs: 50 })('SIGTERM');
    await vi.waitFor(() => expect(dependencies.exit).toHaveBeenCalledWith(1));
  });
});
