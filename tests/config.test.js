import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig } from "../dist/platform/config.js";

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
      siweRpcUrls: {},
      media: undefined,
      backgroundJobs: true,
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
        siweRpcUrls: {},
        media: undefined,
        backgroundJobs: true,
      },
    );
  });

  it("rejects an unsupported environment", () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: "staging", DATABASE_URL: databaseUrl }),
      /NODE_ENV must be development, test, or production/,
    );
  });

  it("validates background worker configuration", () => {
    assert.equal(
      loadConfig({
        DATABASE_URL: databaseUrl,
        RUN_BACKGROUND_JOBS: "false",
      }).backgroundJobs,
      false,
    );
    assert.throws(
      () =>
        loadConfig({ DATABASE_URL: databaseUrl, RUN_BACKGROUND_JOBS: "off" }),
      /RUN_BACKGROUND_JOBS/,
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

  it("accepts configured HTTPS smart-wallet RPC endpoints", () => {
    const config = loadConfig({
      DATABASE_URL: databaseUrl,
      SIWE_RPC_URLS: '{"1":"https://rpc.example.com"}',
    });
    assert.deepEqual(config.siweRpcUrls, { 1: "https://rpc.example.com" });
    assert.throws(
      () =>
        loadConfig({
          DATABASE_URL: databaseUrl,
          NODE_ENV: "production",
          APP_ORIGIN: "https://app.example.com",
          SIWE_RPC_URLS: '{"1":"http://rpc.example.com"}',
        }),
      /SIWE_RPC_URLS has an invalid chain or URL/,
    );
  });

  it("requires complete media credentials and secure production media URLs", () => {
    const media = {
      LIVEKIT_URL: "http://localhost:7880",
      LIVEKIT_PUBLIC_URL: "ws://localhost:7880",
      LIVEKIT_API_KEY: "devkey",
      LIVEKIT_API_SECRET: "secret",
      MEDIA_S3_ENDPOINT: "http://localhost:8333",
      MEDIA_S3_PUBLIC_ENDPOINT: "http://localhost:8333",
      MEDIA_S3_REGION: "us-east-1",
      MEDIA_S3_BUCKET: "replays",
      MEDIA_S3_ACCESS_KEY: "local",
      MEDIA_S3_SECRET_KEY: "local-secret",
    };
    assert.equal(
      loadConfig({ DATABASE_URL: databaseUrl, ...media }).media.s3Bucket,
      "replays",
    );
    assert.equal(
      loadConfig({
        DATABASE_URL: databaseUrl,
        ...media,
        MEDIA_S3_ENDPOINT: "https://example.r2.cloudflarestorage.com",
        MEDIA_S3_PUBLIC_ENDPOINT: "https://example.r2.cloudflarestorage.com",
        MEDIA_S3_REGION: "Eastern North America (ENAM)",
      }).media.s3Region,
      "auto",
    );
    assert.equal(
      loadConfig({ DATABASE_URL: databaseUrl, ...media }).media.s3Region,
      "us-east-1",
    );
    assert.throws(
      () =>
        loadConfig({
          DATABASE_URL: databaseUrl,
          LIVEKIT_URL: media.LIVEKIT_URL,
        }),
      /media configuration requires/,
    );
    assert.throws(
      () =>
        loadConfig({
          DATABASE_URL: databaseUrl,
          ...media,
          LIVEKIT_PUBLIC_URL: "http://localhost:7880",
        }),
      /invalid LiveKit URLs/,
    );
    assert.throws(
      () =>
        loadConfig({
          DATABASE_URL: databaseUrl,
          ...media,
          MEDIA_S3_ENDPOINT: "ftp://storage",
        }),
      /invalid media S3 endpoint/,
    );
    assert.throws(
      () =>
        loadConfig({
          DATABASE_URL: databaseUrl,
          ...media,
          MEDIA_S3_PUBLIC_ENDPOINT: undefined,
        }),
      /custom media S3 endpoint requires a public playback endpoint/,
    );
    assert.throws(
      () =>
        loadConfig({
          DATABASE_URL: databaseUrl,
          ...media,
          MEDIA_S3_PUBLIC_ENDPOINT: "ftp://storage",
        }),
      /invalid public media S3 endpoint/,
    );
    assert.throws(
      () =>
        loadConfig({
          DATABASE_URL: databaseUrl,
          ...media,
          LIVEKIT_URL: "ws://localhost:7880",
        }),
      /invalid LiveKit URLs/,
    );
    assert.throws(
      () =>
        loadConfig({
          DATABASE_URL: databaseUrl,
          ...media,
          NODE_ENV: "production",
          APP_ORIGIN: "https://arena.example",
        }),
      /production media requires/,
    );
    const production = {
      ...media,
      LIVEKIT_URL: "https://media.example",
      LIVEKIT_PUBLIC_URL: "wss://media.example",
      MEDIA_S3_ENDPOINT: "https://storage.example",
      MEDIA_S3_PUBLIC_ENDPOINT: "https://storage.example",
    };
    assert.equal(
      loadConfig({
        DATABASE_URL: databaseUrl,
        ...production,
        NODE_ENV: "production",
        APP_ORIGIN: "https://arena.example",
      }).media.livekitUrl,
      "https://media.example",
    );
    assert.throws(
      () =>
        loadConfig({
          DATABASE_URL: databaseUrl,
          ...production,
          MEDIA_S3_ENDPOINT: "http://storage.example",
          NODE_ENV: "production",
          APP_ORIGIN: "https://arena.example",
        }),
      /invalid media S3 endpoint/,
    );
    assert.throws(
      () =>
        loadConfig({
          DATABASE_URL: databaseUrl,
          ...production,
          MEDIA_S3_PUBLIC_ENDPOINT: "http://storage.example",
          NODE_ENV: "production",
          APP_ORIGIN: "https://arena.example",
        }),
      /invalid public media S3 endpoint/,
    );
    assert.equal(
      loadConfig({
        DATABASE_URL: databaseUrl,
        ...production,
        MEDIA_S3_ENDPOINT: undefined,
        MEDIA_S3_PUBLIC_ENDPOINT: undefined,
        NODE_ENV: "production",
        APP_ORIGIN: "https://arena.example",
      }).media.s3Endpoint,
      undefined,
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
