import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';

const SCHEMA_FILE_URL = new URL('../../sql/schema.sql', import.meta.url);

export async function initializeDatabase(databaseName) {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    multipleStatements: true,
  });

  try {
    const schemaSql = await readFile(SCHEMA_FILE_URL, 'utf8');
    await connection.query(`CREATE DATABASE IF NOT EXISTS ${connection.escapeId(databaseName)} CHARACTER SET utf8mb4`);
    await connection.changeUser({ database: databaseName });
    await connection.query(schemaSql);
  } finally {
    await connection.end();
  }
}
