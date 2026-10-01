function closeHttpServer(httpServer) {
  return new Promise((resolve, reject) => {
    httpServer.close((error) => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
        return reject(error);
      }
      resolve();
    });
    httpServer.closeIdleConnections?.();
  });
}

export function createGracefulShutdown({ httpServer, collaboration, pool, timeoutMs, exit = process.exit }) {
  let isShuttingDown = false;

  return async function shutDown(signal) {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;
    console.log(`Signal ${signal} reçu : sauvegarde des documents ouverts avant l'arrêt`);

    const forcedExitTimer = setTimeout(() => {
      console.error(`Arrêt propre dépassant ${timeoutMs} ms : sortie forcée`);
      exit(1);
    }, timeoutMs);
    forcedExitTimer.unref();

    let exitCode = 0;
    try {
      await collaboration.close();
      await closeHttpServer(httpServer);
      await pool.end();
    } catch (error) {
      console.error("Arrêt propre de l'API impossible :", error.message);
      exitCode = 1;
    }
    clearTimeout(forcedExitTimer);
    exit(exitCode);
  };
}
