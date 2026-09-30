import { pool } from '../src/db.js';

export async function resetDatabase() {
  const connection = await pool.getConnection();
  try {
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    await connection.query('TRUNCATE TABLE folder_shares');
    await connection.query('TRUNCATE TABLE file_contents');
    await connection.query('TRUNCATE TABLE file_binaries');
    await connection.query('TRUNCATE TABLE nodes');
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    connection.release();
  }
}

export async function closeDatabase() {
  await pool.end();
}
