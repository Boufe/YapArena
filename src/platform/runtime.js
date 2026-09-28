export function createRuntime({
  app,
  database,
  sessions,
  logger,
  config,
  verifyDatabase,
  cleanupIntervalMs = 60 * 60 * 1_000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  let server;
  let cleanupTimer;

  async function cleanupSessions() {
    try {
      const deleted = await sessions.deleteExpired();
      if (deleted > 0) logger.info({ deleted }, "expired sessions deleted");
    } catch (error) {
      logger.error({ error }, "expired session cleanup failed");
    }
  }

  return Object.freeze({
    async start() {
      await verifyDatabase();

      server = await new Promise((resolve, reject) => {
        const listeningServer = app.listen(config.port, config.host, () =>
          resolve(listeningServer),
        );
        listeningServer.once("error", reject);
      });

      cleanupTimer = setIntervalFn(cleanupSessions, cleanupIntervalMs);
      cleanupTimer.unref();
      return server;
    },

    async stop() {
      if (cleanupTimer) clearIntervalFn(cleanupTimer);

      if (server) {
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }

      await database.end();
    },
  });
}
