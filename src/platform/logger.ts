import { randomUUID } from "node:crypto";

import pino from "pino";
import { pinoHttp } from "pino-http";
import type { DestinationStream, Logger } from "pino";

function serializeError() {
  // Messages, stacks, causes and provider properties can all contain credentials.
  // Retain the call site's fixed event message and safe context instead.
  return { redacted: true };
}

export function createLogger({
  level = "info",
  enabled = true,
  destination,
}: {
  level?: string;
  enabled?: boolean;
  destination?: DestinationStream;
} = {}) {
  return pino(
    {
      level,
      enabled,
      serializers: {
        err: serializeError,
        error: serializeError,
        permissionError: serializeError,
        pauseError: serializeError,
        stopError: serializeError,
      },
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          'res.headers["set-cookie"]',
        ],
        censor: "[REDACTED]",
      },
    },
    destination,
  );
}

export function createHttpLogger(logger: Logger) {
  return pinoHttp({
    logger,
    // Honor the parent's safe err serializer; pino-http otherwise replaces it.
    wrapSerializers: false,
    serializers: {
      req: pino.stdSerializers.req,
      res: pino.stdSerializers.res,
    },
    quietReqLogger: true,
    autoLogging: {
      ignore(request) {
        return (
          request.url === "/health" ||
          request.url === "/ready" ||
          request.url === "/metrics" ||
          /^\/api\/community\/events\/[^/]+\/(?:stream|chat\/submissions)(?:\?|$)/.test(
            request.url ?? "",
          )
        );
      },
    },
    genReqId(request, response) {
      const incomingId = request.headers["x-request-id"];
      const requestId = Array.isArray(incomingId)
        ? (incomingId[0] ?? randomUUID())
        : incomingId || randomUUID();

      response.setHeader("X-Request-Id", requestId);
      return requestId;
    },
    customLogLevel(_request, response, error) {
      if (error || response.statusCode >= 500) return "error";
      if (response.statusCode >= 400) return "warn";
      return "info";
    },
  });
}
