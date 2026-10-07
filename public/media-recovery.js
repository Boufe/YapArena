// SDK transport recovery owns the connected/reconnecting phase. The application
// requests a fresh grant only after a recoverable terminal disconnect.
export function createMediaRecovery({
  join,
  available,
  online,
  schedule,
  cancel,
  random = Math.random,
  exhausted = () => {},
}) {
  let intent;
  let generation = 0;
  let attempt = 0;
  let timer;
  let running = false;
  let transportRecovering = false;
  let transportConnected = false;
  let connectionGeneration = 0;
  const delays = [250, 750, 1500, 3000, 5000];
  const clear = () => {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  };
  function retry() {
    if (
      !intent ||
      running ||
      timer !== undefined ||
      transportRecovering ||
      !online() ||
      !available(intent)
    )
      return;
    if (attempt >= delays.length) {
      stop();
      exhausted();
      return;
    }
    const role = intent;
    const epoch = generation;
    const delay = delays[attempt++] * (0.75 + random() * 0.5);
    timer = schedule(async () => {
      timer = undefined;
      if (epoch !== generation || !online() || !available(role)) return;
      running = true;
      try {
        await join(role, () => epoch === generation && intent === role);
      } catch (error) {
        if (
          [401, 403, 404, 409].includes(error.status) ||
          ["NotAllowedError", "SecurityError"].includes(error.name)
        )
          stop();
      } finally {
        running = false;
        if (epoch === generation && intent && !transportRecovering) retry();
      }
    }, delay);
  }
  function stop() {
    clear();
    intent = undefined;
    generation++;
    attempt = 0;
    transportRecovering = false;
    transportConnected = false;
    connectionGeneration++;
  }
  return {
    start(role) {
      stop();
      intent = role;
    },
    stop,
    retry,
    transportRecovering() {
      transportRecovering = true;
      transportConnected = false;
      connectionGeneration++;
      clear();
    },
    connected() {
      transportRecovering = true;
      transportConnected = true;
      connectionGeneration++;
      clear();
    },
    disconnected(recoverable) {
      transportRecovering = false;
      transportConnected = false;
      connectionGeneration++;
      if (recoverable) retry();
      else stop();
    },
    offline() {
      connectionGeneration++;
      clear();
    },
    // The caller measures uninterrupted media progress before supplying the
    // captured connection generation. Transport success alone cannot replenish
    // the budget, and evidence from a previous connection must not reset it.
    playbackStable(epoch) {
      if (
        !intent ||
        !transportConnected ||
        epoch !== connectionGeneration ||
        !online() ||
        !available(intent)
      )
        return false;
      attempt = 0;
      return true;
    },
    get intent() {
      return intent;
    },
    get generation() {
      return generation;
    },
    get connectionGeneration() {
      return connectionGeneration;
    },
  };
}

export function mayRecoverDisconnect(reason) {
  // livekit-client 2.22.3 DisconnectReason: unknown, shutdown, mismatch,
  // join failure, migration, signal close and connection/media failure only.
  return reason === undefined || [0, 3, 6, 7, 8, 9, 14, 15].includes(reason);
}
