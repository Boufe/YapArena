import type { Server } from "node:http";
import type { Express } from "express";
import type { Pool } from "pg";
import type { Logger } from "pino";
import type { createSessionRepository } from "./auth/sessions.ts";
import type { createIdentityRepository } from "../features/identity/repository.ts";
import type { createMatchingRepository } from "../features/matching/repository.ts";
import type { createMediaRepository } from "../features/media/repository.ts";
import type { createMediaProvider } from "../features/media/provider.ts";
import type { createCommunityRepository } from "../features/community/repository.ts";
import type { createMeasurementRepository } from "../features/measurement/repository.ts";
import type { createProviderRevocation } from "./auth/provider-revocation.ts";
import type { createEmbeddedWalletProvisioning } from "./auth/embedded-wallet-provisioning.ts";
import type { loadConfig } from "./config.ts";
import type { createMetrics } from "./metrics.ts";

const providerIntervalMs = 10_000;

export function createRuntime({
  app,
  a4,
  coinDebates,
  database,
  sessions,
  accountSecurityCleanup,
  mediaAccountRevocation,
  identity,
  matching,
  community,
  communityStreams,
  measurement,
  media,
  mediaProvider,
  mediaOperations,
  providerRevocation,
  embeddedWallet,
  metrics,
  logger,
  config,
  verifyDatabase,
  backgroundJobs = true,
  cleanupIntervalMs = 60 * 60 * 1_000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}: {
  app?: Express;
  a4?: { tick(): Promise<void> };
  coinDebates?: { advance(): Promise<unknown> };
  database: Pick<Pool, "end">;
  sessions: Pick<ReturnType<typeof createSessionRepository>, "deleteExpired">;
  accountSecurityCleanup?: () => Promise<void>;
  mediaAccountRevocation?: { flush(): Promise<unknown> };
  identity?: Pick<
    ReturnType<typeof createIdentityRepository>,
    "deleteExpiredAudit"
  >;
  matching?: Pick<
    ReturnType<typeof createMatchingRepository>,
    "expireRequests"
  >;
  community?: Pick<
    ReturnType<typeof createCommunityRepository>,
    "pruneExpired"
  >;
  communityStreams?: { start(): Promise<void>; stop(): Promise<void> };
  measurement?: Pick<
    ReturnType<typeof createMeasurementRepository>,
    "pruneExpired"
  >;
  media?: Pick<
    ReturnType<typeof createMediaRepository>,
    "tick" | "claimRecordingStops" | "recordingStopFailed"
  >;
  mediaProvider?: Pick<
    ReturnType<typeof createMediaProvider>,
    "stopRecording" | "setTurn"
  >;
  mediaOperations?: { tick(): Promise<void>; stop(): Promise<void> };
  providerRevocation?: Pick<
    ReturnType<typeof createProviderRevocation>,
    "synchronize"
  >;
  embeddedWallet?: Pick<
    ReturnType<typeof createEmbeddedWalletProvisioning>,
    "process"
  >;
  metrics?: Pick<ReturnType<typeof createMetrics>, "authJourney">;
  logger: Pick<Logger, "info" | "error">;
  config: Pick<ReturnType<typeof loadConfig>, "port" | "host">;
  verifyDatabase: () => Promise<void>;
  backgroundJobs?: boolean;
  cleanupIntervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}) {
  let server: Server | undefined;
  let a4Timer: NodeJS.Timeout | undefined;
  let a4Task: Promise<void> | undefined;
  let a4Ticking = false;
  let speakerTimer: NodeJS.Timeout | undefined;
  let speakerTask: Promise<void> | undefined;
  let speakerWorking = false;
  let cleanupTimer: NodeJS.Timeout | undefined;
  let mediaTimer: NodeJS.Timeout | undefined;
  let mediaTicking = false;
  let mediaTask: Promise<void> | undefined;
  let providerTimer: NodeJS.Timeout | undefined;
  let providerWork: Promise<void> | undefined;
  let embeddedWalletTimer: NodeJS.Timeout | undefined;
  let embeddedWalletWork: Promise<void> | undefined;
  let stopping = false;
  const completedJobs = new Set<string>();

  // One line per job after its first completed run lets operators confirm that
  // this process runs the job; failures are logged separately as errors.
  function completed(job: string) {
    if (completedJobs.has(job)) return;
    completedJobs.add(job);
    logger.info({ job }, "background job ran");
  }

  async function tickMedia() {
    if (!media || mediaTicking || stopping) return;
    mediaTicking = true;
    try {
      const result = mediaOperations
        ? (await mediaOperations.tick(), undefined)
        : await media.tick();
      if (mediaProvider && result) {
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
          if (stopping) break;
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
      completed("media-clock");
    }
  }

  async function cleanupSessions() {
    try {
      const deleted = await sessions.deleteExpired();
      if (deleted > 0) logger.info({ deleted }, "expired sessions deleted");
    } catch (error) {
      logger.error({ error }, "expired session cleanup failed");
    }
    if (accountSecurityCleanup) {
      try {
        await accountSecurityCleanup();
      } catch (error) {
        logger.error({ error }, "expired account authorization cleanup failed");
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
    if (community) {
      try {
        await community.pruneExpired();
      } catch (error) {
        logger.error({ error }, "community retention cleanup failed");
      }
    }
    if (measurement) {
      try {
        await measurement.pruneExpired();
      } catch (error) {
        logger.error({ error }, "product measurement retention cleanup failed");
      }
    }
    completed("cleanup");
  }

  return Object.freeze({
    async start() {
      await verifyDatabase();
      await communityStreams?.start();

      if (app) {
        server = await new Promise<Server>((resolve, reject) => {
          const listeningServer = app.listen(config.port, config.host, () =>
            resolve(listeningServer),
          );
          listeningServer.once("error", reject);
        });
      }

      if (backgroundJobs) {
        if (mediaAccountRevocation) {
          speakerTimer = setIntervalFn(() => {
            if (speakerWorking || stopping) return speakerTask;
            speakerWorking = true;
            speakerTask = mediaAccountRevocation
              .flush()
              .then(() => {})
              .catch((error) =>
                logger.error({ error }, "speaker access revocation failed"),
              )
              .finally(() => {
                speakerWorking = false;
                completed("speaker-revocation");
              });
            return speakerTask;
          }, 1000);
          if (app) speakerTimer.unref();
        }
        if (a4 || coinDebates) {
          a4Timer = setIntervalFn(() => {
            if (a4Ticking || stopping) return a4Task;
            a4Ticking = true;
            a4Task = Promise.allSettled([a4?.tick(), coinDebates?.advance()])
              .then((results) => {
                for (const result of results)
                  if (result.status === "rejected")
                    logger.error(
                      { error: result.reason },
                      "A4 recovery tick failed",
                    );
              })
              .finally(() => {
                a4Ticking = false;
                completed("a4-recovery");
              });
            return a4Task;
          }, 1000);
          if (app) a4Timer.unref();
        }
        cleanupTimer = setIntervalFn(cleanupSessions, cleanupIntervalMs);
        if (app) cleanupTimer.unref();
        if (media) {
          mediaTimer = setIntervalFn(() => {
            if (!mediaTicking) mediaTask = tickMedia();
            return mediaTask;
          }, 1000);
          if (app) mediaTimer.unref();
        }
        // Privy session revocation and embedded-wallet provisioning run once at
        // start, then every ten seconds, each without overlapping itself.
        if (providerRevocation) {
          const synchronizeProvider = () => {
            if (providerWork || stopping) return providerWork;
            providerWork = providerRevocation
              .synchronize()
              .catch(() => {
                metrics?.authJourney.inc({
                  event: "provider_revocation_retry",
                });
              })
              .finally(() => {
                providerWork = undefined;
                completed("provider-revocation");
              });
            return providerWork;
          };
          providerTimer = setIntervalFn(
            synchronizeProvider,
            providerIntervalMs,
          );
          if (app) providerTimer.unref();
          void synchronizeProvider();
        }
        if (embeddedWallet) {
          const synchronizeEmbeddedWallet = () => {
            if (embeddedWalletWork || stopping) return embeddedWalletWork;
            embeddedWalletWork = embeddedWallet
              .process(1)
              .then((result) => {
                if (result.ready)
                  metrics?.authJourney.inc(
                    { event: "embedded_wallet_ready" },
                    result.ready,
                  );
                if (result.retry)
                  metrics?.authJourney.inc(
                    { event: "embedded_wallet_retry" },
                    result.retry,
                  );
                if (result.review)
                  metrics?.authJourney.inc(
                    { event: "embedded_wallet_review" },
                    result.review,
                  );
              })
              .catch(() => {
                metrics?.authJourney.inc({
                  event: "embedded_wallet_worker_error",
                });
              })
              .finally(() => {
                embeddedWalletWork = undefined;
                completed("embedded-wallet");
              });
            return embeddedWalletWork;
          };
          embeddedWalletTimer = setIntervalFn(
            synchronizeEmbeddedWallet,
            providerIntervalMs,
          );
          if (app) embeddedWalletTimer.unref();
          void synchronizeEmbeddedWallet();
        }
      }
      return server;
    },

    async stop() {
      stopping = true;
      if (a4Timer) clearIntervalFn(a4Timer);
      if (speakerTimer) clearIntervalFn(speakerTimer);
      if (providerTimer) clearIntervalFn(providerTimer);
      if (embeddedWalletTimer) clearIntervalFn(embeddedWalletTimer);
      await providerWork;
      await embeddedWalletWork;
      await speakerTask;
      await a4Task;
      if (cleanupTimer) clearIntervalFn(cleanupTimer);
      if (mediaTimer) clearIntervalFn(mediaTimer);
      await Promise.all([mediaTask, mediaOperations?.stop()]);
      await communityStreams?.stop();

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
