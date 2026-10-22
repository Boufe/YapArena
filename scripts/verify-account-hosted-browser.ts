import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

// Guest-only acceptance against the named staging deployment. No OTP is sent,
// no provider result is intercepted, and no account or financial action runs.
const origin = "https://yaparena-staging-web.onrender.com";
const appId = "cmvfjb3r800vy0hl3heg2cuvv";
const expectedRevision = process.env.ACCOUNT_HOSTED_EXPECTED_REVISION;
assert.match(expectedRevision ?? "", /^[a-f0-9]{40}$/);
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
assert.equal(
  expectedRevision,
  revision,
  "run from the exact revision selected for staging acceptance",
);
const probeRedis = process.env.ACCOUNT_HOSTED_REDIS_PROBE === "approved";
const metricsHeaders: Record<string, string> = process.env.METRICS_TOKEN
  ? { Authorization: `Bearer ${process.env.METRICS_TOKEN}` }
  : {};
assert.ok(
  process.env.ACCOUNT_HOSTED_REDIS_PROBE === undefined || probeRedis,
  "Redis probe accepts only the explicit approved value",
);
const directory = resolve(
  "docs/evidence/account-completion-baseline/account-hosted-browser",
);
const checks: string[] = [];
const failures: string[] = [];
const assetHashes: Record<string, string> = {};
const sourceHashes: Record<string, string> = {};
let stage = "validate served assets";
const sha = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
const assets = [
  "session-coordination.js",
  "auth-return.js",
  "site-header.js",
  "site.js",
  "account.js",
  "account-session-list.js",
  "account-sessions.js",
  "account-auth.bundle.js",
  "account-security.bundle.js",
  "account-coins.js",
  "account-auth.css",
  "site-header.css",
  "site.css",
  "arena.css",
];
const startedAt = Date.now();
const deadline = startedAt + 150_000;
function remaining(maximum = 15_000) {
  const duration = Math.min(maximum, deadline - Date.now());
  assert.ok(duration > 0, "hosted acceptance deadline reached");
  return duration;
}
async function request(path: string, init: RequestInit = {}) {
  assert.ok(path.startsWith("/") && !path.startsWith("//"));
  const response = await fetch(origin + path, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(remaining()),
  });
  return response;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(isObject(value));
  return value;
}
function noStore(response: Response) {
  assert.match(response.headers.get("cache-control") ?? "", /\bno-store\b/);
}
function guestCookies(response: Response, allowMediaGuard: boolean) {
  const cookies = response.headers.getSetCookie();
  if (!allowMediaGuard) {
    assert.equal(cookies.length, 0, "private guest route issues no cookies");
    return;
  }
  assert.ok(cookies.length <= 1, "at most the media-admission guard is issued");
  for (const cookie of cookies) {
    const [pair, ...attributes] = cookie.split(";").map((part) => part.trim());
    assert.match(
      pair ?? "",
      /^yap_media_guard=[a-f0-9]{32}\.\d{13}\.[A-Za-z0-9_-]{43}$/,
      "only the non-authentication media-admission guard is issued",
    );
    assert.ok(attributes.includes("Secure"));
    assert.ok(attributes.includes("HttpOnly"));
    assert.ok(attributes.includes("SameSite=Strict"));
    assert.ok(attributes.includes("Path=/"));
    assert.equal(
      attributes.some((part) => /^Domain=/i.test(part)),
      false,
    );
    const lifetime = attributes.find((part) => /^Max-Age=/i.test(part));
    assert.match(lifetime ?? "", /^Max-Age=\d+$/);
    const seconds = Number(lifetime?.slice("Max-Age=".length));
    assert.ok(seconds > 0 && seconds <= 900);
  }
}
type RedisMetrics = { ok: number; observations: number; seconds: number };
function redisMetrics(body: string): RedisMetrics {
  function value(pattern: RegExp) {
    const match = pattern.exec(body);
    assert.ok(match, "required aggregate Redis metric is present");
    const result = Number(match[1]);
    assert.ok(Number.isFinite(result) && result >= 0);
    return result;
  }
  assert.match(body, /^# TYPE yaparena_redis_security_total counter$/m);
  return {
    ok: /^yaparena_redis_security_total\{outcome="ok"\} /m.test(body)
      ? value(/^yaparena_redis_security_total\{outcome="ok"\} ([0-9.eE+-]+)$/m)
      : 0,
    observations: value(
      /^yaparena_redis_security_seconds_count ([0-9.eE+-]+)$/m,
    ),
    seconds: value(/^yaparena_redis_security_seconds_sum ([0-9.eE+-]+)$/m),
  };
}
let redisObservation: {
  before: RedisMetrics;
  after: RedisMetrics;
  minimumAdditionalSuccessfulOperations: number;
} | null = null;
let providerMetadata: Record<string, boolean | string> | null = null;
const accountResponses: {
  viewport: string;
  status: number;
  origin: string;
  pathname: string;
  fromServiceWorker: boolean;
  redirects: { status: number | null; origin: string; pathname: string }[];
}[] = [];
const navigationFailures: {
  viewport: string;
  origin: string;
  pathname: string;
  aborted: boolean;
  timedOut: boolean;
}[] = [];
const completedHistoryBarriers: string[] = [];
const browser = await chromium.launch({
  executablePath:
    process.env.BROWSER_CHROME_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--autoplay-policy=user-gesture-required"],
});
const timer = setTimeout(() => void browser.close(), remaining(150_000));
try {
  await mkdir(directory, { recursive: true });
  for (const file of [
    "scripts/verify-account-hosted-browser.ts",
    "src/platform/auth/router.ts",
    "src/platform/shared-abuse.ts",
    "src/platform/auth/browser-security.ts",
    "src/platform/viewer-admission.ts",
    "frontend/site-header.ts",
    "dist/platform/auth/router.js",
    "dist/platform/shared-abuse.js",
  ])
    sourceHashes[file] = sha(await readFile(file));
  for (const file of assets) {
    const local = sha(await readFile(resolve("public", file)));
    const response = await request(`/assets/${file}`);
    assert.equal(response.status, 200, `hosted asset status: ${file}`);
    const hosted = sha(Buffer.from(await response.arrayBuffer()));
    assert.equal(hosted, local, `hosted bytes match local build: ${file}`);
    assetHashes[file] = local;
  }
  checks.push(
    "all fourteen hosted authentication/header/security assets match the selected local build",
  );

  stage = "public health and database readiness";
  const health = await request("/health");
  assert.equal(health.status, 200);
  assert.equal(object(await health.json()).status, "ok");
  const ready = await request("/ready");
  assert.equal(ready.status, 200);
  assert.equal(object(await ready.json()).status, "ready");
  checks.push("public health and PostgreSQL-backed readiness return 200");

  stage = "public application and genuine provider configuration";
  const configuration = await request("/api/auth/provider");
  assert.equal(configuration.status, 200);
  noStore(configuration);
  const settings = object(await configuration.json());
  assert.equal(settings.enabled, true);
  assert.equal(settings.appId, appId);
  assert.equal(settings.google, true);
  assert.equal(settings.passkeys, true);
  const provider = await fetch(`https://auth.privy.io/api/v1/apps/${appId}`, {
    headers: { "privy-app-id": appId },
    redirect: "error",
    signal: AbortSignal.timeout(remaining()),
  });
  assert.equal(provider.status, 200);
  const metadata = object(await provider.json());
  assert.equal(metadata.id, appId);
  assert.equal(metadata.data_classification, "public");
  for (const field of ["email_auth", "google_oauth", "passkey_auth"])
    assert.equal(metadata[field], true);
  assert.equal(metadata.merge_accounts_by_email, false);
  const embedded = object(metadata.embedded_wallet_config);
  assert.equal(embedded.create_on_login, "off");
  assert.equal(object(embedded.ethereum).create_on_login, "off");
  assert.equal(object(embedded.solana).create_on_login, "off");
  providerMetadata = {
    appId,
    email: true,
    google: true,
    passkeys: true,
    automaticEthereumWallet: false,
    automaticSolanaWallet: false,
    mergeAccountsByEmail: false,
  };
  checks.push(
    "real public provider metadata and app flags agree; email/Google/passkeys enabled and merging/automatic wallets off",
  );

  stage = "anonymous protected-route responses";
  for (const path of [
    "/api/auth/me",
    "/api/auth/sessions",
    "/api/auth/security/passkeys",
    "/api/auth/methods",
    "/api/coin-sandbox/summary",
  ]) {
    const response = await request(path);
    assert.equal(response.status, 401, `anonymous protected route: ${path}`);
    noStore(response);
    guestCookies(response, path === "/api/auth/me");
  }
  checks.push(
    "five private routes deny a fresh guest with 401/no-store and issue no application cookie",
  );

  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 1000 }],
    ["mobile", { width: 390, height: 844 }],
  ] as const) {
    stage = `${name} genuine guest browser`;
    const context = await browser.newContext({ viewport, permissions: [] });
    context.setDefaultTimeout(15_000);
    context.setDefaultNavigationTimeout(20_000);
    const page = await context.newPage();
    let pageErrors = 0;
    let unexpectedMutations = 0;
    let mediaJoins = 0;
    page.on("pageerror", () => pageErrors++);
    page.on("request", (entry) => {
      const url = new URL(entry.url());
      if (
        url.origin === origin &&
        !["GET", "HEAD", "OPTIONS"].includes(entry.method()) &&
        !["/api/measurement/discovery", "/api/auth/journey"].includes(
          url.pathname,
        )
      )
        unexpectedMutations++;
      if (
        url.origin === origin &&
        /^\/api\/media\/.+(?:token|join|speaker)/.test(url.pathname)
      )
        mediaJoins++;
    });
    const home = await page.goto(origin + "/", {
      waitUntil: "domcontentloaded",
    });
    stage = `${name} homepage HTTP and CSP`;
    assert.equal(home?.status(), 200);
    const csp = home?.headers()["content-security-policy"] ?? "";
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /connect-src[^;]*https:\/\/auth\.privy\.io/);
    assert.match(csp, /script-src[^;]*'self'/);
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-eval'/);
    const guest = page.locator("[data-header-guest]");
    stage = `${name} signed-out header`;
    await guest.waitFor({ state: "visible" });
    assert.equal(await page.locator("[data-header-member]").isVisible(), false);
    await page.screenshot({ path: resolve(directory, `home-${name}.png`) });
    await guest.locator("[data-auth-open=login]").click();
    stage = `${name} login popup rendering`;
    const dialog = page.locator("#site-auth-dialog");
    await dialog
      .getByRole("heading", { name: "Welcome back.", exact: true })
      .waitFor();
    await dialog
      .getByRole("button", { name: "Continue with email →", exact: true })
      .waitFor({ state: "visible" });
    stage = `${name} genuine provider initialization and email focus`;
    await page.waitForFunction(
      () => {
        const submit = document.querySelector<HTMLButtonElement>(
          "#site-auth-dialog button[type=submit]",
        );
        return (
          submit?.disabled === false &&
          document.activeElement?.id === "auth-email"
        );
      },
      undefined,
      { timeout: remaining() },
    );
    stage = `${name} optional login controls and empty email`;
    assert.equal(
      await dialog
        .getByRole("button", { name: "Continue with Google", exact: true })
        .isEnabled(),
      true,
    );
    assert.equal(
      await dialog
        .getByRole("button", { name: "Use a passkey", exact: true })
        .isEnabled(),
      true,
    );
    assert.equal(
      await dialog.getByLabel("Email address", { exact: true }).inputValue(),
      "",
    );
    await page.screenshot({ path: resolve(directory, `login-${name}.png`) });
    stage = `${name} Escape closes popup and restores focus`;
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    stage = `${name} Escape history traversal completion`;
    await page.waitForFunction(
      () => {
        const state: unknown = history.state;
        return !(
          state &&
          typeof state === "object" &&
          "yapAuthDialog" in state
        );
      },
      undefined,
      { timeout: remaining() },
    );
    completedHistoryBarriers.push(name);
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("data-auth-open") === "login",
    );
    stage = `${name} public account page HTTP`;
    const account = await page
      .goto(origin + "/account", { waitUntil: "domcontentloaded" })
      .catch((cause: unknown) => {
        const url = new URL(page.url());
        navigationFailures.push({
          viewport: name,
          origin: url.origin,
          pathname: url.pathname,
          aborted:
            cause instanceof Error && /net::ERR_ABORTED/.test(cause.message),
          timedOut: cause instanceof Error && cause.name === "TimeoutError",
        });
        throw cause;
      });
    if (account) {
      const url = new URL(account.url());
      const redirects: {
        status: number | null;
        origin: string;
        pathname: string;
      }[] = [];
      let previous = account.request().redirectedFrom();
      while (previous && redirects.length < 10) {
        const response = await previous.response();
        const redirectedUrl = new URL(previous.url());
        redirects.push({
          status: response?.status() ?? null,
          origin: redirectedUrl.origin,
          pathname: redirectedUrl.pathname,
        });
        previous = previous.redirectedFrom();
      }
      accountResponses.push({
        viewport: name,
        status: account.status(),
        origin: url.origin,
        pathname: url.pathname,
        fromServiceWorker: account.fromServiceWorker(),
        redirects,
      });
    }
    assert.equal(account?.status(), 200);
    stage = `${name} public account email form`;
    await page
      .locator("#email-auth")
      .getByLabel("Email address", { exact: true })
      .waitFor();
    stage = `${name} account provider initialization`;
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLButtonElement>(
          "#email-auth button[type=submit]",
        )?.disabled === false,
      undefined,
      { timeout: remaining() },
    );
    stage = `${name} account privacy and viewport layout`;
    assert.equal(await page.locator("#signed-in").isVisible(), false);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    );
    assert.equal(overflow, false, "guest account fits viewport");
    await page.screenshot({
      path: resolve(directory, `account-${name}.png`),
      fullPage: true,
    });
    stage = `${name} page exception and mutation counters`;
    assert.equal(pageErrors, 0, "no uncaught page exceptions");
    assert.equal(
      unexpectedMutations,
      0,
      "guest inspection sends no account mutation",
    );
    assert.equal(
      mediaJoins,
      0,
      "guest inspection does not request a media join",
    );
    await context.close();
    checks.push(
      `${name}: real SDK ready, guest header, empty login popup, Google/passkey availability, Escape focus, private account hidden, layout/CSP and no account mutation/media join`,
    );
  }

  if (probeRedis) {
    stage = "guarded retired-register Redis probe";
    const router = await readFile("src/platform/auth/router.ts", "utf8");
    assert.match(
      router,
      /router\.post\("\/register", authLimiter,[\s\S]*?if \(provider\)[\s\S]*?response\.status\(410\)\.json\(\{ error: "use verified email signup" \}\)/,
    );
    const limiter = await readFile("src/platform/shared-abuse.ts", "utf8");
    assert.match(limiter, /client\.info\("memory"\)/);
    assert.match(limiter, /maxmemory_policy:noeviction/);
    const beforeResponse = await request("/metrics", {
      headers: metricsHeaders,
    });
    assert.equal(beforeResponse.status, 200);
    const before = redisMetrics(await beforeResponse.text());
    const response = await request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: "{}",
    });
    assert.equal(response.status, 410);
    assert.equal(response.headers.has("set-cookie"), false);
    assert.equal(
      object(await response.json()).error,
      "use verified email signup",
    );
    noStore(response);
    const afterResponse = await request("/metrics", {
      headers: metricsHeaders,
    });
    assert.equal(afterResponse.status, 200);
    const after = redisMetrics(await afterResponse.text());
    assert.ok(after.ok >= before.ok + 1);
    assert.ok(after.observations >= before.observations + 1);
    assert.ok(after.seconds >= before.seconds);
    redisObservation = {
      before,
      after,
      minimumAdditionalSuccessfulOperations: 1,
    };
    checks.push(
      "guarded retired-register request returned 410 without identity/cookie and increased successful Redis operation/latency aggregates",
    );
  }
} catch {
  // Raw browser/provider exceptions can contain URLs, query parameters or data.
  failures.push(
    `hosted guest acceptance failed during ${stage}; no raw provider/browser error was recorded`,
  );
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await browser.close();
  const evidence = {
    observedAt: new Date().toISOString(),
    passed: failures.length === 0,
    origin,
    expectedRevision,
    localRevision: revision,
    revisionEvidence:
      "Expected operator-selected revision plus exact served asset hashes; this does not independently attest server commit identity.",
    elapsedMs: Date.now() - startedAt,
    checks,
    failures,
    sourceHashes,
    assetHashes,
    providerMetadata,
    redisObservation,
    accountResponses,
    navigationFailures,
    completedHistoryBarriers,
    limitations: [
      "Guest browser only; no OTP, OAuth or provider-passkey ceremony, account creation, signed-in financial action or identity mutation.",
      "Headless emulated viewports; no physical device, screen-reader or full WCAG conformance claim.",
      "Redis probe is behavioral code-enforced noeviction/Lua evidence; it is not raw hosted INFO, a hosted outage drill or a multi-instance topology test.",
    ],
  };
  await mkdir(directory, { recursive: true });
  const destination = resolve(directory, "acceptance.json");
  await writeFile(
    destination + ".tmp",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  await rename(destination + ".tmp", destination);
  console.log(
    `${evidence.passed ? "PASS" : "FAIL"} hosted guest acceptance: ${checks.length} groups; no credentials or provider error text printed`,
  );
}
