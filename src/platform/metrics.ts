import {
  collectDefaultMetrics,
  Counter,
  Histogram,
  Registry,
} from "prom-client";
import type { NextFunction, Request, Response } from "express";

export function createMetrics() {
  const registry = new Registry();

  collectDefaultMetrics({
    register: registry,
    prefix: "yaparena_",
  });

  const requests = new Counter({
    name: "yaparena_http_requests_total",
    help: "Total number of completed HTTP requests",
    labelNames: ["method", "route", "status_code"],
    registers: [registry],
  });
  const requestDuration = new Histogram({
    name: "yaparena_http_request_duration_seconds",
    help: "HTTP request duration in seconds",
    labelNames: ["method", "route", "status_code"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  function middleware(
    request: Request,
    response: Response,
    next: NextFunction,
  ) {
    if (request.path === "/metrics") {
      return next();
    }

    const stopTimer = requestDuration.startTimer({ method: request.method });

    response.once("finish", () => {
      const route = request.route?.path
        ? `${request.baseUrl}${request.route.path}`
        : "unmatched";
      const labels = {
        method: request.method,
        route,
        status_code: String(response.statusCode),
      };

      requests.inc(labels);
      stopTimer({ route, status_code: labels.status_code });
    });

    return next();
  }

  async function handler(_request: Request, response: Response) {
    response.type(registry.contentType);
    return response.send(await registry.metrics());
  }

  return Object.freeze({ middleware, handler, registry });
}
