import 'dotenv/config';
import { app } from './app.js';
import { createCollaboration } from './collaboration/collaborationServer.js';
import { ensureAdminAccount } from './database/ensureAdminAccount.js';
import { pool } from './db.js';
import { checkEncryptionKey } from './lib/encryption.js';
import { checkJwtSecret } from './lib/jwt.js';

const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGUSR2'];

checkJwtSecret();
checkEncryptionKey();

const PORT = process.env.PORT || 3000;

const httpServer = app.listen(PORT, async () => {
  console.log(`API démarrée sur http://localhost:${PORT}`);

  try {
    await pool.query('SELECT 1');
    console.log('Connexion MySQL OK');
  } catch (err) {
    console.error('Connexion MySQL impossible :', err.code || err.message);
  }

  try {
    const isAdminCreated = await ensureAdminAccount({
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
    });
    if (isAdminCreated) {
      console.log(`Compte administrateur ${process.env.ADMIN_EMAIL} créé`);
    }
  } catch (error) {
    console.error('Création du compte administrateur impossible :', error.code || error.message);
  }
});

const collaboration = createCollaboration();
collaboration.attachToHttpServer(httpServer);

let isShuttingDown = false;

async function shutDown(signal) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  console.log(`Signal ${signal} reçu : sauvegarde des documents ouverts avant l'arrêt`);
  try {
    await collaboration.close();
    await pool.end();
  } catch (error) {
    console.error("Arrêt propre de l'API impossible :", error.message);
  }
  process.exit(0);
}

for (const shutdownSignal of SHUTDOWN_SIGNALS) {
  process.once(shutdownSignal, () => shutDown(shutdownSignal));
}
