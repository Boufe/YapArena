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
import { renderAccount, renderAbout } from "../dist/features/discovery/web.js";
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
  "account-auth.bundle.js",
  "account-security.bundle.js",
  "account-session-list.js",
  "account-sessions.js",
  "account.js",
  "site-header.js",
  "site.js",
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
try {
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 1000 }],
    ["mobile", { width: 390, height: 844 }],
  ] as const) {
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
      route.fulfill({ json: { sessions: managedSessions, hasMore: false } }),
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
      await sessionRemovalStarted.promise;
      assert.deepEqual(sessionRemovals, ["101", "100", "201"]);
      const staleResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "DELETE" &&
          new URL(response.url()).pathname === "/api/auth/sessions/100",
      );
      previousRemovalGate.release();
      await staleResponse;
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
        `${name}: session list removes only the selected session, permits a replacement account's removal while the old DELETE is held and keeps that newer removal busy when the old response arrives, without signing out the replacement account`,
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
      await page.route("**/api/auth/security/passkeys/enrollment", (route) =>
        route.fulfill({
          json: {
            id: "fixture-enrollment",
            bootstrapAllowed: false,
            // The cancelled fixture never invokes native registration.
            options: {},
          },
        }),
      );
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
      const addSecurityKey = page.getByRole("button", {
          name: "Add security passkey",
          exact: true,
        }),
        securityApproval = page.getByRole("dialog", {
          name: "Add security passkey",
          exact: true,
        });
      await addSecurityKey.click();
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
      await addSecurityKey.click();
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
    await page.route(
      "**/assets/account-auth.bundle.js*",
      (route) => route.abort("failed"),
      { times: 1 },
    );
    await page.getByRole("link", { name: "Log in", exact: true }).click();
    await authModal
      .getByText(
        "Sign-in could not load. Check your connection, then close and reopen this window to retry.",
        {
          exact: true,
        },
      )
      .waitFor();
    assert.equal(await authModal.getByRole("status").count(), 1);
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
      `${name}: interrupted provider-bundle download is announced and close/reopen retries the real installed SDK successfully`,
    );
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
          "Local SSR fixture and installed Privy SDK; public provider metadata fetched live with CAPTCHA explicitly disabled in the fixture response only; OTP endpoints intercepted. No real CAPTCHA validation, email delivery, successful provider login, hosted session, physical device or complete WCAG conformance evidence.",
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
