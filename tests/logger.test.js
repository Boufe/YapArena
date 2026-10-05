import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { describe, it } from "node:test";
import express from "express";
import request from "../scripts/test-http-request.js";
import { privateKeyToAccount } from "viem/accounts";

import { createApp } from "../dist/app.js";
import { createLogger, createHttpLogger } from "../dist/platform/logger.js";
import { hashSessionToken } from "../dist/platform/auth/session-tokens.js";
import { createProductActionRecorder } from "../dist/features/measurement/router.js";

const password = "synthetic logging test passphrase";
const authorization = "Bearer synthetic-authorization-credential";
const providerSecret = "synthetic-provider-secret";
const origin = "https://arena.example";
const user = { id: "7", email: "logger@example.com", createdAt: new Date(0) };
const owner = privateKeyToAccount(`0x${"11".repeat(32)}`);
const challengeId = "11111111-1111-4111-8111-111111111111";

function captureLogger(options = {}) {
  let output = "";
  const records = [];
  const waiters = new Set();
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      // Deliberately asynchronous: receiving the HTTP response is not a flush.
      setImmediate(() => {
        output += chunk.toString();
        for (const line of chunk.toString().trim().split("\n")) {
          if (!line) continue;
          let record;
          try {
            record = JSON.parse(line);
          } catch {
            callback(new Error("logger output must be valid JSON"));
            return;
          }
          records.push(record);
          for (const waiter of waiters) waiter(record);
        }
        callback();
      });
    },
  });
  const logger = createLogger({ ...options, destination });
  return {
    logger,
    records,
    async flush() {
      await new Promise((resolve, reject) => {
        destination.write("", (error) => (error ? reject(error) : resolve()));
      });
    },
    async completion(requestId, status, level) {
      const matches = (record) =>
        record.reqId === requestId && record.res !== undefined;
      const record = await new Promise((resolve, reject) => {
        const existing = records.find(matches);
        if (existing) return resolve(existing);
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error("expected HTTP completion log was not written"));
        }, 2_000);
        const waiter = (record) => {
          if (!matches(record)) return;
          clearTimeout(timer);
          waiters.delete(waiter);
          resolve(record);
        };
        waiters.add(waiter);
      });
      await this.flush();
      assert.equal(record.res.statusCode, status);
      assert.equal(record.level, level);
      assert.equal(record.reqId, requestId);
      assert.ok(Number.isFinite(record.responseTime));
      assert.ok(record.responseTime >= 0);
      return record;
    },
    assertAbsent(values) {
      // Compare booleans so assertion diagnostics never print credentials/logs.
      for (const value of values) {
        assert.equal(
          output.includes(value),
          false,
          "captured logs must not contain a sensitive value",
        );
        assert.equal(
          output.includes(JSON.stringify(value).slice(1, -1)),
          false,
          "captured logs must not contain an encoded sensitive value",
        );
      }
    },
  };
}

function fixture({ environment = "development", ...overrides } = {}) {
  const capture = captureLogger();
  const sessionRecords = new Map();
  const consents = new Set();
  let registered;
  let challenge;
  const app = createApp({
    messages: { isReady: async () => {} },
    users: {
      create: async (email, passwordHash) => {
        registered = { ...user, email, passwordHash, authGeneration: "0" };
        return { ...user, email, authGeneration: "0" };
      },
      findByEmail: async () => registered ?? null,
    },
    sessions: {
      create: async (_userId, hash) => sessionRecords.set(hash, user),
      findUserByTokenHash: async (hash) => sessionRecords.get(hash) ?? null,
      deleteByTokenHash: async (hash) => sessionRecords.delete(hash),
    },
    wallets: {
      createChallenge: async (input) => {
        challenge = {
          ...input,
          id: challengeId,
          chainId: String(input.chainId),
        };
        return challenge;
      },
      getChallenge: async () => challenge,
      completeLogin: async (_id, issuance) => {
        sessionRecords.set(issuance.tokenHash, user);
        return { ...user, authGeneration: "0" };
      },
    },
    measurement: {
      grant: async (hash) => consents.add(hash),
      hasConsent: async (hash) => consents.has(hash),
      withdraw: async (hash) => consents.delete(hash),
      summary: async () => ({ events: [], watch: [] }),
    },
    identity: { getRoles: async () => ["participant"] },
    logger: capture.logger,
    environment,
    applicationOrigin: origin,
    ...overrides,
  });
  return { app, capture, sessionRecords, consents };
}

function clientCookie(response, name, environment, { cleared = false } = {}) {
  const cookies = response.headers["set-cookie"];
  assert.ok(Array.isArray(cookies), "the client must still receive cookies");
  const cookie = cookies.find((value) => value.startsWith(`${name}=`));
  assert.ok(typeof cookie === "string", "the expected cookie must be returned");
  assert.ok(cookie.includes("HttpOnly"));
  assert.ok(cookie.includes("SameSite=Strict"));
  assert.ok(cookie.includes("Path=/"));
  assert.equal(cookie.includes("Secure"), environment === "production");
  assert.equal(cookie.includes("Domain="), false);
  const pair = cookie.split(";")[0];
  const token = pair.slice(name.length + 1);
  if (cleared) {
    assert.equal(token.length, 0);
    assert.ok(cookie.includes("Expires=Thu, 01 Jan 1970"));
  } else {
    const pattern = name.endsWith("measurement")
      ? /^[0-9a-f]{64}$/
      : /^[A-Za-z0-9_-]{43}$/;
    assert.ok(pattern.test(token), "the returned bearer must remain valid");
  }
  return { cookie, pair, token };
}

function assertRedactedCookies(record) {
  const cookies = record.res.headers["set-cookie"];
  assert.ok(
    cookies === undefined || cookies === "[REDACTED]",
    "the entire Set-Cookie field must be removed or redacted",
  );
}

function assertRedactedError(error) {
  assert.ok(
    error !== null &&
      typeof error === "object" &&
      Object.keys(error).length === 1 &&
      error.redacted === true,
    "error diagnostics must be replaced with a safe summary",
  );
}

async function loggedResponse(capture, httpRequest, requestId, status) {
  const response = await httpRequest
    .set("X-Request-Id", requestId)
    .set("Origin", origin);
  assert.equal(response.status, status);
  assert.equal(response.headers["x-request-id"], requestId);
  const record = await capture.completion(
    requestId,
    status,
    status >= 500 ? 50 : status >= 400 ? 40 : 30,
  );
  if (response.headers["set-cookie"]) assertRedactedCookies(record);
  return response;
}

function credentialError(signature = "synthetic-wallet-signature") {
  const error = new Error(`provider rejected ${providerSecret}`, {
    cause: new Error(`signature ${signature}`, {
      cause: new Error(`password ${password}`),
    }),
  });
  // Provider/database errors can carry request bodies, headers and diagnostics.
  Object.assign(error, {
    name: providerSecret,
    code: providerSecret,
    password,
    signature,
    headers: { authorization, cookie: "session=synthetic-error-cookie" },
    config: { credentials: providerSecret },
    diagnostics: { request: { password, signature } },
    errors: [new Error(`aggregate ${providerSecret}`)],
  });
  error.stack = `provider stack ${providerSecret}`;
  Object.defineProperty(error, "message", { enumerable: true });
  return error;
}

describe("credential-safe HTTP logs", () => {
  it("redacts registration response cookies with the real app logger", async () => {
    const { app, capture, sessionRecords } = fixture();
    const requestId = "logger-registration";
    const response = await request(app)
      .post("/api/auth/register")
      .set("X-Request-Id", requestId)
      .send({ email: user.email, password });
    assert.equal(response.status, 201);
    assert.equal(response.headers["x-request-id"], requestId);
    const cookie = clientCookie(response, "session", "development");
    assert.ok(sessionRecords.has(hashSessionToken(cookie.token)));
    const record = await capture.completion(requestId, 201, 30);
    capture.assertAbsent([cookie.cookie, cookie.token, password]);
    assertRedactedCookies(record);
  });

  for (const environment of ["development", "production"]) {
    const sessionName =
      environment === "production" ? "__Host-session" : "session";
    const measurementName =
      environment === "production" ? "__Host-measurement" : "measurement";

    it(`preserves registration, password/SIWE login and logout in ${environment}`, async () => {
      const { app, capture, sessionRecords } = fixture({ environment });
      const registered = await loggedResponse(
        capture,
        request(app)
          .post("/api/auth/register")
          .send({ email: user.email, password }),
        "register",
        201,
      );
      const registrationCookie = clientCookie(
        registered,
        sessionName,
        environment,
      );
      assert.ok(sessionRecords.has(hashSessionToken(registrationCookie.token)));
      await loggedResponse(
        capture,
        request(app).get("/api/auth/me").set("Cookie", registrationCookie.pair),
        "registered-user",
        200,
      );
      const login = await loggedResponse(
        capture,
        request(app)
          .post("/api/auth/login")
          .send({ email: user.email, password }),
        "password-login",
        200,
      );
      const loginCookie = clientCookie(login, sessionName, environment);
      assert.ok(sessionRecords.has(hashSessionToken(loginCookie.token)));
      await loggedResponse(
        capture,
        request(app).get("/api/auth/me").set("Cookie", loginCookie.pair),
        "password-user",
        200,
      );
      const issued = await loggedResponse(
        capture,
        request(app)
          .post("/api/auth/wallet/login/challenge")
          .send({ address: owner.address, chainId: 1 }),
        "wallet-challenge",
        201,
      );
      const signature = await owner.signMessage({
        message: issued.body.message,
      });
      const verified = await loggedResponse(
        capture,
        request(app)
          .post("/api/auth/wallet/login/verify")
          .send({ challengeId: issued.body.id, signature }),
        "wallet-login",
        200,
      );
      const walletCookie = clientCookie(verified, sessionName, environment);
      assert.ok(sessionRecords.has(hashSessionToken(walletCookie.token)));
      await loggedResponse(
        capture,
        request(app).get("/api/auth/me").set("Cookie", walletCookie.pair),
        "wallet-user",
        200,
      );
      const logout = await loggedResponse(
        capture,
        request(app).post("/api/auth/logout").set("Cookie", walletCookie.pair),
        "logout",
        204,
      );
      const cleared = clientCookie(logout, sessionName, environment, {
        cleared: true,
      });
      assert.equal(
        sessionRecords.has(hashSessionToken(walletCookie.token)),
        false,
      );
      await loggedResponse(
        capture,
        request(app).get("/api/auth/me").set("Cookie", walletCookie.pair),
        "revoked-user",
        401,
      );
      capture.assertAbsent([
        registrationCookie.cookie,
        registrationCookie.token,
        loginCookie.cookie,
        loginCookie.token,
        walletCookie.cookie,
        walletCookie.token,
        cleared.cookie,
        password,
        signature,
      ]);
    });

    it(`preserves measurement consent grant and withdrawal in ${environment}`, async () => {
      const { app, capture, consents } = fixture({ environment });
      const granted = await loggedResponse(
        capture,
        request(app).post("/api/measurement/consent").send({ consent: true }),
        "consent-grant",
        201,
      );
      const cookie = clientCookie(granted, measurementName, environment);
      const hash = createHash("sha256").update(cookie.token).digest("hex");
      assert.ok(consents.has(hash));
      const status = await loggedResponse(
        capture,
        request(app).get("/api/measurement/consent").set("Cookie", cookie.pair),
        "consent-status",
        200,
      );
      assert.equal(status.body.consented, true);
      const withdrawn = await loggedResponse(
        capture,
        request(app)
          .delete("/api/measurement/consent")
          .set("Cookie", cookie.pair),
        "consent-withdraw",
        200,
      );
      assert.equal(withdrawn.body.consented, false);
      const cleared = clientCookie(withdrawn, measurementName, environment, {
        cleared: true,
      });
      assert.equal(consents.has(hash), false);
      const after = await loggedResponse(
        capture,
        request(app).get("/api/measurement/consent").set("Cookie", cookie.pair),
        "consent-after-withdrawal",
        200,
      );
      assert.equal(after.body.consented, false);
      capture.assertAbsent([cookie.cookie, cookie.token, cleared.cookie]);
    });

    it(`redacts multiple session and measurement cookies together in ${environment}`, async () => {
      const { app, capture } = fixture({ environment });
      const combined = express();
      const measurementToken = createHash("sha256")
        .update("synthetic extra cookie")
        .digest("hex");
      combined.use((_request, response, next) => {
        response.cookie(measurementName, measurementToken, {
          httpOnly: true,
          secure: environment === "production",
          sameSite: "strict",
          path: "/",
        });
        next();
      });
      // The real app middleware serializes both the existing and new headers.
      combined.use(app);
      const response = await loggedResponse(
        capture,
        request(combined)
          .post("/api/auth/register")
          .send({ email: user.email, password }),
        "multiple-cookies",
        201,
      );
      assert.equal(response.headers["set-cookie"].length, 2);
      const session = clientCookie(response, sessionName, environment);
      const measurement = clientCookie(response, measurementName, environment);
      capture.assertAbsent([
        session.cookie,
        session.token,
        measurement.cookie,
        measurement.token,
        password,
      ]);
    });
  }

  it("retains incoming Cookie and Authorization header redaction", async () => {
    const { app, capture } = fixture();
    const incomingToken = "synthetic-incoming-cookie";
    await loggedResponse(
      capture,
      request(app)
        .get("/api/auth/me")
        .set("Cookie", `session=${incomingToken}`)
        .set("Authorization", authorization),
      "incoming-credentials",
      401,
    );
    const record = capture.records.find((record) => record.res);
    assert.ok(record.req.headers.cookie === "[REDACTED]");
    assert.ok(record.req.headers.authorization === "[REDACTED]");
    assert.equal(record.req.headers["x-request-id"], "incoming-credentials");
    capture.assertAbsent([incomingToken, authorization]);
  });

  it("does not log passwords or signatures on validation and authentication failures", async () => {
    const { app, capture } = fixture();
    await loggedResponse(
      capture,
      request(app)
        .post("/api/auth/register")
        .send({ email: "invalid", password }),
      "invalid-registration",
      400,
    );
    await loggedResponse(
      capture,
      request(app)
        .post("/api/auth/login")
        .send({ email: user.email, password }),
      "invalid-login",
      401,
    );
    const signature = "synthetic-invalid-signature";
    await loggedResponse(
      capture,
      request(app)
        .post("/api/auth/wallet/login/verify")
        .send({ challengeId: "invalid", signature }),
      "invalid-wallet-input",
      400,
    );
    await loggedResponse(
      capture,
      request(app)
        .post("/api/auth/wallet/login/challenge")
        .send({ address: owner.address, chainId: 1 }),
      "challenge",
      201,
    );
    const invalidSignature = `0x${"ab".repeat(65)}`;
    await loggedResponse(
      capture,
      request(app)
        .post("/api/auth/wallet/login/verify")
        .send({ challengeId, signature: invalidSignature }),
      "invalid-wallet-proof",
      401,
    );
    await loggedResponse(
      capture,
      request(app)
        .post("/api/auth/login")
        .set("Content-Type", "application/json")
        .send(`{"password":"${password}",`),
      "invalid-json",
      400,
    );
    capture.assertAbsent([password, signature, invalidSignature]);
    assert.ok(capture.records.every((record) => record.req.body === undefined));
  });

  it("keeps rate-limit responses at warning level without logging the body", async () => {
    const { app, capture } = fixture({ authRateLimit: 1 });
    await loggedResponse(
      capture,
      request(app).post("/api/auth/login").send({ email: "invalid", password }),
      "first-login",
      401,
    );
    await loggedResponse(
      capture,
      request(app)
        .post("/api/auth/login")
        .send({ email: user.email, password }),
      "limited-login",
      429,
    );
    capture.assertAbsent([password]);
  });

  it("sanitizes explicit application error logs across authentication and consent routes", async () => {
    const signature = "synthetic-error-wallet-signature";
    const error = credentialError(signature);
    const fail = async () => {
      throw error;
    };
    const cases = [
      {
        options: { users: { create: fail } },
        path: "/api/auth/register",
        body: { email: user.email, password },
      },
      {
        options: { users: { findByEmail: fail } },
        path: "/api/auth/login",
        body: { email: user.email, password },
      },
      {
        options: { wallets: { getChallenge: fail } },
        path: "/api/auth/wallet/login/verify",
        body: { challengeId, signature },
      },
      {
        options: { measurement: { grant: fail } },
        path: "/api/measurement/consent",
        body: { consent: true },
      },
    ];
    for (const [index, scenario] of cases.entries()) {
      const { app, capture } = fixture(scenario.options);
      const requestId = `unexpected-error-${index}`;
      const response = await loggedResponse(
        capture,
        request(app)
          .post(scenario.path)
          .set("Authorization", authorization)
          .set("Cookie", "session=synthetic-error-cookie")
          .send(scenario.body),
        requestId,
        500,
      );
      assert.ok(response.body.error === "internal server error");
      const explicit = capture.records.find(
        (record) => record.msg === "unhandled request error",
      );
      assert.ok(explicit);
      assert.equal(explicit.reqId, requestId);
      assert.equal(explicit.level, 50);
      assertRedactedError(explicit.error);
      assertRedactedError(capture.records.find((record) => record.res).err);
      capture.assertAbsent([
        password,
        signature,
        providerSecret,
        authorization,
        "synthetic-error-cookie",
      ]);
    }
  });

  for (const mode of ["response.err", "response error event"]) {
    it(`sanitizes automatic HTTP errors from ${mode}`, async () => {
      const capture = captureLogger();
      const app = express();
      const error = credentialError();
      app.use(createHttpLogger(capture.logger));
      app.get("/provider-error", (_request, response) => {
        response.cookie("session", "synthetic-automatic-cookie");
        response.status(502);
        if (mode === "response.err") response.err = error;
        else {
          response.flushHeaders();
          response.emit("error", error);
        }
        response.end();
      });
      await loggedResponse(
        capture,
        request(app).get("/provider-error").set("Authorization", authorization),
        "automatic-error",
        502,
      );
      assert.equal(capture.records.length, 1);
      assertRedactedError(capture.records[0].err);
      assert.ok(capture.records[0].msg === "request errored");
      capture.assertAbsent([
        password,
        "synthetic-wallet-signature",
        providerSecret,
        authorization,
        "synthetic-error-cookie",
        "synthetic-automatic-cookie",
      ]);
    });
  }

  it("sanitizes provider error fields and free-text diagnostics on root and child loggers", async () => {
    const capture = captureLogger();
    const error = credentialError();
    const fields = [
      "error",
      "err",
      "permissionError",
      "pauseError",
      "stopError",
    ];
    for (const logger of [
      capture.logger,
      capture.logger.child({ reqId: "provider-error" }),
    ]) {
      logger.error(
        Object.fromEntries(fields.map((field) => [field, error])),
        "provider operation failed",
      );
      logger.warn(
        { error: `provider diagnostic ${providerSecret}` },
        "provider reported an error",
      );
    }
    await capture.flush();
    assert.equal(capture.records.length, 4);
    for (const record of capture.records) {
      for (const field of fields) {
        if (field in record) assertRedactedError(record[field]);
      }
    }
    capture.assertAbsent([
      password,
      "synthetic-wallet-signature",
      providerSecret,
      authorization,
      "synthetic-error-cookie",
    ]);
  });

  it("sanitizes nonfatal product-event errors while preserving their context", async () => {
    const capture = captureLogger();
    const recorder = createProductActionRecorder({
      environment: "development",
      measurement: {
        recordAction: async () => {
          throw credentialError();
        },
      },
    });
    const measurementToken = "ab".repeat(32);
    await recorder(
      {
        cookies: { measurement: measurementToken },
        user,
        log: capture.logger.child({ reqId: "product-event" }),
      },
      { type: "follow", resourceId: challengeId },
    );
    await capture.flush();
    assert.equal(capture.records.length, 1);
    assert.equal(capture.records[0].level, 40);
    assert.equal(capture.records[0].reqId, "product-event");
    assert.equal(capture.records[0].eventType, "follow");
    assertRedactedError(capture.records[0].error);
    capture.assertAbsent([
      password,
      providerSecret,
      "synthetic-wallet-signature",
      authorization,
      measurementToken,
    ]);
  });

  it("excludes health, readiness and metrics completion logs", async () => {
    const { app, capture } = fixture();
    for (const path of ["/health", "/ready", "/metrics"]) {
      const response = await request(app).get(path);
      assert.equal(response.status, 200);
      assert.ok(/^[0-9a-f-]{36}$/.test(response.headers["x-request-id"]));
    }
    await capture.flush();
    assert.equal(capture.records.length, 0);
  });

  it("retains sanitized explicit readiness failures without a completion log", async () => {
    const { app, capture } = fixture({
      messages: {
        isReady: async () => {
          throw credentialError();
        },
      },
    });
    const response = await request(app)
      .get("/ready")
      .set("X-Request-Id", "failed-readiness");
    assert.equal(response.status, 503);
    await capture.flush();
    assert.equal(capture.records.length, 1);
    assert.equal(capture.records[0].reqId, "failed-readiness");
    assert.equal(capture.records[0].level, 50);
    assert.equal(capture.records[0].res, undefined);
    assertRedactedError(capture.records[0].error);
    capture.assertAbsent([
      password,
      "synthetic-wallet-signature",
      providerSecret,
      authorization,
    ]);
  });

  it("respects disabled logging and configured log levels", async () => {
    for (const options of [{ enabled: false }, { level: "error" }]) {
      const capture = captureLogger(options);
      capture.logger.info("info event");
      capture.logger.warn("warning event");
      capture.logger.error({ error: credentialError() }, "error event");
      await capture.flush();
      assert.equal(capture.records.length, options.enabled === false ? 0 : 1);
      if (capture.records.length) assertRedactedError(capture.records[0].error);
      capture.assertAbsent([password, providerSecret, authorization]);
    }
  });
});
