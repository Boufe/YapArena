// One EventSource/page. The application cursor advances only after apply succeeds;
// EventSource's last received ID is never trusted as an application acknowledgment.
export function createCommunityStream({
  room,
  apply,
  unavailable,
  status,
  degraded,
  beforeConnect,
  EventSourceClass = globalThis.EventSource,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
  random = Math.random,
}) {
  let source;
  let timer;
  let freshness;
  let cursor = null;
  let stopped = false;
  let attempt = 0;
  let generation = 0;
  let applied = false;
  let lastFresh = now();
  let applying = Promise.resolve();
  let applyingSince = null;
  function close() {
    generation++;
    source?.close();
    source = undefined;
    clearTimer(freshness);
    applying = Promise.resolve();
    applyingSince = null;
  }
  function failed() {
    close();
    if (stopped) return;
    status("Connection interrupted. Polling while reconnecting…");
    degraded(true);
    clearTimer(timer);
    timer = setTimer(
      connect,
      Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)) *
        (0.75 + random() * 0.5),
    );
  }
  function checkFreshness() {
    if (stopped) return;
    if (
      now() - lastFresh > 45000 ||
      (applyingSince !== null && now() - applyingSince > 45000)
    ) {
      failed();
      return;
    }
    freshness = setTimer(checkFreshness, 5000);
  }
  function connect() {
    if (stopped) return;
    close();
    clearTimer(timer);
    beforeConnect();
    degraded(false);
    status(
      cursor
        ? "Reconnecting community updates…"
        : "Connecting community updates…",
    );
    if (!EventSourceClass) {
      failed();
      return;
    }
    const epoch = generation;
    source = new EventSourceClass(
      `/api/community/events/${room}/stream${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    lastFresh = now() - 35000; // Ten seconds to the first application frame/heartbeat.
    freshness = setTimer(checkFreshness, 5000);
    source.addEventListener("community", (event) => {
      applying = applying
        .then(async () => {
          if (epoch !== generation || stopped) return;
          await receive(
            JSON.parse(event.data),
            event.lastEventId,
            "stream",
            epoch,
          );
        })
        .catch(() => {
          if (epoch === generation) failed();
        });
    });
    source.addEventListener("heartbeat", (event) => {
      if (epoch !== generation || stopped) return;
      try {
        if (JSON.parse(event.data).version !== 1) throw new Error();
        // Resume with no new records is valid only after earlier state was applied.
        if (applied) {
          lastFresh = now();
          attempt = 0;
          degraded(false);
          status("Live updates on");
        }
      } catch {
        failed();
      }
    });
    source.addEventListener("unavailable", () => {
      if (epoch !== generation || stopped) return;
      stopped = true;
      close();
      clearTimer(timer);
      degraded(false);
      unavailable();
      status("This event is no longer public.");
    });
    source.onerror = () => {
      if (epoch === generation && !stopped) failed();
    };
  }
  async function receive(frame, receivedId, mode, epoch) {
    if (
      frame.version !== 1 ||
      frame.roomId !== room ||
      frame.cursor !== receivedId ||
      !new RegExp(`^v1:${room}:(0|[1-9]\\d{0,18})$`).test(frame.cursor) ||
      BigInt(frame.cursor.split(":")[2]) > 9223372036854775807n ||
      !["snapshot", "changes"].includes(frame.kind)
    )
      throw new Error("invalid community frame");
    const next = BigInt(frame.cursor.split(":")[2]);
    const previous = cursor === null ? -1n : BigInt(cursor.split(":")[2]);
    if (next > previous || !applied) {
      applyingSince = now();
      await apply(frame, mode);
      if (epoch !== generation || stopped) return;
      cursor = frame.cursor;
      applied = true;
      applyingSince = null;
    }
    if (mode === "stream") {
      lastFresh = now();
      attempt = 0;
      degraded(false);
      status("Live updates on");
    }
  }
  return {
    start: connect,
    async acceptHttp(frame) {
      const epoch = generation;
      if (frame.kind === "unavailable") {
        stopped = true;
        close();
        clearTimer(timer);
        degraded(false);
        unavailable();
        status("This event is no longer public.");
        return;
      }
      await receive(frame, frame.cursor, "poll", epoch);
    },
    reconnect() {
      if (!stopped) {
        attempt = 0;
        connect();
      }
    },
    suspend() {
      close();
      clearTimer(timer);
      degraded(false);
    },
    stop() {
      stopped = true;
      close();
      clearTimer(timer);
      degraded(false);
    },
    get cursor() {
      return cursor;
    },
  };
}
