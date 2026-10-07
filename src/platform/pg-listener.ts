import pg from "pg";
import type { Logger } from "pino";
import { verifyRuntimeIdentity } from "./database.ts";

export function createPgListener(
  connectionString: string,
  logger: Pick<Logger, "warn">,
  wake: (room?: string) => void,
  count: (kind: string) => void,
) {
  let current: pg.Client | undefined;
  let stopped = false;
  let retry: NodeJS.Timeout | undefined;
  let attempt = 0;
  let connecting: Promise<void> | undefined;
  function reconnect() {
    if (stopped || retry) return;
    const delay =
      Math.min(30000, 500 * 2 ** Math.min(attempt++, 6)) *
      (0.75 + Math.random() * 0.5);
    retry = setTimeout(() => {
      retry = undefined;
      void connect();
    }, delay);
    retry.unref();
  }
  function connect() {
    if (connecting) return connecting;
    connecting = (async () => {
      const client = new pg.Client({
        connectionString,
        options: "-c search_path=pg_catalog,yaparena,pg_temp",
        connectionTimeoutMillis: 5000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10000,
        query_timeout: 5000,
        application_name: "yaparena-community-listener",
      });
      current = client;
      let failed = false;
      function lost() {
        if (failed || stopped) return;
        failed = true;
        count("listener_failure");
        logger.warn("community listener connection lost");
        if (current === client) current = undefined;
        void client.end().catch(() => {});
        reconnect();
      }
      client.on("error", lost);
      client.on("end", lost);
      client.on("notification", (notification) => {
        if (!failed && notification.channel === "yaparena_community_v1")
          wake(notification.payload);
      });
      try {
        await client.connect();
        await verifyRuntimeIdentity(client);
        // Autocommit LISTEN must finish before durable inspection (including reconnect).
        await client.query("LISTEN yaparena_community_v1");
        if (stopped || failed) {
          await client.end();
          return;
        }
        attempt = 0;
        count("listener_connected");
        wake();
      } catch {
        lost();
      }
    })().finally(() => {
      connecting = undefined;
    });
    return connecting;
  }
  return {
    start: connect,
    async stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      if (current) {
        const client = current;
        const deadline = setTimeout(
          () => client.connection.stream.destroy(),
          1500,
        );
        try {
          await client.end().catch(() => {});
        } finally {
          clearTimeout(deadline);
        }
      }
      await connecting;
    },
  };
}
