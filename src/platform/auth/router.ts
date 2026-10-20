import express from "express";
import type { NextFunction, Request, Response } from "express";
import type { IdentityVerifier } from "./privy.ts";
import { ProviderUnavailableError } from "./privy.ts";
import {
  ProviderAccountError,
  type createProviderAccounts,
} from "./provider-accounts.ts";
import { publicUser } from "./users.ts";
import type { PublicUser, AuthenticationUser } from "./users.ts";
import { SessionUnavailableError } from "./sessions.ts";
import type { AuthenticationSnapshot } from "./sessions.ts";
import type { createUserRepository } from "./users.ts";
import type { createSessionRepository } from "./sessions.ts";
import type { createWalletRepository } from "./wallets.ts";
import type { WalletChallenge } from "./wallets.ts";
import { hashPassword, validatePassword, verifyPassword } from "./passwords.ts";
import { createSessionToken, hashSessionToken } from "./session-tokens.ts";
import {
  createChallengeMessage,
  normalizeWalletAddress,
  validChainId,
  verifyChallengeSignature,
  WalletVerificationUnavailableError,
} from "./siwe.ts";
import {
  ChallengeUnavailableError,
  WalletAlreadyLinkedError,
} from "./wallets.ts";
import { createApiRateLimiter } from "../security.ts";
import { WalletOperationError } from "./wallet-operations.ts";

const dummyPasswordHash =
  "$argon2id$v=19$m=19456,p=1,t=2$lyjbixDyiZIjLayIBjKzug$XkfmwNfqtaLsRnC6LtyIEGEQ5pApGzGiypF/XpcVboI";

declare module "express-serve-static-core" {
  interface Request {
    user?: PublicUser;
  }
}

function normalizeEmail(email: unknown) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function isValidEmail(email: string) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email);
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

export function getCookieSettings(environment: string) {
  const isProduction = environment === "production";

  return {
    name: isProduction ? "__Host-session" : "session",
    options: Object.freeze({
      httpOnly: true,
      secure: isProduction,
      sameSite: "strict" as const,
      path: "/",
    }),
  };
}

export function createRequireAuthentication({
  sessions,
  environment,
  localRevocation = false,
}: {
  sessions: ReturnType<typeof createSessionRepository>;
  environment: string;
  localRevocation?: boolean;
}) {
  const cookie = getCookieSettings(environment);

  return async function requireAuthentication(
    request: Request,
    response: Response,
    next: NextFunction,
  ) {
    const token = request.cookies[cookie.name];

    if (!token) {
      return response.status(401).json({ error: "authentication required" });
    }

    const user = await sessions.findUserByTokenHash(
      hashSessionToken(token),
      localRevocation ? { localRevocation: true } : undefined,
    );

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
  wallets,
  environment,
  applicationOrigin = "http://localhost:3000",
  siweRpcUrls = {},
  now = Date.now,
  sessionDurationMs = 7 * 24 * 60 * 60 * 1_000,
  authRateLimit = 10,
  rateLimitWindowMs = 15 * 60 * 1_000,
  provider,
  recordAuth = () => {},
  synchronizeProvider,
  sharedAccountLimiter,
}: {
  users: ReturnType<typeof createUserRepository>;
  sessions: ReturnType<typeof createSessionRepository>;
  wallets?: ReturnType<typeof createWalletRepository>;
  environment: string;
  applicationOrigin?: string;
  siweRpcUrls?: Readonly<Record<string, string>>;
  now?: () => number;
  sessionDurationMs?: number;
  authRateLimit?: number;
  rateLimitWindowMs?: number;
  provider?: {
    appId: string;
    clientId?: string;
    verifier: IdentityVerifier;
    accounts: ReturnType<typeof createProviderAccounts>;
  };
  recordAuth?: (
    event: string,
    seconds?: number,
    phase?: "journey" | "exchange",
  ) => void;
  synchronizeProvider?: (userId: string) => Promise<void>;
  sharedAccountLimiter?: express.RequestHandler;
}) {
  const router = express.Router();
  const cookie = getCookieSettings(environment);
  const requireAuthentication = createRequireAuthentication({
    sessions,
    environment,
  });
  const requireLocalRevocation = createRequireAuthentication({
    sessions,
    environment,
    localRevocation: true,
  });
  const authLimiter = createApiRateLimiter({
    windowMs: rateLimitWindowMs,
    limit: authRateLimit,
  });
  const walletLimiter = createApiRateLimiter({
    windowMs: rateLimitWindowMs,
    limit: authRateLimit * 4,
  });

  router.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  router.get("/provider", async (_request, response) => {
    if (!provider) return response.json({ enabled: false });
    try {
      const methods = await provider.verifier.configuration();
      return response.json({
        enabled: true,
        appId: provider.appId,
        clientId: provider.clientId,
        ...methods,
      });
    } catch {
      return response
        .status(503)
        .json({ error: "sign-in is temporarily unavailable" });
    }
  });
  router.post("/journey", authLimiter, (request, response) => {
    const events = new Set([
      "started",
      "completed",
      "code_sent",
      "code_resent",
      "provider_error",
      "recovery_started",
      "recovery_completed",
      "cancelled",
    ]);
    const { event, seconds } = request.body ?? {};
    if (
      !request.body ||
      Object.keys(request.body).some(
        (key) => key !== "event" && key !== "seconds",
      ) ||
      !events.has(event) ||
      (seconds !== undefined &&
        (typeof seconds !== "number" ||
          !Number.isFinite(seconds) ||
          seconds < 0 ||
          seconds > 600))
    )
      return response.status(400).json({ error: "invalid journey event" });
    recordAuth(event, seconds);
    return response.status(204).end();
  });
  router.post("/privy/exchange", authLimiter, async (request, response) => {
    const exchangeStart = performance.now();
    if (!provider)
      return response
        .status(503)
        .json({ error: "email verification is not configured" });
    // Login CSRF applies even before there is an application cookie.
    if (request.get("origin") !== applicationOrigin)
      return response
        .status(403)
        .json({ error: "request origin is not allowed" });
    const currentToken = request.cookies[cookie.name];
    if (
      typeof currentToken === "string" &&
      (await sessions.findUserByTokenHash(hashSessionToken(currentToken)))
    )
      return response.status(409).json({
        error: "already signed in; sign out before changing accounts",
      });
    const header = request.get("authorization");
    if (!header?.startsWith("Bearer ") || header.length > 12_000)
      return response
        .status(401)
        .json({ error: "provider authentication required" });
    let identity;
    try {
      identity = await provider.verifier.verify(header.slice(7));
    } catch (error) {
      recordAuth("provider_error");
      if (error instanceof ProviderUnavailableError)
        return response
          .status(503)
          .json({ error: "sign-in is temporarily unavailable" });
      return response
        .status(401)
        .json({ error: "provider verification failed; sign in again" });
    }
    try {
      const { token, tokenHash } = createSessionToken();
      const result = await provider.accounts.exchange(
        identity,
        tokenHash,
        new Date(now() + sessionDurationMs),
      );
      response.cookie(cookie.name, token, {
        ...cookie.options,
        maxAge: sessionDurationMs,
      });
      recordAuth(
        result.created ? "signup_completed" : "signin_completed",
        (performance.now() - exchangeStart) / 1000,
        "exchange",
      );
      return response
        .status(result.created ? 201 : 200)
        .json({ user: publicUser(result.user), created: result.created });
    } catch (error) {
      if (error instanceof ProviderAccountError)
        return response.status(error.status).json({ error: error.message });
      if (error instanceof SessionUnavailableError)
        return response.status(401).json({ error: "account unavailable" });
      throw error;
    }
  });
  router.get("/methods", requireAuthentication, async (request, response) =>
    response.json({
      provider: provider
        ? await provider.accounts.details(request.user!.id)
        : null,
      legacyPassword: Boolean(request.user!.email),
    }),
  );
  if (sharedAccountLimiter)
    router.use(
      "/wallet/operations",
      requireAuthentication,
      sharedAccountLimiter,
    );

  async function startSession(
    user: AuthenticationUser,
    response: Response,
    expected: AuthenticationSnapshot = { authGeneration: user.authGeneration },
  ) {
    const { token, tokenHash } = createSessionToken();
    const expiresAt = new Date(now() + sessionDurationMs);

    await sessions.create(user.id, tokenHash, expiresAt, expected);
    response.cookie(cookie.name, token, {
      ...cookie.options,
      maxAge: sessionDurationMs,
    });
  }

  router.post("/register", authLimiter, async (request, response) => {
    if (provider)
      return response.status(410).json({ error: "use verified email signup" });
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

    return response.status(201).json({ user: publicUser(user) });
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

    try {
      await startSession(user, response, {
        authGeneration: user.authGeneration,
        passwordHash: user.passwordHash!,
        email,
      });
    } catch (error) {
      if (error instanceof SessionUnavailableError)
        return response.status(401).json(invalidCredentials);
      throw error;
    }
    return response.json({ user: publicUser(user) });
  });

  router.get("/me", requireAuthentication, (request, response) => {
    return response.json({ user: request.user });
  });

  router.post("/logout", async (request, response) => {
    if (request.body && Object.keys(request.body).length)
      return response.status(400).json({
        error: "this operation accepts no account or session selectors",
      });
    const token = request.cookies[cookie.name];
    if (!token) {
      return response.status(401).json({
        error:
          "this session has ended; sign in again to sign out other devices",
      });
    }
    if (token) {
      const hash = hashSessionToken(token);
      const user = await sessions.findUserByTokenHash(hash, {
        localRevocation: true,
      });
      if (!user) {
        return response.status(401).json({
          error:
            "this session has ended; sign in again to sign out other devices",
        });
      }
      if (user) {
        try {
          await sessions.revoke(user.id, hash, false, String(request.id));
          if (synchronizeProvider)
            void Promise.resolve()
              .then(() => synchronizeProvider(user.id))
              .catch(() => recordAuth("provider_revocation_retry"));
        } catch (error) {
          if (!(error instanceof SessionUnavailableError)) throw error;
          return response.status(401).json({
            error:
              "this session ended before sign-out-all completed; sign in again to end other sessions",
          });
        }
      }
    }

    // Revocation is authoritative in PostgreSQL. Do not delete the shared cookie
    // in a delayed response: another tab may have established a newer session.
    return response.status(204).end();
  });

  router.get("/sessions", requireLocalRevocation, async (request, response) => {
    try {
      return response.json(
        await sessions.list(
          request.user!.id,
          hashSessionToken(request.cookies[cookie.name]),
        ),
      );
    } catch (error) {
      if (error instanceof SessionUnavailableError)
        return response.status(401).json({ error: "authentication required" });
      throw error;
    }
  });
  // Session revocation remains available when provider or shared Redis is down.
  router.delete(
    "/sessions/:id",
    requireLocalRevocation,
    async (request, response) => {
      if (request.body && Object.keys(request.body).length)
        return response
          .status(400)
          .json({ error: "this operation accepts no account selectors" });
      const id = request.params.id;
      if (
        typeof id !== "string" ||
        !/^[1-9][0-9]{0,18}$/.test(id) ||
        BigInt(id) > 9223372036854775807n
      )
        return response.status(400).json({ error: "invalid session" });
      try {
        const removed = await sessions.revokeSession(
          request.user!.id,
          hashSessionToken(request.cookies[cookie.name]),
          id,
          String(request.id),
        );
        if (!removed)
          return response.status(404).json({ error: "session unavailable" });
        return response.json(removed);
      } catch (error) {
        if (error instanceof SessionUnavailableError)
          return response
            .status(401)
            .json({ error: "authentication required" });
        throw error;
      }
    },
  );

  for (const [path, retainCurrent] of [
    ["/logout-all", false],
    ["/logout-other-sessions", true],
  ] as const) {
    router.post(
      path,
      authLimiter,
      requireLocalRevocation,
      async (request, response) => {
        // No account/session selector is accepted. Ownership comes from the live cookie.
        if (request.body && Object.keys(request.body).length)
          return response.status(400).json({
            error: "this operation accepts no account or session selectors",
          });
        try {
          await sessions.revoke(
            request.user!.id,
            hashSessionToken(request.cookies[cookie.name]),
            retainCurrent,
            String(request.id),
          );
          if (synchronizeProvider)
            void Promise.resolve()
              .then(() => synchronizeProvider(request.user!.id))
              .catch(() => recordAuth("provider_revocation_retry"));
        } catch (error) {
          if (error instanceof SessionUnavailableError)
            return response
              .status(401)
              .json({ error: "authentication required" });
          throw error;
        }
        return response.status(204).end();
      },
    );
  }

  if (wallets) {
    const walletRepository = wallets;
    function walletInput(body: unknown) {
      if (typeof body !== "object" || body === null || Array.isArray(body))
        return null;
      const value = body as Record<string, unknown>;
      const address = normalizeWalletAddress(value.address);
      if (!address || !validChainId(value.chainId)) return null;
      return { address, chainId: value.chainId };
    }

    async function issueChallenge(
      body: unknown,
      purpose: "login" | "link",
      userId?: string,
      sessionTokenHash?: string,
    ) {
      const input = walletInput(body);
      if (!input) return null;
      const { message, expiresAt } = createChallengeMessage({
        ...input,
        origin: applicationOrigin,
        purpose,
      });
      return walletRepository.createChallenge({
        ...input,
        purpose,
        message,
        expiresAt,
        userId,
        sessionTokenHash,
      });
    }

    function verificationInput(body: unknown) {
      if (typeof body !== "object" || body === null || Array.isArray(body))
        return null;
      const value = body as Record<string, unknown>;
      if (
        typeof value.challengeId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          value.challengeId,
        ) ||
        typeof value.signature !== "string" ||
        value.signature.length > 8194
      )
        return null;
      return { challengeId: value.challengeId, signature: value.signature };
    }

    async function validSignature(
      challenge: WalletChallenge,
      signature: string,
    ) {
      return verifyChallengeSignature({
        challenge,
        signature,
        origin: applicationOrigin,
        rpcUrls: siweRpcUrls,
      });
    }

    router.post(
      "/wallet/login/challenge",
      walletLimiter,
      async (request, response) => {
        const existingToken = request.cookies[cookie.name];
        if (
          existingToken &&
          (await sessions.findUserByTokenHash(hashSessionToken(existingToken)))
        ) {
          return response
            .status(409)
            .json({ error: "sign out before switching accounts" });
        }
        const challenge = await issueChallenge(request.body, "login");
        if (!challenge)
          return response
            .status(400)
            .json({ error: "invalid wallet or chain" });
        return response.status(201).json({
          id: challenge.id,
          message: challenge.message,
          expiresAt: challenge.expiresAt,
        });
      },
    );

    router.post(
      "/wallet/login/verify",
      walletLimiter,
      async (request, response) => {
        const input = verificationInput(request.body);
        if (!input)
          return response
            .status(400)
            .json({ error: "invalid verification request" });
        const existingToken = request.cookies[cookie.name];
        if (
          existingToken &&
          (await sessions.findUserByTokenHash(hashSessionToken(existingToken)))
        ) {
          return response
            .status(409)
            .json({ error: "sign out before switching accounts" });
        }
        const challenge = await walletRepository.getChallenge(
          input.challengeId,
        );
        if (!challenge || challenge.purpose !== "login")
          return response
            .status(410)
            .json({ error: "challenge expired or used" });
        try {
          if (!(await validSignature(challenge, input.signature)))
            return response
              .status(401)
              .json({ error: "wallet signature is invalid" });
        } catch (error) {
          if (error instanceof WalletVerificationUnavailableError)
            return response.status(503).json({
              error: "wallet verification is temporarily unavailable",
            });
          throw error;
        }
        try {
          const { token, tokenHash } = createSessionToken();
          const user = await walletRepository.completeLogin(challenge.id, {
            tokenHash,
            expiresAt: new Date(now() + sessionDurationMs),
          });
          response.cookie(cookie.name, token, {
            ...cookie.options,
            maxAge: sessionDurationMs,
          });
          return response.json({ user: publicUser(user) });
        } catch (error) {
          if (error instanceof ChallengeUnavailableError)
            return response
              .status(410)
              .json({ error: "challenge expired or used" });
          throw error;
        }
      },
    );

    function operationInput(body: unknown) {
      const target = walletInput(body);
      if (!target) return null;
      const value = body as Record<string, unknown>;
      if (value.purpose !== "link" && value.purpose !== "unlink") return null;
      return { ...target, purpose: value.purpose as "link" | "unlink" };
    }

    function uuid(value: unknown): value is string {
      return (
        typeof value === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          value,
        )
      );
    }

    function operationError(error: unknown, response: Response) {
      if (error instanceof WalletOperationError)
        return response.status(error.status).json({ error: error.message });
      if (error instanceof SessionUnavailableError)
        return response.status(401).json({ error: "authentication required" });
      if (error instanceof WalletAlreadyLinkedError)
        return response
          .status(409)
          .json({ error: "wallet is already linked to an account" });
      if (error instanceof WalletVerificationUnavailableError)
        return response.status(503).json({
          error: "wallet verification is temporarily unavailable; try again",
        });
      throw error;
    }

    router.post(
      "/wallet/operations",
      walletLimiter,
      requireAuthentication,
      async (request, response) => {
        const input = operationInput(request.body);
        const credential = request.body?.credential;
        if (
          !input ||
          !credential ||
          (credential.type !== "password" && credential.type !== "wallet") ||
          (credential.type === "wallet" && !uuid(credential.walletId)) ||
          (input.purpose === "unlink" && !uuid(request.body.targetWalletId))
        )
          return response
            .status(400)
            .json({ error: "invalid wallet operation" });
        try {
          const operation = await walletRepository.operations.create({
            ...input,
            targetWalletId:
              input.purpose === "unlink"
                ? request.body.targetWalletId
                : undefined,
            credential,
            userId: request.user!.id,
            sessionTokenHash: hashSessionToken(request.cookies[cookie.name]),
            origin: applicationOrigin,
          });
          return response.status(201).json({
            id: operation.id,
            purpose: operation.purpose,
            address: operation.address,
            chainId: operation.chainId,
            expiresAt: operation.expiresAt,
            authorizationMessage: operation.authorizationMessage,
            proposedMessage: operation.proposedMessage,
            authorizingAddress: operation.authorizingAddress,
            authorizingChainId: operation.authorizingChainId,
          });
        } catch (error) {
          return operationError(error, response);
        }
      },
    );

    router.post(
      "/wallet/operations/:id/complete",
      authLimiter,
      requireAuthentication,
      async (request, response) => {
        const input = operationInput(request.body);
        const { password, authorizationSignature, proposedSignature } =
          request.body ?? {};
        if (
          !input ||
          !uuid(request.params.id) ||
          [authorizationSignature, proposedSignature].some(
            (value) =>
              value !== undefined &&
              (typeof value !== "string" || value.length > 8194),
          ) ||
          (password !== undefined &&
            (typeof password !== "string" || password.length > 512))
        )
          return response
            .status(400)
            .json({ error: "invalid wallet operation proof" });
        try {
          const result = await walletRepository.operations.complete({
            ...input,
            id: request.params.id,
            password,
            authorizationSignature,
            proposedSignature,
            userId: request.user!.id,
            sessionTokenHash: hashSessionToken(request.cookies[cookie.name]),
            origin: applicationOrigin,
            rpcUrls: siweRpcUrls,
            sessionDurationMs,
            requestId: String(request.id),
          });
          response.cookie(cookie.name, result.token, {
            ...cookie.options,
            maxAge: sessionDurationMs,
          });
          return response.json({ wallet: result.wallet });
        } catch (error) {
          return operationError(error, response);
        }
      },
    );

    router.get("/wallets", requireAuthentication, async (request, response) => {
      return response.json({
        wallets: await walletRepository.listWallets(request.user!.id),
      });
    });
  }

  return router;
}
