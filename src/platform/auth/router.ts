import express from "express";
import type { NextFunction, Request, Response } from "express";
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
  WalletRegistrationUnavailableError,
} from "./wallets.ts";
import { createApiRateLimiter } from "../security.ts";
import type { SharedRateLimits } from "../shared-abuse.ts";
import { WalletOperationError } from "./wallet-operations.ts";
import {
  Auth0SignInError,
  Auth0UnavailableError,
  createLoginSecrets,
  type Auth0Client,
  type Auth0SignInFailure,
} from "./auth0.ts";
import { SignInError, type Auth0Accounts } from "./auth0-accounts.ts";
import {
  createBindingValue,
  getBindingCookieSettings,
  safeReturnPath,
  validBindingValue,
  type createSignInState,
} from "./sign-in-state.ts";
import { renderSignInContinue, renderSignInProblem } from "./sign-in-pages.ts";

export type Auth0SignIn = {
  client: Auth0Client;
  accounts: Auth0Accounts;
  state: ReturnType<typeof createSignInState>;
};

const dummyPasswordHash =
  "$argon2id$v=19$m=19456,p=1,t=2$lyjbixDyiZIjLayIBjKzug$XkfmwNfqtaLsRnC6LtyIEGEQ5pApGzGiypF/XpcVboI";

const providerFailures: Readonly<
  Record<Auth0SignInFailure, { title: string; message: string }>
> = {
  cancelled: {
    title: "Sign-in cancelled",
    message: "Sign-in was cancelled. Nothing changed.",
  },
  invalid: {
    title: "Sign-in didn't finish",
    message: "We couldn't verify this sign-in. Start again.",
  },
  email_unverified: {
    title: "Email not verified",
    message:
      "Your email address isn't verified, so we can't sign you in. Contact YapArena support for help.",
  },
  unsupported_method: {
    title: "Use Google or an email code",
    message: "YAP Arena accepts Google and email-code sign-in only.",
  },
};

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
    // Authentication failures must be private too: downstream feature routers
    // cannot install their cache policy before this middleware rejects access.
    response.set("Cache-Control", "private, no-store");
    response.vary("Cookie");
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
  auth0,
  recordAuth = () => {},
  sharedAccountLimiter,
  sharedRateLimits,
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
  auth0?: Auth0SignIn;
  recordAuth?: (
    event: string,
    seconds?: number,
    phase?: "journey" | "exchange",
  ) => void;
  sharedAccountLimiter?: express.RequestHandler;
  sharedRateLimits?: SharedRateLimits;
}) {
  const router = express.Router();
  const cookie = getCookieSettings(environment);
  const bindingCookie = getBindingCookieSettings(environment);
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
    shared: sharedRateLimits?.("auth", "closed"),
  });
  const walletLimiter = createApiRateLimiter({
    windowMs: rateLimitWindowMs,
    limit: authRateLimit * 4,
    shared: sharedRateLimits?.("auth-wallet", "closed"),
  });

  router.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  function problem(
    response: Response,
    status: number,
    input: { title: string; message: string; back: string; retry?: string },
  ) {
    return response
      .status(status)
      .type("html")
      .send(renderSignInProblem(input));
  }
  const signInLink = (returnPath: string) =>
    `/api/auth/login?return=${encodeURIComponent(returnPath)}`;
  const unavailablePage = (back: string) => ({
    title: "Sign-in unavailable",
    message:
      "Sign-in is temporarily unavailable. You can keep browsing and try again shortly.",
    back,
    retry: signInLink(back),
  });

  // One random value per browser binds every pending sign-in to it. Reusing a
  // live value lets two tabs sign in at once.
  function browserBinding(request: Request, response: Response) {
    const current: unknown = request.cookies[bindingCookie.name];
    const binding = validBindingValue(current) ? current : createBindingValue();
    response.cookie(bindingCookie.name, binding, bindingCookie.options);
    return binding;
  }

  async function signedIn(request: Request) {
    const token: unknown = request.cookies[cookie.name];
    return (
      typeof token === "string" &&
      Boolean(await sessions.findUserByTokenHash(hashSessionToken(token)))
    );
  }

  // Public: which sign-in methods this deployment offers.
  router.get("/provider", (_request, response) =>
    response.json(
      auth0
        ? { enabled: true, methods: ["email", "google"] }
        : { enabled: false, methods: [] },
    ),
  );

  router.get("/login", authLimiter, async (request, response) => {
    const returnPath =
      safeReturnPath(request.query.return, applicationOrigin) ?? "/";
    if (!auth0) return problem(response, 503, unavailablePage(returnPath));
    const connection = request.query.connection;
    if (
      connection !== undefined &&
      connection !== "email" &&
      connection !== "google"
    )
      return problem(response, 400, {
        title: "Sign-in unavailable",
        message: "Choose Google or an email code to sign in.",
        back: returnPath,
      });
    // Already signed in on this device: there is nothing to do.
    if (await signedIn(request)) return response.redirect(303, returnPath);
    try {
      const secrets = createLoginSecrets();
      const url = await auth0.client.authorizationUrl({
        ...secrets,
        ...(connection ? { connection } : {}),
      });
      await auth0.state.create({
        binding: browserBinding(request, response),
        purpose: "sign_in",
        returnPath,
        secrets,
      });
      recordAuth("login_started");
      return response.redirect(303, url.href);
    } catch (error) {
      if (!(error instanceof Auth0UnavailableError)) throw error;
      recordAuth("provider_error");
      return problem(response, 503, unavailablePage(returnPath));
    }
  });

  router.get("/callback", authLimiter, async (request, response) => {
    if (!auth0) return problem(response, 503, unavailablePage("/"));
    const query = new URLSearchParams(
      request.originalUrl.includes("?")
        ? request.originalUrl.slice(request.originalUrl.indexOf("?") + 1)
        : "",
    );
    const state = query.get("state");
    const binding: unknown = request.cookies[bindingCookie.name];
    const transaction =
      state && state.length <= 512 && validBindingValue(binding)
        ? await auth0.state.consume(state, binding)
        : null;
    if (!transaction || transaction.purpose === "confirm") {
      recordAuth("signin_expired");
      return problem(response, 400, {
        title: "Sign-in expired",
        message:
          "This sign-in expired or was already used, so nothing changed. Start again.",
        back: "/",
        retry: signInLink("/"),
      });
    }
    const back = transaction.returnPath;
    try {
      const identity = await auth0.client.verifyCallback(query, {
        ...transaction.secrets,
      });
      const { token, tokenHash } = createSessionToken();
      const result = await auth0.accounts.signIn(
        identity,
        transaction.purpose === "link" && transaction.pendingLinkId
          ? { purpose: "link", pendingLinkId: transaction.pendingLinkId }
          : { purpose: "sign_in" },
        { tokenHash, expiresAt: new Date(now() + sessionDurationMs) },
      );
      if (result.kind === "link_required") {
        // Decision 0009, point 4: no account and no session until the same
        // address is proven with an email code.
        const secrets = createLoginSecrets();
        const url = await auth0.client.authorizationUrl({
          ...secrets,
          connection: "email",
          loginHint: result.email,
          prompt: "login",
        });
        await auth0.state.create({
          binding: browserBinding(request, response),
          purpose: "link",
          returnPath: back,
          pendingLinkId: result.pendingLinkId,
          secrets,
        });
        recordAuth("link_required");
        return response.redirect(303, url.href);
      }
      response.cookie(cookie.name, token, {
        ...cookie.options,
        maxAge: sessionDurationMs,
      });
      recordAuth(
        result.created
          ? "signup_completed"
          : result.linked.length
            ? "link_completed"
            : "signin_completed",
      );
      return response.type("html").send(renderSignInContinue(back));
    } catch (error) {
      if (error instanceof Auth0UnavailableError) {
        recordAuth("provider_error");
        return problem(response, 503, unavailablePage(back));
      }
      if (error instanceof Auth0SignInError) {
        recordAuth(`signin_${error.code}`);
        return problem(response, error.code === "cancelled" ? 400 : 401, {
          ...providerFailures[error.code],
          back,
          retry: signInLink(back),
        });
      }
      if (error instanceof SignInError) {
        recordAuth(`signin_${error.code}`);
        return problem(response, error.status, {
          title: "Sign-in didn't finish",
          message: error.message,
          back,
          ...(error.code === "link_failed" || error.code === "signup_paused"
            ? { retry: signInLink(back) }
            : {}),
        });
      }
      throw error;
    }
  });

  router.get("/methods", requireAuthentication, async (request, response) =>
    response.json({
      accountId: request.user!.id,
      methods: auth0 ? await auth0.accounts.methods(request.user!.id) : [],
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
    if (auth0)
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

  // Sign out ends this device only (Decision 0009, point 6): it deletes this
  // session row, then the browser visits the provider's logout endpoint so
  // the next sign-in on this device asks for credentials again.
  router.post("/logout", async (request, response) => {
    if (request.body && Object.keys(request.body).length)
      return response.status(400).json({
        error: "this operation accepts no account or session selectors",
      });
    const redirectTo = auth0?.client
      .logoutUrl(new URL("/", applicationOrigin).href)
      .toString();
    const ended = {
      error: "this session has already ended",
      ...(redirectTo ? { redirectTo } : {}),
    };
    const token = request.cookies[cookie.name];
    if (!token) return response.status(401).json(ended);
    const hash = hashSessionToken(token);
    const user = await sessions.findUserByTokenHash(hash, {
      localRevocation: true,
    });
    if (!user) return response.status(401).json(ended);
    const expectedAccount = request.get("X-YapArena-Expected-Account");
    if (expectedAccount && expectedAccount !== user.id)
      return response.status(409).json({
        error: "the account changed before sign-out; refresh and try again",
      });
    try {
      if (
        !(await sessions.revokeSession(
          user.id,
          hash,
          undefined,
          String(request.id),
        ))
      )
        return response.status(401).json(ended);
    } catch (error) {
      if (!(error instanceof SessionUnavailableError)) throw error;
      return response.status(401).json(ended);
    }

    // Revocation is authoritative in PostgreSQL. Do not delete the shared cookie
    // in a delayed response: another tab may have established a newer session.
    return redirectTo
      ? response.json({ redirectTo })
      : response.status(204).end();
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
      const expectedAccount = request.get("X-YapArena-Expected-Account");
      if (expectedAccount && expectedAccount !== request.user!.id)
        return response.status(409).json({
          error: "the account changed before sign-out; refresh and try again",
        });
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
          if (error instanceof WalletRegistrationUnavailableError)
            return response.status(403).json({ error: error.message });
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
          if (auth0 && input.purpose === "link")
            return response
              .status(410)
              .json({ error: "external wallet linking is unavailable" });
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
          if (auth0 && input.purpose === "link")
            return response
              .status(410)
              .json({ error: "external wallet linking is unavailable" });
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
