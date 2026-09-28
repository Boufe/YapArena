import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import request from "supertest";

import { createApp, handleError } from "../src/app.js";
import { createLogger } from "../src/platform/logger.js";

describe("yaparena API", () => {
  const logger = createLogger({ enabled: false });
  const createdAt = "2026-08-04T17:00:00.000Z";
  const messages = {
    isReady: mock.fn(async () => {}),
    create: mock.fn(async (_userId, name, message) => ({
      id: "1",
      name,
      message,
      createdAt,
    })),
    list: mock.fn(async () => [
      {
        id: "1",
        name: "Example User",
        message: "Hello, Example User!",
        createdAt,
      },
    ]),
  };
  const users = {
    create: async () => ({}),
    findByEmail: async () => null,
  };
  const sessions = {
    create: async () => ({}),
    findUserByTokenHash: async () => ({ id: "7" }),
    deleteByTokenHash: async () => false,
  };
  const app = createApp({ messages, users, sessions, logger });

  function authenticated(method, path) {
    return request(app)[method](path).set("Cookie", "session=test-token");
  }

  it("reports that it is healthy", async () => {
    const response = await request(app).get("/health");

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { status: "ok" });
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.headers["x-powered-by"], undefined);
    assert.match(response.headers["x-request-id"], /^[0-9a-f-]{36}$/);
  });

  it("reports that it is ready for traffic", async () => {
    const response = await request(app).get("/ready");

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { status: "ready" });
  });

  it("exposes bounded Prometheus HTTP and process metrics", async () => {
    await request(app).get("/health");
    const response = await request(app).get("/metrics");

    assert.equal(response.status, 200);
    assert.match(response.headers["content-type"], /^text\/plain;/);
    assert.match(response.headers["content-type"], /version=0\.0\.4/);
    assert.match(response.text, /yaparena_process_cpu_user_seconds_total/);
    assert.match(
      response.text,
      /yaparena_http_requests_total\{method="GET",route="\/health",status_code="200"\}/,
    );
    assert.match(
      response.text,
      /yaparena_http_request_duration_seconds_count\{method="GET",route="\/health",status_code="200"\}/,
    );
    assert.doesNotMatch(response.text, /route="\/metrics"/);
  });

  it("reports when it is not ready for traffic", async () => {
    const unavailableMessages = {
      isReady: async () => {
        throw new Error("database unavailable");
      },
    };
    const unavailableApp = createApp({
      messages: unavailableMessages,
      users,
      sessions,
      logger,
    });
    const response = await request(unavailableApp).get("/ready");

    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { status: "not ready" });
  });

  it("preserves an incoming request ID", async () => {
    const response = await request(app)
      .get("/health")
      .set("X-Request-Id", "test-request-id");

    assert.equal(response.headers["x-request-id"], "test-request-id");
  });

  it("creates a message", async () => {
    const response = await authenticated("post", "/api/messages").send({
      name: "Example User",
    });

    assert.equal(response.status, 201);
    assert.deepEqual(response.body, {
      id: "1",
      name: "Example User",
      message: "Hello, Example User!",
      createdAt,
    });
  });

  it("rejects an empty name", async () => {
    const response = await authenticated("post", "/api/messages").send({
      name: "",
    });

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, {
      error: "name must be between 1 and 80 characters",
    });
  });

  it("handles a missing request body", async () => {
    const response = await authenticated("post", "/api/messages");

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, {
      error: "name must be between 1 and 80 characters",
    });
  });

  it("rejects a name longer than 80 characters", async () => {
    const response = await authenticated("post", "/api/messages").send({
      name: "x".repeat(81),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, {
      error: "name must be between 1 and 80 characters",
    });
  });

  it("lists messages with default pagination", async () => {
    const response = await authenticated("get", "/api/messages");

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      items: [
        {
          id: "1",
          name: "Example User",
          message: "Hello, Example User!",
          createdAt,
        },
      ],
      pagination: { limit: 20, offset: 0 },
    });
  });

  it("accepts custom pagination", async () => {
    const response = await authenticated(
      "get",
      "/api/messages?limit=5&offset=10",
    );

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.pagination, { limit: 5, offset: 10 });
  });

  it("rejects an invalid pagination limit", async () => {
    const response = await authenticated("get", "/api/messages?limit=101");

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, {
      error: "limit must be an integer between 1 and 100",
    });
  });

  it("rejects an invalid pagination offset", async () => {
    const response = await authenticated("get", "/api/messages?offset=-1");

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, {
      error: "offset must be an integer between 0 and 10000",
    });
  });

  it("returns JSON for unknown routes", async () => {
    const response = await request(app).get("/does-not-exist");

    assert.equal(response.status, 404);
    assert.deepEqual(response.body, {
      error: "resource not found",
    });
  });

  it("rejects malformed JSON", async () => {
    const response = await request(app)
      .post("/api/messages")
      .set("Content-Type", "application/json")
      .send('{"name":');

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, {
      error: "request body contains invalid JSON",
    });
  });

  it("hides unexpected error details", () => {
    let statusCode;
    let responseBody;
    const response = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(body) {
        responseBody = body;
        return this;
      },
    };
    const errorLog = mock.fn();

    handleError(
      new Error("secret internal detail"),
      { log: { error: errorLog } },
      response,
      () => {},
    );

    assert.equal(statusCode, 500);
    assert.deepEqual(responseBody, { error: "internal server error" });
    assert.equal(errorLog.mock.callCount(), 1);
  });

  it("rate limits the general API independently of authentication", async () => {
    const limitedApp = createApp({
      messages,
      users,
      sessions,
      logger,
      apiRateLimit: 1,
    });

    assert.equal((await request(limitedApp).get("/health")).status, 200);
    assert.equal((await request(limitedApp).get("/health")).status, 429);
  });
});
