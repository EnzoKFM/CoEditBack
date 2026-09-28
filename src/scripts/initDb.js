import 'dotenv/config';
import { initializeDatabase } from '../database/initializeDatabase.js';

try {
  await initializeDatabase(process.env.DB_NAME);
  console.log(`Base ${process.env.DB_NAME} initialisée`);
} catch (error) {
  console.error('Initialisation de la base impossible :', error.code || error.message);
  process.exitCode = 1;
}
