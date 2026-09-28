import { randomUUID } from "node:crypto";

import pino from "pino";
import pinoHttp from "pino-http";

export function createLogger({ level = "info", enabled = true } = {}) {
  return pino({
    level,
    enabled,
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie"],
      censor: "[REDACTED]",
    },
  });
}

export function createHttpLogger(logger) {
  return pinoHttp({
    logger,
    quietReqLogger: true,
    autoLogging: {
      ignore(request) {
        return (
          request.url === "/health" ||
          request.url === "/ready" ||
          request.url === "/metrics"
        );
      },
    },
    genReqId(request, response) {
      const incomingId = request.headers["x-request-id"];
      const requestId = Array.isArray(incomingId)
        ? incomingId[0]
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
