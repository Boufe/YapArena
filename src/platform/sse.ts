import type { Response } from "express";

export interface StreamSink {
  send(event: string, data: unknown, id?: string): boolean;
  sendFrame(frame: Buffer): boolean;
  close(): void;
}
export function encodeSse(event: string, data: unknown, id?: string) {
  return Buffer.from(
    `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

// Node's writable queue plus our own queue share a hard byte budget. No state is
// dropped: pressure closes the connection so the application resumes durably.
export function createSseSink(
  response: Response,
  onClose: () => void,
  onPressure: () => void,
  budget = 65536,
  stallMs = 15000,
): StreamSink {
  let closed = false;
  let blocked = false;
  let bytes = 0;
  let stall: NodeJS.Timeout | undefined;
  const queue: Buffer[] = [];
  function close() {
    if (closed) return;
    closed = true;
    if (stall) clearTimeout(stall);
    response.off("drain", drain);
    queue.length = 0;
    bytes = 0;
    response.end();
    if (blocked) response.destroy();
    onClose();
  }
  function pressure() {
    onPressure();
    close();
    response.destroy();
  }
  function flush() {
    while (!closed && !blocked && queue.length) {
      const frame = queue.shift()!;
      bytes -= Buffer.byteLength(frame);
      blocked = !response.write(frame);
      if (blocked) stall = setTimeout(pressure, stallMs);
    }
  }
  function drain() {
    if (stall) clearTimeout(stall);
    blocked = false;
    flush();
  }
  response.on("drain", drain);
  response.once("close", close);
  response.once("error", close);
  response.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders();
  function sendFrame(frame: Buffer) {
    if (closed) return false;
    const size = frame.byteLength;
    if (bytes + response.writableLength + size > budget) {
      pressure();
      return false;
    }
    queue.push(frame);
    bytes += size;
    flush();
    return !closed;
  }
  return {
    send(event, data, id) {
      return sendFrame(encodeSse(event, data, id));
    },
    sendFrame,
    close,
  };
}
