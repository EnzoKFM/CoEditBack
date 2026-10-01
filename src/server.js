import 'dotenv/config';
import { app } from './app.js';
import { createCollaboration } from './collaboration/collaborationServer.js';
import { ensureAdminAccount } from './database/ensureAdminAccount.js';
import { checkClientUrl, checkTrustProxy } from './config/environment.js';
import { pool } from './db.js';
import { checkEncryptionKey } from './lib/encryption.js';
import { createGracefulShutdown } from './lib/gracefulShutdown.js';
import { checkJwtSecret } from './lib/jwt.js';

const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGUSR2'];
const SHUTDOWN_TIMEOUT_MS = 10_000;

checkJwtSecret();
checkEncryptionKey();
checkClientUrl();
checkTrustProxy();

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

const shutDown = createGracefulShutdown({
  httpServer,
  collaboration,
  pool,
  timeoutMs: SHUTDOWN_TIMEOUT_MS,
});

for (const shutdownSignal of SHUTDOWN_SIGNALS) {
  process.once(shutdownSignal, () => shutDown(shutdownSignal));
}
