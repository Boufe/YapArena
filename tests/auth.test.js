import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import request from "../scripts/test-http-request.js";

import { createApp } from "../dist/app.js";
import { hashPassword } from "../dist/platform/auth/passwords.js";
import { createLogger } from "../dist/platform/logger.js";

const logger = createLogger({ enabled: false });
const messages = { isReady: async () => {} };
const createdAt = "2026-08-04T17:00:00.000Z";
const publicUser = { id: "1", email: "user@example.com", createdAt };

function createAuthenticationApp({
  users = {
    create: mock.fn(async (email) => ({
      ...publicUser,
      email,
      authGeneration: "0",
    })),
    findByEmail: mock.fn(async () => null),
  },
  sessions = {
    create: mock.fn(async () => ({})),
    findUserByTokenHash: mock.fn(async () => null),
    deleteByTokenHash: mock.fn(async () => false),
  },
  environment = "development",
} = {}) {
  return {
    app: createApp({ messages, users, sessions, logger, environment }),
    users,
    sessions,
  };
}

describe("authentication API", () => {
  it("registers a normalized email and starts a session", async () => {
    const { app, users, sessions } = createAuthenticationApp();
    const response = await request(app).post("/api/auth/register").send({
      email: "  User@Example.com ",
      password: "a secure passphrase",
    });

    assert.equal(response.status, 201);
    assert.deepEqual(response.body, { user: publicUser });
    assert.equal(users.create.mock.calls[0].arguments[0], "user@example.com");
    assert.match(users.create.mock.calls[0].arguments[1], /^\$argon2id\$/);
    assert.equal(sessions.create.mock.calls[0].arguments[0], "1");
    assert.match(sessions.create.mock.calls[0].arguments[1], /^[a-f0-9]{64}$/);
    assert.match(response.headers["set-cookie"][0], /^session=/);
    assert.match(response.headers["set-cookie"][0], /HttpOnly/);
    assert.match(response.headers["set-cookie"][0], /SameSite=Strict/);
    assert.equal(response.headers["cache-control"], "no-store");
  });

  it("rejects an invalid registration email", async () => {
    const { app } = createAuthenticationApp();
    const response = await request(app)
      .post("/api/auth/register")
      .send({ email: "invalid", password: "a secure passphrase" });

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: "email is invalid" });
  });

  it("rejects an invalid registration password", async () => {
    const { app } = createAuthenticationApp();
    const response = await request(app)
      .post("/api/auth/register")
      .send({ email: "user@example.com", password: "short" });

    assert.equal(response.status, 400);
    assert.match(response.body.error, /between 15 and 128/);
  });

  it("reports an already registered email", async () => {
    const duplicateError = Object.assign(new Error("duplicate"), {
      code: "23505",
    });
    const users = {
      create: async () => {
        throw duplicateError;
      },
      findByEmail: async () => null,
    };
    const { app } = createAuthenticationApp({ users });
    const response = await request(app).post("/api/auth/register").send({
      email: "user@example.com",
      password: "a secure passphrase",
    });

    assert.equal(response.status, 409);
    assert.deepEqual(response.body, { error: "email is already registered" });
  });

  it("logs in with valid credentials without exposing the password hash", async () => {
    const passwordHash = await hashPassword("a secure passphrase");
    const users = {
      create: async () => publicUser,
      findByEmail: mock.fn(async () => ({
        ...publicUser,
        passwordHash,
        authGeneration: "0",
      })),
    };
    const { app, sessions } = createAuthenticationApp({ users });
    const response = await request(app).post("/api/auth/login").send({
      email: "User@Example.com",
      password: "a secure passphrase",
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { user: publicUser });
    assert.equal(response.body.user.passwordHash, undefined);
    assert.equal(sessions.create.mock.callCount(), 1);
  });

  it("uses a generic error for invalid or missing credentials", async () => {
    const passwordHash = await hashPassword("a secure passphrase");
    const users = {
      create: async () => publicUser,
      findByEmail: mock.fn(async (email) =>
        email === "user@example.com" ? { ...publicUser, passwordHash } : null,
      ),
    };
    const { app } = createAuthenticationApp({ users });
    const wrongPassword = await request(app).post("/api/auth/login").send({
      email: "user@example.com",
      password: "the wrong passphrase",
    });
    const missingUser = await request(app).post("/api/auth/login").send({
      email: "missing@example.com",
      password: "a secure passphrase",
    });
    const invalidBody = await request(app)
      .post("/api/auth/login")
      .send({ email: "invalid" });

    for (const response of [wrongPassword, missingUser, invalidBody]) {
      assert.equal(response.status, 401);
      assert.deepEqual(response.body, {
        error: "email or password is incorrect",
      });
    }
  });

  it("uses a secure host-only cookie in production", async () => {
    const { app } = createAuthenticationApp({ environment: "production" });
    const response = await request(app)
      .post("/api/auth/register")
      .set("Origin", "https://service.example.com")
      .send({
        email: "user@example.com",
        password: "a secure passphrase",
      });

    assert.match(response.headers["set-cookie"][0], /^__Host-session=/);
    assert.match(response.headers["set-cookie"][0], /Secure/);
    assert.match(response.headers["set-cookie"][0], /Path=\//);
  });

  it("returns the current user for a valid session", async () => {
    const sessions = {
      create: async () => ({}),
      findUserByTokenHash: mock.fn(async () => publicUser),
      deleteByTokenHash: async () => false,
    };
    const { app } = createAuthenticationApp({ sessions });
    const response = await request(app)
      .get("/api/auth/me")
      .set("Cookie", "session=raw-session-token");

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { user: publicUser });
    assert.match(
      sessions.findUserByTokenHash.mock.calls[0].arguments[0],
      /^[a-f0-9]{64}$/,
    );
  });

  it("rejects missing and expired sessions", async () => {
    const { app } = createAuthenticationApp();
    const missingCookie = await request(app).get("/api/auth/me");
    const expiredSession = await request(app)
      .get("/api/auth/me")
      .set("Cookie", "session=expired-token");

    for (const response of [missingCookie, expiredSession]) {
      assert.equal(response.status, 401);
      assert.deepEqual(response.body, { error: "authentication required" });
    }
  });

  it("logs out and clears the session cookie", async () => {
    const sessions = {
      create: async () => ({}),
      findUserByTokenHash: async () => null,
      deleteByTokenHash: mock.fn(async () => true),
    };
    const { app } = createAuthenticationApp({ sessions });
    const response = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", "session=raw-session-token");

    assert.equal(response.status, 204);
    assert.equal(sessions.deleteByTokenHash.mock.callCount(), 1);
    assert.match(response.headers["set-cookie"][0], /^session=;/);
  });

  it("allows idempotent logout without a cookie", async () => {
    const { app, sessions } = createAuthenticationApp();
    const response = await request(app).post("/api/auth/logout");

    assert.equal(response.status, 204);
    assert.equal(sessions.deleteByTokenHash.mock.callCount(), 0);
  });

  it("protects message routes", async () => {
    const { app } = createAuthenticationApp();
    const response = await request(app).get("/api/messages");

    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { error: "authentication required" });
  });

  it("rejects cross-origin cookie-authenticated mutations in production", async () => {
    const { app } = createAuthenticationApp({ environment: "production" });
    const response = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", "__Host-session=raw-session-token")
      .set("Origin", "https://attacker.example");

    assert.equal(response.status, 403);
    assert.deepEqual(response.body, { error: "request origin is not allowed" });
  });

  it("passes unexpected registration failures to the error handler", async () => {
    const users = {
      create: async () => {
        throw new Error("database unavailable");
      },
      findByEmail: async () => null,
    };
    const { app } = createAuthenticationApp({ users });
    const response = await request(app).post("/api/auth/register").send({
      email: "user@example.com",
      password: "a secure passphrase",
    });

    assert.equal(response.status, 500);
    assert.deepEqual(response.body, { error: "internal server error" });
  });
});
