import type { Logger } from "pino";
import type { Pool } from "pg";
import {
  createRoomFanout,
  type FanoutMetrics,
  type FanoutOptions,
} from "../../platform/room-fanout.ts";
import { createPgListener } from "../../platform/pg-listener.ts";
import { createCommunityDelivery, roomIdPattern } from "./delivery.ts";

export function createCommunityStreams(
  database: Pool,
  url: string,
  logger: Pick<Logger, "warn">,
  metrics: FanoutMetrics,
  options?: FanoutOptions,
) {
  const delivery = createCommunityDelivery(database);
  const fanout = createRoomFanout(
    async (room, after) => {
      const value = await delivery.read(room, after);
      return {
        head: value.head,
        floor: value.floor,
        eligible: value.eligible,
        snapshot: {
          summary: value.summary,
          items: value.items,
          hasMore: value.hasMore,
        },
        events: value.events.map((e) => ({
          cursor: e.cursor,
          reset: e.kind === "reset",
          at: e.occurredAt,
          change: { type: e.kind, message: e.message, summary: value.summary },
        })),
      };
    },
    metrics,
    options,
  );
  const listener = createPgListener(
    url,
    logger,
    (id) => {
      if (id === undefined || roomIdPattern.test(id)) fanout.wake(id);
      else metrics.count("invalid_hint");
    },
    (kind) => metrics.count(kind),
  );
  let cleanup: NodeJS.Timeout | undefined;
  let pruning: Promise<unknown> | undefined;
  return {
    subscribe: fanout.subscribe,
    async start() {
      // No durable reads before committed LISTEN registration.
      await listener.start();
      fanout.start();
      cleanup = setInterval(() => {
        if (pruning) return;
        pruning = delivery
          .prune()
          .catch(() => metrics.count("retention_failure"))
          .finally(() => {
            pruning = undefined;
          });
      }, 60000);
      cleanup.unref();
    },
    async stop() {
      if (cleanup) clearInterval(cleanup);
      const draining = fanout.stop();
      delivery.stop();
      await draining;
      await listener.stop();
      await pruning;
    },
  };
}
