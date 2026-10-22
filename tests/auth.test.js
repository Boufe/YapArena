import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import express from "express";
import cookieParser from "cookie-parser";
import { createRequireAuthentication } from "../dist/platform/auth/router.js";
import { ProviderUnavailableError } from "../dist/platform/auth/privy.js";
import request from "../scripts/test-http-request.ts";

import { createApp } from "../dist/app.js";
import { hashPassword } from "../dist/platform/auth/passwords.js";
import { createLogger } from "../dist/platform/logger.js";
import { SessionUnavailableError } from "../dist/platform/auth/sessions.js";

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

describe("private authentication response caching", () => {
  it("marks missing, expired and successful cookie lookups private before authorization and preserves existing Vary", async () => {
    const sessions = { findUserByTokenHash: mock.fn(async () => null) };
    const app = express()
      .use(cookieParser())
      .use((_r, s, next) => {
        s.set("Cache-Control", "public, max-age=300");
        s.vary("Origin");
        next();
      });
    app.get(
      "/protected",
      createRequireAuthentication({ sessions, environment: "development" }),
      (_r, s) => s.status(200).json({ private: true }),
    );
    const missing = await request(app).get("/protected");
    assert.equal(sessions.findUserByTokenHash.mock.callCount(), 0);
    const expired = await request(app)
      .get("/protected")
      .set("Cookie", "session=synthetic-expired-cookie");
    sessions.findUserByTokenHash.mock.mockImplementation(
      async () => publicUser,
    );
    const success = await request(app)
      .get("/protected")
      .set("Cookie", "session=synthetic-current-cookie");
    assert.deepEqual(
      [missing.status, expired.status, success.status],
      [401, 401, 200],
    );
    for (const response of [missing, expired, success]) {
      assert.equal(response.headers["cache-control"], "private, no-store");
      assert.equal(response.headers.vary, "Origin, Cookie");
    }
  });
  it("keeps provider-outage responses uncacheable and cookie-varying through the real app error handler", async () => {
    const { app } = createAuthenticationApp({
      sessions: {
        findUserByTokenHash: async () => {
          throw new ProviderUnavailableError("synthetic provider outage");
        },
      },
    });
    const response = await request(app)
      .get("/api/auth/me")
      .set("Cookie", "session=synthetic-current-cookie");
    assert.equal(response.status, 503);
    assert.match(
      response.headers["cache-control"],
      /(?:^|,\s*)no-store(?:,|$)/,
    );
    assert.match(response.headers.vary, /(?:^|,\s*)Cookie(?:,|$)/);
    assert.doesNotMatch(response.headers["cache-control"], /public|max-age/);
  });
});

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

  it("normal sign out revokes all account sessions without deleting a potentially newer cookie", async () => {
    const sessions = {
      create: async () => ({}),
      findUserByTokenHash: mock.fn(async () => publicUser),
      deleteByTokenHash: mock.fn(async () => true),
      revoke: mock.fn(async () => {}),
    };
    const { app } = createAuthenticationApp({ sessions });
    const response = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", "session=raw-session-token");

    assert.equal(response.status, 204);
    assert.equal(sessions.deleteByTokenHash.mock.callCount(), 0);
    assert.equal(sessions.revoke.mock.callCount(), 1);
    assert.equal(sessions.revoke.mock.calls[0].arguments[0], publicUser.id);
    assert.equal(sessions.revoke.mock.calls[0].arguments[2], false);
    assert.deepEqual(sessions.findUserByTokenHash.mock.calls[0].arguments[1], {
      localRevocation: true,
    });
    assert.equal(response.headers["set-cookie"], undefined);
  });

  it("rejects an absent cookie without claiming revocation or deleting a potentially newer cookie", async () => {
    const { app, sessions } = createAuthenticationApp();
    const response = await request(app).post("/api/auth/logout");

    assert.equal(response.status, 401);
    assert.match(
      response.body.error,
      /sign in again to sign out other devices/,
    );
    assert.equal(response.headers["set-cookie"], undefined);
    assert.equal(sessions.deleteByTokenHash.mock.callCount(), 0);
  });
  it("compares the observed account without using it to select or authorize a revocation", async () => {
    const sessions = {
      create: async () => ({}),
      findUserByTokenHash: mock.fn(async () => publicUser),
      revoke: mock.fn(async () => {}),
    };
    const { app } = createAuthenticationApp({ sessions });
    for (const path of ["logout", "logout-all", "logout-other-sessions"]) {
      await request(app)
        .post(`/api/auth/${path}`)
        .set("Cookie", "session=valid")
        .set("X-YapArena-Expected-Account", "different-account")
        .expect(409);
      assert.equal(sessions.revoke.mock.callCount(), 0);
      await request(app)
        .post(`/api/auth/${path}`)
        .set("X-YapArena-Expected-Account", publicUser.id)
        .expect(401);
    }
    for (const path of ["logout", "logout-all", "logout-other-sessions"])
      await request(app)
        .post(`/api/auth/${path}`)
        .set("Cookie", "session=valid")
        .set("X-YapArena-Expected-Account", publicUser.id)
        .expect(204);
    // The hint is optional for direct API/initial-outage compatibility; cookie
    // ownership is authoritative in either case.
    await request(app)
      .post("/api/auth/logout")
      .set("Cookie", "session=valid")
      .expect(204);
    assert.equal(sessions.revoke.mock.callCount(), 4);
  });
  it("does not claim other devices ended when the sign-out cookie is expired or loses authorization while waiting", async () => {
    for (const expiredAtLookup of [true, false]) {
      const { app } = createAuthenticationApp({
        sessions: {
          findUserByTokenHash: async () =>
            expiredAtLookup ? null : publicUser,
          revoke: async () => {
            throw new SessionUnavailableError();
          },
        },
      });
      const response = await request(app)
        .post("/api/auth/logout")
        .set("Cookie", "session=synthetic-ended-session");
      assert.equal(response.status, 401);
      assert.match(response.body.error, /sign in again/);
      assert.equal(response.headers["set-cookie"], undefined);
    }
  });
  it("preserves a replacement HTTP cookie jar when older successful or rejected revocation responses arrive", async () => {
    for (const scenario of [
      "logout",
      "logout-all",
      "current-session",
      "expired",
      "absent",
      "authorization-ended",
    ]) {
      const live = new Map();
      let nextUserId = 0,
        release,
        arrived,
        revocations = 0;
      const gate = new Promise((resolve) => (release = resolve)),
        started = new Promise((resolve) => (arrived = resolve));
      const sessions = {
        create: async (userId, tokenHash) => {
          live.set(tokenHash, { ...publicUser, id: userId });
        },
        findUserByTokenHash: async (tokenHash) => live.get(tokenHash) ?? null,
        revoke: async (userId) => {
          if (scenario === "authorization-ended")
            throw new SessionUnavailableError();
          revocations++;
          for (const [hash, user] of live)
            if (user.id === userId) live.delete(hash);
        },
        revokeSession: async (userId) => {
          revocations++;
          for (const [hash, user] of live)
            if (user.id === userId) live.delete(hash);
          return { current: true };
        },
      };
      const { app } = createAuthenticationApp({
        users: {
          create: async (email) => ({
            ...publicUser,
            id: String(++nextUserId),
            email,
            authGeneration: "0",
          }),
        },
        sessions,
      });
      const outer = express(),
        path =
          scenario === "current-session"
            ? "/api/auth/sessions/1"
            : scenario === "logout-all"
              ? "/api/auth/logout-all"
              : "/api/auth/logout";
      outer.use(async (r, _s, next) => {
        if (r.path === path && r.method !== "GET") {
          arrived();
          await gate;
        }
        next();
      });
      outer.use(app);
      const browser = request.agent(outer);
      let oldCookie;
      if (scenario !== "absent") {
        const original = await browser.post("/api/auth/register").send({
          email: "original-cookie-fixture@example.invalid",
          password: "synthetic cookie fixture passphrase",
        });
        assert.equal(original.status, 201);
        oldCookie = original.headers["set-cookie"][0].split(";")[0];
      }
      if (scenario === "expired") live.clear();
      const pending = (
        scenario === "current-session"
          ? browser.delete(path)
          : browser.post(path)
      ).then((response) => response);
      await started;
      try {
        const replacement = await browser.post("/api/auth/register").send({
          email: "replacement-cookie-fixture@example.invalid",
          password: "synthetic cookie fixture passphrase",
        });
        assert.equal(replacement.status, 201);
        release();
        const previous = await pending;
        assert.equal(
          previous.status,
          scenario === "current-session"
            ? 200
            : ["expired", "absent", "authorization-ended"].includes(scenario)
              ? 401
              : 204,
          scenario,
        );
        assert.equal(previous.headers["set-cookie"], undefined, scenario);
        const current = await browser.get("/api/auth/me");
        assert.equal(current.status, 200, scenario);
        assert.equal(current.body.user.id, replacement.body.user.id, scenario);
        assert.equal(
          revocations,
          ["expired", "absent", "authorization-ended"].includes(scenario)
            ? 0
            : 1,
          scenario,
        );
        if (oldCookie && scenario !== "authorization-ended")
          assert.equal(
            (await request(outer).get("/api/auth/me").set("Cookie", oldCookie))
              .status,
            401,
            scenario,
          );
      } finally {
        release();
        await pending;
      }
    }
  });
  it("rejects browser account selectors on normal account-wide sign out", async () => {
    const { app } = createAuthenticationApp();
    const response = await request(app)
      .post("/api/auth/logout")
      .send({ userId: "some-other-owner" });
    assert.equal(response.status, 400);
  });
  it(
    "finishes local sign-out-all while provider reset is unavailable and bypasses the Redis sign-in limiter",
    { timeout: 2000 },
    async () => {
      let complete,
        revoked = 0,
        throttled = 0;
      const app = createApp({
        messages,
        users: {},
        logger,
        environment: "test",
        sessions: {
          findUserByTokenHash: async (_hash, options) => {
            assert.equal(options.localRevocation, true);
            return publicUser;
          },
          revoke: async (_id, _hash, retainCurrent) => {
            assert.equal(retainCurrent, false);
            revoked++;
          },
        },
        sharedAuthLimiter: (_r, s) => {
          throttled++;
          s.sendStatus(503);
        },
        synchronizeProvider: () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      });
      try {
        const response = await request(app)
          .post("/api/auth/logout")
          .set("Cookie", "session=synthetic-live-session");
        assert.equal(response.status, 204);
        assert.equal(revoked, 1);
        assert.equal(throttled, 0);
      } finally {
        complete?.();
      }
    },
  );
  it("does not report successful global sign out when the authoritative database rejects revocation", async () => {
    const { app } = createAuthenticationApp({
      sessions: {
        findUserByTokenHash: async () => publicUser,
        revoke: async () => {
          throw new Error("synthetic database unavailable");
        },
      },
    });
    const response = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", "session=synthetic-live-session");
    assert.equal(response.status, 500);
    assert.equal(response.headers["set-cookie"], undefined);
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
