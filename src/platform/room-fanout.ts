import type { Response } from "express";
import { createSseSink, encodeSse, type StreamSink } from "./sse.ts";

export interface RoomProjection {
  head: string;
  floor: string;
  eligible: boolean;
  snapshot: unknown;
  events: { cursor: string; reset: boolean; change: unknown; at: Date }[];
}
export interface FanoutMetrics {
  count(kind: string): void;
  streams(value: number): void;
  rooms(value: number): void;
  lag(seconds: number): void;
}
interface Subscriber {
  cursor: string | null;
  sink: StreamSink;
  ip: string;
  replays: number;
  first: boolean;
}
interface Room {
  id: string;
  subscribers: Set<Subscriber>;
  dirty: boolean;
  busy: boolean;
}
export interface FanoutOptions {
  maxStreams: number;
  maxRooms: number;
  maxConcurrentReads: number;
  reconcileMs: number;
  heartbeatMs: number;
  bufferBytes: number;
}
export const defaultFanoutOptions: FanoutOptions = {
  maxStreams: 500,
  maxRooms: 50,
  maxConcurrentReads: 4,
  reconcileMs: 5000,
  heartbeatMs: 15000,
  bufferBytes: 65536,
};

export function createRoomFanout(
  read: (room: string, after: string) => Promise<RoomProjection>,
  metrics: FanoutMetrics,
  options: FanoutOptions = defaultFanoutOptions,
) {
  const rooms = new Map<string, Room>();
  const admissions = new Map<string, { tokens: number; at: number }>();
  let streams = 0;
  let reads = 0;
  let stopped = false;
  let reconciliation: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let scheduled: NodeJS.Timeout | undefined;
  let readTokens = 20;
  let lastRefill = performance.now();
  const tasks = new Set<Promise<void>>();
  const heartbeatFrame = encodeSse("heartbeat", { version: 1 });
  function schedule() {
    if (!stopped && !scheduled)
      scheduled = setTimeout(() => {
        scheduled = undefined;
        pump();
      }, 25);
  }
  function admit(ip: string) {
    const now = Date.now();
    // Bounded, expiring token table, generous to shared-IP audiences. Concurrent
    // process/room limits are primary; no user IDs enter metrics or retained logs.
    for (const [key, value] of admissions)
      if (now - value.at > 60000) admissions.delete(key);
    let value = admissions.get(ip);
    if (!value) {
      if (admissions.size >= 2048) return false;
      value = { tokens: 1200, at: now };
      admissions.set(ip, value);
    }
    value.tokens = Math.min(1200, value.tokens + (now - value.at) * 0.05);
    value.at = now;
    if (value.tokens < 1) return false;
    value.tokens--;
    return true;
  }
  function envelope(
    room: Room,
    cursor: string,
    kind: string,
    projection: RoomProjection,
    changes: unknown[] = [],
  ) {
    return {
      version: 1,
      roomId: room.id,
      cursor: `v1:${room.id}:${cursor}`,
      kind,
      snapshot: kind === "snapshot" ? projection.snapshot : undefined,
      changes: kind === "changes" ? changes : undefined,
    };
  }
  async function refresh(room: Room) {
    // This read belongs to this subscriber cohort and its minimum cursor.
    // A reconnect joining while PostgreSQL is reading may have an older cursor;
    // subscribe marks the room dirty so that subscriber gets a subsequent read.
    const subscribers = [...room.subscribers];
    const cursors = subscribers.flatMap((s) =>
      s.cursor === null ? [] : [s.cursor],
    );
    const after = cursors.reduce(
      (a, b) => (BigInt(a) < BigInt(b) ? a : b),
      cursors[0] ?? "0",
    );
    try {
      const projection = await read(room.id, after);
      if (stopped || rooms.get(room.id) !== room) return;
      const encoded = new Map<string, Buffer>();
      function send(
        sub: Subscriber,
        cursor: string,
        kind: string,
        changes: unknown[] = [],
      ) {
        const key = `${kind}:${cursor}:${kind === "changes" ? sub.cursor : ""}`;
        let frame = encoded.get(key);
        if (!frame) {
          frame = encodeSse(
            "community",
            envelope(room, cursor, kind, projection, changes),
            `v1:${room.id}:${cursor}`,
          );
          encoded.set(key, frame);
        }
        return sub.sink.sendFrame(frame);
      }
      for (const sub of subscribers) {
        if (!room.subscribers.has(sub)) continue;
        if (!projection.eligible) {
          sub.sink.send("unavailable", { version: 1, roomId: room.id });
          sub.sink.close();
          continue;
        }
        const reset =
          sub.cursor === null ||
          BigInt(sub.cursor) > BigInt(projection.head) ||
          BigInt(sub.cursor) < BigInt(projection.floor) ||
          BigInt(projection.head) - BigInt(sub.cursor) > 1000n ||
          sub.replays >= 100 ||
          projection.events.some(
            (e) => e.reset && BigInt(e.cursor) > BigInt(sub.cursor ?? "0"),
          );
        if (reset) {
          if (send(sub, projection.head, "snapshot")) {
            sub.cursor = projection.head;
            sub.replays = 0;
            sub.first = false;
            metrics.count("snapshot");
          }
          continue;
        }
        const events = projection.events.filter(
          (e) => BigInt(e.cursor) > BigInt(sub.cursor!),
        );
        if (events.length) {
          const cursor = events.at(-1)!.cursor;
          if (
            send(
              sub,
              cursor,
              "changes",
              events.map((e) => e.change),
            )
          ) {
            sub.cursor = cursor;
            sub.first = false;
            sub.replays++;
            metrics.count("catchup");
            for (const e of events)
              metrics.lag(Math.max(0, (Date.now() - e.at.getTime()) / 1000));
          }
        } else if (sub.first) {
          sub.sink.sendFrame(heartbeatFrame);
          sub.first = false;
        }
        if (BigInt(sub.cursor!) < BigInt(projection.head)) room.dirty = true;
        else sub.replays = 0;
      }
    } catch {
      metrics.count("read_failure");
      // Close instead of promising freshness when projection cannot be read.
      for (const sub of [...room.subscribers]) sub.sink.close();
    }
  }
  function pump() {
    const now = performance.now();
    readTokens = Math.min(20, readTokens + (now - lastRefill) * 0.08);
    lastRefill = now;
    for (const room of [...rooms.values()]) {
      if (reads >= options.maxConcurrentReads) break;
      if (room.busy || !room.dirty) continue;
      if (readTokens < 1) {
        metrics.count("read_limited");
        schedule();
        break;
      }
      readTokens--;
      room.busy = true;
      room.dirty = false;
      reads++;
      rooms.delete(room.id);
      rooms.set(room.id, room);
      const task = refresh(room).finally(() => {
        room.busy = false;
        reads--;
        tasks.delete(task);
        schedule();
      });
      tasks.add(task);
    }
  }
  return {
    start() {
      stopped = false;
      reconciliation = setInterval(() => {
        for (const room of rooms.values()) room.dirty = true;
        schedule();
      }, options.reconcileMs);
      reconciliation.unref();
      heartbeat = setInterval(() => {
        for (const room of rooms.values())
          for (const sub of [...room.subscribers])
            sub.sink.sendFrame(heartbeatFrame);
      }, options.heartbeatMs);
      heartbeat.unref();
    },
    wake(id?: string) {
      if (id) {
        const room = rooms.get(id);
        if (room) room.dirty = true;
      } else for (const room of rooms.values()) room.dirty = true;
      schedule();
    },
    subscribe(
      id: string,
      cursor: string | null,
      ip: string,
      response: Response,
    ) {
      if (
        stopped ||
        streams >= options.maxStreams ||
        (!rooms.has(id) && rooms.size >= options.maxRooms) ||
        !admit(ip)
      ) {
        metrics.count("admission_refused");
        response
          .set("Retry-After", "5")
          .status(503)
          .json({ error: "community stream temporarily unavailable" });
        return;
      }
      let room = rooms.get(id);
      if (!room) {
        room = { id, subscribers: new Set(), dirty: true, busy: false };
        rooms.set(id, room);
      }
      const current = room;
      const sub: Subscriber = {
        cursor,
        ip,
        replays: 0,
        first: true,
        sink: undefined!,
      };
      sub.sink = createSseSink(
        response,
        () => {
          if (!current.subscribers.delete(sub)) return;
          streams--;
          metrics.streams(streams);
          if (!current.subscribers.size) rooms.delete(id);
          metrics.rooms(rooms.size);
        },
        () => metrics.count("buffer_pressure"),
        options.bufferBytes,
      );
      current.subscribers.add(sub);
      streams++;
      current.dirty = true;
      metrics.streams(streams);
      metrics.rooms(rooms.size);
      schedule();
    },
    async stop() {
      stopped = true;
      if (reconciliation) clearInterval(reconciliation);
      if (heartbeat) clearInterval(heartbeat);
      if (scheduled) clearTimeout(scheduled);
      for (const room of rooms.values())
        for (const sub of [...room.subscribers]) sub.sink.close();
      admissions.clear();
      await Promise.allSettled([...tasks]);
    },
  };
}
