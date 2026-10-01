import type { Server } from "node:http";
import type { Express } from "express";
import type { Pool } from "pg";
import type { Logger } from "pino";
import type { createSessionRepository } from "./auth/sessions.ts";
import type { createIdentityRepository } from "../features/identity/repository.ts";
import type { createMatchingRepository } from "../features/matching/repository.ts";
import type { createMediaRepository } from "../features/media/repository.ts";
import type { createMediaProvider } from "../features/media/provider.ts";
import type { createWalletRepository } from "./auth/wallets.ts";
import type { loadConfig } from "./config.ts";

export function createRuntime({
  app,
  database,
  sessions,
  identity,
  matching,
  media,
  mediaProvider,
  wallets,
  logger,
  config,
  verifyDatabase,
  backgroundJobs = true,
  cleanupIntervalMs = 60 * 60 * 1_000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}: {
  app?: Express;
  database: Pick<Pool, "end">;
  sessions: Pick<ReturnType<typeof createSessionRepository>, "deleteExpired">;
  identity?: Pick<
    ReturnType<typeof createIdentityRepository>,
    "deleteExpiredAudit"
  >;
  matching?: Pick<
    ReturnType<typeof createMatchingRepository>,
    "expireRequests"
  >;
  media?: Pick<
    ReturnType<typeof createMediaRepository>,
    "tick" | "claimRecordingStops" | "recordingStopFailed"
  >;
  mediaProvider?: Pick<
    ReturnType<typeof createMediaProvider>,
    "stopRecording" | "setTurn"
  >;
  wallets?: Pick<
    ReturnType<typeof createWalletRepository>,
    "deleteExpiredChallenges"
  >;
  logger: Pick<Logger, "info" | "error">;
  config: Pick<ReturnType<typeof loadConfig>, "port" | "host">;
  verifyDatabase: () => Promise<void>;
  backgroundJobs?: boolean;
  cleanupIntervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}) {
  let server: Server | undefined;
  let cleanupTimer: NodeJS.Timeout | undefined;
  let mediaTimer: NodeJS.Timeout | undefined;
  let mediaTicking = false;

  async function tickMedia() {
    if (!media || mediaTicking) return;
    mediaTicking = true;
    try {
      const result = await media.tick();
      if (mediaProvider) {
        for (const turn of result.turns)
          await mediaProvider.setTurn(turn.debateId, turn.side);
        for (const debateId of result.ended)
          await mediaProvider.setTurn(debateId, null);
      }
    } catch (error) {
      logger.error({ error }, "media clock failed");
    }
    try {
      if (mediaProvider) {
        const due = await media.claimRecordingStops();
        for (const stop of due) {
          try {
            await mediaProvider.stopRecording(stop.egressId);
          } catch (error) {
            logger.error(
              { error, debateId: stop.debateId },
              "recording stop failed",
            );
            await media.recordingStopFailed(stop.debateId);
          }
        }
      }
    } catch (error) {
      logger.error({ error }, "recording stop queue failed");
    } finally {
      mediaTicking = false;
    }
  }

  async function cleanupSessions() {
    try {
      const deleted = await sessions.deleteExpired();
      if (deleted > 0) logger.info({ deleted }, "expired sessions deleted");
    } catch (error) {
      logger.error({ error }, "expired session cleanup failed");
    }
    if (wallets) {
      try {
        await wallets.deleteExpiredChallenges();
      } catch (error) {
        logger.error({ error }, "expired wallet challenge cleanup failed");
      }
    }
    if (identity) {
      try {
        await identity.deleteExpiredAudit();
      } catch (error) {
        logger.error({ error }, "identity audit cleanup failed");
      }
    }
    if (matching) {
      try {
        await matching.expireRequests();
      } catch (error) {
        logger.error({ error }, "debate request expiry failed");
      }
    }
  }

  return Object.freeze({
    async start() {
      await verifyDatabase();

      if (app) {
        server = await new Promise<Server>((resolve, reject) => {
          const listeningServer = app.listen(config.port, config.host, () =>
            resolve(listeningServer),
          );
          listeningServer.once("error", reject);
        });
      }

      if (backgroundJobs) {
        cleanupTimer = setIntervalFn(cleanupSessions, cleanupIntervalMs);
        if (app) cleanupTimer.unref();
        if (media) {
          mediaTimer = setIntervalFn(tickMedia, 1000);
          if (app) mediaTimer.unref();
        }
      }
      return server;
    },

    async stop() {
      if (cleanupTimer) clearIntervalFn(cleanupTimer);
      if (mediaTimer) clearIntervalFn(mediaTimer);

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
