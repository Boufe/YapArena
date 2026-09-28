import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { createMetrics } from "../src/platform/metrics.js";

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
});
