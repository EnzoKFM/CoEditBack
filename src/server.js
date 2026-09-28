import 'dotenv/config';
import { app } from './app.js';
import { pool } from './db.js';

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`API démarrée sur http://localhost:${PORT}`);

  try {
    await pool.query('SELECT 1');
    console.log('Connexion MySQL OK');
  } catch (err) {
    console.error('Connexion MySQL impossible :', err.code || err.message);
  }
});
