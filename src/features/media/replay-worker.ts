import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Logger } from "pino";
import { buildReplayPackage, ReplayFailure } from "./replay-packaging.ts";
import type { createReplayJobs, ReplayJob } from "./replay-jobs.ts";
import type { createReplayStorage } from "./replay-storage.ts";

export type ReplayWorkerOptions = {
  concurrency?: number;
  pollMs?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  maxJobMs?: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  maxDurationSeconds?: number;
  maxFiles?: number;
  tempRoot?: string;
};
export function createReplayWorker({
  jobs,
  storage,
  logger,
  options = {},
  packageMedia = buildReplayPackage,
}: {
  jobs: ReturnType<typeof createReplayJobs>;
  storage: ReturnType<typeof createReplayStorage>;
  logger: Pick<Logger, "info" | "warn">;
  options?: ReplayWorkerOptions;
  packageMedia?: typeof buildReplayPackage;
}) {
  const limits = {
    concurrency: 1,
    pollMs: 5000,
    leaseMs: 60_000,
    heartbeatMs: 15_000,
    maxJobMs: 30 * 60 * 1000,
    maxInputBytes: 2 * 1024 ** 3,
    maxOutputBytes: 4 * 1024 ** 3,
    maxDurationSeconds: 7200,
    maxFiles: 11_000,
    ...options,
  };
  const bounds = {
    concurrency: [1, 2],
    pollMs: [1000, 60_000],
    leaseMs: [5000, 300_000],
    heartbeatMs: [100, 60_000],
    maxJobMs: [5000, 2 * 60 * 60 * 1000],
    maxInputBytes: [1, 2 * 1024 ** 3],
    maxOutputBytes: [1, 4 * 1024 ** 3],
    maxDurationSeconds: [1, 7200],
    maxFiles: [4, 11_000],
  };
  for (const [name, [low, high]] of Object.entries(bounds)) {
    const value = limits[name as keyof typeof bounds];
    if (!Number.isSafeInteger(value) || value < low! || value > high!)
      throw new RangeError("invalid replay worker bounds");
  }
  if (
    limits.heartbeatMs * 3 > limits.leaseMs ||
    limits.maxJobMs < limits.leaseMs
  )
    throw new RangeError("invalid replay worker lease");
  let timer: NodeJS.Timeout | undefined;
  let ticking: Promise<void> | undefined;
  let stopped = false;
  const controllers = new Set<AbortController>();
  async function processJob(job: ReplayJob) {
    const controller = new AbortController();
    controllers.add(controller);
    if (stopped) controller.abort(new ReplayFailure("cancelled"));
    const { signal } = controller;
    let directory: string | undefined;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let heartbeatPending: Promise<void> | undefined;
    const deadline = setTimeout(
      () => controller.abort(new ReplayFailure("job_timeout")),
      limits.maxJobMs,
    );
    const heartbeat = async () => {
      try {
        if (!(await jobs.heartbeat(job, limits.leaseMs)))
          controller.abort(new ReplayFailure("lease_lost"));
      } catch {
        controller.abort(new ReplayFailure("lease_lost"));
      }
    };
    const scheduleHeartbeat = () => {
      heartbeatTimer = setTimeout(() => {
        heartbeatPending = heartbeat().then(() => {
          if (!signal.aborted) scheduleHeartbeat();
        });
      }, limits.heartbeatMs);
    };
    scheduleHeartbeat();
    let failure: ReplayFailure | undefined;
    try {
      directory = await mkdtemp(
        resolve(limits.tempRoot ?? tmpdir(), "yaparena-replay-"),
      );
      const source = resolve(directory, "source.mp4");
      await storage.download(job.sourceKey, source, {
        signal,
        maxInputBytes: limits.maxInputBytes,
        acceptSource: (etag) => jobs.bindSource(job, etag),
      });
      const output = resolve(directory, "package");
      const manifest = await packageMedia(source, output, job.captionsVtt, {
        ...limits,
        signal,
      });
      const digest = await storage.upload(
        output,
        manifest,
        job.packageKey,
        signal,
        async () => {
          if (!(await jobs.heartbeat(job, limits.leaseMs)))
            throw new ReplayFailure("lease_lost");
        },
      );
      if (!(await jobs.complete(job, digest)))
        throw new ReplayFailure("lease_lost");
      logger.info(
        {
          event: "replay_ready",
          attempt: job.attempts,
          files: manifest.files.length,
          bytes: manifest.bytes,
        },
        "Adaptive replay ready",
      );
    } catch (error) {
      const reason = signal.aborted ? signal.reason : error;
      failure =
        reason instanceof ReplayFailure
          ? reason
          : new ReplayFailure("processing_failed");
      controller.abort(failure);
    } finally {
      clearTimeout(deadline);
      clearTimeout(heartbeatTimer);
      await heartbeatPending;
      // Encoder close and SDK abort must have settled before disk/prefix cleanup.
      if (directory) await rm(directory, { recursive: true, force: true });
      controllers.delete(controller);
    }
    if (failure) {
      await jobs.fail(job, failure.code, failure.retryable);
      logger.warn(
        { event: "replay_failed", code: failure.code, attempt: job.attempts },
        "Adaptive replay attempt failed",
      );
    }
  }
  async function cleanup() {
    const attempt = await jobs.claimCleanup(limits.leaseMs);
    if (!attempt) return;
    const controller = new AbortController();
    controllers.add(controller);
    const deadline = setTimeout(
      () => controller.abort(),
      Math.min(30_000, limits.leaseMs - 1000),
    );
    let success = false;
    try {
      await storage.removePackage(attempt.packageKey, controller.signal);
      success = true;
    } catch {
      logger.warn(
        { event: "replay_cleanup_failed" },
        "Adaptive replay cleanup will retry",
      );
    } finally {
      clearTimeout(deadline);
      controllers.delete(controller);
      await jobs.finishCleanup(attempt, success);
    }
  }
  function tick() {
    if (stopped) return Promise.resolve();
    if (ticking) return ticking;
    ticking = (async () => {
      await jobs.reconcile();
      await cleanup();
      await jobs.prune();
      const work: Promise<void>[] = [];
      for (let slot = 0; slot < limits.concurrency && !stopped; slot++) {
        const job = await jobs.claim(limits.leaseMs, limits.maxJobMs);
        if (!job) break;
        work.push(processJob(job));
      }
      // Drain every task even when a sibling hits a database failure.
      const results = await Promise.allSettled(work);
      for (const result of results)
        if (result.status === "rejected") throw result.reason;
    })().finally(() => {
      ticking = undefined;
    });
    return ticking;
  }
  const poll = () => {
    void tick().catch(() =>
      logger.warn({ event: "replay_queue_failed" }, "Replay queue will retry"),
    );
  };
  return Object.freeze({
    tick,
    start() {
      if (timer || stopped) return;
      timer = setInterval(poll, limits.pollMs);
      poll();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      for (const controller of controllers)
        controller.abort(new ReplayFailure("cancelled"));
      await ticking;
    },
  });
}
