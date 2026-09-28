import type { Server } from "node:http";
import type { Express } from "express";
import type { Pool } from "pg";
import type { Logger } from "pino";
import type { createSessionRepository } from "./auth/sessions.ts";
import type { loadConfig } from "./config.ts";

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
}: {
  app: Express;
  database: Pick<Pool, "end">;
  sessions: Pick<ReturnType<typeof createSessionRepository>, "deleteExpired">;
  logger: Pick<Logger, "info" | "error">;
  config: Pick<ReturnType<typeof loadConfig>, "port" | "host">;
  verifyDatabase: () => Promise<void>;
  cleanupIntervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}) {
  let server: Server | undefined;
  let cleanupTimer: NodeJS.Timeout | undefined;

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

      server = await new Promise<Server>((resolve, reject) => {
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
        const listeningServer = server;
        await new Promise<void>((resolve, reject) => {
          listeningServer.close((error) => (error ? reject(error) : resolve()));
        });
      }

      await database.end();
    },
  });
}
