import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";
import type { NextFunction, Request, Response } from "express";
import type { createMeasurementRepository } from "../features/measurement/repository.ts";

type ProductSummary = Awaited<
  ReturnType<ReturnType<typeof createMeasurementRepository>["summary"]>
>;

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
  const productEvents = new Gauge({
    name: "yaparena_product_events_28d",
    help: "Consented product events in the trailing 28 days, plus public debate completions",
    labelNames: ["event_type", "affiliation"],
    registers: [registry],
  });
  const productWatch = new Gauge({
    name: "yaparena_product_watch_seconds_28d",
    help: "Bounded active watch seconds in the trailing 28 days",
    labelNames: ["mode", "affiliation"],
    registers: [registry],
  });
  const productSnapshot = new Gauge({
    name: "yaparena_product_snapshot_fresh",
    help: "One when the product aggregate snapshot was refreshed successfully",
    registers: [registry],
  });
  productSnapshot.set(0);
  let productSummaryProvider: (() => Promise<ProductSummary>) | undefined;
  let lastProductRefresh = 0;
  let refreshing: Promise<void> | undefined;

  async function refreshProduct() {
    if (!productSummaryProvider || Date.now() - lastProductRefresh < 60_000)
      return;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const summary = await productSummaryProvider();
        productEvents.reset();
        productWatch.reset();
        for (const row of summary.events)
          productEvents.set(
            { event_type: row.eventType, affiliation: row.affiliation },
            row.count,
          );
        for (const row of summary.watch)
          productWatch.set(
            { mode: row.mode, affiliation: row.affiliation },
            row.watchedSeconds,
          );
        productSnapshot.set(1);
        lastProductRefresh = Date.now();
      } catch {
        productSnapshot.set(0);
      } finally {
        refreshing = undefined;
      }
    })();
    return refreshing;
  }

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
    await refreshProduct();
    response.type(registry.contentType);
    return response.send(await registry.metrics());
  }

  return Object.freeze({
    middleware,
    handler,
    registry,
    setProductSummaryProvider(provider: () => Promise<ProductSummary>) {
      productSummaryProvider = provider;
      lastProductRefresh = 0;
    },
  });
}
