import './testEnvironment.js';
import { initializeDatabase } from '../src/database/initializeDatabase.js';

export default async function setup() {
  await initializeDatabase(process.env.DB_NAME);
}
