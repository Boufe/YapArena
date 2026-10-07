import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { createMetrics } from "../dist/platform/metrics.js";

describe("metrics", () => {
  it("labels unmatched routes without using the raw URL", async () => {
    const metrics = createMetrics();
    const finishListeners = [];
    const request = {
      method: "GET",
      path: "/users/private-value",
      baseUrl: "",
    };
    const response = {
      statusCode: 404,
      once: mock.fn((event, listener) => {
        assert.equal(event, "finish");
        finishListeners.push(listener);
      }),
    };
    const next = mock.fn();

    metrics.middleware(request, response, next);
    finishListeners[0]();

    const output = await metrics.registry.metrics();
    assert.match(output, /route="unmatched"/);
    assert.doesNotMatch(output, /private-value/);
    assert.equal(next.mock.callCount(), 1);
  });

  it("does not instrument the scrape endpoint", async () => {
    const metrics = createMetrics();
    const next = mock.fn();

    metrics.middleware(
      { method: "GET", path: "/metrics" },
      { once: mock.fn() },
      next,
    );

    const output = await metrics.registry.metrics();
    assert.doesNotMatch(output, /yaparena_http_requests_total{/);
    assert.equal(next.mock.callCount(), 1);
  });

  it("keeps stream lifetime outside ordinary request latency and records bounded operational metrics", async () => {
    const metrics = createMetrics();
    const response = { once: mock.fn() };
    metrics.middleware(
      { method: "GET", path: "/api/community/events/example/stream" },
      response,
      () => {},
    );
    assert.equal(response.once.mock.callCount(), 0);
    metrics.community.streams(2);
    metrics.community.rooms(1);
    metrics.community.count("snapshot");
    metrics.community.lag(0.05);
    metrics.poolWait.observe(0.01);
    const output = await metrics.registry.metrics();
    assert.match(output, /yaparena_community_streams 2/);
    assert.match(output, /yaparena_community_rooms 1/);
    assert.match(
      output,
      /yaparena_community_delivery_total\{kind="snapshot"\} 1/,
    );
    assert.match(output, /yaparena_community_delivery_lag_seconds_count 1/);
    assert.match(output, /yaparena_database_pool_wait_seconds_count 1/);
    assert.doesNotMatch(output, /yaparena_http_requests_total\{/);
  });

  it("exports only fixed product categories and caches the aggregate snapshot", async () => {
    const metrics = createMetrics();
    let queries = 0;
    metrics.setProductSummaryProvider(async () => {
      queries += 1;
      return {
        windowDays: 28,
        events: [
          {
            eventType: "discovery_view",
            affiliation: "independent",
            count: 3,
          },
        ],
        watch: [
          {
            mode: "live",
            affiliation: "independent",
            sessions: 1,
            watchedSeconds: 42,
          },
        ],
      };
    });
    const response = {
      type() {
        return this;
      },
      send(value) {
        return value;
      },
    };
    const first = await metrics.handler({}, response);
    assert.match(
      first,
      /yaparena_product_events_28d{event_type="discovery_view",affiliation="independent"} 3/,
    );
    assert.match(
      first,
      /yaparena_product_watch_seconds_28d{mode="live",affiliation="independent"} 42/,
    );
    assert.match(first, /yaparena_product_snapshot_fresh 1/);
    assert.doesNotMatch(first, /user_id|wallet|debate_id/);
    await metrics.handler({}, response);
    assert.equal(queries, 1);
  });

  it("marks a failed product snapshot as stale without breaking HTTP metrics", async () => {
    const metrics = createMetrics();
    metrics.setProductSummaryProvider(async () => {
      throw new Error("database unavailable");
    });
    const response = {
      type() {
        return this;
      },
      send(value) {
        return value;
      },
    };
    const output = await metrics.handler({}, response);
    assert.match(output, /yaparena_product_snapshot_fresh 0/);
    assert.match(output, /yaparena_http_requests_total/);
  });
});
