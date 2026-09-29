import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import { initializeDatabase } from '../src/database/initializeDatabase.js';

const SCHEMA_DATABASE_NAME = `${process.env.DB_NAME}_schema`;

let connection;

beforeAll(async () => {
  connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });
  await connection.query(`DROP DATABASE IF EXISTS ${connection.escapeId(SCHEMA_DATABASE_NAME)}`);
  await initializeDatabase(SCHEMA_DATABASE_NAME);
});

afterAll(async () => {
  await connection.query(`DROP DATABASE IF EXISTS ${connection.escapeId(SCHEMA_DATABASE_NAME)}`);
  await connection.end();
});

describe('schéma de la base', () => {
  it('ne crée aucun compte utilisateur, donc aucun administrateur au mot de passe connu', async () => {
    const [userRows] = await connection.query(
      `SELECT email FROM ${connection.escapeId(SCHEMA_DATABASE_NAME)}.users`,
    );
    expect(userRows).toEqual([]);
  });
});
