import express from "express";
import { hashPassword, validatePassword, verifyPassword } from "./passwords.js";
import { createSessionToken, hashSessionToken } from "./session-tokens.js";
import { createApiRateLimiter } from "../security.js";

const dummyPasswordHash =
  "$argon2id$v=19$m=19456,p=1,t=2$lyjbixDyiZIjLayIBjKzug$XkfmwNfqtaLsRnC6LtyIEGEQ5pApGzGiypF/XpcVboI";

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function isValidEmail(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email);
}

function isUniqueViolation(error) {
  return error?.code === "23505";
}

function getCookieSettings(environment) {
  const isProduction = environment === "production";

  return {
    name: isProduction ? "__Host-session" : "session",
    options: Object.freeze({
      httpOnly: true,
      secure: isProduction,
      sameSite: "strict",
      path: "/",
    }),
  };
}

export function createRequireAuthentication({ sessions, environment }) {
  const cookie = getCookieSettings(environment);

  return async function requireAuthentication(request, response, next) {
    const token = request.cookies[cookie.name];

    if (!token) {
      return response.status(401).json({ error: "authentication required" });
    }

    const user = await sessions.findUserByTokenHash(hashSessionToken(token));

    if (!user) {
      return response.status(401).json({ error: "authentication required" });
    }

    request.user = user;
    return next();
  };
}

export function createAuthRouter({
  users,
  sessions,
  environment,
  now = Date.now,
  sessionDurationMs = 7 * 24 * 60 * 60 * 1_000,
  authRateLimit = 10,
  rateLimitWindowMs = 15 * 60 * 1_000,
}) {
  const router = express.Router();
  const cookie = getCookieSettings(environment);
  const requireAuthentication = createRequireAuthentication({
    sessions,
    environment,
  });
  const authLimiter = createApiRateLimiter({
    windowMs: rateLimitWindowMs,
    limit: authRateLimit,
  });

  router.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  async function startSession(user, response) {
    const { token, tokenHash } = createSessionToken();
    const expiresAt = new Date(now() + sessionDurationMs);

    await sessions.create(user.id, tokenHash, expiresAt);
    response.cookie(cookie.name, token, {
      ...cookie.options,
      maxAge: sessionDurationMs,
    });
  }

  router.post("/register", authLimiter, async (request, response) => {
    const email = normalizeEmail(request.body?.email);
    const password = request.body?.password;

    if (!isValidEmail(email)) {
      return response.status(400).json({ error: "email is invalid" });
    }

    const passwordError = validatePassword(password);
    if (passwordError) {
      return response.status(400).json({ error: passwordError });
    }

    const passwordHash = await hashPassword(password);
    let user;

    try {
      user = await users.create(email, passwordHash);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return response
          .status(409)
          .json({ error: "email is already registered" });
      }

      throw error;
    }

    await startSession(user, response);

    return response.status(201).json({ user });
  });

  router.post("/login", authLimiter, async (request, response) => {
    const email = normalizeEmail(request.body?.email);
    const password = request.body?.password;
    const invalidCredentials = { error: "email or password is incorrect" };

    if (!isValidEmail(email) || typeof password !== "string") {
      return response.status(401).json(invalidCredentials);
    }

    const user = await users.findByEmail(email);
    const passwordMatches = await verifyPassword(
      user?.passwordHash ?? dummyPasswordHash,
      password,
    );

    if (!user || !passwordMatches) {
      return response.status(401).json(invalidCredentials);
    }

    const publicUser = {
      id: user.id,
      email: user.email,
      createdAt: user.createdAt,
    };

    await startSession(publicUser, response);

    return response.json({ user: publicUser });
  });

  router.get("/me", requireAuthentication, (request, response) => {
    return response.json({ user: request.user });
  });

  router.post("/logout", async (request, response) => {
    const token = request.cookies[cookie.name];

    if (token) {
      await sessions.deleteByTokenHash(hashSessionToken(token));
    }

    response.clearCookie(cookie.name, cookie.options);
    return response.status(204).end();
  });

  return router;
}
