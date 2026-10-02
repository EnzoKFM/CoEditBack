import './testEnvironment.js';
import mysql from 'mysql2/promise';
import { initializeDatabase } from '../src/database/initializeDatabase.js';

async function dropTestDatabase(databaseName) {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });
  try {
    await connection.query(`DROP DATABASE IF EXISTS ${connection.escapeId(databaseName)}`);
  } finally {
    await connection.end();
  }
}

export default async function setup() {
  await dropTestDatabase(process.env.DB_NAME);
  await initializeDatabase(process.env.DB_NAME);
}
