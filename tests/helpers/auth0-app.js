// Builds the real application with Auth0 sign-in pointed at an in-process
// issuer, and drives a browser-like sign-in through it.
import assert from "node:assert/strict";
import { createApp } from "../../dist/app.js";
import { createLogger } from "../../dist/platform/logger.js";
import { createSessionRepository } from "../../dist/platform/auth/sessions.js";
import { createUserRepository } from "../../dist/platform/auth/users.js";
import { createAuth0Client } from "../../dist/platform/auth/auth0.js";
import { createAuth0Accounts } from "../../dist/platform/auth/auth0-accounts.js";
import { createSignInState } from "../../dist/platform/auth/sign-in-state.js";
import { createAccountOperationRepository } from "../../dist/platform/auth/account-operations.js";
import { startIssuer } from "../../scripts/oidc-test-issuer.ts";
import request from "../../scripts/test-http-request.ts";

export const origin = "http://localhost:3000";
export const clientId = "test-client-0123456789";
export const clientSecret = "test-client-secret-0123456789";

export async function createAuth0TestApp(pool, options = {}) {
  const issuer = await startIssuer({ clientId, clientSecret });
  const accounts = createAuth0Accounts(pool);
  const state = createSignInState(pool);
  const sessions = createSessionRepository(pool);
  const operations = createAccountOperationRepository(pool);
  const app = createApp({
    messages: {},
    users: createUserRepository(pool),
    sessions,
    logger: createLogger({ enabled: false }),
    environment: "test",
    applicationOrigin: origin,
    authRateLimit: 10_000,
    auth0: {
      client: createAuth0Client(
        { issuer: new URL(issuer.issuer), clientId, clientSecret },
        { redirectUri: `${origin}/api/auth/callback` },
      ),
      accounts,
      state,
    },
    ...options,
  });
  return { app, issuer, accounts, state, sessions, operations };
}

// Starts a sign-in on this agent and returns the provider's authorization URL.
export async function startSignIn(agent, query = "connection=email") {
  const response = await agent.get(`/api/auth/login?${query}`).expect(303);
  return response.headers.location;
}

export function sessionCookie(response) {
  return (response.headers["set-cookie"] ?? []).find((value) =>
    value.startsWith("session="),
  );
}

// A complete browser sign-in: login, provider, callback.
export async function signIn(context, identity, { query, agent } = {}) {
  const browser = agent ?? request.agent(context.app);
  const location = await startSignIn(
    browser,
    query ??
      `connection=${identity.subject.startsWith("google") ? "google" : "email"}`,
  );
  const callback = await browser.get(
    context.issuer.authorize(location, identity),
  );
  return { agent: browser, callback, location };
}

export async function me(agent) {
  const response = await agent.get("/api/auth/me");
  return response.status === 200 ? response.body.user : null;
}

export function continueTarget(response) {
  const match = /http-equiv="refresh" content="0;url=([^"]+)"/.exec(
    response.text,
  );
  assert.ok(match, "callback renders the same-site continue page");
  return match[1].replaceAll("&amp;", "&");
}
