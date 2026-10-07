import assert from "node:assert/strict";
import { it } from "node:test";
import {
  createMediaRecovery,
  mayRecoverDisconnect,
} from "../public/media-recovery.js";

function setup(options = {}) {
  const jobs = new Map();
  let index = 0;
  let connected = true;
  let allowed = true;
  const calls = [];
  const controller = createMediaRecovery({
    join: async (role, current) => {
      calls.push({ role, current });
      controller.connected();
    },
    available: () => allowed,
    online: () => connected,
    schedule: (fn, ms) => {
      jobs.set(++index, { fn, ms });
      return index;
    },
    cancel: (id) => jobs.delete(id),
    random: () => 0.5,
    ...options,
  });
  return {
    controller,
    calls,
    jobs,
    offline: () => {
      connected = false;
    },
    online: () => {
      connected = true;
    },
    unavailable: () => {
      allowed = false;
    },
    async run() {
      const [id, job] = jobs.entries().next().value;
      jobs.delete(id);
      await job.fn();
    },
  };
}

it("allows SDK recovery before a bounded application rejoin for viewers and speakers", async () => {
  for (const role of ["viewer", "speaker"]) {
    const f = setup();
    f.controller.start(role);
    f.controller.connected();
    f.controller.retry();
    assert.equal(f.jobs.size, 0);
    f.controller.transportRecovering();
    f.controller.retry();
    assert.equal(f.jobs.size, 0);
    f.controller.disconnected(true);
    assert.equal(f.jobs.values().next().value.ms, 250);
    await f.run();
    assert.equal(f.calls[0].role, role);
    assert.equal(f.calls[0].current(), true);
    assert.equal(f.jobs.size, 0);
    f.controller.stop();
    assert.equal(f.calls[0].current(), false);
    assert.equal(f.controller.intent, undefined);
  }
});
it("suspends retries offline, cancels pending work on leave and refuses terminal reasons", async () => {
  const f = setup();
  f.controller.start("viewer");
  f.offline();
  f.controller.retry();
  assert.equal(f.jobs.size, 0);
  f.online();
  f.controller.retry();
  f.controller.offline();
  assert.equal(f.jobs.size, 0);
  f.controller.retry();
  f.controller.stop();
  assert.equal(f.jobs.size, 0);
  f.controller.start("speaker");
  f.controller.disconnected(false);
  assert.equal(f.controller.intent, undefined);
  f.controller.start("viewer");
  f.unavailable();
  f.controller.retry();
  assert.equal(f.jobs.size, 0);
  assert.equal(mayRecoverDisconnect(undefined), true);
  for (const reason of [0, 3, 6, 7, 8, 9, 14, 15])
    assert.equal(mayRecoverDisconnect(reason), true);
  for (const reason of [1, 2, 4, 5, 10, 11, 12, 13, 999])
    assert.equal(mayRecoverDisconnect(reason), false);
});
it("bounds failed retries and stops when a fresh grant or permission is denied", async () => {
  let exhausted = 0;
  const f = setup({
    join: async () => {
      throw new Error("temporary");
    },
    exhausted: () => exhausted++,
  });
  f.controller.start("viewer");
  f.controller.retry();
  f.controller.retry();
  for (let i = 0; i < 5; i++) await f.run();
  assert.equal(f.jobs.size, 0);
  assert.equal(exhausted, 1);
  for (const error of [
    { status: 401 },
    { status: 403 },
    { status: 404 },
    { status: 409 },
    { name: "NotAllowedError" },
    { name: "SecurityError" },
  ]) {
    const denied = setup({
      join: async () => {
        throw error;
      },
    });
    denied.controller.start("speaker");
    denied.controller.retry();
    await denied.run();
    assert.equal(denied.controller.intent, undefined);
  }
});
it("does not rejoin when offline or unavailable by the time the retry fires", async () => {
  for (const change of ["offline", "unavailable"]) {
    const f = setup();
    f.controller.start("viewer");
    f.controller.retry();
    f[change]();
    await f.run();
    assert.equal(f.calls.length, 0);
  }
  let current;
  const f = setup({
    join: async (_role, isCurrent) => {
      current = isCurrent;
      f.controller.stop();
    },
  });
  f.controller.start("viewer");
  f.controller.retry();
  await f.run();
  assert.equal(current(), false);
});

it("exhausts the retry budget across transport joins that immediately fail without stable playback", async () => {
  for (const role of ["viewer", "speaker"]) {
    let joins = 0;
    let exhausted = 0;
    const f = setup({
      join: async () => {
        joins++;
        f.controller.connected();
        f.controller.disconnected(true);
      },
      exhausted: () => exhausted++,
    });
    f.controller.start(role);
    f.controller.retry();
    for (const delay of [250, 750, 1500, 3000, 5000]) {
      assert.equal(f.jobs.values().next().value.ms, delay);
      await f.run();
    }
    assert.equal(joins, 5);
    assert.equal(exhausted, 1);
    assert.equal(f.jobs.size, 0);
    assert.equal(f.controller.intent, undefined);
    f.controller.retry();
    f.controller.disconnected(true);
    assert.equal(exhausted, 1);
    assert.equal(f.jobs.size, 0);
    f.controller.start(role);
    f.controller.retry();
    assert.equal(f.jobs.values().next().value.ms, 250);
    f.controller.stop();
  }
});

it("replenishes retries only after stable media evidence for the current connection", async () => {
  const f = setup();
  f.controller.start("viewer");
  assert.equal(
    f.controller.playbackStable(f.controller.connectionGeneration),
    false,
  );
  f.controller.retry();
  await f.run();
  const oldConnection = f.controller.connectionGeneration;
  f.controller.disconnected(true);
  assert.equal(f.jobs.values().next().value.ms, 750);
  assert.equal(f.controller.playbackStable(oldConnection), false);
  await f.run();
  assert.equal(f.controller.playbackStable(oldConnection), false);
  assert.equal(
    f.controller.playbackStable(f.controller.connectionGeneration),
    true,
  );
  f.controller.disconnected(true);
  assert.equal(f.jobs.values().next().value.ms, 250);
  await f.run();
  f.controller.stop();
});

it("rejects stable media evidence after SDK reconnecting, offline return or a new user session", () => {
  const f = setup();
  f.controller.start("speaker");
  f.controller.connected();
  const beforeReconnect = f.controller.connectionGeneration;
  f.controller.transportRecovering();
  assert.equal(f.controller.playbackStable(beforeReconnect), false);
  f.controller.connected();
  assert.equal(f.controller.playbackStable(beforeReconnect), false);
  const beforeOffline = f.controller.connectionGeneration;
  f.offline();
  f.controller.offline();
  const whileOffline = f.controller.connectionGeneration;
  assert.equal(f.controller.playbackStable(whileOffline), false);
  f.online();
  assert.equal(f.controller.playbackStable(beforeOffline), false);
  assert.equal(f.controller.playbackStable(whileOffline), true);
  f.controller.stop();
  assert.equal(f.controller.playbackStable(whileOffline), false);
  f.controller.start("speaker");
  f.controller.connected();
  assert.equal(f.controller.playbackStable(whileOffline), false);
  f.unavailable();
  assert.equal(
    f.controller.playbackStable(f.controller.connectionGeneration),
    false,
  );
  f.controller.stop();
});
