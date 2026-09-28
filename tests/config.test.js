import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig } from "../src/platform/config.js";

describe("configuration", () => {
  const databaseUrl = "postgresql://user:password@localhost:5432/database";

  it("provides safe development defaults", () => {
    assert.deepEqual(loadConfig({ DATABASE_URL: databaseUrl }), {
      environment: "development",
      host: "0.0.0.0",
      port: 3000,
      databaseUrl,
      logLevel: "info",
      applicationOrigin: undefined,
      trustProxy: false,
      requestBodyLimit: "10kb",
      apiRateLimit: 300,
      authRateLimit: 10,
      rateLimitWindowMs: 900000,
      sessionDurationMs: 604800000,
    });
  });

  it("loads values from the environment", () => {
    assert.deepEqual(
      loadConfig({
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "8080",
        DATABASE_URL: databaseUrl,
        LOG_LEVEL: "warn",
        APP_ORIGIN: "https://service.example.com",
        TRUST_PROXY: "1",
        REQUEST_BODY_LIMIT: "20kb",
        API_RATE_LIMIT: "500",
        AUTH_RATE_LIMIT: "20",
        RATE_LIMIT_WINDOW_MS: "60000",
        SESSION_DURATION_MS: "3600000",
      }),
      {
        environment: "production",
        host: "127.0.0.1",
        port: 8080,
        databaseUrl,
        logLevel: "warn",
        applicationOrigin: "https://service.example.com",
        trustProxy: 1,
        requestBodyLimit: "20kb",
        apiRateLimit: 500,
        authRateLimit: 20,
        rateLimitWindowMs: 60000,
        sessionDurationMs: 3600000,
      },
    );
  });

  it("rejects an unsupported environment", () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: "staging", DATABASE_URL: databaseUrl }),
      /NODE_ENV must be development, test, or production/,
    );
  });

  it("rejects an empty host", () => {
    assert.throws(
      () => loadConfig({ HOST: "", DATABASE_URL: databaseUrl }),
      /HOST must not be empty/,
    );
  });

  it("rejects an invalid port", () => {
    assert.throws(
      () => loadConfig({ PORT: "not-a-port", DATABASE_URL: databaseUrl }),
      /PORT must be an integer between 1 and 65535/,
    );
  });

  it("requires a database URL", () => {
    assert.throws(() => loadConfig({}), /DATABASE_URL is required/);
  });

  it("rejects an invalid log level", () => {
    assert.throws(
      () => loadConfig({ DATABASE_URL: databaseUrl, LOG_LEVEL: "verbose" }),
      /LOG_LEVEL is invalid/,
    );
  });

  it("requires an HTTPS application origin in production", () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: "production", DATABASE_URL: databaseUrl }),
      /APP_ORIGIN must be an HTTPS origin in production/,
    );
    assert.throws(
      () =>
        loadConfig({
          NODE_ENV: "production",
          DATABASE_URL: databaseUrl,
          APP_ORIGIN: "http://service.example.com",
        }),
      /APP_ORIGIN must be an HTTPS origin in production/,
    );
  });

  it("rejects invalid security configuration", () => {
    assert.throws(
      () => loadConfig({ DATABASE_URL: databaseUrl, TRUST_PROXY: "true" }),
      /TRUST_PROXY must be an integer/,
    );
    assert.throws(
      () => loadConfig({ DATABASE_URL: databaseUrl, API_RATE_LIMIT: "0" }),
      /API_RATE_LIMIT must be an integer/,
    );
    assert.throws(
      () =>
        loadConfig({ DATABASE_URL: databaseUrl, REQUEST_BODY_LIMIT: "huge" }),
      /REQUEST_BODY_LIMIT must use kb or mb units/,
    );
  });
});
