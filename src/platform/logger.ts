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
          'req.headers["x-yap-signature"]',
          'req.headers["x-yaparena-expected-account"]',
          'req.headers["x-yaparena-session"]',
          'res.headers["set-cookie"]',
          // Sign-in redirects carry state, nonce and PKCE challenges.
          "res.headers.location",
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
      req(request) {
        const record = pino.stdSerializers.req(request);
        // Sign-in routes carry one-use codes, state and return paths. Keep the
        // route useful for operations without persisting query values.
        const query = new URLSearchParams((record.url ?? "").split("?")[1]);
        if (
          /^\/account(?:[/?]|$)/.test(record.url ?? "") ||
          /^\/api\/auth\/(?:login|callback|confirm)(?:[/?]|$)/.test(
            record.url ?? "",
          ) ||
          [...query.keys()].some((key) => key.startsWith("privy_"))
        ) {
          record.url = record.url.replace(/\?.*$/, "");
          record.query = {};
        }
        return record;
      },
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
