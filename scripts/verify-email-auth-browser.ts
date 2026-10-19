import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import express from "express";
import helmet from "helmet";
import { chromium } from "playwright-core";
import axe from "axe-core";
import { renderAccount } from "../dist/features/discovery/web.js";
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
await mkdir(directory, { recursive: true });
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use("/account", createEmailAuthSecurity("test"));
app.get("/test/axe.js", (_request, response) =>
  response.type("js").send(axe.source),
);
app.use("/assets", express.static(resolve("public")));
app.get("/account", (request, response) =>
  response.send(
    renderAccount(base, request.query.baseline !== "1").replace(
      "</head>",
      '<script defer src="/test/axe.js"></script></head>',
    ),
  ),
);
app.get("/test/debate", (_request, response) =>
  response.send(`<!doctype html><html lang="en" data-email-first><head><title>Auth return fixture</title><link rel="stylesheet" href="/assets/site.css"><link rel="stylesheet" href="/assets/arena.css"><script defer src="/test/axe.js"></script></head><body>
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
      if (window === window.top)
        localStorage.setItem("yaparena-measurement-declined", "1");
    });
    const page = await context.newPage();
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
    await page.route(
      (url) => url.pathname === `/api/v1/apps/${appId}`,
      async (route) => {
        captchaFixtures++;
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
      await route.fulfill({ json: { success: true } });
    });
    await page.route("**/api/v1/passwordless/authenticate", async (route) => {
      verifications++;
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
    await page.screenshot({
      path: resolve(directory, `before-${name}.png`),
      fullPage: true,
    });
    await page.goto(
      `${base}/account?next=%2Fdebates%2Ffixture%3Fround%3D1%23commit`,
    );
    const button = page.getByRole("button", { name: "Continue with email" });
    try {
      await button.waitFor();
    } catch {
      await page.screenshot({
        path: resolve(directory, "initialization-failure.png"),
        fullPage: true,
      });
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
    await page.screenshot({
      path: resolve(directory, `after-${name}.png`),
      fullPage: true,
    });
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
    await button.press("Enter");
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
    await code.fill("123456");
    await page.getByRole("button", { name: "Verify and continue" }).click();
    await page
      .getByText("That code is incorrect, expired or already used.", {
        exact: false,
      })
      .waitFor();
    assert.equal(verifications, 1);
    await page.screenshot({
      path: resolve(directory, `code-error-${name}.png`),
      fullPage: true,
    });
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
    await walletToggle.press("Enter");
    await page
      .getByText("Available for withdrawal: 1250 YC", { exact: true })
      .first()
      .waitFor();
    const walletPanel = page.locator(".arena-wallet-popover");
    assert.deepEqual(
      await walletPanel
        .locator("progress")
        .evaluateAll((elements) =>
          elements.map((element) => (element as HTMLProgressElement).value),
        ),
      [40, 0, 100],
    );
    await page.screenshot({
      path: resolve(directory, `wallet-progress-${name}.png`),
      fullPage: true,
    });
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
    await page.screenshot({
      path: resolve(directory, `balance-dialog-${name}.png`),
      fullPage: true,
    });
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
    let appSignedIn = true;
    await page.route("**/api/auth/me", (route) =>
      route.fulfill(
        appSignedIn
          ? { json: { user: { id: "fixture", email: null } } }
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
    await page.goto(`${base}/account`);
    await page.getByText("Account ready.", { exact: true }).waitFor();
    await page
      .locator("#provider-settings")
      .getByText("Email", { exact: true })
      .waitFor();
    await page.screenshot({
      path: resolve(directory, `account-signed-in-${name}.png`),
      fullPage: true,
    });
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
    await page.route("**/api/auth/logout-all", (route) => {
      appSignedIn = false;
      return route.fulfill({ status: 204 });
    });
    page.once("dialog", (confirmation) => void confirmation.accept());
    await page.locator("#sign-out-all").click();
    await page.locator("#signed-out").waitFor({ state: "visible" });
    assert.equal(await page.locator("#signed-in").isVisible(), false);
    checks.push(
      `${name}: server-owned authentication methods, profile create/publish with permanent handle, other/all-session sign-out controls, account/dialog automated WCAG tags and no account overflow`,
    );
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(directory, "browser-results.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        checks,
        errors,
        scope:
          "Local SSR fixture and installed Privy SDK; public provider metadata fetched live with CAPTCHA explicitly disabled in the fixture response only; OTP endpoints intercepted. No real CAPTCHA validation, email delivery, successful provider login, hosted session, physical device or complete WCAG conformance evidence.",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ result: "PASS", checks, evidence: directory }));
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise<void>((done, fail) =>
    server.close((error) => (error ? fail(error) : done())),
  );
}
