import bcrypt from 'bcryptjs';
import request from 'supertest';
import { app } from '../src/app.js';
import { pool } from '../src/db.js';

export const TEST_PASSWORD = 'MotDePasse123!';

export async function createTestUser(email, role = 'user') {
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 4);
  await deleteTestUser(email);
  const [insertResult] = await pool.execute(
    'INSERT INTO users (email, password_hash, first_name, last_name, role) VALUES (?, ?, ?, ?, ?)',
    [email, passwordHash, 'Test', 'Utilisateur', role],
  );
  return insertResult.insertId;
}

export async function deleteTestUser(email) {
  await pool.execute('DELETE FROM users WHERE email = ?', [email]);
}

export async function createAuthenticatedAgent(email, role = 'user') {
  await createTestUser(email, role);
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ email, password: TEST_PASSWORD });
  return agent;
}

export async function loginAndGetSessionCookie(email) {
  const loginResponse = await request(app).post('/api/auth/login').send({ email, password: TEST_PASSWORD });
  return loginResponse.headers['set-cookie'][0].split(';')[0];
}
