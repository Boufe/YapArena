import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import pg from "pg";
import { createSseSink, encodeSse } from "../dist/platform/sse.js";
import {
  createRoomFanout,
  defaultFanoutOptions,
} from "../dist/platform/room-fanout.js";
import { createPgListener } from "../dist/platform/pg-listener.js";
import {
  parseRoomCursor,
  roomCursor,
  publicFrame,
  createCommunityDelivery,
} from "../dist/features/community/delivery.js";
import { createCommunityStreams } from "../dist/features/community/streams.js";
import { createCommunityStream } from "../public/community-stream.js";

const room = "11111111-1111-4111-8111-111111111111";
class Response extends EventEmitter {
  writableLength = 0;
  frames = [];
  blocked = false;
  ended = false;
  destroyed = false;
  status(code) {
    this.code = code;
    return this;
  }
  set(headers, value) {
    this.headers = {
      ...this.headers,
      ...(typeof headers === "string" ? { [headers]: value } : headers),
    };
    return this;
  }
  flushHeaders() {}
  write(frame) {
    this.frames.push(frame.toString());
    return !this.blocked;
  }
  end() {
    this.ended = true;
    this.emit("close");
  }
  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
  json(value) {
    this.body = value;
    return this;
  }
  data() {
    return this.frames.map((f) => JSON.parse(f.split("\ndata: ")[1].trim()));
  }
}
const metrics = () => {
  const values = {};
  return {
    values,
    count: (kind) => (values[kind] = (values[kind] ?? 0) + 1),
    streams: (n) => (values.streams = n),
    rooms: (n) => (values.rooms = n),
    lag: (n) => (values.lag = n),
  };
};
const projection = (head = "1", events = []) => ({
  head,
  floor: "0",
  eligible: true,
  snapshot: { summary: { revision: head }, items: [] },
  events,
});
const event = (cursor, reset = false) => ({
  cursor,
  reset,
  change: { revision: cursor },
  at: new Date(),
});
const options = { ...defaultFanoutOptions, reconcileMs: 10, heartbeatMs: 100 };
async function until(fn) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await delay(5);
  }
  throw Error("test deadline");
}

describe("bounded SSE output and room fanout", () => {
  it("stops writing at backpressure, resumes on drain, and cleans listeners", () => {
    const response = new Response();
    let closed = 0;
    let pressure = 0;
    const sink = createSseSink(
      response,
      () => closed++,
      () => pressure++,
    );
    assert.equal(response.headers["X-Accel-Buffering"], "no");
    response.blocked = true;
    sink.send("change", { a: 1 }, roomCursor(room, "1"));
    sink.send("heartbeat", { version: 1 });
    assert.equal(response.frames.length, 1);
    response.blocked = false;
    response.emit("drain");
    assert.equal(response.frames.length, 2);
    assert.ok(!response.frames[1].includes("id:"));
    sink.close();
    sink.close();
    assert.equal(closed, 1);
    assert.equal(pressure, 0);
    assert.equal(sink.send("change", {}), false);
    assert.equal(response.listenerCount("drain"), 0);
  });
  it("disconnects on aggregate byte pressure and on stalled drain", async () => {
    const response = new Response();
    response.writableLength = 100;
    let pressure = 0;
    const sink = createSseSink(
      response,
      () => {},
      () => pressure++,
      128,
      10,
    );
    assert.equal(sink.send("change", { text: "x".repeat(100) }), false);
    assert.equal(response.destroyed, true);
    assert.equal(pressure, 1);
    const stalled = new Response();
    stalled.blocked = true;
    createSseSink(
      stalled,
      () => {},
      () => pressure++,
      1024,
      10,
    ).send("change", {});
    await until(() => stalled.destroyed);
    assert.equal(pressure, 2);
  });
  it("coalesces viewers into one room read and repairs missed wakeups", async () => {
    let reads = 0;
    let head = "1";
    const m = metrics();
    const fanout = createRoomFanout(
      async () => {
        reads++;
        return projection(head, head === "1" ? [] : [event("2")]);
      },
      m,
      options,
    );
    fanout.start();
    const a = new Response();
    const b = new Response();
    fanout.subscribe(room, null, "same-ip", a);
    fanout.subscribe(room, null, "same-ip", b);
    fanout.wake("absent");
    await until(() => a.frames.length && b.frames.length);
    assert.equal(reads, 1);
    assert.equal(m.values.streams, 2);
    head = "2";
    await until(
      () =>
        a.data().some((f) => f.kind === "changes") &&
        b.data().some((f) => f.kind === "changes"),
    );
    assert.equal(a.data().filter((f) => f.kind === "changes").length, 1);
    await until(() => a.frames.some((f) => f.startsWith("event: heartbeat")));
    await fanout.stop();
    assert.equal(m.values.streams, 0);
    assert.equal(m.values.rooms, 0);
    const refused = new Response();
    fanout.subscribe(room, null, "ip", refused);
    assert.equal(refused.code, 503);
  });
  it("keeps subscribers joining an in-flight read behind their own resume cursor", async () => {
    let release;
    let started = false;
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    const afters = [];
    const f = createRoomFanout(
      async (_id, after) => {
        afters.push(after);
        const events = Array.from({ length: 20 }, (_, i) =>
          event(String(i + 1)),
        )
          .filter((item) => BigInt(item.cursor) > BigInt(after))
          .slice(0, 10);
        if (afters.length === 1) {
          started = true;
          await barrier;
        }
        return projection("20", events);
      },
      metrics(),
      { ...options, reconcileMs: 1000, heartbeatMs: 1000 },
    );
    f.start();
    const existing = new Response(),
      closed = new Response();
    const reconnecting = new Response(),
      fresh = new Response();
    try {
      f.subscribe(room, "10", "same-ip", existing);
      f.subscribe(room, "10", "same-ip", closed);
      await until(() => started);
      f.subscribe(room, "0", "same-ip", reconnecting);
      f.subscribe(room, null, "same-ip", fresh);
      closed.end();
      release();
      await until(() =>
        reconnecting
          .data()
          .some((frame) => frame.cursor === roomCursor(room, "20")),
      );
      assert.deepEqual(
        reconnecting
          .data()
          .flatMap((frame) => frame.changes ?? [])
          .map((change) => change.revision),
        Array.from({ length: 20 }, (_, i) => String(i + 1)),
      );
      assert.equal(fresh.data()[0].kind, "snapshot");
      assert.equal(closed.frames.length, 0);
      assert.equal(afters[0], "10");
      assert.equal(afters[1], "0");
    } finally {
      release();
      await f.stop();
    }
  });
  it("resets retention/future cursors, preserves resumes, closes revoked rooms", async () => {
    let value = { ...projection("5", [event("4"), event("5")]), floor: "2" };
    const m = metrics();
    const f = createRoomFanout(async () => value, m, options);
    f.start();
    const gap = new Response(),
      future = new Response(),
      resume = new Response(),
      caught = new Response();
    f.subscribe(room, "1", "a", gap);
    f.subscribe(room, "9", "b", future);
    f.subscribe(room, "3", "c", resume);
    f.subscribe(room, "5", "d", caught);
    await until(
      () =>
        gap.frames.length &&
        future.frames.length &&
        resume.frames.length &&
        caught.frames.length,
    );
    assert.equal(gap.data()[0].kind, "snapshot");
    assert.equal(future.data()[0].kind, "snapshot");
    assert.equal(resume.data()[0].changes.length, 2);
    assert.ok(caught.frames[0].startsWith("event: heartbeat"));
    value = projection("6", [event("6", true)]);
    f.wake();
    await until(() => resume.data().some((v) => v.kind === "snapshot"));
    value = { ...value, eligible: false };
    f.wake(room);
    await until(() => resume.ended);
    assert.equal(resume.data().at(-1).version, 1);
    await f.stop();
  });
  it("bounds reads, admissions and recovery work and releases inactive rooms", async () => {
    let release;
    let inflight = 0;
    let maximum = 0;
    const hold = new Promise((resolve) => {
      release = resolve;
    });
    const m = metrics();
    const f = createRoomFanout(
      async () => {
        inflight++;
        maximum = Math.max(maximum, inflight);
        await hold;
        inflight--;
        return projection("1002");
      },
      m,
      { ...options, maxRooms: 2, maxStreams: 3, maxConcurrentReads: 1 },
    );
    f.start();
    const a = new Response(),
      b = new Response(),
      c = new Response();
    f.subscribe(room, "0", "a", a);
    f.subscribe("second", null, "b", b);
    f.subscribe("third", null, "c", c);
    assert.equal(c.code, 503);
    f.subscribe(room, "0", "d", c);
    const overflow = new Response();
    f.subscribe(room, null, "e", overflow);
    assert.equal(overflow.code, 503);
    await until(() => inflight === 1);
    release();
    await until(() => a.frames.length && b.frames.length);
    assert.equal(maximum, 1);
    assert.equal(a.data()[0].kind, "snapshot");
    a.end();
    c.end();
    await until(() => m.values.rooms === 1);
    await f.stop();
    assert.equal(m.values.streams, 0);
  });
  it("closes failed reads and bounds per-IP reconnect token memory", async () => {
    const m = metrics();
    const f = createRoomFanout(
      async () => {
        throw Error("synthetic");
      },
      m,
      options,
    );
    f.start();
    const a = new Response();
    f.subscribe(room, null, "ip", a);
    await until(() => a.ended);
    assert.equal(m.values.read_failure, 1);
    // Disconnect before each admission to test reconnect accounting rather than active limits.
    for (let i = 0; i < 1250; i++) {
      const r = new Response();
      f.subscribe(room, null, "storm", r);
      r.end();
    }
    assert.ok(m.values.admission_refused > 0);
    await f.stop();
  });
});

describe("versioned cursors and safe durable projections", () => {
  it("fits maximum escaped public payloads within the slow-client byte budget", () => {
    const item = {
      id: "9223372036854775807",
      debateId: room,
      authorName: "\u0001".repeat(80),
      body: "\u0001".repeat(500),
      state: "visible",
      createdAt: new Date().toISOString(),
      revision: "9223372036854775807",
      streamRevision: "9223372036854775807",
      clientMessageId: null,
    };
    const summary = {
      eventId: room,
      likes: "9223372036854775807",
      chatState: "open",
      chatWritable: true,
      eventStatus: "live",
      revision: item.revision,
    };
    for (const payload of [
      { snapshot: { items: Array(10).fill(item), summary, hasMore: true } },
      { changes: Array(10).fill({ type: "message", message: item, summary }) },
    ]) {
      const frame = encodeSse(
        "community",
        {
          version: 1,
          roomId: room,
          cursor: roomCursor(room, item.revision),
          ...payload,
        },
        roomCursor(room, item.revision),
      );
      assert.ok(frame.byteLength < 65536, String(frame.byteLength));
    }
  });

  it("cancels active reads on shutdown or their deadline and refuses further work", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const mode of ["stop", "deadline"]) {
      let rejectRead;
      let started;
      let released = 0;
      const waiting = new Promise((resolve) => {
        started = resolve;
      });
      const client = {
        connection: {
          stream: {
            destroy() {
              rejectRead(new Error("connection closed"));
            },
          },
        },
        query(sql) {
          if (sql.startsWith("BEGIN")) {
            started();
            return new Promise((_, reject) => {
              rejectRead = reject;
            });
          }
          return Promise.resolve({ rows: [] });
        },
        release() {
          released++;
        },
      };
      const source = createCommunityDelivery({ connect: async () => client });
      const pending = source.read(room, "0");
      await waiting;
      if (mode === "stop") source.stop();
      else t.mock.timers.tick(4000);
      await assert.rejects(pending, /connection closed/);
      assert.equal(released, 1);
      source.stop();
      await assert.rejects(source.read(room, "0"), /stopping/);
      assert.equal(released, 2);
    }
  });
  it("rejects malformed, overflowing and wrong-room IDs without Number conversion", () => {
    assert.equal(parseRoomCursor(room, undefined), null);
    assert.equal(
      parseRoomCursor(room, roomCursor(room, "9007199254740993")),
      "9007199254740993",
    );
    for (const value of [
      "",
      `v2:${room}:1`,
      "v1:other:1",
      `v1:${room}:01`,
      `v1:${room}:9223372036854775808`,
      `v1:${room}:-1`,
    ])
      assert.throws(() => parseRoomCursor(room, value), /invalid/);
  });
  it("resets gaps and projects the same bounded protocol for HTTP recovery", () => {
    const value = {
      head: "3",
      floor: "1",
      eligible: true,
      summary: { revision: "3" },
      items: [],
      hasMore: false,
      events: [
        {
          cursor: "2",
          kind: "message",
          message: { state: "removed", body: null },
        },
        { cursor: "3", kind: "summary", message: null },
      ],
    };
    assert.equal(publicFrame(room, null, value).kind, "snapshot");
    assert.equal(publicFrame(room, "0", value).kind, "snapshot");
    assert.equal(publicFrame(room, "4", value).kind, "snapshot");
    assert.equal(publicFrame(room, "1", value).changes.length, 2);
    assert.equal(
      publicFrame(room, "1", { ...value, events: value.events.slice(0, 1) })
        .more,
      true,
    );
    assert.equal(
      publicFrame(room, "3", { ...value, events: [] }).cursor,
      roomCursor(room, "3"),
    );
    assert.equal(
      publicFrame(room, "1", { ...value, head: "1002" }).kind,
      "snapshot",
    );
    assert.equal(
      publicFrame(room, "1", {
        ...value,
        events: [{ kind: "reset", cursor: "2" }],
      }).kind,
      "snapshot",
    );
    assert.equal(
      publicFrame(room, "1", { ...value, eligible: false }).kind,
      "unavailable",
    );
    assert.throws(() => parseRoomCursor(room, ["bad"]));
  });
  function pool({
    eligible = true,
    missing = false,
    fail = false,
    prune = true,
  } = {}) {
    const queries = [];
    let released = 0;
    const query = async (sql) => {
      queries.push(sql);
      if (sql.includes("AS head"))
        return {
          rows: [
            {
              head: "3",
              floor: "0",
              eligible,
              status: "live",
              likes: "9007199254740993",
              chatState: "open",
            },
          ],
        };
      if (sql.includes("ORDER BY m.id DESC"))
        return {
          rows: Array.from({ length: 21 }, (_, i) => ({ id: String(i + 1) })),
        };
      if (sql.includes("occurred_at AS"))
        return {
          rows: [
            {
              cursor: "2",
              kind: "message",
              messageId: "9",
              messageRevision: "2",
              occurredAt: new Date(),
            },
          ],
        };
      if (sql.includes("m.id=ANY")) {
        if (fail) throw Error("synthetic");
        return {
          rows: missing
            ? []
            : [{ id: "9", body: null, state: "removed", revision: "2" }],
        };
      }
      if (sql.includes("SELECT DISTINCT room_id"))
        return { rows: prune ? [{ room_id: room }] : [] };
      if (sql.includes("RETURNING cursor"))
        return { rows: prune ? [{ cursor: "1" }, { cursor: "2" }] : [] };
      return { rows: [] };
    };
    return {
      queries,
      get released() {
        return released;
      },
      connect: async () => ({
        query,
        release() {
          released++;
        },
      }),
    };
  }
  it("binds snapshot, head and public visibility to one short transaction", async () => {
    const db = pool();
    const r = await createCommunityDelivery(db).read(room, "0");
    assert.equal(r.summary.likes, "9007199254740993");
    assert.equal(r.hasMore, true);
    assert.equal(r.items.length, 10);
    assert.equal(r.events[0].message.body, null);
    assert.ok(db.queries[0].includes("REPEATABLE READ READ ONLY"));
    assert.equal(db.queries.at(-1), "COMMIT");
    assert.equal(db.released, 1);
    const hidden = await createCommunityDelivery(
      pool({ eligible: false }),
    ).read(room, "0");
    assert.deepEqual(hidden.items, []);
    assert.equal(hidden.summary.chatWritable, false);
  });
  it("redacts purged messages and rolls back read failures", async () => {
    const deleted = await createCommunityDelivery(pool({ missing: true })).read(
      room,
      "0",
    );
    assert.equal(deleted.events[0].message.state, "removed");
    assert.equal(deleted.events[0].message.clientMessageId, null);
    const db = pool({ fail: true });
    await assert.rejects(
      createCommunityDelivery(db).read(room, "0"),
      /synthetic/,
    );
    assert.equal(db.queries.at(-1), "ROLLBACK");
    assert.equal(db.released, 1);
  });
  it("bounds retention and atomically advances its recovery floor", async () => {
    const db = pool();
    assert.equal(await createCommunityDelivery(db).prune(), 2);
    assert.ok(db.queries.some((q) => q.includes("FOR UPDATE")));
    assert.ok(db.queries.some((q) => q.includes("retained_after=GREATEST")));
    assert.equal(
      await createCommunityDelivery(pool({ prune: false })).prune(),
      0,
    );
  });
});

describe("persistent runtime listener", () => {
  it("verifies identity before committed LISTEN, reconnects then wakes durable reads", async () => {
    const Original = pg.Client;
    const clients = [];
    const order = [];
    let failedConnect = false;
    class Client extends EventEmitter {
      constructor() {
        super();
        clients.push(this);
      }
      async connect() {
        order.push("connect");
        if (failedConnect) {
          failedConnect = false;
          throw Error("synthetic");
        }
      }
      async query(sql) {
        order.push(sql.startsWith("LISTEN") ? "LISTEN" : "identity");
        return { rows: [{ safe: true }] };
      }
      async end() {
        this.emit("end");
      }
    }
    pg.Client = Client;
    const m = metrics();
    let wakes = 0;
    const listener = createPgListener(
      "synthetic",
      { warn() {} },
      () => {
        order.push("wake");
        wakes++;
      },
      m.count,
    );
    try {
      await listener.start();
      assert.deepEqual(order.slice(0, 4), [
        "connect",
        "identity",
        "LISTEN",
        "wake",
      ]);
      clients[0].emit("notification", { channel: "other", payload: room });
      assert.equal(wakes, 1);
      clients[0].emit("notification", {
        channel: "yaparena_community_v1",
        payload: room,
      });
      assert.equal(wakes, 2);
      clients[0].emit("error", Error("synthetic"));
      await until(() => clients.length >= 2 && wakes >= 3);
      assert.equal(m.values.listener_failure, 1);
      await listener.stop();
      await listener.stop();
      failedConnect = true;
      const failed = createPgListener(
        "synthetic",
        { warn() {} },
        () => {},
        m.count,
      );
      await failed.start();
      await failed.stop();
      assert.equal(m.values.listener_failure, 2);
      const db = {
        connect: async () => ({
          query: async (sql) =>
            sql.includes("AS head")
              ? {
                  rows: [
                    {
                      head: "0",
                      floor: "0",
                      eligible: false,
                      status: "unavailable",
                      likes: "0",
                      chatState: "open",
                    },
                  ],
                }
              : { rows: [] },
          release() {},
        }),
      };
      const streams = createCommunityStreams(
        db,
        "synthetic",
        { warn() {} },
        m,
        options,
      );
      await streams.start();
      const res = new Response();
      streams.subscribe(room, null, "ip", res);
      await until(() => res.ended);
      await streams.stop();
    } finally {
      await listener.stop();
      pg.Client = Original;
    }
  });
});

class BrowserSource {
  static instances = [];
  handlers = new Map();
  closed = false;
  constructor(url) {
    this.url = url;
    BrowserSource.instances.push(this);
  }
  addEventListener(type, fn) {
    this.handlers.set(type, fn);
  }
  close() {
    this.closed = true;
  }
  emit(type, value, id) {
    this.handlers.get(type)?.({
      data: typeof value === "string" ? value : JSON.stringify(value),
      lastEventId: id,
    });
  }
}
function client(overrides = {}) {
  BrowserSource.instances = [];
  const timers = new Map();
  let next = 1;
  let time = 0;
  const statuses = [];
  const modes = [];
  const frames = [];
  const transport = createCommunityStream({
    room,
    EventSourceClass: BrowserSource,
    apply: (frame) => frames.push(frame),
    unavailable: () => statuses.push("revoked"),
    status: (value) => statuses.push(value),
    degraded: (value) => modes.push(value),
    beforeConnect() {},
    now: () => time,
    setTimer: (fn, ms) => {
      const id = next++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    random: () => 0.5,
    ...overrides,
  });
  return {
    transport,
    statuses,
    modes,
    frames,
    timers,
    set time(value) {
      time = value;
    },
    async flush() {
      await delay(0);
    },
    runTimer() {
      const [id, timer] = [...timers].at(-1);
      timers.delete(id);
      timer.fn();
    },
  };
}
const frame = (cursor, kind = "changes") => ({
  version: 1,
  roomId: room,
  cursor: roomCursor(room, cursor),
  kind,
  changes: [],
});
describe("application cursor and reconnect switching", () => {
  it("advances only applied frames, ignores duplicates, and supplies explicit resume", async () => {
    const c = client();
    c.transport.start();
    const source = BrowserSource.instances[0];
    source.emit(
      "community",
      frame("9007199254740993"),
      roomCursor(room, "9007199254740993"),
    );
    await c.flush();
    source.emit(
      "community",
      frame("9007199254740993"),
      roomCursor(room, "9007199254740993"),
    );
    await c.flush();
    assert.equal(c.frames.length, 1);
    source.emit("heartbeat", { version: 1 });
    assert.equal(c.transport.cursor, roomCursor(room, "9007199254740993"));
    c.transport.reconnect();
    assert.ok(BrowserSource.instances[1].url.includes("cursor=v1%3A"));
    assert.equal(source.closed, true);
    c.transport.suspend();
    c.transport.stop();
    assert.equal(c.timers.size, 0);
  });
  it("keeps failed application behind the received ID and cancels obsolete work", async () => {
    let reject = false;
    const c = client({
      apply() {
        if (reject) throw Error("synthetic application failure");
      },
    });
    c.transport.start();
    let source = BrowserSource.instances[0];
    source.emit("community", frame("1"), roomCursor(room, "1"));
    await c.flush();
    reject = true;
    source.emit("community", frame("2"), roomCursor(room, "2"));
    await c.flush();
    assert.equal(c.transport.cursor, roomCursor(room, "1"));
    assert.equal(c.modes.at(-1), true);
    reject = false;
    c.runTimer();
    source = BrowserSource.instances.at(-1);
    assert.ok(
      source.url.endsWith("v1%3A11111111-1111-4111-8111-111111111111%3A1"),
    );
    source.emit("community", frame("2"), roomCursor(room, "2"));
    c.transport.suspend();
    await c.flush();
    assert.equal(c.transport.cursor, roomCursor(room, "1"));
    c.transport.stop();
  });
  it("shares application acknowledgments with degraded HTTP without marking the stream healthy", async () => {
    const c = client();
    c.transport.start();
    await c.transport.acceptHttp(frame("1"));
    assert.equal(c.transport.cursor, roomCursor(room, "1"));
    assert.ok(!c.statuses.includes("Live updates on"));
    c.transport.reconnect();
    const source = BrowserSource.instances.at(-1);
    source.emit("heartbeat", { version: 1 });
    assert.equal(c.statuses.at(-1), "Live updates on");
    await c.transport.acceptHttp({
      version: 1,
      roomId: room,
      kind: "unavailable",
    });
    assert.equal(c.statuses.at(-1), "This event is no longer public.");
    c.transport.stop();
  });
  it("recovers malformed frames and stale applications and stops on revocation", async () => {
    const c = client();
    c.transport.start();
    let source = BrowserSource.instances[0];
    source.emit("community", "invalid-json", "x");
    await c.flush();
    assert.equal(c.transport.cursor, null);
    c.runTimer();
    source = BrowserSource.instances.at(-1);
    source.emit(
      "community",
      { ...frame("1"), version: 2 },
      roomCursor(room, "1"),
    );
    await c.flush();
    c.runTimer();
    source = BrowserSource.instances.at(-1);
    source.emit("heartbeat", "bad-json");
    c.runTimer();
    c.time = 100000;
    c.runTimer();
    assert.equal(c.modes.at(-1), true);
    c.runTimer();
    source = BrowserSource.instances.at(-1);
    source.emit("unavailable", { version: 1 });
    assert.equal(c.statuses.at(-1), "This event is no longer public.");
    const n = BrowserSource.instances.length;
    c.transport.reconnect();
    assert.equal(BrowserSource.instances.length, n);
    c.transport.stop();
    const unsupported = client({ EventSourceClass: null });
    unsupported.transport.start();
    assert.equal(unsupported.modes.at(-1), true);
    unsupported.transport.stop();
  });
});
