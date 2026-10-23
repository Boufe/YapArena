// Test identity entry (Decision 0009, point 10). Tests, browser verifiers and
// local development sign in here without Auth0. It calls the same
// post-callback sign-in function as GET /api/auth/callback, with an identity
// the caller chooses. It lives under scripts/: the build compiles only src/**
// and the image copies four named scripts, so it never ships.
import { createHash } from "node:crypto";
import express from "express";
import type { Request, Response } from "express";
import cookieParser from "cookie-parser";
import { html } from "../dist/platform/html.js";
import { createSessionToken } from "../dist/platform/auth/session-tokens.js";
import { getCookieSettings } from "../dist/platform/auth/router.js";
import {
  normalizeEmail,
  signInMethod,
  type SignInMethod,
} from "../dist/platform/auth/auth0.js";
import {
  SignInError,
  type Auth0Accounts,
} from "../dist/platform/auth/auth0-accounts.js";
import { safeReturnPath } from "../dist/platform/auth/sign-in-state.js";

const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
const providerSettings = [
  "AUTH0_ISSUER_BASE_URL",
  "AUTH0_CLIENT_ID",
  "AUTH0_CLIENT_SECRET",
  "PRODUCTION_SERVICE",
  "PRIVY_APP_ID",
  "PRIVY_APP_SECRET",
  "PRIVY_VERIFICATION_KEY",
];

// The startup refusals. The entry exits before loading the application when
// any applies, so it cannot serve a hosted or production environment.
export function testIdentityRefusal(env: NodeJS.ProcessEnv): string | null {
  if (env.NODE_ENV === "production")
    return "the test identity entry refuses NODE_ENV=production";
  if (env.RENDER !== undefined)
    return "the test identity entry refuses to run on Render";
  for (const key of providerSettings)
    if (env[key]) return `the test identity entry refuses ${key}`;
  if (env.APP_ORIGIN) {
    let hostname: string;
    try {
      hostname = new URL(env.APP_ORIGIN).hostname;
    } catch {
      return "the test identity entry requires a loopback APP_ORIGIN";
    }
    if (!loopback.has(hostname))
      return "the test identity entry requires a loopback APP_ORIGIN";
  }
  return null;
}

// A stable subject per address and method, shaped like Auth0's.
export function testSubject(method: SignInMethod, email: string) {
  const id = createHash("sha256")
    .update(`${method}:${email}`)
    .digest("hex")
    .slice(0, 24);
  return `${method === "google" ? "google-oauth2" : "email"}|test-${id}`;
}

type SignInFields = {
  email?: unknown;
  method?: unknown;
  subject?: unknown;
  pendingLinkId?: unknown;
  return?: unknown;
};

export function createTestIdentityRouter({
  accounts,
  environment,
  applicationOrigin = "http://localhost:3000",
  sessionDurationMs = 7 * 24 * 60 * 60 * 1_000,
  now = Date.now,
}: {
  accounts: Pick<Auth0Accounts, "signIn">;
  environment: string;
  applicationOrigin?: string;
  sessionDurationMs?: number;
  now?: () => number;
}) {
  const router = express.Router();
  const cookie = getCookieSettings(environment);
  router.use(express.json({ limit: "4kb" }));
  router.use(express.urlencoded({ extended: false, limit: "4kb" }));
  router.use(cookieParser());
  router.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  function form(
    response: Response,
    input: {
      returnPath: string;
      notice?: string;
      pendingLinkId?: string;
      email?: string;
    },
  ) {
    const link = input.pendingLinkId
      ? html`<input type="hidden" name="pendingLinkId" value="${input.pendingLinkId}"><input type="hidden" name="method" value="email"><input type="hidden" name="email" value="${input.email}"><p>Confirm the email code for ${input.email} to link Google.</p>`
      : html`<label>Email <input name="email" type="email" required autocomplete="email"></label>
<fieldset><legend>Method</legend><label><input type="radio" name="method" value="email" checked> Email code</label><label><input type="radio" name="method" value="google"> Google</label></fieldset>`;
    return response.type("html").send(
      html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Test sign-in · YAP Arena</title></head>
<body><main><h1>Test sign-in</h1><p>Local test identity entry. It never runs in production.</p>${input.notice ? html`<p role="alert">${input.notice}</p>` : ""}
<form method="post" action="/api/test-identity/sign-in" id="test-identity-form"><input type="hidden" name="return" value="${input.returnPath}">${link}<button type="submit">Continue</button></form></main></body></html>`.toString(),
    );
  }

  router.get("/", (request: Request, response) =>
    form(response, {
      returnPath:
        safeReturnPath(request.query.return, applicationOrigin) ?? "/",
    }),
  );

  router.post("/sign-in", async (request: Request, response) => {
    const body: SignInFields =
      request.body && typeof request.body === "object" ? request.body : {};
    const browser = !request.is("application/json");
    const returnPath = safeReturnPath(body.return, applicationOrigin) ?? "/";
    const email = normalizeEmail(body.email);
    const method = body.method === undefined ? "email" : String(body.method);
    if (!email || (method !== "email" && method !== "google"))
      return response.status(400).json({ error: "email and method required" });
    const subject =
      typeof body.subject === "string"
        ? body.subject
        : testSubject(method, email);
    if (signInMethod(subject) !== method)
      return response
        .status(400)
        .json({ error: "subject does not match method" });
    const pendingLinkId =
      typeof body.pendingLinkId === "string" ? body.pendingLinkId : undefined;
    const { token, tokenHash } = createSessionToken();
    try {
      const result = await accounts.signIn(
        { subject, email, method, authTime: Math.floor(now() / 1000) },
        pendingLinkId
          ? { purpose: "link", pendingLinkId }
          : { purpose: "sign_in" },
        { tokenHash, expiresAt: new Date(now() + sessionDurationMs) },
      );
      if (result.kind === "link_required") {
        if (browser)
          return form(response.status(202), {
            returnPath,
            pendingLinkId: result.pendingLinkId,
            email: result.email,
          });
        return response.status(202).json({
          linkRequired: true,
          pendingLinkId: result.pendingLinkId,
          email: result.email,
        });
      }
      response.cookie(cookie.name, token, {
        ...cookie.options,
        maxAge: sessionDurationMs,
      });
      if (browser) return response.redirect(303, returnPath);
      return response.status(result.created ? 201 : 200).json({
        user: {
          id: result.user.id,
          email: result.user.email,
          createdAt: result.user.createdAt,
        },
        created: result.created,
        linked: result.linked,
        subject,
      });
    } catch (error) {
      if (!(error instanceof SignInError)) throw error;
      if (browser)
        return form(response.status(error.status), {
          returnPath,
          notice: error.message,
        });
      return response
        .status(error.status)
        .json({ error: error.message, code: error.code });
    }
  });
  return router;
}
