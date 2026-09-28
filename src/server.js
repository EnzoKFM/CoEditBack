import 'dotenv/config';
import { app } from './app.js';
import { createCollaboration } from './collaboration/collaborationServer.js';
import { pool } from './db.js';

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET manquant dans le .env (voir .env.example)');
}

const PORT = process.env.PORT || 3000;

const httpServer = app.listen(PORT, async () => {
  console.log(`API démarrée sur http://localhost:${PORT}`);

  try {
    await pool.query('SELECT 1');
    console.log('Connexion MySQL OK');
  } catch (err) {
    console.error('Connexion MySQL impossible :', err.code || err.message);
  }
});

createCollaboration().attachToHttpServer(httpServer);
