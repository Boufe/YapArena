import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import express from "express";
import helmet from "helmet";
import { chromium, type Page, type Route } from "playwright-core";
import axe from "axe-core";
import {
  renderAccount,
  renderAbout,
  renderMatchmaking,
} from "../dist/features/discovery/web.js";
import { renderDebateWorkspace } from "../dist/features/discovery/debate-web.js";
import { createEmailAuthSecurity } from "../dist/platform/auth/browser-security.js";

// Local UI evidence only: real installed Privy SDK and public configuration,
// intercepted OTP delivery/verification and synthetic application responses.
// No inbox, provider identity, hosted database or money is modified.
const appId = process.env.PRIVY_APP_ID;
assert.ok(appId, "set the public PRIVY_APP_ID; never pass the app secret here");
type PublicProviderSettings = {
  id: string;
  data_classification: string;
  captcha_enabled: boolean;
  enabled_captcha_provider: string | null;
};
let providerSettings: PublicProviderSettings;
try {
  const response = await fetch(`https://auth.privy.io/api/v1/apps/${appId}`, {
    headers: { "privy-app-id": appId },
    signal: AbortSignal.timeout(10_000),
  });
  assert.ok(response.ok);
  providerSettings = await response.json();
  assert.equal(providerSettings.id, appId);
  assert.equal(providerSettings.data_classification, "public");
} catch {
  throw new Error("public provider metadata unavailable for the local fixture");
}
const directory = resolve(
  process.env.AUTH_BROWSER_ARTIFACT_DIR ?? "docs/evidence/email-first",
);
const publicDirectory = resolve(
  process.env.AUTH_BROWSER_PUBLIC_DIR ?? "public",
);
const phase = process.env.AUTH_BROWSER_PHASE ?? "current";
assert.match(phase, /^[a-z-]{1,40}$/);
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const assetFiles = [
  "session-coordination.js",
  "account-auth.bundle.js",
  "account-security.bundle.js",
  "account-session-list.js",
  "account-sessions.js",
  "account.js",
  "site-header.js",
  "auth-return.js",
  "site.js",
  "matching.js",
  "a4-inline.js",
  "arena-chart.js",
  "arena-price.js",
  "account-auth.css",
  "site-header.css",
  "site.css",
  "arena.css",
];
const assetHashes = Object.fromEntries(
  await Promise.all(
    assetFiles.map(async (file) => {
      try {
        return [
          file,
          createHash("sha256")
            .update(await readFile(resolve(publicDirectory, file)))
            .digest("hex"),
        ];
      } catch (error) {
        if (
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return [file, null];
        throw error;
      }
    }),
  ),
);
const sourceHashes = Object.fromEntries(
  await Promise.all(
    [
      "scripts/verify-email-auth-browser.ts",
      "dist/features/discovery/web.js",
      "dist/features/discovery/account-web.js",
      "dist/features/discovery/debate-web.js",
    ].map(async (file) => [
      file,
      createHash("sha256")
        .update(await readFile(resolve(file)))
        .digest("hex"),
    ]),
  ),
);
await mkdir(directory, { recursive: true });
const app = express();
const passkeyCookieGates = new Map<
  string,
  {
    held: ReturnType<typeof deferred>;
    arrived: ReturnType<typeof deferred>;
  }
>();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(createEmailAuthSecurity("test"));
app.get("/test/axe.js", (_request, response) =>
  response.type("js").send(axe.source),
);
app.use("/assets", express.static(publicDirectory));
app.get("/account", (request, response) =>
  response.send(
    renderAccount(base, request.query.baseline !== "1").replace(
      "</head>",
      '<script defer src="/test/axe.js"></script></head>',
    ),
  ),
);
app.get("/test/entry", (_request, response) =>
  response.send(
    renderAbout(base)
      .replace('<html lang="en">', '<html lang="en" data-email-first>')
      .replace("</head>", '<script defer src="/test/axe.js"></script></head>')
      .replace(
        "</main>",
        '<a class="button" id="participate-login" href="/account?next=%2Ftest%2Fentry">Log in to participate</a><a id="reports-login" href="/account/moderation?view=open#appeals">My reports and appeals</a></main>',
      ),
  ),
);
app.get("/test/header-only", (_request, response) =>
  response.send(
    renderAbout(base)
      .replace('<html lang="en">', '<html lang="en" data-email-first>')
      .replace(/<link rel="stylesheet" href="\/assets\/arena\.css[^"]*">/, ""),
  ),
);
app.get("/test/action-return", (_request, response) =>
  response.send(
    renderAbout(base)
      .replace('<html lang="en">', '<html lang="en" data-email-first>')
      .replace("</head>", '<script defer src="/test/axe.js"></script></head>')
      .replace(
        "</main>",
        '<section class="container information-card"><h2>Confirmation fixture</h2><form data-community-chat-form id="resume-chat"><label>Draft message<textarea name="body" id="resume-draft"></textarea></label><button type="submit" id="resume-review">Review message</button></form><button type="button" class="follow-button button-secondary" data-follow-type="topics" data-follow-slug="return-topic">Follow topic</button><span role="status"></span></section></main>',
      ),
  ),
);
app.get("/match", (_request, response) =>
  response.send(
    renderMatchmaking(base).replace(
      '<html lang="en">',
      '<html lang="en" data-email-first>',
    ),
  ),
);
app.get("/test/inline-return", (_request, response) =>
  response.send(
    renderAbout(base)
      .replace('<html lang="en">', '<html lang="en" data-email-first>')
      .replace(
        "</main>",
        renderDebateWorkspace(
          {
            id: "return-fixture-debate",
            slug: "return-fixture-debate",
            proposition: "Synthetic return-action fixture",
            status: "scheduled",
            rulesVersion: "fixture-v1",
            scheduledAt: null,
            liveStartedAt: null,
            liveEndedAt: null,
            isDemo: true,
            createdAt: new Date("2026-10-19T12:00:00.000Z"),
            topic: {
              slug: "return-fixture-topic",
              title: "Synthetic fixture topic",
              sideALabel: "For",
              sideBLabel: "Against",
            },
            speakerA: null,
            speakerB: null,
            sponsor: null,
          },
          true,
          (file) => `/assets/${file}`,
        ).replace(
          /<script[^>]+src="\/assets\/(?:arena\.js|media\.bundle\.js|community\.js)"[^>]*><\/script>/g,
          "",
        ) + "</main>",
      ),
  ),
);
app.get("/test/debate", (_request, response) =>
  response.send(`<!doctype html><html lang="en" data-email-first><head><title>Auth return fixture</title><link rel="stylesheet" href="/assets/site.css"><link rel="stylesheet" href="/assets/arena.css"><link rel="stylesheet" href="/assets/site-header.css"><script defer src="/test/axe.js"></script></head><body>
  <main><a href="/account?next=%2Ftest%2Fdebate" id="return-link">Sign in to participate</a>
  <a href="/account#account-wallet" data-wallet-progress-open>Yap Coins balance</a></main>
  <script defer src="/assets/site.js"></script><script defer src="/assets/account-balance.js"></script></body></html>`),
);
app.get("/api/auth/provider", (_request, response) =>
  response.json({ enabled: true, appId, google: true, passkeys: true }),
);
app.get("/api/auth/me", (_request, response) =>
  response.status(401).json({ error: "authentication required" }),
);
app.get("/api/auth/methods", (_request, response) =>
  response.json({
    provider: { email: "synthetic@example.invalid", methods: ["email"] },
    legacyPassword: false,
  }),
);
app.get("/api/me/profile", (_request, response) =>
  response.status(404).json({ error: "profile not found" }),
);
app.get("/api/auth/wallets", (_request, response) =>
  response.json({ wallets: [] }),
);
app.get("/api/auth/security/passkeys", (_request, response) =>
  response.json({ passkeys: [] }),
);
app.get("/api/auth/sessions", (_request, response) =>
  response.json({
    sessions: [
      {
        id: "100",
        current: true,
        createdAt: "2026-10-19T12:00:00.000Z",
        expiresAt: "2026-11-19T12:00:00.000Z",
      },
      {
        id: "101",
        current: false,
        createdAt: "2026-10-19T11:00:00.000Z",
        expiresAt: "2026-11-19T11:00:00.000Z",
      },
    ],
    hasMore: false,
  }),
);
app.delete("/api/auth/sessions/:id", (request, response) =>
  ["100", "101"].includes(request.params.id)
    ? response.json({ current: request.params.id === "100" })
    : response.status(404).json({ error: "session not found" }),
);
app.get(["/api/me/follows", "/api/me/activity"], (_request, response) =>
  response.json({ items: [], pagination: { hasMore: false } }),
);
app.get("/api/matching/notifications", (_request, response) =>
  response.json({ notifications: [] }),
);
app.get("/api/account-wallet", (_request, response) =>
  response.json({
    enabled: true,
    withdrawalsEnabled: false,
    available: "1250",
    withdrawable: "1250",
    reserved: "100",
    pending: "50",
    promotional: "3000",
    grants: [
      {
        id: "welcome",
        label: "Welcome grant",
        target: "2500",
        netProfit: "1000",
        remaining: "1500",
        qualified: false,
        percent: 40,
      },
      {
        id: "daily",
        label: "Daily grant",
        target: "500",
        netProfit: "0",
        remaining: "500",
        qualified: false,
        percent: 0,
      },
      {
        id: "qualified",
        label: "Daily grant",
        target: "500",
        netProfit: "100",
        remaining: "0",
        qualified: true,
        percent: 100,
      },
    ],
  }),
);
app.post("/api/auth/journey", (_request, response) => response.sendStatus(204));
app.post("/api/auth/login", async (request, response) => {
  const fixture = request.query.passkeyQueue;
  const gate =
    typeof fixture === "string" ? passkeyCookieGates.get(fixture) : undefined;
  if (!gate)
    return response
      .status(400)
      .json({ error: "unknown synthetic login fixture" });
  gate.arrived.release();
  await gate.held.promise;
  return response
    .cookie("single_privy_actor", "B", {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
    })
    .sendStatus(204);
});
app.get("/api/measurement/consent", (_request, response) =>
  response.json({ granted: false }),
);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const browser = await chromium.launch({
  executablePath:
    process.env.BROWSER_CHROME_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const checks: string[] = [];
const errors: string[] = [];
const requirementFailures: string[] = [];
function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function capture(page: Page, name: string, fullPage: boolean) {
  const badge = page.locator("[data-acceptance-fixture-label]");
  await page.evaluate((label) => {
    const element = document.createElement("div");
    element.dataset.acceptanceFixtureLabel = "true";
    element.textContent = label;
    Object.assign(element.style, {
      position: "fixed",
      left: "8px",
      bottom: "8px",
      zIndex: "2147483647",
      maxWidth: "calc(100vw - 16px)",
      padding: "5px 8px",
      font: "11px/1.4 monospace",
      background: "#fff2c4",
      color: "#271900",
      border: "1px solid #927328",
      pointerEvents: "none",
    });
    if (Number(getComputedStyle(document.documentElement).zoom) > 1) {
      element.style.top = "8px";
      element.style.bottom = "auto";
    }
    (document.querySelector("dialog[open]") ?? document.body).append(element);
  }, `LOCAL UI FIXTURE · ${phase} · Synthetic identity/OTP; no money`);
  try {
    await page.screenshot({ path: resolve(directory, name), fullPage });
  } finally {
    await badge.evaluate((element) => element.remove());
  }
}
async function verifyExchangeFailureClassification(
  name: string,
  viewport: { width: number; height: number },
) {
  const scenarios = [
    {
      code: "provider_reset_review_required",
      status: 403,
      notice:
        "Your previous sign-out could not be confirmed with the sign-in provider.",
      reconciliation: false,
    },
    {
      code: "provider_reset_pending",
      status: 503,
      notice: "Your previous sign-out is still being completed.",
      reconciliation: false,
    },
    {
      code: "synthetic_unknown_denial",
      status: 403,
      notice: "Account access needs a security review before signing in again.",
      reconciliation: false,
    },
    {
      code: "provider_credentials_changed",
      status: 403,
      notice: "Review sign-in changes",
      reconciliation: true,
    },
  ];
  for (const scenario of scenarios) {
    const context = await browser.newContext({ viewport });
    try {
      await context.addInitScript(() => {
        if (window === window.top)
          localStorage.setItem("yaparena-measurement-declined", "1");
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      let exchanges = 0;
      let candidates = 0;
      const unexpectedProviderPaths: string[] = [];
      const now = Math.floor(Date.now() / 1000);
      const token = [
        Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT" })).toString(
          "base64url",
        ),
        Buffer.from(
          JSON.stringify({
            iss: "privy.io",
            aud: appId,
            sub: "did:privy:synthetic-exchange-classification",
            sid: "synthetic-exchange-classification",
            iat: now,
            exp: now + 600,
          }),
        ).toString("base64url"),
        "synthetic-signature-never-server-verified",
      ].join(".");
      const user = {
        id: "did:privy:synthetic-exchange-classification",
        is_guest: false,
        created_at: now - 100,
        has_accepted_terms: true,
        mfa_methods: [],
        linked_accounts: [
          {
            type: "email",
            address: "unchanged-classification@example.invalid",
            verified_at: now,
            first_verified_at: now - 100,
            latest_verified_at: now,
          },
        ],
      };
      const providerSession = {
        user,
        token,
        privy_access_token: token,
        refresh_token: "synthetic-refresh-never-sent-to-provider",
        is_new_user: false,
        session_update_action: "set",
      };
      await context.route(
        (url) =>
          url.origin === "https://auth.privy.io" &&
          url.pathname.startsWith("/api/"),
        (route) => {
          const path = new URL(route.request().url()).pathname;
          const headers = {
            "access-control-allow-origin": base,
            "access-control-allow-credentials": "true",
            "access-control-allow-methods": "GET, POST, OPTIONS",
            "access-control-allow-headers":
              route.request().headers()["access-control-request-headers"] ??
              "authorization, content-type, privy-app-id",
          };
          if (route.request().method() === "OPTIONS")
            return route.fulfill({ status: 204, headers });
          if (path === `/api/v1/apps/${appId}`)
            return route.fulfill({
              headers,
              json: {
                ...providerSettings,
                captcha_enabled: false,
                enabled_captcha_provider: null,
              },
            });
          if (path === "/api/v1/passwordless/init")
            return route.fulfill({ headers, json: { success: true } });
          if (
            path === "/api/v1/passwordless/authenticate" ||
            path === "/api/v1/sessions"
          )
            return route.fulfill({ headers, json: providerSession });
          if (path === "/api/v1/users/me")
            return route.fulfill({ headers, json: { user } });
          if (
            path === "/api/v1/analytics_events" ||
            path === "/api/v1/sessions/logout"
          )
            return route.fulfill({ headers, json: { success: true } });
          unexpectedProviderPaths.push(path);
          return route.abort();
        },
      );
      await page.route("**/api/auth/me", (route) =>
        route.fulfill({
          status: 401,
          json: { error: "authentication required" },
        }),
      );
      await page.route("**/api/auth/privy/exchange", (route) => {
        exchanges++;
        return route.fulfill({
          status: scenario.status,
          headers:
            scenario.code === "provider_reset_pending"
              ? { "retry-after": "5" }
              : {},
          json: { error: "Synthetic classified denial", code: scenario.code },
        });
      });
      await page.route(
        "**/api/auth/security/access/reconciliation/candidate",
        (route) => {
          candidates++;
          return route.fulfill({
            json: {
              before: [
                {
                  type: "email",
                  id: "unchanged-classification@example.invalid",
                },
              ],
              after: [
                {
                  type: "email",
                  id: scenario.reconciliation
                    ? "changed-classification@example.invalid"
                    : "unchanged-classification@example.invalid",
                },
              ],
              passkeys: [],
              wallets: [],
              legacyPassword: scenario.reconciliation,
            },
          });
        },
      );
      await page.goto(`${base}/account`);
      const auth = page.locator("#email-auth");
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLButtonElement>(
            '#email-auth button[type="submit"]',
          )?.disabled === false,
      );
      await auth
        .getByLabel("Email address", { exact: true })
        .fill("unchanged-classification@example.invalid");
      await auth.getByRole("button", { name: /Continue with email/ }).click();
      await auth
        .getByLabel("Verification code", { exact: true })
        .fill("123456");
      await auth.getByRole("button", { name: "Verify and continue" }).click();
      await page.getByText(scenario.notice, { exact: false }).waitFor();
      assert.equal(exchanges, 1);
      assert.equal(candidates, scenario.reconciliation ? 1 : 0);
      assert.equal(
        await page
          .getByRole("heading", { name: "Review sign-in changes", exact: true })
          .count(),
        scenario.reconciliation ? 1 : 0,
      );
      if (scenario.reconciliation) {
        await page.getByLabel("Verify with a retained method").waitFor();
        assert.equal(
          await page.getByRole("option", { name: "Current password" }).count(),
          1,
        );
        await page
          .getByText("Email: changed-classification@example.invalid", {
            exact: true,
          })
          .waitFor();
      } else {
        assert.equal(
          await page.getByLabel("Verify with a retained method").count(),
          0,
        );
        assert.equal(
          await page
            .getByText("No retained security method is available.", {
              exact: false,
            })
            .count(),
          0,
        );
      }
      assert.equal(await page.locator("#signed-in").isVisible(), false);
      assert.deepEqual(unexpectedProviderPaths, []);
      await capture(page, `exchange-${scenario.code}-${name}.png`, true);
      checks.push(
        `${name}: ${scenario.code} keeps denied app access and ${scenario.reconciliation ? "opens exact changed-method review with its retained password" : "shows its classified notice without an empty sign-in-method reconciliation"}; synthetic SDK success only`,
      );
    } finally {
      await context.close();
    }
  }
}
async function verifyPrivyPasskeySetup(
  name: string,
  viewport: { width: number; height: number },
  expiredRestart = false,
  queuedCompletion = false,
  settingsRaces = false,
) {
  // WebAuthn accepts localhost for a local secure-context fixture, not an IP RP.
  const fixtureOrigin = new URL(base);
  fixtureOrigin.hostname = "localhost";
  const passkeyBase = fixtureOrigin.origin;
  const context = await browser.newContext({ viewport });
  let stage = "initialize";
  let counters = () => ({});
  try {
    await context.addInitScript(() => {
      if (window === window.top)
        localStorage.setItem("yaparena-measurement-declined", "1");
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send(
      "WebAuthn.addVirtualAuthenticator",
      {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      },
    );
    const now = Math.floor(Date.now() / 1000),
      subject = "did:privy:synthetic-single-passkey",
      email = "single-passkey@example.invalid",
      intentId = "00000000-0000-4000-8000-000000000011",
      operationId = "00000000-0000-4000-8000-000000000012",
      resumedOperationId = "00000000-0000-4000-8000-000000000014",
      keyId = "00000000-0000-4000-8000-000000000013",
      terms = { intentId, subject, beforeDigest: "2".repeat(64) },
      challenge = Buffer.alloc(32, 7).toString("base64url");
    let sdkSubject = subject,
      sdkEmail = email;
    const makeToken = (sid: string) =>
      [
        Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT" })).toString(
          "base64url",
        ),
        Buffer.from(
          JSON.stringify({
            iss: "privy.io",
            aud: appId,
            sub: sdkSubject,
            sid,
            iat: now,
            exp: now + 600,
          }),
        ).toString("base64url"),
        "synthetic-signature-never-server-verified",
      ].join(".");
    let token = makeToken("synthetic-single-passkey");
    let authenticated = false,
      activated = false,
      protectedReadsBlocked = false,
      activationInterrupted = false,
      credentialId: string | null = null,
      beginCalls = 0,
      operationCalls = 0,
      resumedOperationCalls = 0,
      scopedCandidateCalls = 0,
      providerInitCalls = 0,
      providerLinkCalls = 0,
      providerLogins = 0,
      restartCalls = 0,
      restartCompletions = 0,
      completeCalls = 0,
      providerChangeCalls = 0,
      beginUnavailable = false,
      fixtureAccount = "single-passkey-account",
      replacementActor = false,
      holdBegin = false;
    const beginGate = deferred(),
      heldBeginArrived = deferred(),
      heldBeginFinished = deferred();
    const unexpectedProviderPaths: string[] = [];
    counters = () => ({
      beginCalls,
      operationCalls,
      resumedOperationCalls,
      scopedCandidateCalls,
      providerInitCalls,
      providerLinkCalls,
      completeCalls,
    });
    const user = () => ({
      id: sdkSubject,
      is_guest: false,
      created_at: now - 100,
      has_accepted_terms: true,
      mfa_methods: [],
      linked_accounts: [
        {
          type: "email",
          address: sdkEmail,
          verified_at: now,
          first_verified_at: now - 100,
          latest_verified_at: now,
        },
        ...(credentialId && sdkSubject === subject
          ? [
              {
                type: "passkey",
                credential_id: credentialId,
                authenticator_name: "Synthetic virtual authenticator",
                verified_at: now,
                first_verified_at: now,
                latest_verified_at: now,
              },
            ]
          : []),
      ],
    });
    const session = () => ({
      user: user(),
      token,
      privy_access_token: token,
      refresh_token: "synthetic-refresh-never-sent-to-provider",
      is_new_user: false,
      session_update_action: "set",
    });
    await context.route(
      (url) =>
        url.origin === "https://auth.privy.io" &&
        url.pathname.startsWith("/api/"),
      async (route) => {
        const path = new URL(route.request().url()).pathname,
          headers = {
            "access-control-allow-origin": passkeyBase,
            "access-control-allow-credentials": "true",
            "access-control-allow-methods": "GET, POST, OPTIONS",
            "access-control-allow-headers":
              route.request().headers()["access-control-request-headers"] ??
              "authorization, content-type, privy-app-id",
          };
        if (route.request().method() === "OPTIONS")
          return route.fulfill({ status: 204, headers });
        if (path === `/api/v1/apps/${appId}`)
          return route.fulfill({
            headers,
            json: {
              ...providerSettings,
              captcha_enabled: false,
              enabled_captcha_provider: null,
            },
          });
        if (path === "/api/v1/passwordless/init")
          return route.fulfill({ headers, json: { success: true } });
        if (path === "/api/v1/passwordless/authenticate") {
          providerLogins++;
          if (expiredRestart && providerLogins > 1)
            token = makeToken("synthetic-fresh-first-passkey-session");
          return route.fulfill({ headers, json: session() });
        }
        if (path === "/api/v1/sessions")
          return route.fulfill({ headers, json: session() });
        if (path === "/api/v1/users/me")
          return route.fulfill({ headers, json: { user: user() } });
        if (path === "/api/v1/passkeys/authenticate/init") {
          assert.ok(settingsRaces && credentialId);
          return route.fulfill({
            headers,
            json: {
              relying_party: passkeyBase,
              options: {
                challenge,
                rp_id: "localhost",
                allow_credentials: [{ id: credentialId, type: "public-key" }],
                timeout: 60000,
                user_verification: "required",
              },
            },
          });
        }
        if (path === "/api/v1/passkeys/authenticate") {
          assert.ok(settingsRaces && credentialId);
          const body: { authenticator_response?: { id?: string } } = route
            .request()
            .postDataJSON();
          assert.equal(body.authenticator_response?.id, credentialId);
          providerLogins++;
          return route.fulfill({ headers, json: session() });
        }
        if (path === "/api/v1/passkeys/link/init") {
          providerInitCalls++;
          return route.fulfill({
            headers,
            json: {
              relying_party: passkeyBase,
              options: {
                rp: { id: "localhost", name: "Synthetic Privy SDK fixture" },
                user: {
                  id: Buffer.from("synthetic-single-passkey").toString(
                    "base64url",
                  ),
                  name: email,
                  display_name: "Synthetic fixture",
                },
                challenge,
                pub_key_cred_params: [{ type: "public-key", alg: -7 }],
                timeout: 60000,
                attestation: "none",
                authenticator_selection: {
                  authenticator_attachment: "platform",
                  resident_key: "required",
                  require_resident_key: true,
                  user_verification: "required",
                },
              },
            },
          });
        }
        if (path === "/api/v1/passkeys/link") {
          providerLinkCalls++;
          const body: { authenticator_response?: { id?: unknown } } = route
            .request()
            .postDataJSON();
          assert.equal(typeof body.authenticator_response?.id, "string");
          assert.ok(body.authenticator_response?.id);
          credentialId = String(body.authenticator_response.id);
          // Unlike login, the installed SDK's link transport parses a raw user.
          return route.fulfill({ headers, json: user() });
        }
        if (
          path === "/api/v1/analytics_events" ||
          path === "/api/v1/sessions/logout"
        )
          return route.fulfill({ headers, json: { success: true } });
        unexpectedProviderPaths.push(path);
        return route.abort();
      },
    );
    await page.route("**/api/auth/me", (route) =>
      route.fulfill(
        protectedReadsBlocked
          ? {
              status: 503,
              json: { error: "Finish the pending passkey setup." },
            }
          : authenticated
            ? {
                json: {
                  user: {
                    id: fixtureAccount,
                    username: "Synthetic passkey fixture",
                    email: sdkEmail,
                    roles: ["participant"],
                  },
                },
              }
            : { status: 401, json: { error: "authentication required" } },
      ),
    );
    await page.route("**/api/auth/privy/exchange", (route) => {
      // The original valid cookie reaches the provider-session monitor before
      // ordinary exchange; its exact pending delta denies that lookup with503.
      if (protectedReadsBlocked)
        return route.fulfill({
          status: 503,
          json: { error: "Finish the pending passkey setup." },
        });
      if (expiredRestart && activationInterrupted)
        return route.fulfill({
          status: 403,
          json: {
            code: "provider_credentials_changed",
            error: "Synthetic expired first-key setup",
          },
        });
      authenticated = true;
      return route.fulfill({ status: 204 });
    });
    await page.route("**/api/account-wallet", (route) =>
      route.fulfill({
        json: {
          enabled: true,
          withdrawalsEnabled: false,
          available: "0",
          withdrawable: "0",
          reserved: "0",
          pending: "0",
          promotional: "0",
          grants: [],
        },
      }),
    );
    await page.route("**/api/auth/methods", (route) =>
      route.fulfill(
        protectedReadsBlocked
          ? {
              status: 503,
              json: { error: "Finish the pending passkey setup." },
            }
          : {
              json: {
                provider: {
                  subject: replacementActor
                    ? "did:privy:synthetic-replacement"
                    : sdkSubject,
                  email: sdkEmail,
                  methods:
                    credentialId && sdkSubject === subject
                      ? ["email", "passkey"]
                      : ["email"],
                  credentials: [
                    { type: "email", id: sdkEmail },
                    ...(credentialId && sdkSubject === subject
                      ? [{ type: "passkey", id: credentialId }]
                      : []),
                  ],
                },
                legacyPassword: !expiredRestart,
              },
            },
      ),
    );
    await page.route("**/api/auth/security/passkeys", (route) =>
      route.fulfill(
        !authenticated
          ? { status: 401, json: { error: "authentication required" } }
          : protectedReadsBlocked
            ? {
                status: 503,
                json: { error: "Finish the pending passkey setup." },
              }
            : {
                json: {
                  passkeys:
                    activated && sdkSubject === subject
                      ? [
                          {
                            id: keyId,
                            credentialId,
                            provenance: "privy",
                            createdAt: new Date(now * 1000).toISOString(),
                            deviceType: "singleDevice",
                            backedUp: false,
                          },
                        ]
                      : [],
                },
              },
      ),
    );
    await page.route(
      "**/api/auth/security/provider/passkeys",
      async (route) => {
        beginCalls++;
        assert.deepEqual(route.request().postDataJSON(), {});
        if (beginUnavailable)
          return route.fulfill({
            status: 503,
            json: { error: "Synthetic provider unavailable; retry later." },
          });
        if (holdBegin) {
          heldBeginArrived.release();
          await beginGate.promise;
        }
        await route.fulfill({
          json: {
            id: intentId,
            expiresAt: new Date(Date.now() + 300000).toISOString(),
            bootstrapAllowed: expiredRestart,
            terms,
          },
        });
        if (holdBegin) heldBeginFinished.release();
      },
    );
    await page.route("**/api/auth/security/operations", (route) => {
      operationCalls++;
      assert.deepEqual(route.request().postDataJSON(), {
        purpose: "provider.passkey.link",
        terms,
        credential: { type: "password" },
      });
      return route.fulfill({
        json: { id: operationId, authorizationMessage: null },
      });
    });
    await page.route(
      `**/api/auth/security/provider/passkeys/${intentId}/activation`,
      (route) => {
        assert.ok(credentialId);
        if (expiredRestart && activationInterrupted)
          return route.fulfill({
            status: 410,
            json: { error: "Synthetic original activation expired." },
          });
        if (!activationInterrupted) {
          activationInterrupted = true;
          protectedReadsBlocked = true;
          return route.fulfill({
            status: 503,
            json: {
              error: "Synthetic interruption. Choose Finish passkey setup.",
            },
          });
        }
        return route.fulfill({
          json: {
            id: intentId,
            bootstrapAllowed: false,
            terms,
            authenticationOptions: {
              challenge,
              rpId: "localhost",
              allowCredentials: [{ id: credentialId, type: "public-key" }],
              userVerification: "required",
              timeout: 60000,
            },
          },
        });
      },
    );
    await page.route("**/api/auth/wallets", (route) =>
      route.fulfill(
        protectedReadsBlocked
          ? {
              status: 503,
              json: { error: "Finish the pending passkey setup." },
            }
          : { json: { wallets: [] } },
      ),
    );
    await page.route(
      "**/api/auth/security/access/reconciliation/candidate",
      (route) => {
        scopedCandidateCalls++;
        assert.equal(
          route.request().headers().authorization,
          `Bearer ${token}`,
        );
        return route.fulfill({
          json: {
            before: [{ type: "email", id: email }],
            after: [
              { type: "email", id: email },
              { type: "passkey", id: credentialId },
            ],
            legacyPassword: !expiredRestart,
            passkeys: [],
            wallets: [],
          },
        });
      },
    );
    await page.route(
      `**/api/auth/security/provider/passkeys/${intentId}/operations`,
      (route) => {
        resumedOperationCalls++;
        assert.equal(
          route.request().headers().authorization,
          `Bearer ${token}`,
        );
        assert.deepEqual(route.request().postDataJSON(), {
          credential: { type: "password" },
        });
        return route.fulfill({
          json: { id: resumedOperationId, authorizationMessage: null, terms },
        });
      },
    );
    await page.route(
      `**/api/auth/security/provider/passkeys/${intentId}/complete`,
      (route) => {
        completeCalls++;
        const body: {
          authentication: { id: string };
          approval: { id: string; password: string };
        } = route.request().postDataJSON();
        assert.equal(body.authentication.id, credentialId);
        assert.deepEqual(body.approval, {
          id: resumedOperationId,
          password: "synthetic-retained-passphrase",
        });
        activated = true;
        protectedReadsBlocked = false;
        return route.fulfill({
          headers: queuedCompletion
            ? {
                "set-cookie":
                  "single_privy_actor=A; Path=/; HttpOnly; SameSite=Strict",
              }
            : {},
          json: { keyId },
        });
      },
    );
    await page.route(
      "**/api/auth/security/provider/passkeys/bootstrap/candidate",
      (route) => {
        assert.ok(expiredRestart);
        assert.equal(
          route.request().headers().authorization,
          `Bearer ${token}`,
        );
        if (providerLogins < 2)
          return route.fulfill({
            status: 401,
            json: {
              code: "provider_session_revoked",
              error:
                "Sign in with Privy again before restarting passkey setup.",
            },
          });
        return route.fulfill({
          json: { code: "first_passkey_restart_available" },
        });
      },
    );
    await page.route(
      "**/api/auth/security/provider/passkeys/bootstrap/restart",
      (route) => {
        restartCalls++;
        assert.ok(expiredRestart && credentialId && providerLogins === 2);
        assert.equal(
          route.request().headers().authorization,
          `Bearer ${token}`,
        );
        return route.fulfill({
          json: {
            id: intentId,
            before: [{ type: "email", id: email }],
            after: [
              { type: "email", id: email },
              { type: "passkey", id: credentialId },
            ],
            authenticationOptions: {
              challenge,
              rpId: "localhost",
              allowCredentials: [{ id: credentialId, type: "public-key" }],
              userVerification: "required",
              timeout: 60000,
            },
          },
        });
      },
    );
    await page.route(
      `**/api/auth/security/provider/passkeys/bootstrap/${intentId}/complete`,
      (route) => {
        restartCompletions++;
        assert.equal(
          route.request().headers().authorization,
          `Bearer ${token}`,
        );
        const body: { authentication: { id: string } } = route
          .request()
          .postDataJSON();
        assert.deepEqual(Object.keys(body), ["authentication"]);
        assert.equal(body.authentication.id, credentialId);
        activated = true;
        authenticated = true;
        protectedReadsBlocked = false;
        return route.fulfill({ json: { keyId } });
      },
    );
    await page.route("**/api/auth/security/provider/change", (route) => {
      providerChangeCalls++;
      return route.fulfill({
        status: 409,
        json: { error: "unexpected provider removal" },
      });
    });
    stage = "synthetic SDK email sign-in";
    await page.goto(`${passkeyBase}/account`);
    const auth = page.locator("#email-auth");
    await auth
      .getByRole("button", { name: "Continue with email", exact: false })
      .waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLButtonElement>(
          '#email-auth button[type="submit"]',
        )?.disabled === false,
    );
    await auth.getByLabel("Email address", { exact: true }).fill(email);
    await auth
      .getByRole("button", { name: "Continue with email", exact: false })
      .click();
    await auth.getByLabel("Verification code", { exact: true }).fill("123456");
    await auth
      .getByRole("button", { name: "Verify and continue", exact: false })
      .click();
    await page.getByText("Account ready.", { exact: true }).waitFor();
    await page.waitForFunction(
      () => typeof window.yapApproveProviderChange === "function",
    );
    assert.equal(
      await page.locator("#account-security-passkeys").isVisible(),
      false,
    );
    assert.equal(
      await page
        .locator("#account-security-passkeys")
        .getByText("authentication required", { exact: true })
        .count(),
      0,
    );
    const add = page.getByRole("button", {
        name: "Add a passkey",
        exact: true,
      }),
      approval = page.getByRole("dialog", {
        name: "Approve Privy passkey",
        exact: true,
      });
    await add.waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Add security passkey", exact: true })
        .count(),
      0,
    );
    if (!expiredRestart) {
      stage = "cancel retained approval before SDK write";
      await add.click();
      await approval.waitFor();
      assert.equal(await add.isDisabled(), true);
      await add.evaluate((button) => {
        if (!(button instanceof HTMLButtonElement))
          throw new Error("Passkey setup control must be a button");
        button.click();
        button.click();
      });
      assert.equal(beginCalls, 1, "busy setup cannot start duplicate intents");
      await approval
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await approval.waitFor({ state: "detached" });
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll("button")).some(
          (button) =>
            button.textContent?.trim() === "Add a passkey" && !button.disabled,
        ),
      );
      await page.waitForFunction(
        () => document.activeElement?.textContent?.trim() === "Add a passkey",
        undefined,
        { timeout: 1000 },
      );
      assert.equal(
        await add.evaluate((button) => document.activeElement === button),
        true,
        "cancelling trusted authorization restores focus to the re-enabled setup opener",
      );
      assert.equal(providerInitCalls, 0);
      assert.equal(providerLinkCalls, 0);
      assert.equal(operationCalls, 0);
      checks.push(
        `${name}: Account settings exposes only Add a passkey; cancelling retained authorization issues no operation or SDK passkey request`,
      );
    }
    // The server deliberately reuses its still-unconsumed exact intent.
    stage = "SDK creates and activates one passkey";
    await add.click();
    if (!expiredRestart) {
      await approval.waitFor();
      await approval
        .getByLabel("Current password", { exact: true })
        .fill("synthetic-retained-passphrase");
      await approval
        .getByRole("button", { name: "Approve change", exact: true })
        .click();
    }
    await page
      .locator("#provider-settings")
      .getByText("Synthetic interruption. Choose Finish passkey setup.", {
        exact: true,
      })
      .waitFor();
    assert.equal(operationCalls, expiredRestart ? 0 : 1);
    assert.equal(
      completeCalls,
      0,
      "preparing approval must not consume the bridge proof",
    );
    assert.equal(providerLinkCalls, 1);
    assert.equal(completeCalls, 0);
    assert.equal(
      await page.evaluate(() =>
        sessionStorage.getItem("yaparena-provider-passkey-setup"),
      ),
      intentId,
    );
    if (expiredRestart) {
      stage = "fresh SDK sign-in after expired first-key setup";
      authenticated = false;
      protectedReadsBlocked = false;
      await page.reload();
      await page
        .getByRole("dialog", { name: "Review sign-in changes", exact: true })
        .getByRole("button", {
          name: "Sign in again to restart setup",
          exact: true,
        })
        .click();
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLButtonElement>(
            '#email-auth button[type="submit"]',
          )?.disabled === false,
      );
      await auth.getByLabel("Email address", { exact: true }).fill(email);
      await auth
        .getByRole("button", { name: "Continue with email", exact: false })
        .click();
      await auth
        .getByLabel("Verification code", { exact: true })
        .fill("123456");
      await auth
        .getByRole("button", { name: "Verify and continue", exact: false })
        .click();
      const restart = page.getByRole("button", {
        name: "Verify my first passkey and finish setup",
        exact: true,
      });
      await restart.waitFor();
      assert.equal(restartCalls, 0);
      assert.equal(restartCompletions, 0);
      assert.equal(await page.locator("#signed-in").isVisible(), false);
      await capture(
        page,
        `first-privy-passkey-restart-confirmation-${name}.png`,
        true,
      );
      await restart.click();
      await page.locator("#signed-in").waitFor({ state: "visible" });
      assert.equal(providerLogins, 2);
      assert.equal(providerInitCalls, 1);
      assert.equal(providerLinkCalls, 1);
      assert.equal(restartCalls, 1);
      assert.equal(restartCompletions, 1);
      assert.equal(operationCalls, 0);
      assert.equal(completeCalls, 0);
      assert.equal(
        (await cdp.send("WebAuthn.getCredentials", { authenticatorId }))
          .credentials.length,
        1,
      );
      assert.equal(
        await page.evaluate(() =>
          sessionStorage.getItem("yaparena-provider-passkey-setup"),
        ),
        null,
      );
      await capture(
        page,
        `first-privy-passkey-restart-complete-${name}.png`,
        true,
      );
      checks.push(
        `${name}: before-funds first-key fixture requires another installed-SDK email login with a distinct synthetic SID after interruption, keeps app access denied, and offers restart only from the explicit server availability response`,
      );
      checks.push(
        `${name}: explicit first-key restart obtains native user verification from the same single SDK-created credential, completes only its bootstrap endpoint and never uses a password proof, new enrollment or payment`,
      );
      return;
    }
    stage = "refresh interrupted exact intent with protected reads unavailable";
    await page.reload();
    const resume = page
      .locator("#passkey-setup-resume")
      .getByRole("button", { name: "Finish passkey setup", exact: true });
    await resume.waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLButtonElement>(
          "#passkey-setup-resume button",
        )?.disabled === false,
    );
    assert.equal(await page.locator("#signed-in").isVisible(), false);
    assert.equal(
      await page.evaluate(async () => (await fetch("/api/auth/me")).status),
      503,
    );
    await resume.click();
    await approval.waitFor();
    let queueFixture: string | undefined;
    if (queuedCompletion) {
      queueFixture = name;
      const gate = { held: deferred(), arrived: deferred() };
      passkeyCookieGates.set(queueFixture, gate);
      await page.evaluate((fixture) => {
        if (!window.yapSessionFetch)
          throw new Error("session coordination unavailable");
        void window
          .yapSessionFetch(
            `/api/auth/login?passkeyQueue=${encodeURIComponent(fixture)}`,
            { method: "POST" },
          )
          .then(() => {
            window.yapRememberSessionAccount?.("replacement-passkey-account");
            window.dispatchEvent(new Event("yap:account-changed"));
            Reflect.set(window, "__queuedPasskeyLoginComplete", true);
          });
      }, queueFixture);
      await gate.arrived.promise;
    }
    await approval
      .getByLabel("Current password", { exact: true })
      .fill("synthetic-retained-passphrase");
    await approval
      .getByRole("button", { name: "Approve change", exact: true })
      .click();
    if (queueFixture) {
      stage =
        "queued original-key completion is cancelled by replacement login";
      await page.waitForFunction(async () =>
        (await navigator.locks.query()).pending?.some(
          (lock) => lock.name === "yaparena-application-session",
        ),
      );
      assert.equal(completeCalls, 0);
      fixtureAccount = "replacement-passkey-account";
      replacementActor = true;
      protectedReadsBlocked = false;
      passkeyCookieGates.get(queueFixture)?.held.release();
      await page.waitForFunction(
        () => Reflect.get(window, "__queuedPasskeyLoginComplete") === true,
      );
      await approval.waitFor({ state: "detached" });
      await page.waitForFunction(
        async () =>
          (await navigator.locks.query()).pending?.length === 0 &&
          (await navigator.locks.query()).held?.length === 0,
      );
      assert.equal(completeCalls, 0);
      assert.equal(providerInitCalls, 1);
      assert.equal(providerLinkCalls, 1);
      assert.equal(
        (await context.cookies(passkeyBase)).find(
          (cookie) => cookie.name === "single_privy_actor",
        )?.value,
        "B",
      );
      assert.equal(
        await page.evaluate(() =>
          sessionStorage.getItem("yaparena-provider-passkey-setup"),
        ),
        null,
      );
      passkeyCookieGates.delete(queueFixture);
      checks.push(
        `${name}: real replacement-login HTTP headers hold the shared browser lock; account change aborts queued original-key completion before any submission and preserves the replacement HttpOnly cookie`,
      );
      return;
    }
    await page
      .getByText(
        "Passkey ready for sign-in and account approvals. Other sessions were signed out.",
        { exact: true },
      )
      .waitFor();
    assert.equal(providerInitCalls, 1);
    assert.equal(providerLinkCalls, 1);
    assert.equal(completeCalls, 1);
    assert.equal(beginCalls, 2);
    assert.equal(scopedCandidateCalls, 1);
    assert.equal(resumedOperationCalls, 1);
    assert.equal(
      operationCalls,
      1,
      "resume does not retry ordinary protected authorization",
    );
    assert.equal(
      (await cdp.send("WebAuthn.getCredentials", { authenticatorId }))
        .credentials.length,
      1,
    );
    assert.equal(
      await page.evaluate(() =>
        sessionStorage.getItem("yaparena-provider-passkey-setup"),
      ),
      null,
    );
    await capture(page, `single-privy-passkey-${name}.png`, true);
    checks.push(
      `${name}: installed Privy SDK creates one virtual-authenticator passkey through intercepted link endpoints; refresh preserves only its exact intent, keeps protected account data hidden, obtains a new scoped retained proof, and activates the same credential without a second registration`,
    );
    if (settingsRaces) {
      let sequence = 0,
        staleSdkRequests = 0,
        targetEmail = "",
        holdChange = false,
        holdSend = false,
        holdVerify = false;
      let gate = deferred(),
        arrived = deferred(),
        finished = deferred();
      const settings = page.locator("#provider-settings");
      const providerDialog = page.getByRole("dialog", {
        name: "Change sign-in methods",
        exact: true,
      });
      await page.route("**/api/auth/security/operations", (route) => {
        const body: { purpose: string; credential: { type: string } } = route
          .request()
          .postDataJSON();
        assert.equal(body.purpose, "provider.credentials.change");
        assert.deepEqual(body.credential, { type: "password" });
        return route.fulfill({
          json: { id: operationId, authorizationMessage: null },
        });
      });
      await page.route(
        "**/api/auth/security/provider/change",
        async (route) => {
          if (holdChange) {
            arrived.release();
            await gate.promise;
          }
          await route.fulfill({ status: 204 });
          if (holdChange) finished.release();
        },
      );
      await page.route("**/api/v1/passwordless/init", async (route) => {
        if (route.request().method() === "OPTIONS") return route.fallback();
        const changing =
          route.request().postData()?.includes(targetEmail) &&
          targetEmail !== "";
        if (changing) {
          staleSdkRequests++;
          if (holdSend) {
            arrived.release();
            await gate.promise;
          }
        }
        await route.fulfill({
          headers: {
            "access-control-allow-origin": passkeyBase,
            "access-control-allow-credentials": "true",
          },
          json: { success: true },
        });
        if (changing && holdSend) finished.release();
      });
      await page.route("**/api/v1/passwordless/update", async (route) => {
        if (route.request().method() === "OPTIONS") return route.fallback();
        assert.equal(holdVerify, true);
        arrived.release();
        await gate.promise;
        await route.fulfill({
          status: 503,
          headers: {
            "access-control-allow-origin": passkeyBase,
            "access-control-allow-credentials": "true",
          },
          json: { error: "synthetic delayed original-actor provider failure" },
        });
        finished.release();
      });
      const sdkMutations: string[] = [];
      const passkeyCounters = counters;
      counters = () => ({
        ...passkeyCounters(),
        sequence,
        staleSdkRequests,
        sdkMutations,
      });
      async function waitGate(promise: Promise<void>) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(
                () =>
                  reject(new Error(`Fixture gate did not arrive: ${stage}`)),
                10000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
      }
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (
          /\/api\/v1\/(?:oauth\/init|passwordless\/unlink|passkeys\/unlink)$/.test(
            path,
          ) &&
          request.method() !== "OPTIONS"
        )
          sdkMutations.push(path);
      });
      async function approveSettings() {
        await providerDialog.waitFor();
        await providerDialog.getByRole("combobox").selectOption("password");
        await providerDialog
          .getByLabel("Current password", { exact: true })
          .fill("synthetic-retained-passphrase");
        await providerDialog
          .getByRole("button", { name: "Approve change", exact: true })
          .click();
      }
      async function replacementLogin(native = false) {
        sequence++;
        authenticated = false;
        sdkSubject = `did:privy:synthetic-settings-replacement-${sequence}`;
        sdkEmail = `settings-replacement-${sequence}@example.invalid`;
        fixtureAccount = `settings-replacement-${sequence}`;
        token = makeToken(`synthetic-settings-session-${sequence}`);
        await page.evaluate(() => {
          window.dispatchEvent(new Event("yap:provider-logout"));
          window.dispatchEvent(new Event("yap:account-changed"));
          window.dispatchEvent(
            new CustomEvent("yap:request-auth", { detail: { mode: "login" } }),
          );
        });
        await page.waitForFunction(
          () =>
            document.querySelector<HTMLButtonElement>(
              '#email-auth button[type="submit"]',
            )?.disabled === false,
        );
        if (native) {
          await auth
            .getByRole("button", {
              name: "Use a passkey",
              exact: true,
            })
            .click();
        } else {
          await auth
            .getByLabel("Email address", { exact: true })
            .fill(sdkEmail);
          await auth
            .getByRole("button", { name: "Continue with email", exact: false })
            .click();
          await auth
            .getByLabel("Verification code", { exact: true })
            .fill("123456");
          await auth
            .getByRole("button", { name: "Verify and continue", exact: false })
            .click();
        }
        await page.waitForFunction(
          (account) => window.yapCurrentSessionAccount?.() === account,
          fixtureAccount,
        );
        await settings
          .getByLabel("New sign-in email", { exact: true })
          .waitFor();
        assert.equal(
          await settings
            .getByRole("button", { name: "Verify new email", exact: true })
            .count(),
          0,
        );
      }
      async function releaseAndCheck(draft: string) {
        const field = settings.getByLabel("New sign-in email", { exact: true });
        const enabledBeforeRelease = await field.isEnabled();
        if (enabledBeforeRelease) await field.fill(draft);
        gate.release();
        await waitGate(finished.promise);
        await page.evaluate(
          () =>
            new Promise<void>((done) =>
              requestAnimationFrame(() => requestAnimationFrame(() => done())),
            ),
        );
        assert.equal(
          enabledBeforeRelease,
          true,
          "replacement actor controls must not stay blocked by the original request",
        );
        assert.equal(
          await settings
            .getByLabel("New sign-in email", { exact: true })
            .inputValue(),
          draft,
        );
        assert.equal(
          await settings
            .getByRole("button", { name: "Change email", exact: true })
            .isEnabled(),
          true,
        );
        assert.equal(
          await settings
            .getByRole("button", { name: "Verify new email", exact: true })
            .count(),
          0,
        );
        assert.equal(
          await page
            .getByRole("dialog", {
              name: "Review sign-in changes",
              exact: true,
            })
            .count(),
          0,
        );
        assert.equal(
          await page.evaluate(() =>
            sessionStorage.getItem("yaparena-provider-change"),
          ),
          null,
        );
      }
      for (const mutation of ["remove", "google", "email"] as const) {
        stage = `held ${mutation} approval cannot continue under replacement provider`;
        gate = deferred();
        arrived = deferred();
        finished = deferred();
        holdChange = true;
        targetEmail = `stale-${mutation}@example.invalid`;
        if (mutation === "remove")
          await settings
            .getByRole("button", { name: "Remove Email", exact: true })
            .click();
        else if (mutation === "google")
          await settings
            .getByRole("button", { name: "Add Google sign-in", exact: true })
            .click();
        else {
          await settings
            .getByLabel("New sign-in email", { exact: true })
            .fill(targetEmail);
          await settings
            .getByRole("button", { name: "Change email", exact: true })
            .click();
        }
        await approveSettings();
        await waitGate(arrived.promise);
        const requestsBefore = staleSdkRequests;
        await replacementLogin();
        await releaseAndCheck(`replacement-${mutation}-draft@example.invalid`);
        assert.equal(staleSdkRequests, requestsBefore);
        assert.deepEqual(sdkMutations, []);
        holdChange = false;
        checks.push(
          `${name}: held original-account ${mutation} authorization response cannot send an email code, launch Google or unlink under the replacement SDK login; private fields clear and the new actor's controls/draft remain usable`,
        );
      }
      stage = "held email-send response cannot restore original private state";
      gate = deferred();
      arrived = deferred();
      finished = deferred();
      targetEmail = "held-send-original@example.invalid";
      holdSend = true;
      await settings
        .getByLabel("New sign-in email", { exact: true })
        .fill(targetEmail);
      await settings
        .getByRole("button", { name: "Change email", exact: true })
        .click();
      await approveSettings();
      await waitGate(arrived.promise);
      await replacementLogin(true);
      await releaseAndCheck("replacement-send-draft@example.invalid");
      holdSend = false;
      assert.equal(
        await settings
          .getByText(
            "Privy sent a code to the new email. Enter its newest code below.",
            { exact: true },
          )
          .count(),
        0,
      );
      checks.push(
        `${name}: an already-started SDK email-send response arriving after replacement login cannot restore the old email/code form or success notice, and cannot reset the new actor's draft`,
      );
      stage =
        "held email-verification failure cannot reconcile a replacement actor";
      targetEmail = "held-verify-original@example.invalid";
      await settings
        .getByLabel("New sign-in email", { exact: true })
        .fill(targetEmail);
      await settings
        .getByRole("button", { name: "Change email", exact: true })
        .click();
      await approveSettings();
      await settings
        .getByRole("button", { name: "Verify new email", exact: true })
        .waitFor();
      await settings
        .getByLabel(`Code for ${targetEmail}`, { exact: true })
        .fill("123456");
      gate = deferred();
      arrived = deferred();
      finished = deferred();
      holdVerify = true;
      const candidatesBefore = scopedCandidateCalls;
      await settings
        .getByRole("button", { name: "Verify new email", exact: true })
        .click();
      await waitGate(arrived.promise);
      await replacementLogin(true);
      await releaseAndCheck("replacement-verify-draft@example.invalid");
      assert.equal(scopedCandidateCalls, candidatesBefore);
      assert.equal(
        await settings
          .getByText("synthetic delayed original-actor provider failure", {
            exact: true,
          })
          .count(),
        0,
      );
      await capture(page, `provider-settings-replacement-${name}.png`, true);
      checks.push(
        `${name}: a delayed original SDK email-verification failure cannot open reconciliation or disclose its private/error state over the replacement account; already-started provider work is not claimed cancelled`,
      );
      assert.deepEqual(unexpectedProviderPaths, []);
      return;
    }
    stage = "same passkey cannot approve its removal";
    await page
      .getByRole("button", { name: "Remove Passkey", exact: true })
      .click();
    const removal = page.getByRole("dialog", {
      name: "Change sign-in methods",
      exact: true,
    });
    await removal.waitFor();
    assert.equal(
      await removal.getByRole("option", { name: /^Passkey added/ }).count(),
      0,
    );
    assert.equal(
      await removal
        .getByRole("option", { name: "Current password", exact: true })
        .count(),
      1,
    );
    assert.equal(
      await page
        .locator("#account-security-passkeys")
        .getByRole("button")
        .count(),
      0,
      "Privy management has no duplicate local removal control",
    );
    await removal.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(providerChangeCalls, 0);
    beginUnavailable = true;
    await add.click();
    await page
      .getByText("Synthetic provider unavailable; retry later.", {
        exact: true,
      })
      .waitFor();
    assert.equal(providerInitCalls, 1);
    assert.equal(providerLinkCalls, 1);
    assert.equal(completeCalls, 1);
    await capture(page, `single-privy-passkey-unavailable-${name}.png`, true);
    checks.push(
      `${name}: a failed guarded setup request surfaces its retry notice without opening another provider ceremony or repeating bridge completion`,
    );
    stage = "held begin cannot continue under a replacement account";
    beginUnavailable = false;
    holdBegin = true;
    await add.click();
    await heldBeginArrived.promise;
    fixtureAccount = "replacement-passkey-account";
    replacementActor = true;
    await page.evaluate(() =>
      window.dispatchEvent(new Event("yap:account-changed")),
    );
    await page.waitForFunction(
      () =>
        window.yapCurrentSessionAccount?.() === "replacement-passkey-account",
    );
    beginGate.release();
    await heldBeginFinished.promise;
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
    assert.equal(operationCalls, 1);
    assert.equal(resumedOperationCalls, 1);
    assert.equal(providerInitCalls, 1);
    assert.equal(providerLinkCalls, 1);
    assert.equal(completeCalls, 1);
    assert.equal(
      await page.evaluate(() =>
        sessionStorage.getItem("yaparena-provider-passkey-setup"),
      ),
      null,
    );
    checks.push(
      `${name}: a delayed original-account begin response cannot retain an intent, collect proof, open a provider ceremony or complete activation after verified account replacement`,
    );
    assert.deepEqual(unexpectedProviderPaths, []);
    checks.push(
      `${name}: the Privy credential is absent from authorization choices for its own removal and has no duplicate application removal button; cancellation changes neither provider nor bridge`,
    );
  } catch (error) {
    const failedPage = context.pages()[0];
    if (failedPage)
      await capture(failedPage, `single-passkey-failure-${name}.png`, true);
    await writeFile(
      resolve(directory, `single-passkey-failure-${name}.json`),
      JSON.stringify(
        {
          revision,
          assetHashes,
          sourceHashes,
          stage,
          settings: await failedPage
            ?.locator("#provider-settings")
            .innerText()
            .catch(() => null),
          resume: await failedPage
            ?.locator("#passkey-setup-resume")
            .innerText()
            .catch(() => null),
          intentRetained: await failedPage
            ?.evaluate(() =>
              Boolean(
                sessionStorage.getItem("yaparena-provider-passkey-setup"),
              ),
            )
            .catch(() => null),
          focus: await failedPage
            ?.evaluate(() => ({
              tag: document.activeElement?.tagName ?? null,
              button:
                document.activeElement instanceof HTMLButtonElement
                  ? (document.activeElement.textContent?.trim() ?? null)
                  : null,
            }))
            .catch(() => null),
          errors,
          counters: counters(),
        },
        null,
        2,
      ) + "\n",
    );
    throw error;
  } finally {
    await context.close();
  }
}
try {
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 1000 }],
    ["mobile", { width: 390, height: 844 }],
  ] as const) {
    await verifyExchangeFailureClassification(name, viewport);
    await verifyPrivyPasskeySetup(name, viewport);
    if (name === "desktop")
      await verifyPrivyPasskeySetup("desktop-expired-restart", viewport, true);
    if (name === "desktop")
      await verifyPrivyPasskeySetup(
        "desktop-queued-completion",
        viewport,
        false,
        true,
      );
    if (name === "desktop")
      await verifyPrivyPasskeySetup(
        "desktop-provider-settings-races",
        viewport,
        false,
        false,
        true,
      );
    const context = await browser.newContext({
      viewport,
      reducedMotion: "reduce",
    });
    await context.addInitScript(() => {
      if (window === window.top) {
        localStorage.setItem("yaparena-measurement-declined", "1");
        const walletDirectoryViolations: string[] = [];
        Object.defineProperty(window, "__walletDirectoryViolations", {
          value: walletDirectoryViolations,
        });
        window.addEventListener("securitypolicyviolation", (event) => {
          if (
            event.blockedURI.startsWith(
              "https://explorer-api.walletconnect.com/",
            )
          )
            walletDirectoryViolations.push(event.effectiveDirective);
        });
      }
    });
    const page = await context.newPage();
    await page.clock.install();
    async function checkHeaderZoom(state: "guest" | "member") {
      if (name !== "desktop") return;
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.evaluate(() => {
        document.documentElement.style.zoom = "2";
      });
      try {
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
          true,
          `${state} header reflows at 200% zoom`,
        );
        await capture(page, `header-${state}-zoom.png`, false);
        checks.push(`${name}: ${state} header reflows at 200% CSS zoom`);
      } finally {
        await page.evaluate(() => {
          document.documentElement.style.zoom = "";
        });
        await page.setViewportSize(viewport);
      }
    }
    async function checkJourneyZoom(journey: string, selector: string) {
      if (name !== "desktop") return;
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.evaluate(() => {
        document.documentElement.style.zoom = "2";
      });
      try {
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
          true,
          `${journey} has no horizontal overflow at 200% CSS zoom`,
        );
        assert.equal(
          await page.locator(selector).evaluate((surface) =>
            [...surface.querySelectorAll("input,select,button")]
              .filter((element) => element.getClientRects().length > 0)
              .every((element) => {
                const box = element.getBoundingClientRect();
                return box.left >= -1 && box.right <= innerWidth + 1;
              }),
          ),
          true,
          `${journey} controls remain horizontally reachable at 200% CSS zoom`,
        );
        checks.push(
          `${name}: ${journey} reflows with reachable controls at 200% CSS zoom`,
        );
      } catch (error) {
        requirementFailures.push(
          `${name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        if (journey === "account-settings")
          await page.locator("#account-security").scrollIntoViewIfNeeded();
        await capture(page, `${journey}-zoom.png`, false);
        await page.evaluate(() => {
          document.documentElement.style.zoom = "";
        });
        await page.setViewportSize(viewport);
      }
    }
    async function compareSharedHeaderStyles() {
      const other = await context.newPage();
      try {
        await other.goto(`${base}/test/header-only`);
        await other
          .locator('[data-site-header][data-session="guest"]')
          .waitFor();
        await other.evaluate(() => document.fonts.ready);
        const snapshot = () =>
          [
            ".brand",
            ".arena-brand-symbol",
            ".arena-nav nav",
            ".arena-nav nav a",
            ".arena-header-search",
            ".arena-header-search input",
            ".arena-header-account",
            ".header-login",
            ".header-signup",
          ].map((selector) => {
            const node = document.querySelector(selector)!;
            const style = getComputedStyle(node);
            const bounds = node.getBoundingClientRect();
            return {
              selector,
              fontSize: style.fontSize,
              fontFamily: style.fontFamily,
              lineHeight: style.lineHeight,
              color: style.color,
              background: style.backgroundColor,
              borderWidth: style.borderWidth,
              borderRadius: style.borderRadius,
              letterSpacing: style.letterSpacing,
              padding: style.padding,
              gap: style.gap,
              x: bounds.x,
              y: bounds.y,
              width: bounds.width,
              height: bounds.height,
            };
          });
        assert.deepEqual(
          await other.evaluate(snapshot),
          await page.evaluate(snapshot),
          "shared header appearance does not depend on the debate stylesheet",
        );
        checks.push(
          `${name}: identical header geometry, typography and colors with and without debate styles`,
        );
      } finally {
        await other.close();
        await page.bringToFront();
      }
    }
    page.on("pageerror", (error) => errors.push(error.message));
    const requests: { path: string; status: number }[] = [];
    page.on("response", (response) =>
      requests.push({
        path: new URL(response.url()).pathname,
        status: response.status(),
      }),
    );
    let sends = 0,
      verifications = 0;
    let captchaFixtures = 0;
    let providerGate: ReturnType<typeof deferred> | undefined;
    let sendGate: ReturnType<typeof deferred> | undefined;
    let verifyGate: ReturnType<typeof deferred> | undefined;
    await page.route(
      (url) => url.pathname === `/api/v1/apps/${appId}`,
      async (route) => {
        captchaFixtures++;
        await providerGate?.promise;
        await route.fulfill({
          headers: {
            "access-control-allow-origin": base,
            "access-control-allow-credentials": "true",
            "access-control-allow-methods": "GET, OPTIONS",
            "access-control-allow-headers":
              route.request().headers()["access-control-request-headers"] ?? "",
          },
          json: {
            ...providerSettings,
            captcha_enabled: false,
            enabled_captcha_provider: null,
          },
        });
      },
    );
    await page.route("**/api/v1/passwordless/init", async (route) => {
      sends++;
      await sendGate?.promise;
      await route.fulfill({ json: { success: true } });
    });
    await page.route("**/api/v1/passwordless/authenticate", async (route) => {
      verifications++;
      await verifyGate?.promise;
      await route.fulfill({
        status: 400,
        json: {
          error: "Invalid verification code",
          code: "invalid_credentials",
        },
      });
    });
    await page.goto(`${base}/account?baseline=1`);
    await page
      .getByText("Sign in to create a profile and follow people or topics.", {
        exact: true,
      })
      .waitFor();
    await capture(page, `legacy-comparison-${name}.png`, true);
    providerGate = deferred();
    await page.goto(
      `${base}/account?next=%2Fdebates%2Ffixture%3Fround%3D1%23commit`,
    );
    const button = page.getByRole("button", { name: "Continue with email" });
    try {
      await button.waitFor();
    } catch {
      await capture(page, "initialization-failure.png", true);
      console.log(
        JSON.stringify({
          phase: "provider initialization",
          errors,
          requests,
          status: await page.locator("#email-auth").innerText(),
        }),
      );
      throw new Error(
        "email form initialization failed; see local fixture evidence",
      );
    }
    assert.equal(await button.isDisabled(), true);
    assert.equal(
      await page.locator("#email-auth [aria-busy]").getAttribute("aria-busy"),
      "true",
      "provider initialization stays busy before public metadata arrives",
    );
    providerGate.release();
    providerGate = undefined;
    await page
      .waitForFunction(
        () =>
          !document.querySelector<HTMLButtonElement>(
            '#email-auth button[type="submit"]',
          )?.disabled,
      )
      .catch(async () => {
        console.log(
          JSON.stringify({
            phase: "provider readiness",
            errors,
            requests,
            status: await page.locator("#email-auth").innerText(),
          }),
        );
        throw new Error("SDK readiness failed in the local fixture");
      });
    assert.equal(
      await page
        .getByLabel("Email address", { exact: true })
        .getAttribute("autocomplete"),
      "email",
    );
    await capture(page, `account-email-${name}.png`, true);
    await checkJourneyZoom("account-email", "#email-auth");
    await page.waitForFunction(() => Boolean(window.axe));
    const results = await page.evaluate(async () =>
      window.axe.run("#email-auth", {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
        },
      }),
    );
    assert.deepEqual(
      results.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
      })),
      [],
    );
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page
      .getByLabel("Email address", { exact: true })
      .fill("synthetic@example.invalid");
    sendGate = deferred();
    await button.press("Enter");
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLButtonElement>(
          '#email-auth button[type="submit"]',
        )?.textContent === "Sending code…",
    );
    assert.equal(await page.locator("#auth-email").isDisabled(), true);
    assert.equal(await page.locator("#auth-code").count(), 0);
    await page.locator("#email-auth form").evaluate((form) => {
      (form as HTMLFormElement).requestSubmit();
      (form as HTMLFormElement).requestSubmit();
    });
    assert.equal(sends, 1, "delayed email send cannot be duplicated");
    sendGate.release();
    sendGate = undefined;
    const code = page.getByLabel("Verification code", { exact: true });
    await code.waitFor();
    assert.ok(
      captchaFixtures > 0,
      "explicit synthetic CAPTCHA configuration used",
    );
    assert.equal(sends, 1);
    assert.equal(await code.getAttribute("autocomplete"), "one-time-code");
    assert.equal(
      await code.evaluate((element) => element === document.activeElement),
      true,
    );
    assert.equal(
      await page.getByRole("button", { name: /Resend in/ }).isDisabled(),
      true,
    );
    await code.focus();
    await page.keyboard.insertText("123456");
    assert.equal(await code.inputValue(), "123456");
    verifyGate = deferred();
    await page.getByRole("button", { name: "Verify and continue" }).click();
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLButtonElement>(
          '#email-auth button[type="submit"]',
        )?.textContent === "Verifying…",
    );
    assert.equal(await code.isDisabled(), true);
    await page.locator("#email-auth form").evaluate((form) => {
      (form as HTMLFormElement).requestSubmit();
      (form as HTMLFormElement).requestSubmit();
    });
    assert.equal(verifications, 1, "delayed verification cannot be duplicated");
    verifyGate.release();
    verifyGate = undefined;
    await page
      .getByText("That code is incorrect, expired or already used.", {
        exact: false,
      })
      .waitFor();
    assert.equal(verifications, 1);
    await capture(page, `code-error-${name}.png`, true);
    await checkJourneyZoom("code-error", "#email-auth");
    assert.equal(await code.getAttribute("inputmode"), "numeric");
    assert.equal(
      await page.locator(".auth-status").getAttribute("aria-live"),
      "polite",
    );
    assert.equal(
      await page.locator(".auth-status").getAttribute("aria-atomic"),
      "true",
    );
    assert.deepEqual(
      await page.evaluate(async () =>
        (
          await window.axe.run("#email-auth", {
            runOnly: {
              type: "tag",
              values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
            },
          })
        ).violations.map((entry) => ({ id: entry.id, impact: entry.impact })),
      ),
      [],
    );
    await page.clock.fastForward(31_000);
    await page
      .getByRole("button", { name: "Resend code", exact: true })
      .click();
    await page
      .getByText(
        "Check your inbox and spam folder. Enter the newest code from Privy.",
        {
          exact: true,
        },
      )
      .waitFor();
    assert.equal(sends, 2);
    assert.equal(await code.inputValue(), "");
    assert.equal(
      await page.getByRole("button", { name: /Resend in/ }).isDisabled(),
      true,
    );
    await page.getByRole("button", { name: "Change email" }).click();
    await page.getByLabel("Email address", { exact: true }).waitFor();
    await page.waitForFunction(
      () => document.activeElement?.id === "auth-email",
    );
    await page.reload();
    assert.equal(
      await page.getByLabel("Email address", { exact: true }).inputValue(),
      "",
    );
    const walletToggle = page.getByLabel("Yap Coins balance and actions", {
      exact: true,
    });
    await page.getByRole("link", { name: "Log in", exact: true }).waitFor();
    assert.equal(
      await walletToggle.isVisible(),
      false,
      "no signed-out balance or account icon",
    );
    assert.equal(
      await page.locator("[data-header-account]").isVisible(),
      false,
    );
    let appSignedIn = true;
    let fixtureAccountId = "fixture";
    await page.route("**/api/auth/me", (route) =>
      route.fulfill(
        appSignedIn
          ? { json: { user: { id: fixtureAccountId, email: null } } }
          : { status: 401, json: { error: "authentication required" } },
      ),
    );
    await page.reload();
    await walletToggle.waitFor({ state: "visible" });
    await walletToggle.press("Enter");
    const walletPanel = page.locator(".arena-wallet-popover");
    await walletPanel
      .getByText("Available for withdrawal: 1250 YC", { exact: true })
      .waitFor();
    assert.deepEqual(
      await walletPanel
        .locator("progress")
        .evaluateAll((elements) =>
          elements.map((element) => (element as HTMLProgressElement).value),
        ),
      [40, 0, 100],
    );
    await capture(page, `wallet-progress-${name}.png`, true);
    await walletToggle.press("Escape");
    assert.equal(
      await page
        .locator(".arena-wallet-menu")
        .evaluate((element) => (element as HTMLDetailsElement).open),
      false,
    );
    assert.equal(
      await walletToggle.evaluate(
        (element) => element === document.activeElement,
      ),
      true,
    );
    checks.push(
      `${name}: synthetic withdrawal balance, independent grant bars, sticky qualification, Escape/focus restoration`,
    );
    checks.push(
      `${name}: SDK initialization with synthetic CAPTCHA-disabled metadata, email/code form, keyboard submit, focus, resend wait, wrong-code error, change email, refresh, no overflow, automated WCAG tags`,
    );
    checks.push(
      `${name}: delayed provider readiness disables submit, delayed send/verification retain busy states and reject repeated native form submissions, paste-style whole-code text insertion`,
    );
    checks.push(
      `${name}: invalid-code status has polite/atomic announcements and automated WCAG checks; virtual-clock cooldown permits a single resend, clears old code and restarts the wait`,
    );
    await page.goto(`${base}/test/debate?round=42#commit`);
    await page
      .getByRole("link", { name: "Yap Coins balance", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByText("Available for withdrawal: 1250 YC", { exact: true })
      .waitFor();
    assert.equal(await dialog.locator("progress").count(), 3);
    await page.waitForFunction(() => Boolean(window.axe));
    assert.deepEqual(
      await page.evaluate(async () =>
        (
          await window.axe.run("dialog", {
            runOnly: {
              type: "tag",
              values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
            },
          })
        ).violations.map((entry) => ({ id: entry.id, impact: entry.impact })),
      ),
      [],
    );
    await capture(page, `balance-dialog-${name}.png`, true);
    await dialog
      .getByRole("button", { name: "Close", exact: true })
      .press("Escape");
    assert.equal(await dialog.isVisible(), false);
    assert.equal(
      await page
        .getByRole("link", { name: "Yap Coins balance", exact: true })
        .evaluate((element) => element === document.activeElement),
      true,
    );
    await page.locator("#return-link").click();
    await page.waitForURL((url) => url.pathname === "/account");
    assert.equal(
      new URL(page.url()).searchParams.get("next"),
      "/test/debate?round=42#commit",
    );
    checks.push(
      `${name}: balance dialog, Escape/focus, exact debate query/fragment preserved through sign-in link`,
    );
    // A YapArena application session may outlive the SDK's browser session.
    // Settings must use methods verified for that app account, not SDK state.
    await page.route("**/api/auth/me", (route) =>
      route.fulfill(
        appSignedIn
          ? { json: { user: { id: fixtureAccountId, email: null } } }
          : { status: 401, json: { error: "authentication required" } },
      ),
    );
    await page.route("**/api/auth/methods", (route) =>
      route.fulfill({
        json: {
          provider: { email: "synthetic@example.invalid", methods: ["email"] },
          legacyPassword: false,
        },
      }),
    );
    let profile: {
      handle: string;
      displayName: string;
      bio: string;
      publicationState: string;
    } | null = null;
    const profileWrites: { method: string; body: unknown }[] = [];
    await page.route("**/api/me/profile", async (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        const body: { handle: string; displayName: string; bio: string } =
          request.postDataJSON();
        profileWrites.push({ method: request.method(), body });
        profile = { ...body, publicationState: "draft" };
      } else if (request.method() === "PATCH" && profile) {
        const body: {
          displayName?: string;
          bio?: string;
          publicationState?: string;
        } = request.postDataJSON();
        profileWrites.push({ method: request.method(), body });
        profile = { ...profile, ...body };
      }
      await route.fulfill(
        profile
          ? { json: { profile } }
          : { status: 404, json: { error: "profile not found" } },
      );
    });
    await page.route("**/api/auth/wallets", (route) =>
      route.fulfill({ json: { wallets: [] } }),
    );
    await page.route("**/api/me/follows?**", (route) =>
      route.fulfill({ json: { items: [], pagination: { hasMore: false } } }),
    );
    await page.route("**/api/me/activity?**", (route) =>
      route.fulfill({ json: { items: [], pagination: { hasMore: false } } }),
    );
    await page.route("**/api/matching/notifications", (route) =>
      route.fulfill({ json: { notifications: [] } }),
    );
    let managedSessions = [
      {
        id: "100",
        current: true,
        createdAt: "2026-10-19T12:00:00.000Z",
        expiresAt: "2026-11-19T12:00:00.000Z",
      },
      {
        id: "101",
        current: false,
        createdAt: "2026-10-19T11:00:00.000Z",
        expiresAt: "2026-11-19T11:00:00.000Z",
      },
    ];
    const sessionRemovals: string[] = [];
    let sessionRemovalGate: ReturnType<typeof deferred> | undefined;
    let sessionRemovalStarted: ReturnType<typeof deferred> | undefined;
    await page.route("**/api/auth/sessions", (route) =>
      route.fulfill(
        appSignedIn
          ? { json: { sessions: managedSessions, hasMore: false } }
          : { status: 401, json: { error: "authentication required" } },
      ),
    );
    await page.route("**/api/auth/sessions/*", async (route) => {
      assert.equal(route.request().method(), "DELETE");
      const id = new URL(route.request().url()).pathname.split("/").at(-1)!;
      sessionRemovals.push(id);
      sessionRemovalStarted?.release();
      await sessionRemovalGate?.promise;
      if (!sessionRemovalGate)
        managedSessions = managedSessions.filter((entry) => entry.id !== id);
      await route.fulfill({ json: { current: id === "100" } });
    });
    await page.goto(`${base}/account`);
    await page.getByText("Account ready.", { exact: true }).waitFor();
    await page
      .locator("#provider-settings")
      .getByText("Email", { exact: true })
      .waitFor();
    await capture(page, `account-signed-in-${name}.png`, true);
    await checkJourneyZoom("account-settings", "#signed-in");
    console.log(`${name}: checking account accessibility and controls`);
    await page.waitForFunction(() => Boolean(window.axe));
    assert.deepEqual(
      await page.evaluate(async () =>
        (
          await window.axe.run("#signed-in", {
            runOnly: {
              type: "tag",
              values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
            },
          })
        ).violations.map((entry) => ({ id: entry.id, impact: entry.impact })),
      ),
      [],
    );
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    console.log(`${name}: account accessibility passed`);
    await page.getByLabel("Handle", { exact: true }).fill("fixture-profile");
    await page
      .getByLabel("Display name", { exact: true })
      .fill("Fixture person");
    await page.getByLabel("Bio", { exact: true }).fill("Synthetic profile.");
    await page.locator('#profile-form button[type="submit"]').click();
    await page.getByText("Profile saved.", { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel("Handle", { exact: true }).isDisabled(),
      true,
    );
    await page
      .locator('#profile-form select[name="publicationState"]')
      .selectOption("published");
    await page.locator('#profile-form button[type="submit"]').click();
    await page
      .getByText("@fixture-profile · published", { exact: true })
      .waitFor();
    assert.deepEqual(profileWrites, [
      {
        method: "POST",
        body: {
          handle: "fixture-profile",
          displayName: "Fixture person",
          bio: "Synthetic profile.",
        },
      },
      {
        method: "PATCH",
        body: {
          displayName: "Fixture person",
          bio: "Synthetic profile.",
          publicationState: "published",
        },
      },
    ]);
    if (phase === "after") {
      const sessions = page.getByRole("region", {
        name: "Active YapArena sessions",
        exact: true,
      });
      await sessions
        .getByText(
          "2 active sessions. Devices and locations are not collected.",
          { exact: true },
        )
        .waitFor();
      page.once("dialog", (confirmation) => void confirmation.accept());
      await sessions
        .getByRole("button", { name: /^Sign out session, started/ })
        .click();
      await sessions
        .getByText("Session signed out.", { exact: true })
        .waitFor();
      assert.deepEqual(sessionRemovals, ["101"]);
      assert.equal(
        await sessions
          .getByRole("button", { name: /^Sign out session, started/ })
          .count(),
        0,
      );
      assert.equal(
        await sessions
          .getByRole("button", { name: "Refresh active sessions", exact: true })
          .evaluate((element) => document.activeElement === element),
        true,
      );
      sessionRemovalGate = deferred();
      sessionRemovalStarted = deferred();
      page.once("dialog", (confirmation) => void confirmation.accept());
      await sessions
        .getByRole("button", { name: /^Sign out this session, started/ })
        .click();
      await sessionRemovalStarted.promise;
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLButtonElement>(
            '[aria-label="Active YapArena sessions"] > button',
          )?.disabled,
      );
      assert.deepEqual(sessionRemovals, ["101", "100"]);
      const previousRemovalGate = sessionRemovalGate;
      fixtureAccountId = "replacement-fixture";
      managedSessions = [
        {
          id: "200",
          current: true,
          createdAt: "2026-10-20T04:00:00.000Z",
          expiresAt: "2026-11-20T04:00:00.000Z",
        },
        {
          id: "201",
          current: false,
          createdAt: "2026-10-20T03:00:00.000Z",
          expiresAt: "2026-11-20T03:00:00.000Z",
        },
      ];
      await page.evaluate(() => {
        Reflect.set(window, "__staleRemovalLogouts", 0);
        window.addEventListener("yap:provider-logout", () =>
          Reflect.set(
            window,
            "__staleRemovalLogouts",
            Number(Reflect.get(window, "__staleRemovalLogouts")) + 1,
          ),
        );
        window.dispatchEvent(new Event("yap:account-changed"));
      });
      await sessions
        .getByText(
          "2 active sessions. Devices and locations are not collected.",
          { exact: true },
        )
        .waitFor();
      sessionRemovalGate = deferred();
      sessionRemovalStarted = deferred();
      page.once("dialog", (confirmation) => void confirmation.accept());
      await sessions
        .getByRole("button", { name: /^Sign out session, started/ })
        .click();
      await page.waitForFunction(async () =>
        (await navigator.locks.query()).pending?.some(
          (lock) => lock.name === "yaparena-application-session",
        ),
      );
      assert.deepEqual(sessionRemovals, ["101", "100"]);
      const staleResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "DELETE" &&
          new URL(response.url()).pathname === "/api/auth/sessions/100",
      );
      previousRemovalGate.release();
      await staleResponse;
      await sessionRemovalStarted.promise;
      assert.deepEqual(sessionRemovals, ["101", "100", "201"]);
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
      assert.equal(await page.locator("#signed-in").isVisible(), true);
      assert.equal(
        await page.evaluate(() => Reflect.get(window, "__staleRemovalLogouts")),
        0,
      );
      assert.equal(
        await sessions
          .getByRole("button", { name: "Refresh active sessions", exact: true })
          .isEnabled(),
        false,
        "the stale request cannot release the replacement account's pending removal",
      );
      const replacementRemovalGate = sessionRemovalGate;
      sessionRemovalGate = undefined;
      replacementRemovalGate.release();
      await sessions
        .getByText("Session signed out.", { exact: true })
        .waitFor();
      assert.equal(await sessions.locator("li").count(), 1);
      assert.equal(
        await sessions
          .getByRole("button", { name: "Refresh active sessions", exact: true })
          .isEnabled(),
        true,
      );
      assert.equal(
        await sessions
          .getByRole("button", { name: /^Sign out this session, started/ })
          .isEnabled(),
        true,
      );
      await capture(page, `session-race-protected-${name}.png`, true);
      sessionRemovalGate = undefined;
      checks.push(
        `${name}: session list queues a replacement account's removal behind the old DELETE and keeps that newer removal busy when the old response arrives, without signing out the replacement account`,
      );
      const passwordMethods = (route: Route) =>
        route.fulfill({
          json: {
            provider: {
              email: "synthetic@example.invalid",
              methods: ["email"],
            },
            legacyPassword: true,
          },
        });
      await page.route("**/api/auth/methods", passwordMethods);
      let staleSecurityWrites = 0;
      const rejectStaleSecurityWrite = (route: Route) => {
        staleSecurityWrites++;
        return route.fulfill({
          status: 409,
          json: { error: "unexpected stale security submission" },
        });
      };
      await page.route(
        "**/api/auth/security/operations",
        rejectStaleSecurityWrite,
      );
      await page.route(
        "**/api/auth/security/passkeys/enrollment/*/complete",
        rejectStaleSecurityWrite,
      );
      const openProviderApproval = () =>
          page.evaluate(() => {
            if (!window.yapPrepareProviderPasskey)
              throw new Error("Privy passkey approval helper unavailable");
            void window
              .yapPrepareProviderPasskey({
                intentId: "00000000-0000-4000-8000-000000000009",
                subject: "did:privy:synthetic-approval",
                beforeDigest: "1".repeat(64),
              })
              .catch(() => {});
          }),
        securityApproval = page.getByRole("dialog", {
          name: "Approve Privy passkey",
          exact: true,
        });
      assert.equal(
        await page
          .getByRole("button", { name: "Add security passkey", exact: true })
          .count(),
        0,
      );
      await openProviderApproval();
      await securityApproval.waitFor();
      await securityApproval
        .getByLabel("Current password", { exact: true })
        .fill("same-synthetic-fixture-password");
      await securityApproval
        .getByLabel("Current password", { exact: true })
        .evaluate((element) =>
          Reflect.set(window, "__detachedSecurityPassword", element),
        );
      fixtureAccountId = "security-replacement-fixture";
      await page.evaluate(() =>
        window.dispatchEvent(new Event("yap:account-changed")),
      );
      await securityApproval.waitFor({ state: "detached" });
      assert.equal(
        await page.evaluate(() => {
          const input: unknown = Reflect.get(
            window,
            "__detachedSecurityPassword",
          );
          return input instanceof HTMLInputElement ? input.value : null;
        }),
        "",
        "changing accounts must erase the detached trusted-credential input",
      );
      assert.equal(staleSecurityWrites, 0);
      await openProviderApproval();
      await securityApproval.waitFor();
      await securityApproval
        .getByLabel("Current password", { exact: true })
        .fill("same-synthetic-fixture-password");
      await securityApproval
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await securityApproval.waitFor({ state: "detached" });
      assert.equal(staleSecurityWrites, 0);
      await page.unroute("**/api/auth/methods", passwordMethods);
      checks.push(
        `${name}: switching accounts cancels the old trusted-credential dialog, erases its detached password and issues no follow-on operation; replacement-account controls still open and cancel a fresh approval with the same synthetic password`,
      );
    }
    await page.route("**/api/auth/logout-other-sessions", (route) =>
      route.fulfill({ status: 204 }),
    );
    page.once("dialog", (confirmation) => void confirmation.accept());
    await page.locator("#sign-out-others").click();
    await page
      .getByText("Other sessions signed out. This device is still signed in.", {
        exact: true,
      })
      .waitFor();
    assert.equal(await page.locator("#signed-in").isVisible(), true);
    if (phase === "after") {
      const unavailableReads = deferred(),
        unavailableReadsArrived = deferred(),
        unavailableReplies: Promise<void>[] = [];
      const unavailableAccount = async (route: Route) => {
        if (!appSignedIn) return route.fallback();
        const replied = deferred();
        unavailableReplies.push(replied.promise);
        if (unavailableReplies.length >= 2) unavailableReadsArrived.release();
        await unavailableReads.promise;
        try {
          await route.fulfill({
            status: 503,
            json: { error: "Synthetic account inspection is unavailable." },
          });
        } finally {
          replied.release();
        }
      };
      await page.route("**/api/auth/me", unavailableAccount);
      fixtureAccountId = "unavailable-replacement-fixture";
      await page.evaluate(() =>
        window.dispatchEvent(new Event("yap:account-changed")),
      );
      await unavailableReadsArrived.promise;
      assert.equal(await page.locator("#signed-in").isVisible(), false);
      assert.equal(await page.locator("#signed-out").isVisible(), false);
      assert.equal(await page.locator("#account-name").textContent(), "");
      assert.equal(
        await page
          .locator('#profile-form input[name="displayName"]')
          .inputValue(),
        "",
      );
      assert.equal(await page.locator("#wallet-list li").count(), 0);
      const checkingSignOut = page.locator("#account-checking-sign-out");
      assert.equal(await checkingSignOut.isVisible(), true);
      assert.equal(await checkingSignOut.isEnabled(), true);
      unavailableReads.release();
      await Promise.all(unavailableReplies);
      await page
        .locator("#account-notice")
        .getByText("Synthetic account inspection is unavailable.", {
          exact: true,
        })
        .waitFor();
      assert.equal(await page.locator("#signed-in").isVisible(), false);
      assert.equal(await page.locator("#signed-out").isVisible(), false);
      await page.reload();
      await page
        .locator("#account-notice")
        .getByText("Synthetic account inspection is unavailable.", {
          exact: true,
        })
        .waitFor();
      assert.equal(await checkingSignOut.isVisible(), true);
      assert.equal(await checkingSignOut.isEnabled(), true);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await checkJourneyZoom("account-checking", ".account-status-row");
      await capture(page, `account-inspection-outage-${name}.png`, true);
      let outageLogoutRequests = 0;
      const outageLogout = (route: Route) => {
        outageLogoutRequests++;
        appSignedIn = false;
        return route.fulfill({ status: 204 });
      };
      await page.route("**/api/auth/logout", outageLogout);
      await checkingSignOut.click();
      await page.locator("#signed-out").waitFor({ state: "visible" });
      assert.equal(outageLogoutRequests, 1);
      assert.equal(await checkingSignOut.isVisible(), false);
      await page.unroute("**/api/auth/me", unavailableAccount);
      await page.unroute("**/api/auth/logout", outageLogout);
      appSignedIn = true;
      await page.evaluate(() =>
        window.dispatchEvent(new Event("yap:account-changed")),
      );
      await page.getByText("Account ready.", { exact: true }).waitFor();
      checks.push(
        `${name}: held account inspection clears prior private fields without guest flashes; initial and continuing inspection outages retain a usable local sign-out action, which sends one logout request and hides after confirmed guest state`,
      );
      for (const action of ["account", "header", "all", "others"] as const) {
        const gate = deferred(),
          started = deferred(),
          path =
            action === "all"
              ? "/api/auth/logout-all"
              : action === "others"
                ? "/api/auth/logout-other-sessions"
                : "/api/auth/logout";
        const heldLogout = async (route: Route) => {
          started.release();
          await gate.promise;
          await route.fulfill(
            action === "account" || action === "header"
              ? {
                  status: 401,
                  json: { error: "synthetic old session has ended" },
                }
              : { status: 204 },
          );
        };
        await page.route(`**${path}`, heldLogout);
        await page.evaluate(() =>
          Reflect.set(window, "__staleRemovalLogouts", 0),
        );
        if (action === "header") {
          await page.locator("[data-header-account]").click();
          await page
            .getByRole("button", { name: "Log out", exact: false })
            .click();
        } else {
          if (action !== "account")
            page.once("dialog", (confirmation) => void confirmation.accept());
          await page
            .locator(
              action === "all"
                ? "#sign-out-all"
                : action === "others"
                  ? "#sign-out-others"
                  : "#sign-out",
            )
            .click();
        }
        await started.promise;
        fixtureAccountId = `replacement-after-${action}-logout`;
        await page.evaluate(() =>
          window.dispatchEvent(new Event("yap:account-changed")),
        );
        await page.getByText("Account ready.", { exact: true }).waitFor();
        const oldReply = page.waitForResponse(
          (response) => new URL(response.url()).pathname === path,
        );
        gate.release();
        await oldReply;
        await page.evaluate(
          () =>
            new Promise<void>((done) =>
              requestAnimationFrame(() => requestAnimationFrame(() => done())),
            ),
        );
        assert.equal(await page.locator("#signed-in").isVisible(), true);
        assert.equal(
          await page.locator("[data-header-member]").isVisible(),
          true,
        );
        assert.equal(
          await page.evaluate(() =>
            Reflect.get(window, "__staleRemovalLogouts"),
          ),
          0,
        );
        assert.equal(
          await page.locator("#account-notice").textContent(),
          "Account ready.",
        );
        await page.unroute(`**${path}`, heldLogout);
      }
      checks.push(
        `${name}: delayed default, header, all-session and other-session logout replies cannot clear or relabel a replacement account or invoke provider logout`,
      );
      for (const action of ["account", "header", "all", "others"] as const) {
        const gate = deferred(),
          started = deferred(),
          path =
            action === "all"
              ? "/api/auth/logout-all"
              : action === "others"
                ? "/api/auth/logout-other-sessions"
                : "/api/auth/logout";
        const heldLogout = async (route: Route) => {
          started.release();
          await gate.promise;
          await route.fulfill({ status: 204 });
        };
        await page.route(`**${path}`, heldLogout);
        if (action === "header") {
          await page.locator("[data-header-account]").click();
          await page
            .getByRole("button", { name: "Log out", exact: false })
            .click();
        } else {
          if (action !== "account")
            page.once("dialog", (confirmation) => void confirmation.accept());
          await page
            .locator(
              action === "all"
                ? "#sign-out-all"
                : action === "others"
                  ? "#sign-out-others"
                  : "#sign-out",
            )
            .click();
        }
        await started.promise;
        await page.evaluate(() =>
          window.dispatchEvent(new Event("yap:account-changed")),
        );
        await page.getByText("Account ready.", { exact: true }).waitFor();
        appSignedIn = action === "others";
        const retainedInspection =
          action === "others" ? page.waitForResponse("**/api/auth/me") : null;
        gate.release();
        if (retainedInspection) {
          await (await retainedInspection).finished();
          await page.locator("#signed-in").waitFor({ state: "visible" });
          await page.getByText("Account ready.", { exact: true }).waitFor();
        } else await page.locator("#signed-out").waitFor({ state: "visible" });
        assert.equal(
          await page.locator("#signed-in").isVisible(),
          action === "others",
        );
        assert.equal(
          await page.evaluate(() =>
            Reflect.get(window, "__staleRemovalLogouts"),
          ),
          0,
        );
        await page.unroute(`**${path}`, heldLogout);
        appSignedIn = true;
        await page.evaluate(() =>
          window.dispatchEvent(new Event("yap:account-changed")),
        );
        await page.getByText("Account ready.", { exact: true }).waitFor();
      }
      checks.push(
        `${name}: same-account changes during held logout trigger a fresh server lookup, converge to the confirmed session state and never apply stale provider logout or notices`,
      );
      for (const response of ["missing", "other-current"] as const) {
        managedSessions = [
          {
            id: "700",
            current: true,
            createdAt: "2026-10-20T04:00:00.000Z",
            expiresAt: "2026-11-20T04:00:00.000Z",
          },
        ];
        await page.evaluate(() =>
          window.dispatchEvent(new Event("yap:account-changed")),
        );
        await page.getByText("Account ready.", { exact: true }).waitFor();
        const changedCurrent = async (route: Route) => {
          managedSessions = [{ ...managedSessions[0]!, id: "701" }];
          await route.fulfill(
            response === "missing"
              ? { status: 404, json: { error: "session unavailable" } }
              : { json: { current: false } },
          );
        };
        await page.route("**/api/auth/sessions/700", changedCurrent);
        await page.evaluate(() =>
          Reflect.set(window, "__staleRemovalLogouts", 0),
        );
        page.once("dialog", (confirmation) => void confirmation.accept());
        await page
          .getByRole("region", { name: "Active YapArena sessions" })
          .getByRole("button", { name: /^Sign out this session, started/ })
          .click();
        await page
          .getByRole("region", { name: "Active YapArena sessions" })
          .getByText("Session signed out.", { exact: true })
          .waitFor();
        assert.equal(await page.locator("#signed-in").isVisible(), true);
        assert.equal(
          await page.evaluate(() =>
            Reflect.get(window, "__staleRemovalLogouts"),
          ),
          0,
        );
        await page.unroute("**/api/auth/sessions/700", changedCurrent);
      }
      checks.push(
        `${name}: session removal trusts server current=false and refreshes a missing stale current row without ending the replacement local session`,
      );
      for (const control of ["all", "others", "individual"] as const) {
        const path =
          control === "individual"
            ? "/api/auth/sessions/701"
            : `/api/auth/logout-${control === "all" ? "all" : "other-sessions"}`;
        const ended = (route: Route) => {
          appSignedIn = false;
          return route.fulfill({
            status: 401,
            json: { error: "synthetic current authorization ended" },
          });
        };
        await page.route(`**${path}`, ended);
        page.once("dialog", (confirmation) => void confirmation.accept());
        if (control === "individual")
          await page
            .getByRole("region", { name: "Active YapArena sessions" })
            .getByRole("button", { name: /^Sign out this session, started/ })
            .click();
        else
          await page
            .locator(control === "all" ? "#sign-out-all" : "#sign-out-others")
            .click();
        await page.locator("#signed-out").waitFor({ state: "visible" });
        await page
          .locator("#account-notice")
          .getByText(
            "This session has ended. Sign in again to sign out other devices.",
            { exact: true },
          )
          .waitFor();
        assert.equal(await page.locator("#account-name").textContent(), "");
        assert.equal(
          await page
            .locator('#profile-form input[name="displayName"]')
            .inputValue(),
          "",
        );
        await page.unroute(`**${path}`, ended);
        appSignedIn = true;
        await page.evaluate(() =>
          window.dispatchEvent(new Event("yap:account-changed")),
        );
        await page.getByText("Account ready.", { exact: true }).waitFor();
      }
      checks.push(
        `${name}: advanced all/other and individual session 401 replies clear local private fields and explain that other-device sign-out is unconfirmed`,
      );
    }
    const oldAccountReads = deferred(),
      oldAccountReadsArrived = deferred(),
      oldAccountResponses: Promise<void>[] = [];
    let holdAccountReads = true;
    const oldAccountReadHandler = async (route: Route) => {
      if (!holdAccountReads) return route.fallback();
      const finished = deferred();
      oldAccountResponses.push(finished.promise);
      if (oldAccountResponses.length >= 2) oldAccountReadsArrived.release();
      await oldAccountReads.promise;
      try {
        await route.fulfill({
          json: { user: { id: fixtureAccountId, email: null } },
        });
      } finally {
        finished.release();
      }
    };
    await page.route("**/api/auth/me", oldAccountReadHandler);
    await page.evaluate(() =>
      window.dispatchEvent(new Event("yap:account-changed")),
    );
    await oldAccountReadsArrived.promise;
    holdAccountReads = false;
    await page.route("**/api/auth/logout", (route) => {
      appSignedIn = false;
      return route.fulfill({
        status: 401,
        json: {
          error:
            "this session has ended; sign in again to sign out other devices",
        },
      });
    });
    await page
      .locator(phase === "after" ? "#account-checking-sign-out" : "#sign-out")
      .click();
    await page.locator("#signed-out").waitFor({ state: "visible" });
    assert.equal(await page.locator("#signed-in").isVisible(), false);
    await page
      .locator("#account-notice")
      .getByText(
        "This session has ended. Sign in again to sign out other devices.",
        { exact: true },
      )
      .waitFor();
    assert.equal(await page.locator("#account-name").textContent(), "");
    assert.equal(
      await page
        .locator('#profile-form input[name="displayName"]')
        .inputValue(),
      "",
    );
    await page.locator('[data-site-header][data-session="guest"]').waitFor();
    oldAccountReads.release();
    await Promise.all(oldAccountResponses);
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
    assert.equal(await page.locator("#signed-in").isVisible(), false);
    assert.equal(await page.locator("#account-name").textContent(), "");
    assert.equal(await page.locator("[data-header-member]").isVisible(), false);
    await page.unroute("**/api/auth/me", oldAccountReadHandler);
    await capture(page, `account-expired-signout-${name}.png`, true);
    checks.push(
      `${name}: an expired normal sign-out cookie clears account fields and member controls, ignores delayed pre-logout identity responses and explains that other-device sign-out is unconfirmed`,
    );
    await page.unroute("**/api/auth/logout");
    appSignedIn = true;
    await page.evaluate(() =>
      window.dispatchEvent(new Event("yap:account-changed")),
    );
    await page.getByText("Account ready.", { exact: true }).waitFor();
    await page.route("**/api/auth/logout-all", (route) => {
      appSignedIn = false;
      return route.fulfill({ status: 204 });
    });
    page.once("dialog", (confirmation) => void confirmation.accept());
    await page.locator("#sign-out-all").click();
    await page.locator("#signed-out").waitFor({ state: "visible" });
    assert.equal(await page.locator("#signed-in").isVisible(), false);
    assert.deepEqual(
      await page.evaluate(() =>
        Reflect.get(window, "__walletDirectoryViolations"),
      ),
      [],
    );
    checks.push(
      `${name}: server-owned authentication methods, profile create/publish with permanent handle, other/all-session sign-out controls, account/dialog automated WCAG tags, no account overflow and unused wallet directory disabled`,
    );
    requests.length = 0;
    await page.goto(`${base}/test/entry?round=42#commit`);
    const login = page.getByRole("link", { name: "Log in", exact: true });
    await login.waitFor();
    assert.equal(
      requests.some((entry) => entry.path.endsWith("account-auth.bundle.js")),
      false,
      "public browsing does not load the provider bundle",
    );
    assert.equal(await page.locator("[data-header-member]").isVisible(), false);
    await compareSharedHeaderStyles();
    await capture(page, `header-guest-${name}.png`, false);
    await checkHeaderZoom("guest");
    await login.click();
    const authModal = page.locator("#site-auth-dialog");
    await authModal
      .getByRole("heading", { name: "Welcome back.", exact: true })
      .waitFor();
    await page.waitForFunction(
      () => document.activeElement?.id === "auth-email",
    );
    assert.equal(await page.locator("#email-auth").count(), 1);
    assert.equal(new URL(page.url()).pathname, "/test/entry");
    assert.equal(
      await page.locator("#email-auth").getAttribute("data-auth-return"),
      "/test/entry?round=42#commit",
    );
    await authModal
      .getByRole("button", { name: "Sign up", exact: true })
      .click();
    await authModal
      .getByRole("heading", { name: "Join YapArena.", exact: true })
      .waitFor();
    await page.waitForFunction(() => Boolean(window.axe));
    assert.deepEqual(
      await page.evaluate(async () =>
        (
          await window.axe.run("#site-auth-dialog", {
            runOnly: {
              type: "tag",
              values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
            },
          })
        ).violations.map((entry) => ({ id: entry.id, impact: entry.impact })),
      ),
      [],
    );
    await capture(page, `signup-popup-${name}.png`, false);
    await page.keyboard.press("Escape");
    await authModal.waitFor({ state: "hidden" });
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("data-auth-open") === "login",
    );
    await login.click();
    await authModal
      .getByLabel("Email address", { exact: true })
      .fill("synthetic@example.invalid");
    await authModal
      .getByRole("button", { name: "Continue with email" })
      .click();
    await authModal.getByLabel("Verification code", { exact: true }).waitFor();
    await capture(page, `code-popup-${name}.png`, false);
    await page.keyboard.press("Escape");
    await authModal.waitFor({ state: "hidden" });
    await page.locator("#participate-login").click();
    await authModal.waitFor({ state: "visible" });
    await page.waitForFunction(
      () => document.activeElement?.id === "auth-email",
    );
    assert.equal(
      await authModal.getByLabel("Email address", { exact: true }).inputValue(),
      "",
      "dismissal clears email and code",
    );
    sendGate = deferred();
    const lateSend = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === "/api/v1/passwordless/init",
    );
    await authModal
      .getByLabel("Email address", { exact: true })
      .fill("synthetic@example.invalid");
    await authModal
      .getByRole("button", { name: "Continue with email" })
      .click();
    await lateSend;
    await page.keyboard.press("Escape");
    await authModal.waitFor({ state: "hidden" });
    const lateSendResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/v1/passwordless/init",
    );
    sendGate.release();
    sendGate = undefined;
    await lateSendResponse;
    await page.locator("#participate-login").click();
    await authModal.waitFor({ state: "visible" });
    await page.waitForFunction(
      () => document.activeElement?.id === "auth-email",
    );
    assert.equal(
      await authModal.getByLabel("Email address", { exact: true }).inputValue(),
      "",
      "a late send response cannot restore cancelled email or advance the form",
    );
    assert.equal(await authModal.locator("#auth-code").count(), 0);
    checks.push(
      `${name}: delayed code-send response after dismissal cannot restore credentials or advance a reopened popup`,
    );
    await page.goBack();
    await authModal.waitFor({ state: "hidden" });
    await page.locator("#reports-login").click();
    await authModal.waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#email-auth").getAttribute("data-auth-return"),
      "/account/moderation?view=open#appeals",
      "protected account subpages use the popup and retain their destination",
    );
    await authModal.getByRole("link", { name: "Keep exploring" }).click();
    await authModal.waitFor({ state: "hidden" });
    await page.waitForFunction(
      () => !(history.state && history.state.yapAuthDialog),
    );
    appSignedIn = true;
    await page.evaluate(() =>
      window.dispatchEvent(new Event("yap:account-changed")),
    );
    await page.getByRole("button", { name: "Deposit", exact: true }).waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-header-balance]")?.textContent ===
        "1250 YC",
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await checkHeaderZoom("member");
    await capture(page, `header-member-${name}.png`, false);
    await page.getByRole("button", { name: "Deposit", exact: true }).click();
    await page
      .getByRole("heading", { name: "Add Yap Coins", exact: true })
      .waitFor();
    await page
      .getByText("Deposits are not open yet.", { exact: false })
      .waitFor();
    await page.keyboard.press("Escape");
    assert.equal(
      await page
        .getByRole("button", { name: "Deposit", exact: true })
        .evaluate((node) => node === document.activeElement),
      true,
    );
    await page.locator("[data-header-account]").click();
    await page
      .getByRole("link", { name: "Account settings", exact: true })
      .waitFor();
    await page.route("**/api/auth/logout", (route) => {
      appSignedIn = false;
      return route.fulfill({
        status: 401,
        json: {
          error:
            "this session has ended; sign in again to sign out other devices",
        },
      });
    });
    await page.getByRole("button", { name: "Log out", exact: false }).click();
    await login.waitFor();
    assert.equal(await page.locator("[data-header-member]").isVisible(), false);
    await page
      .locator("[data-header-status]")
      .getByText(
        "This session has ended. Sign in again to sign out other devices.",
        { exact: true },
      )
      .waitFor();
    checks.push(
      `${name}: expired header sign-out clears the member menu and preserves the warning that other devices may remain signed in`,
    );
    await capture(page, `header-expired-signout-${name}.png`, true);
    await page.unroute("**/api/auth/logout");
    appSignedIn = true;
    await page.evaluate(() =>
      window.dispatchEvent(new Event("yap:account-changed")),
    );
    await page.getByRole("button", { name: "Deposit", exact: true }).waitFor();
    await page.locator("[data-header-account]").click();
    await page
      .getByRole("link", { name: "Account settings", exact: true })
      .waitFor();
    const otherTab = await context.newPage();
    otherTab.on("pageerror", (error) => errors.push(error.message));
    await otherTab.route("**/api/auth/me", (route) =>
      route.fulfill(
        appSignedIn
          ? { json: { user: { id: "fixture", email: null } } }
          : { status: 401, json: { error: "authentication required" } },
      ),
    );
    await otherTab.goto(`${base}/test/entry`);
    await otherTab
      .getByRole("button", { name: "Deposit", exact: true })
      .waitFor();
    await page.route("**/api/auth/logout", (route) => {
      appSignedIn = false;
      return route.fulfill({ status: 204 });
    });
    await page.getByRole("button", { name: "Log out", exact: false }).click();
    await login.waitFor();
    assert.equal(await page.locator("[data-header-member]").isVisible(), false);
    await otherTab.getByRole("link", { name: "Log in", exact: true }).waitFor();
    assert.equal(
      await otherTab.locator("[data-header-member]").isVisible(),
      false,
      "logout removes member controls in another tab",
    );
    await otherTab.close();
    await page.route(
      "**/api/auth/me",
      (route) =>
        route.fulfill({ status: 503, json: { error: "temporary outage" } }),
      { times: 1 },
    );
    await page.evaluate(() =>
      window.dispatchEvent(new Event("yap:account-changed")),
    );
    await page
      .getByRole("button", { name: "Retry account", exact: true })
      .waitFor();
    assert.equal(
      await login.isVisible(),
      false,
      "an outage is not presented as a signed-out session",
    );
    await page
      .getByRole("button", { name: "Retry account", exact: true })
      .click();
    await login.waitFor();
    let releaseWallet: (() => void) | undefined;
    let walletStarted: (() => void) | undefined;
    const heldWallet = new Promise<void>((resolve) => {
      releaseWallet = resolve;
    });
    const requestedWallet = new Promise<void>((resolve) => {
      walletStarted = resolve;
    });
    await page.route(
      "**/api/account-wallet",
      async (route) => {
        walletStarted?.();
        await heldWallet;
        await route.fulfill({ json: { available: "999999", reserved: "0" } });
      },
      { times: 1 },
    );
    appSignedIn = true;
    await page.evaluate(() =>
      window.dispatchEvent(new Event("yap:account-changed")),
    );
    await requestedWallet;
    appSignedIn = false;
    await page.evaluate(() =>
      window.dispatchEvent(new Event("yap:account-changed")),
    );
    await login.waitFor();
    const oldWalletResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/account-wallet",
    );
    releaseWallet?.();
    await oldWalletResponse;
    await page.waitForFunction(
      () =>
        document.querySelector("[data-header-balance]")?.textContent === "—",
    );
    assert.equal(
      await page.locator("[data-header-member]").isVisible(),
      false,
      "a pre-logout response cannot restore another account's balance",
    );
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    checks.push(
      `${name}: anonymous controls only, lazy SDK, unified login/signup/protected-action popup, exact return path, cancellation clears credentials, Back/Escape/focus restoration, server-session-only member balance/deposit/user menu, honest funding gate, cross-tab logout, outage recovery, stale balance rejection and modal WCAG tags`,
    );
    const pendingPage = await context.newPage();
    pendingPage.on("pageerror", (error) => errors.push(error.message));
    let sessionGate = deferred();
    await pendingPage.route("**/api/auth/me", async (route) => {
      await sessionGate.promise;
      await route.fulfill({ json: { user: { id: "fixture", email: null } } });
    });
    await pendingPage.goto(`${base}/test/entry?initializing=1`);
    await pendingPage
      .locator('[data-site-header][data-session="checking"]')
      .waitFor();
    assert.equal(
      await pendingPage.locator("[data-header-guest]").isVisible(),
      false,
      "guest controls stay hidden while the initial application session is pending",
    );
    assert.equal(
      await pendingPage.locator("[data-header-member]").isVisible(),
      false,
    );
    sessionGate.release();
    await pendingPage
      .getByRole("button", { name: "Deposit", exact: true })
      .waitFor();
    sessionGate = deferred();
    await pendingPage.evaluate(() =>
      window.dispatchEvent(new Event("yap:account-changed")),
    );
    await pendingPage
      .locator('[data-site-header][data-session="checking"]')
      .waitFor();
    assert.equal(
      await pendingPage.locator("[data-header-guest]").isVisible(),
      false,
      "refreshing an application session does not flash guest controls",
    );
    sessionGate.release();
    await pendingPage
      .getByRole("button", { name: "Deposit", exact: true })
      .waitFor();
    await pendingPage.close();
    checks.push(
      `${name}: initial and refreshed application-session requests retain a checking state without showing guest controls before the server responds`,
    );
    // A refreshed modal entry retains browser history state. A later Back must
    // still dismiss the newly opened popup in a single step.
    await page.goto(`${base}/test/entry?refresh=1#commit`);
    await page.getByRole("link", { name: "Log in", exact: true }).click();
    await authModal.waitFor({ state: "visible" });
    await page.reload();
    await page.getByRole("link", { name: "Log in", exact: true }).click();
    await authModal.waitFor({ state: "visible" });
    await page.goBack();
    try {
      assert.equal(
        await authModal.isVisible(),
        false,
        "Back dismisses a reopened popup after refresh",
      );
      checks.push(`${name}: refresh/reopen retains single-step Back dismissal`);
    } catch (error) {
      requirementFailures.push(
        `${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      await capture(page, `refresh-back-failure-${name}.png`, false);
    }
    await page.goto(`${base}/test/entry?download-failure=1`);
    const downloadGate = deferred(),
      downloadStarted = deferred();
    await page.route(
      "**/assets/account-auth.bundle.js*",
      async (route) => {
        downloadStarted.release();
        await downloadGate.promise;
        await route.abort("failed");
      },
      { times: 1 },
    );
    const assertFallbackSpacing = async () => {
      const spacing = await authModal
        .locator(".auth-mount > p")
        .evaluate((text) => {
          const dialog = text.closest("dialog")!,
            close = dialog.querySelector<HTMLElement>(".site-auth-close")!,
            bounds = dialog.getBoundingClientRect(),
            closeBounds = close.getBoundingClientRect(),
            style = getComputedStyle(text),
            range = document.createRange();
          range.selectNodeContents(text);
          const lines = [...range.getClientRects()].filter(
            (line) => line.width > 0 && line.height > 0,
          );
          return {
            hasText: lines.length > 0,
            belowClose: lines.every(
              (line) => line.top >= closeBounds.bottom + 8,
            ),
            inset: lines.every(
              (line) =>
                line.left >= bounds.left + 24 &&
                line.right <= bounds.right - 24,
            ),
            noIntersection: lines.every(
              (line) =>
                line.right <= closeBounds.left ||
                line.left >= closeBounds.right ||
                line.bottom <= closeBounds.top ||
                line.top >= closeBounds.bottom,
            ),
            padding: [
              style.paddingTop,
              style.paddingRight,
              style.paddingBottom,
              style.paddingLeft,
            ].map(Number.parseFloat),
            margin: [style.marginTop, style.marginBottom].map(
              Number.parseFloat,
            ),
            closeWidth: closeBounds.width,
            closeHeight: closeBounds.height,
          };
        });
      assert.equal(spacing.hasText, true);
      assert.equal(
        spacing.belowClose,
        true,
        "fallback text clears the entire close target with an extra gap",
      );
      assert.equal(
        spacing.inset,
        true,
        "fallback text stays inset from both dialog edges",
      );
      assert.equal(
        spacing.noIntersection,
        true,
        "fallback text and the close target never intersect",
      );
      assert.ok(spacing.padding[0]! >= 68);
      assert.ok(spacing.padding.slice(1).every((padding) => padding >= 24));
      assert.deepEqual(spacing.margin, [0, 0]);
      assert.ok(spacing.closeWidth >= 44 && spacing.closeHeight >= 44);
    };
    await page.getByRole("link", { name: "Log in", exact: true }).click();
    await downloadStarted.promise;
    await authModal
      .getByText("Preparing secure sign-in…", { exact: true })
      .waitFor();
    await assertFallbackSpacing();
    await capture(page, `provider-download-loading-${name}.png`, false);
    downloadGate.release();
    await authModal
      .getByText(
        "Sign-in could not load. Check your connection, then close and reopen this window to retry.",
        {
          exact: true,
        },
      )
      .waitFor();
    assert.equal(await authModal.getByRole("status").count(), 1);
    await assertFallbackSpacing();
    await capture(page, `provider-download-failure-${name}.png`, false);
    await page.keyboard.press("Escape");
    await authModal.waitFor({ state: "hidden" });
    await page.getByRole("link", { name: "Log in", exact: true }).click();
    await authModal.getByLabel("Email address", { exact: true }).waitFor();
    await page.waitForFunction(
      () =>
        !document.querySelector<HTMLButtonElement>(
          '#email-auth button[type="submit"]',
        )?.disabled,
    );
    checks.push(
      `${name}: loading and download-failure text stays inset below the 44px close target without intersection; failure is announced and close/reopen retries the real installed SDK successfully`,
    );
    if (phase === "after") {
      let followWrites = 0;
      await page.route("**/api/me/follows/topics/return-topic", (route) => {
        if (route.request().method() === "GET")
          return route.fulfill(
            appSignedIn
              ? { json: { following: false } }
              : { status: 401, json: { error: "authentication required" } },
          );
        followWrites++;
        return route.fulfill({
          status: 401,
          json: { error: "authentication required" },
        });
      });
      appSignedIn = false;
      await page.goto(`${base}/test/action-return?round=42#confirm`);
      await page.locator('[data-site-header][data-session="guest"]').waitFor();
      const draft = page.locator("#resume-draft"),
        follow = page.locator(".follow-button");
      await draft.fill("Private draft stays in this document only.");
      await page.evaluate(() => {
        Reflect.set(window, "__resumeDocument", "original-document");
        Reflect.set(window, "__resumeSubmissions", 0);
        document
          .querySelector<HTMLFormElement>("#resume-chat")!
          .addEventListener("submit", (event) => {
            event.preventDefault();
            Reflect.set(
              window,
              "__resumeSubmissions",
              1 + Number(Reflect.get(window, "__resumeSubmissions")),
            );
            window.dispatchEvent(
              new CustomEvent("yap:request-auth", {
                cancelable: true,
                detail: {
                  returnTo: location.pathname + location.search + location.hash,
                  source: event.currentTarget,
                },
              }),
            );
          });
      });
      await page.locator("#resume-review").click();
      await authModal.waitFor({ state: "visible" });
      assert.equal(
        (
          await page.evaluate(() =>
            sessionStorage.getItem("yaparena-auth-return"),
          )
        )?.includes("Private draft"),
        false,
      );
      const actionUrl = page.url();
      appSignedIn = true;
      await page.evaluate(async () => {
        window.dispatchEvent(new Event("yap:account-changed"));
        const url = "/assets/auth-return.js",
          helper: { completeAuthReturn(value: string | null): boolean } =
            await import(url);
        helper.completeAuthReturn(
          location.pathname + location.search + location.hash,
        );
      });
      await authModal.waitFor({ state: "hidden" });
      await page.waitForFunction(
        () => document.activeElement?.id === "resume-draft",
      );
      assert.equal(page.url(), actionUrl);
      assert.equal(
        await draft.inputValue(),
        "Private draft stays in this document only.",
      );
      assert.deepEqual(
        await page.evaluate(() => [
          Reflect.get(window, "__resumeDocument"),
          Reflect.get(window, "__resumeSubmissions"),
        ]),
        ["original-document", 1],
      );
      assert.equal(followWrites, 0);
      await capture(page, `auth-return-confirmation-${name}.png`, false);
      checks.push(
        `${name}: same-page confirmed-session completion preserves the exact document, URL and private draft, restores the initiating form, and does not submit again`,
      );

      appSignedIn = false;
      await page.evaluate(() =>
        window.dispatchEvent(new Event("yap:account-changed")),
      );
      await page.locator('[data-site-header][data-session="guest"]').waitFor();
      await follow.click();
      await authModal.waitFor({ state: "visible" });
      assert.equal(followWrites, 1);
      await page.evaluate(async () => {
        const url = "/assets/auth-return.js",
          helper: { rememberAuthReturn(value: string | null): void } =
            await import(url);
        helper.rememberAuthReturn(
          location.pathname + location.search + location.hash,
        );
      });
      await page.reload();
      await authModal.waitFor({ state: "visible" });
      assert.equal(await draft.inputValue(), "");
      appSignedIn = true;
      await page.evaluate(async () => {
        const target = location.pathname + location.search + location.hash;
        history.replaceState(
          history.state,
          "",
          location.pathname +
            "?round=42&privy_oauth_code=synthetic-callback#confirm",
        );
        window.dispatchEvent(new Event("yap:account-changed"));
        const url = "/assets/auth-return.js",
          helper: { completeAuthReturn(value: string | null): boolean } =
            await import(url);
        helper.completeAuthReturn(target);
      });
      await authModal.waitFor({ state: "hidden" });
      await page.waitForFunction(() =>
        document.activeElement?.matches(".follow-button"),
      );
      assert.equal(page.url(), actionUrl);
      assert.equal(
        followWrites,
        1,
        "OAuth-style return does not retry the initiating PUT",
      );
      assert.equal(
        await page.evaluate(() =>
          sessionStorage.getItem("yaparena-auth-return"),
        ),
        null,
      );
      checks.push(
        `${name}: OAuth-style document replacement resumes only the expiring public action locator, clears callback parameters, focuses Follow for confirmation and performs no automatic PUT`,
      );

      appSignedIn = false;
      await page.evaluate(() =>
        window.dispatchEvent(new Event("yap:account-changed")),
      );
      await page.locator('[data-site-header][data-session="guest"]').waitFor();
      await follow.click();
      await authModal.waitFor({ state: "visible" });
      await page.goto(
        `${base}/account?next=${encodeURIComponent("/test/action-return?round=42#confirm")}`,
      );
      appSignedIn = true;
      await page.evaluate(async () => {
        const url = "/assets/auth-return.js",
          helper: { completeAuthReturn(value: string | null): boolean } =
            await import(url);
        helper.completeAuthReturn(
          new URLSearchParams(location.search).get("next"),
        );
      });
      await page.waitForURL(actionUrl);
      await page.waitForFunction(() =>
        document.activeElement?.matches(".follow-button"),
      );
      assert.equal(
        followWrites,
        2,
        "full-page return does not retry the initiating PUT",
      );
      checks.push(
        `${name}: full-page account return navigates to the exact safe URL and restores the original public action for a new explicit confirmation without copying draft values`,
      );

      const oldFollow = deferred(),
        oldFollowStarted = deferred();
      await page.route(
        "**/api/me/follows/topics/return-topic",
        async (route) => {
          if (route.request().method() === "GET") return route.fallback();
          followWrites++;
          oldFollowStarted.release();
          await oldFollow.promise;
          await route.fulfill({ json: { following: true } });
        },
      );
      await follow.click();
      await oldFollowStarted.promise;
      fixtureAccountId = "replacement-action-account";
      await page.evaluate(() =>
        window.dispatchEvent(new Event("yap:account-changed")),
      );
      oldFollow.release();
      await page.waitForFunction(
        () =>
          !document.querySelector<HTMLButtonElement>(".follow-button")
            ?.disabled,
      );
      assert.equal(await follow.getAttribute("aria-pressed"), "false");
      assert.equal(followWrites, 3);
      assert.equal(await authModal.isVisible(), false);
      checks.push(
        `${name}: an old account's held Follow response cannot apply its state or open sign-in for a replacement account; the new account gets a fresh read only`,
      );

      let matchingWrites = 0;
      await page.route("**/api/matching/**", (route) => {
        if (route.request().method() !== "GET") matchingWrites++;
        return route.fulfill({
          json: {
            topics: [
              {
                slug: "private-draft",
                title: "Private result before refresh",
                publicationState: "draft",
              },
            ],
            requests: [],
            events: [],
            notifications: [],
          },
        });
      });
      await page.goto(`${base}/match?topic=context#request-create`);
      await page
        .getByText("Matching ready. Review your request before submitting.", {
          exact: true,
        })
        .waitFor();
      const proposition = page.locator(
        '#request-create input[name="proposition"]',
      );
      await proposition.fill("Keep this proposed debate for confirmation.");
      const identityGate = deferred(),
        identityStarted = deferred();
      await page.route("**/api/auth/me", async (route) => {
        identityStarted.release();
        await identityGate.promise;
        return route.fallback();
      });
      await page.evaluate(() =>
        window.dispatchEvent(new Event("yap:account-changed")),
      );
      await identityStarted.promise;
      assert.equal(await page.locator("#match-signed-in").isVisible(), false);
      assert.equal(await page.locator("#my-topics").textContent(), "");
      identityGate.release();
      await page
        .getByText("Matching ready. Review your request before submitting.", {
          exact: true,
        })
        .waitFor();
      assert.equal(
        await proposition.inputValue(),
        "Keep this proposed debate for confirmation.",
      );
      assert.equal(matchingWrites, 0);
      checks.push(
        `${name}: matching clears private result lists during permission refresh, preserves its draft fields and never opens a request automatically`,
      );

      const publicTopic = {
        slug: "context",
        title: "Synthetic public context",
        sideALabel: "For",
        sideBLabel: "Against",
      };
      await page.route("**/api/public/topics/context", (route) =>
        route.fulfill({ json: publicTopic }),
      );
      await page
        .locator('#request-create input[name="topicSlug"]')
        .fill("context");
      await page
        .locator('#request-create input[name="scheduledAt"]')
        .fill("2026-11-20T12:00");
      await proposition.fill("Original actor request must not continue.");
      const oldTopic = deferred(),
        oldTopicStarted = deferred();
      let holdTopic = true;
      await page.route("**/api/public/topics/context", async (route) => {
        if (holdTopic) {
          oldTopicStarted.release();
          await oldTopic.promise;
        }
        return route.fulfill({ json: publicTopic });
      });
      await page.locator("#request-create").evaluate((form) => {
        if (form instanceof HTMLFormElement) form.requestSubmit();
      });
      await oldTopicStarted.promise;
      fixtureAccountId = "matching-replacement-account";
      await page.evaluate(() =>
        window.dispatchEvent(new Event("yap:account-changed")),
      );
      await page
        .getByText("Matching ready. Review your request before submitting.", {
          exact: true,
        })
        .waitFor();
      await proposition.fill("Replacement actor keeps this separate proposal.");
      const oldTopicResponse = page.waitForResponse(
        "**/api/public/topics/context",
      );
      holdTopic = false;
      oldTopic.release();
      await (await oldTopicResponse).finished();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      assert.equal(
        matchingWrites,
        0,
        "a held lookup cannot initiate the old actor's POST with the replacement cookie",
      );
      assert.equal(
        await proposition.inputValue(),
        "Replacement actor keeps this separate proposal.",
      );

      const topicForm = page.locator("#topic-create");
      for (const [field, value] of Object.entries({
        slug: "original-topic",
        title: "Original actor topic",
        summary: "Original actor synthetic draft summary.",
        sideALabel: "For",
        sideBLabel: "Against",
      }))
        await topicForm.locator(`[name="${field}"]`).fill(value);
      const oldCreate = deferred(),
        oldCreateStarted = deferred();
      await page.route("**/api/matching/topics", async (route) => {
        matchingWrites++;
        oldCreateStarted.release();
        await oldCreate.promise;
        return route.fulfill({ status: 201, json: { topic: publicTopic } });
      });
      await topicForm
        .getByRole("button", { name: "Create private draft" })
        .click();
      await oldCreateStarted.promise;
      fixtureAccountId = "matching-third-account";
      await page.evaluate(() =>
        window.dispatchEvent(new Event("yap:account-changed")),
      );
      await page
        .getByText("Matching ready. Review your request before submitting.", {
          exact: true,
        })
        .waitFor();
      await topicForm
        .locator('[name="title"]')
        .fill("Replacement actor topic draft");
      const oldCreateResponse = page.waitForResponse("**/api/matching/topics");
      oldCreate.release();
      await (await oldCreateResponse).finished();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      assert.equal(
        await topicForm.locator('[name="title"]').inputValue(),
        "Replacement actor topic draft",
      );
      assert.equal(
        await page.locator("#match-notice").textContent(),
        "Matching ready. Review your request before submitting.",
      );
      assert.equal(
        matchingWrites,
        1,
        "only the original explicitly submitted topic write occurred",
      );
      checks.push(
        `${name}: matching discards an old account's delayed topic lookup before any follow-on request and its delayed creation response cannot reset or announce success over the replacement actor's draft`,
      );

      let inlineWrites = 0;
      await page.route("**/api/a4/**", (route) => {
        if (route.request().method() !== "GET") inlineWrites++;
        if (route.request().url().includes("/workspace"))
          return route.fulfill({
            json: {
              accountId: fixtureAccountId,
              runs: { items: [] },
              run: null,
              wallet: {
                mode: "yap-coins",
                balances: [{ kind: "available", amount: "1000000" }],
                fundingPolicy: { starterCoins: 0, refillCoins: 0 },
              },
              timeline: {
                revision: "fixture",
                scope: "human",
                items: [],
                totals: {
                  premium: "0",
                  humanCommitments: 0,
                  botCommitments: 0,
                },
              },
            },
          });
        return route.fulfill({
          json: route.request().url().includes("/publication")
            ? { published: false }
            : { items: [] },
        });
      });
      fixtureAccountId = "inline-original-account";
      await page.goto(`${base}/test/inline-return`);
      await page.locator("[data-inline-access]").waitFor({ state: "visible" });
      await page
        .getByText("Choose a round or start a labeled sandbox.", {
          exact: true,
        })
        .waitFor();
      const argument = page.locator("[data-inline-argument]");
      await argument.fill("Keep only for its verified original account.");
      await argument.evaluate((node) =>
        node.scrollIntoView({ block: "center" }),
      );
      await capture(page, `inline-draft-original-${name}.png`, false);
      let inlineIdentityGate = deferred(),
        inlineIdentityStarted = deferred(),
        holdInlineIdentity = false;
      await page.route("**/api/auth/me", async (route) => {
        if (holdInlineIdentity) {
          inlineIdentityStarted.release();
          await inlineIdentityGate.promise;
        }
        return route.fallback();
      });
      const refreshInlineIdentity = async (nextAccount: string) => {
        inlineIdentityGate = deferred();
        inlineIdentityStarted = deferred();
        holdInlineIdentity = true;
        fixtureAccountId = nextAccount;
        await page.evaluate(() =>
          window.dispatchEvent(new Event("yap:account-changed")),
        );
        await inlineIdentityStarted.promise;
        assert.equal(
          await argument.inputValue(),
          "",
          "private argument detaches before identity verification",
        );
        assert.equal(
          await page.locator("[data-inline-access]").isVisible(),
          false,
        );
        holdInlineIdentity = false;
        inlineIdentityGate.release();
        await page
          .getByText("Choose a round or start a labeled sandbox.", {
            exact: true,
          })
          .waitFor();
      };
      await refreshInlineIdentity("inline-original-account");
      assert.equal(
        await argument.inputValue(),
        "Keep only for its verified original account.",
      );
      await refreshInlineIdentity("inline-replacement-account");
      assert.equal(
        await argument.inputValue(),
        "",
        "another verified account never receives the previous actor's argument",
      );
      await argument.evaluate((node) =>
        node.scrollIntoView({ block: "center" }),
      );
      await capture(page, `inline-draft-replacement-${name}.png`, false);
      await argument.fill("Replacement actor's independent draft.");
      await refreshInlineIdentity("inline-replacement-account");
      assert.equal(
        await argument.inputValue(),
        "Replacement actor's independent draft.",
      );
      assert.equal(inlineWrites, 0);
      checks.push(
        `${name}: inline A4 immediately detaches an argument during identity inspection, restores it only to the same verified actor, clears it for a replacement account, and performs no automatic mutation`,
      );

      let ordinaryExchanges = 0;
      const recoveryTelemetry: string[] = [];
      await page.route("**/api/auth/privy/exchange", (route) => {
        ordinaryExchanges++;
        return route.fulfill({
          status: 500,
          json: { error: "unexpected ordinary exchange" },
        });
      });
      await page.route("**/api/auth/journey", (route) => {
        const body: { event: string; seconds?: number } = route
          .request()
          .postDataJSON();
        assert.ok(
          Object.keys(body).every(
            (key) => key === "event" || key === "seconds",
          ),
        );
        assert.ok(typeof body.event === "string" && body.event.length < 40);
        if (body.seconds !== undefined)
          assert.ok(
            Number.isFinite(body.seconds) &&
              body.seconds >= 0 &&
              body.seconds <= 600,
          );
        if (body.event.startsWith("recovery_"))
          recoveryTelemetry.push(body.event);
        return route.fulfill({ status: 204 });
      });
      await page.goto(`${base}/account`);
      await page.getByText("Account ready.", { exact: true }).waitFor();
      // Legacy recovery remains a guarded internal event for retained keys;
      // current account UI exposes only the Privy passkey setup flow.
      await page.evaluate(() =>
        window.dispatchEvent(new Event("yap:recover-provider")),
      );
      await authModal
        .getByRole("heading", { name: "Recover your sign-in.", exact: true })
        .waitFor();
      const recoveryRaw = await page.evaluate(() =>
        localStorage.getItem("yaparena-provider-recovery"),
      );
      assert.ok(recoveryRaw);
      const recovery: {
        id: string;
        accountId: string;
        expiresAt: number;
        status: string;
      } = JSON.parse(recoveryRaw);
      assert.deepEqual(Object.keys(recovery).sort(), [
        "accountId",
        "expiresAt",
        "id",
        "status",
      ]);
      assert.equal(recovery.accountId, fixtureAccountId);
      assert.equal(recovery.status, "pending");
      assert.equal(
        await authModal
          .getByRole("button", { name: "Continue with Google", exact: true })
          .count(),
        0,
      );
      const recoverySends = sends;
      await authModal
        .getByLabel("Email address", { exact: true })
        .fill("new-recovery@example.invalid");
      await authModal
        .getByRole("button", { name: "Continue with email", exact: false })
        .click();
      await authModal
        .getByLabel("Verification code", { exact: true })
        .waitFor();
      assert.equal(sends, recoverySends + 1);
      const recoveryVerifications = verifications;
      await authModal
        .getByLabel("Verification code", { exact: true })
        .fill("654321");
      await authModal
        .getByRole("button", { name: "Verify and continue", exact: false })
        .click();
      await page.waitForFunction(
        () =>
          !document.querySelector<HTMLButtonElement>(
            '#email-auth button[type="submit"]',
          )?.disabled,
      );
      assert.equal(verifications, recoveryVerifications + 1);
      assert.equal(ordinaryExchanges, 0);
      assert.equal(
        await page.evaluate(() =>
          localStorage.getItem("yaparena-provider-recovery"),
        ),
        recoveryRaw,
      );
      await page.reload();
      await page.getByText("Account ready.", { exact: true }).waitFor();
      assert.equal(
        await page.evaluate(() =>
          localStorage.getItem("yaparena-provider-recovery"),
        ),
        recoveryRaw,
      );
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent("yap:request-auth", { detail: { mode: "login" } }),
        ),
      );
      await authModal
        .getByRole("heading", { name: "Recover your sign-in.", exact: true })
        .waitFor();
      checks.push(
        `${name}: installed SDK starts retained-key recovery with a private expiring comparison marker, sends a new-email OTP only through the SDK, retains recovery across refresh and does not ordinarily exchange an invalid candidate`,
      );

      const markerTab = await context.newPage();
      await markerTab.goto(`${base}/test/header-only`);
      await markerTab.evaluate(
        (value) =>
          localStorage.setItem(
            "yaparena-provider-recovery",
            JSON.stringify({ ...value, status: "cancelled" }),
          ),
        recovery,
      );
      await authModal
        .getByRole("heading", { name: "Recovery cancelled.", exact: true })
        .waitFor();
      await authModal
        .getByRole("button", {
          name: "Start ordinary email sign-in",
          exact: false,
        })
        .waitFor();
      await markerTab.evaluate(
        (value) =>
          localStorage.setItem(
            "yaparena-provider-recovery",
            JSON.stringify({ ...value, expiresAt: Date.now() - 1 }),
          ),
        recovery,
      );
      await authModal
        .getByRole("heading", { name: "Recover your sign-in.", exact: true })
        .waitFor();
      await authModal
        .getByLabel("Email address", { exact: true })
        .fill("expired-recovery@example.invalid");
      await authModal
        .getByRole("button", { name: "Continue with email", exact: false })
        .click();
      await authModal
        .getByText(
          "Recovery expired or its browser state is unavailable. Cancel recovery first, or restart it from the correct account settings. No new account was created.",
          { exact: true },
        )
        .waitFor();
      assert.equal(sends, recoverySends + 1);
      assert.equal(ordinaryExchanges, 0);
      await authModal
        .getByRole("button", { name: "Cancel recovery", exact: true })
        .click();
      await authModal
        .getByRole("heading", { name: "Recovery cancelled.", exact: true })
        .waitFor();
      await authModal
        .getByRole("button", {
          name: "Start ordinary email sign-in",
          exact: false,
        })
        .waitFor();
      const cancelledRaw = await page.evaluate(() =>
        localStorage.getItem("yaparena-provider-recovery"),
      );
      assert.ok(cancelledRaw);
      const cancelled: { status: string } = JSON.parse(cancelledRaw);
      assert.equal(cancelled.status, "cancelled");
      assert.equal(sends, recoverySends + 1);
      await authModal
        .getByLabel("Email address", { exact: true })
        .fill("ordinary-restart@example.invalid");
      await authModal
        .getByRole("button", {
          name: "Start ordinary email sign-in",
          exact: false,
        })
        .click();
      await authModal
        .getByLabel("Verification code", { exact: true })
        .waitFor();
      assert.equal(sends, recoverySends + 2);
      assert.equal(
        await page.evaluate(() =>
          localStorage.getItem("yaparena-provider-recovery"),
        ),
        null,
      );
      assert.equal(ordinaryExchanges, 0);
      await markerTab.close();
      assert.ok(recoveryTelemetry.includes("recovery_started"));
      assert.ok(recoveryTelemetry.includes("recovery_cancelled"));
      assert.equal(recoveryTelemetry.includes("recovery_completed"), false);
      checks.push(
        `${name}: a cooperating tab changes the recovery marker, expired recovery blocks new OTPs with an actionable notice, cancellation retains its fence and shows the explicit ordinary-restart action; telemetry contains bounded outcomes only`,
      );
      await page.goto(`${base}/account`);
      await page.getByText("Account ready.", { exact: true }).waitFor();
      const settingsOpener = page.getByRole("button", {
        name: "Refresh active sessions",
        exact: true,
      });
      await settingsOpener.focus();
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent("yap:request-auth", { detail: { mode: "login" } }),
        ),
      );
      await authModal.waitFor({ state: "visible" });
      await page.evaluate(async () => {
        const url = "/assets/auth-return.js",
          helper: { completeAuthReturn(value: string | null): boolean } =
            await import(url);
        helper.completeAuthReturn(null);
      });
      await authModal.waitFor({ state: "hidden" });
      assert.equal(
        await settingsOpener.evaluate(
          (node) => document.activeElement === node,
        ),
        true,
      );
      checks.push(
        `${name}: settings completion without a return URL restores its in-memory opener without navigation`,
      );

      await page.addInitScript(() => {
        const mode = new URL(location.href).searchParams.get("storage-denied");
        if (mode !== "read" && mode !== "write") return;
        const get = Storage.prototype.getItem,
          set = Storage.prototype.setItem;
        Object.defineProperty(Storage.prototype, "getItem", {
          configurable: true,
          value: function (this: Storage, key: string) {
            if (
              this === localStorage &&
              key.startsWith("yaparena-provider-recovery") &&
              mode === "read"
            )
              throw new DOMException(
                "Synthetic storage read denied",
                "SecurityError",
              );
            return get.call(this, key);
          },
        });
        Object.defineProperty(Storage.prototype, "setItem", {
          configurable: true,
          value: function (this: Storage, key: string, value: string) {
            if (
              this === localStorage &&
              key.startsWith("yaparena-provider-recovery") &&
              mode === "write"
            )
              throw new DOMException(
                "Synthetic storage write denied",
                "QuotaExceededError",
              );
            return set.call(this, key, value);
          },
        });
      });
      for (const denial of ["read", "write"] as const) {
        await page.goto(`${base}/account?storage-denied=${denial}`);
        await page.getByText("Account ready.", { exact: true }).waitFor();
        await page.waitForFunction(
          () =>
            Boolean(window.yapCurrentSessionAccount?.()) &&
            document.querySelector<HTMLButtonElement>(
              '#email-auth button[type="submit"]',
            )?.disabled === false,
        );
        await page.evaluate(() =>
          window.dispatchEvent(new Event("yap:recover-provider")),
        );
        await authModal.waitFor({ state: "visible" });
        await authModal
          .getByText(
            "Browser storage is required to safely recover sign-in. Allow storage, then try again. No account was changed.",
            { exact: true },
          )
          .waitFor()
          .catch(async (error: unknown) => {
            await capture(page, `storage-${denial}-failure-${name}.png`, true);
            await writeFile(
              resolve(directory, `storage-${denial}-failure-${name}.json`),
              JSON.stringify(
                {
                  phase: `legacy internal recovery storage ${denial}`,
                  notices: await authModal
                    .locator('[role="status"]')
                    .allTextContents(),
                  comparisonReady: await page.evaluate(() =>
                    Boolean(window.yapCurrentSessionAccount?.()),
                  ),
                },
                null,
                2,
              ) + "\n",
            );
            throw error;
          });
        const beforeDeniedSend: number = sends;
        await authModal
          .getByLabel("Email address", { exact: true })
          .fill("storage-denied@example.invalid");
        await authModal
          .getByRole("button", { name: "Continue with email", exact: false })
          .click();
        await authModal
          .getByText(
            "Browser storage is required to safely finish sign-in. Allow storage, then restart sign-in. Sign-in is paused and no new YapArena account was created.",
            { exact: true },
          )
          .waitFor();
        assert.equal(sends, beforeDeniedSend);
        assert.equal(ordinaryExchanges, 0);
        await page.reload();
        await page.getByText("Account ready.", { exact: true }).waitFor();
        await page.evaluate(() =>
          window.dispatchEvent(
            new CustomEvent("yap:request-auth", { detail: { mode: "login" } }),
          ),
        );
        await authModal.waitFor({ state: "visible" });
        await authModal
          .getByLabel("Email address", { exact: true })
          .fill("still-denied@example.invalid");
        await authModal
          .getByRole("button", { name: "Continue with email", exact: false })
          .click();
        await authModal
          .getByText(
            "Browser storage is required to safely finish sign-in. Allow storage, then restart sign-in. Sign-in is paused and no new YapArena account was created.",
            { exact: true },
          )
          .waitFor();
        assert.equal(sends, beforeDeniedSend);
        assert.equal(ordinaryExchanges, 0);
      }
      checks.push(
        `${name}: denied shared-marker reads and writes fail closed before OTP/exchange with actionable notices, including failed recovery start followed by refresh and an ordinary-send attempt`,
      );
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(directory, "browser-results.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        revision,
        phase,
        assetHashes,
        sourceHashes,
        checks,
        errors,
        requirementFailures,
        scope:
          "Local SSR fixture and installed Privy SDK; public provider metadata fetched live with CAPTCHA explicitly disabled in the fixture response only. OTP/passkey provider endpoints and application responses are synthetic. Real Chromium virtual-authenticator ceremonies exercise native passkey creation/assertion; real PostgreSQL acceptance is recorded separately. No real CAPTCHA validation, email delivery, genuine provider login/link, hosted session, physical device or complete WCAG conformance evidence.",
      },
      null,
      2,
    ) + "\n",
  );
  assert.deepEqual(requirementFailures, []);
  console.log(JSON.stringify({ result: "PASS", checks, evidence: directory }));
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise<void>((done, fail) =>
    server.close((error) => (error ? fail(error) : done())),
  );
}
