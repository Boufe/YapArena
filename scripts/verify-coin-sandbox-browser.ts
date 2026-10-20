import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";
import cookieParser from "cookie-parser";
import express from "express";
import pg from "pg";
import { runner } from "node-pg-migrate";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";
import axe from "axe-core";
import type {} from "pino-http";
import { provisionDatabase } from "./provision-database.ts";
import { createAccountSecurityRouter } from "../dist/platform/auth/security-router.js";
import { createSecurityPasskeyRepository } from "../dist/platform/auth/security-passkeys.js";
import { createAccountOperationRepository } from "../dist/platform/auth/account-operations.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import {
  createSessionToken,
  hashSessionToken,
} from "../dist/platform/auth/session-tokens.js";
import { createRequireAuthentication } from "../dist/platform/auth/router.js";
import { hashPassword } from "../dist/platform/auth/passwords.js";
import {
  createCoinSandboxRepository,
  createCoinSandboxOperatorRepository,
} from "../dist/features/account-wallet/sandbox-repository.js";
import { createCoinDebateSandbox } from "../dist/features/account-wallet/debate-sandbox.js";
import { createCoinSandboxRouter } from "../dist/features/account-wallet/sandbox-router.js";

// All identity, password and financial fixtures are synthetic. This creates its
// own native loopback cluster, never reads .env/database URLs and never selects
// a provider or live asset. Browser requests execute the real runtime-role API.
const exec = promisify(execFile),
  secret = () => randomBytes(24).toString("hex");
const passwords = {
  postgres: secret(),
  yaparena_owner: secret(),
  yaparena_runtime: secret(),
};
const fixturePassword = secret(),
  databaseName = "revocation_test_coin_browser";
const directory = await mkdtemp("/private/tmp/yaparena-coin-browser-");
const evidenceDirectory = resolve(
  "docs/evidence/account-completion-baseline/coin-sandbox-browser",
);
await mkdir(evidenceDirectory, { recursive: true });
let browser: Browser | undefined,
  runtime: pg.Pool | undefined,
  owner: pg.Pool | undefined,
  lastPage: Page | undefined;
let server: ReturnType<express.Express["listen"]> | undefined,
  started = false,
  phase = "provision isolated native PostgreSQL";
const checks: string[] = [],
  errors: string[] = [],
  failures: { route: string; status: number }[] = [];
const accessibilityFailures: {
  phase: string;
  id: string;
  impact: string | null | undefined;
}[] = [];
const layoutFailures: {
  phase: string;
  viewport: number;
  documentWidth: number;
  elements: { tag: string; id: string; left: number; right: number }[];
}[] = [];
const quiet = { info() {}, warn() {}, error() {} };
const evidenceSources = [
  "scripts/verify-coin-sandbox-browser.ts",
  "public/account-coins.js",
  "public/account-security.bundle.js",
  "public/account-auth.css",
  "frontend/account-coins.ts",
  "frontend/account-security.ts",
  ...[
    "sandbox-repository",
    "sandbox-router",
    "debate-sandbox",
    "grant-accounting",
    "ledger",
    "external-operations",
  ].flatMap((name) => [
    `src/features/account-wallet/${name}.ts`,
    `dist/features/account-wallet/${name}.js`,
  ]),
  ...[
    "security-passkeys",
    "security-router",
    "account-operations",
    "sessions",
  ].flatMap((name) => [
    `src/platform/auth/${name}.ts`,
    `dist/platform/auth/${name}.js`,
  ]),
];
function deferred() {
  let release: () => void = () => {};
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}
async function availablePort() {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = (socket.address() as AddressInfo).port;
  await new Promise<void>((done, fail) =>
    socket.close((error) => (error ? fail(error) : done())),
  );
  return port;
}
function databaseUrl(port: number, role: keyof typeof passwords, name: string) {
  const url = new URL(`postgresql://127.0.0.1:${port}/${name}`);
  url.username = role;
  url.password = passwords[role];
  return url.href;
}
async function sourceHash(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
async function selectCookie(
  context: BrowserContext,
  origin: string,
  token: string,
) {
  await context.addCookies([
    {
      name: "session",
      value: token,
      url: origin,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
}
async function announceAccount(page: Page) {
  await page.evaluate(() => {
    window.dispatchEvent(new Event("yap:provider-logout"));
    window.dispatchEvent(new Event("yap:account-changed"));
  });
}
async function automatedA11y(page: Page) {
  await page.waitForFunction(() => Boolean(window.axe));
  const violations = await page.evaluate(async () =>
    (
      await window.axe.run("main", {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
        },
      })
    ).violations.map((entry) => ({ id: entry.id, impact: entry.impact })),
  );
  for (const entry of violations)
    accessibilityFailures.push({ phase, ...entry });
  assert.deepEqual(violations, []);
  const layout = await page.evaluate(() => ({
    viewport: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    elements: Array.from(document.querySelectorAll("main *"))
      .map((element) => ({
        tag: element.tagName,
        id: element.id,
        left: Math.floor(element.getBoundingClientRect().left),
        right: Math.ceil(element.getBoundingClientRect().right),
      }))
      .filter((element) => element.right > innerWidth || element.left < 0)
      .slice(0, 15),
  }));
  if (layout.documentWidth > layout.viewport)
    layoutFailures.push({ phase, ...layout });
  assert.ok(layout.documentWidth <= layout.viewport);
}

try {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      evidenceSources.map(async (path) => [path, await sourceHash(path)]),
    ),
  );
  const postgresVersion = (
    await exec("pg_config", ["--version"])
  ).stdout.trim();
  assert.match(postgresVersion, /^PostgreSQL (17|18)\./);
  const passwordFile = resolve(directory, "password");
  await writeFile(passwordFile, passwords.postgres, { mode: 0o600 });
  await exec("initdb", [
    "--encoding=UTF8",
    "--pgdata",
    resolve(directory, "data"),
    "--username",
    "postgres",
    "--auth",
    "scram-sha-256",
    "--pwfile",
    passwordFile,
  ]);
  await rm(passwordFile);
  const port = await availablePort();
  await exec("pg_ctl", [
    "--pgdata",
    resolve(directory, "data"),
    "--log",
    resolve(directory, "postgres.log"),
    "--options",
    `-p ${port} -h 127.0.0.1 -k ${directory}`,
    "--wait",
    "start",
  ]);
  started = true;
  const admin = new pg.Client({
    connectionString: databaseUrl(port, "postgres", "postgres"),
  });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${databaseName}`);
  } finally {
    await admin.end();
  }
  const provisioner = new pg.Client({
    connectionString: databaseUrl(port, "postgres", databaseName),
  });
  await provisioner.connect();
  try {
    await provisionDatabase(provisioner, passwords);
    const migrationOwner = new pg.Client({
      connectionString: databaseUrl(port, "yaparena_owner", databaseName),
    });
    await migrationOwner.connect();
    try {
      await runner({
        dbClient: migrationOwner,
        dir: "migrations",
        direction: "up",
        schema: "yaparena",
        migrationsSchema: "yaparena_migrations",
        migrationsTable: "pgmigrations",
        logger: quiet,
        log() {},
      });
    } finally {
      await migrationOwner.end();
    }
    await provisionDatabase(provisioner);
  } finally {
    await provisioner.end();
  }
  runtime = new pg.Pool({
    connectionString: databaseUrl(port, "yaparena_runtime", databaseName),
  });
  owner = new pg.Pool({
    connectionString: databaseUrl(port, "yaparena_owner", databaseName),
  });
  const runtimePool = runtime,
    ownerPool = owner,
    sessions = createSessionRepository(runtimePool),
    operations = createAccountOperationRepository(runtimePool),
    passkeys = createSecurityPasskeyRepository(runtimePool);
  const sandbox = createCoinSandboxRepository(runtimePool, {
      rail: "simulation",
    }),
    operator = createCoinSandboxOperatorRepository(ownerPool, {
      rail: "simulation",
    }),
    debates = createCoinDebateSandbox(runtimePool, "simulation");
  const passwordHash = await hashPassword(fixturePassword);
  async function fixture() {
    const user = (
      await ownerPool.query<{ id: string; authGeneration: string }>(
        `INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id,auth_generation AS "authGeneration"`,
        [`${randomUUID()}@example.test`, passwordHash],
      )
    ).rows[0]!;
    const token = createSessionToken();
    await sessions.create(
      user.id,
      token.tokenHash,
      new Date(Date.now() + 1800000),
      user,
    );
    return { userId: user.id, token: token.token };
  }
  const topic = (
    await ownerPool.query<{ id: string }>(
      "INSERT INTO topics(slug,title,summary,side_a_label,side_b_label,publication_state) VALUES($1,'Browser sandbox fixture','Synthetic local fixture','Support','Oppose','published') RETURNING id",
      [`coin-browser-${randomUUID()}`],
    )
  ).rows[0]!;
  for (const proposition of [
    "First synthetic YES/NO debate",
    "Second synthetic YES/NO debate",
  ])
    await ownerPool.query(
      "INSERT INTO debates(topic_id,slug,proposition,status,publication_state,rules_version,rules_snapshot) VALUES($1,$2,$3,'scheduled','published','preview-1','{}')",
      [topic.id, `coin-browser-${randomUUID()}`, proposition],
    );
  const applicationPort = await availablePort(),
    origin = `http://localhost:${applicationPort}`,
    authenticated = createRequireAuthentication({
      sessions,
      environment: "test",
    });
  let dailyGate:
    | {
        arrived: ReturnType<typeof deferred>;
        finish: ReturnType<typeof deferred>;
      }
    | undefined;
  const app = express();
  app.use(express.json({ limit: "64kb" }), cookieParser());
  app.use((request, _response, next) => {
    request.id = randomUUID();
    next();
  });
  app.use("/assets", express.static(resolve("public")));
  app.get("/axe.js", (_request, response) =>
    response.type("js").send(axe.source),
  );
  app.get("/", (_request, response) =>
    response.send(
      `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>YapArena coin sandbox browser acceptance</title><link rel="stylesheet" href="/assets/site.css"><link rel="stylesheet" href="/assets/arena.css"><link rel="stylesheet" href="/assets/account-auth.css"><script defer src="/axe.js"></script></head><body class="account-page"><main class="container"><h1>Account and coins</h1><p>LOCAL REAL BACKEND · Synthetic accounts · Deterministic simulation · Chrome virtual authenticator · No live funds</p><section id="account-security-passkeys" class="information-card account-card"></section><section id="account-wallet" class="information-card account-card"></section></main><script type="module" src="/assets/account-security.bundle.js"></script><script type="module" src="/assets/account-coins.js"></script></body></html>`,
    ),
  );
  app.get("/api/auth/methods", authenticated, async (request, response) =>
    response.json({
      legacyPassword: Boolean(
        (
          await runtimePool.query<{ enabled: boolean }>(
            "SELECT password_hash IS NOT NULL AS enabled FROM users WHERE id=$1",
            [request.user!.id],
          )
        ).rows[0]?.enabled,
      ),
    }),
  );
  app.get("/api/auth/wallets", authenticated, async (request, response) =>
    response.json({
      wallets: (
        await runtimePool.query(
          'SELECT id,address,chain_id AS "chainId" FROM wallet_identities WHERE user_id=$1',
          [request.user!.id],
        )
      ).rows,
    }),
  );
  app.get("/api/public/debates", async (_request, response) =>
    response.json({
      items: (
        await runtimePool.query(
          "SELECT id,proposition FROM debates WHERE topic_id=$1 ORDER BY proposition",
          [topic.id],
        )
      ).rows,
    }),
  );
  app.use(
    "/api/auth",
    createAccountSecurityRouter({
      sessions,
      operations,
      passkeys,
      environment: "test",
      applicationOrigin: origin,
    }),
  );
  app.use(
    "/api/coin-sandbox",
    authenticated,
    async (request, _response, next) => {
      const gate = dailyGate;
      if (
        gate &&
        request.path === "/grants/daily" &&
        request.method === "POST"
      ) {
        dailyGate = undefined;
        gate.arrived.release();
        await gate.finish.promise;
      }
      next();
    },
    createCoinSandboxRouter({
      sandbox,
      debates,
      operations,
      environment: "test",
      applicationOrigin: origin,
    }),
  );
  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => {
      void _next;
      errors.push(
        error instanceof Error ? error.name : "unclassified backend failure",
      );
      response.status(500).json({ error: "isolated backend failure" });
    },
  );
  server = app.listen(applicationPort, "127.0.0.1");
  await once(server, "listening");
  browser = await chromium.launch({
    executablePath:
      process.env.BROWSER_CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 1100 }],
    ["mobile", { width: 390, height: 844 }],
  ] as const) {
    phase = `${name}: real runtime initial account`;
    const identity = await fixture(),
      replacement = await fixture(),
      context = await browser.newContext({ viewport, reducedMotion: "reduce" });
    await selectCookie(context, origin, identity.token);
    const page = await context.newPage();
    lastPage = page;
    page.setDefaultTimeout(15000);
    page.on("pageerror", (error) => errors.push(error.name));
    page.on("response", (response) => {
      if (response.status() >= 400)
        failures.push({
          route: new URL(response.url()).pathname.replace(
            /[a-f0-9]{8}-[a-f0-9-]{27,}/g,
            ":id",
          ),
          status: response.status(),
        });
    });
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
    await page.goto(origin);
    const root = page.locator("#coin-sandbox"),
      security = page.locator("#account-security-passkeys");
    await root
      .getByText(
        "Sandbox balances refreshed. Simulated withdrawals require manual operator review.",
        { exact: true },
      )
      .waitFor();
    await security
      .getByText("No security passkey added yet.", { exact: true })
      .waitFor();
    await page.screenshot({
      path: resolve(evidenceDirectory, `before-${name}.png`),
      fullPage: true,
    });
    phase = `${name}: retained password authorizes native key enrollment`;
    await security
      .getByRole("button", { name: "Add security passkey", exact: true })
      .click();
    const approval = page.getByRole("dialog");
    await approval
      .getByLabel("Current password", { exact: true })
      .fill(fixturePassword);
    await approval
      .getByRole("button", { name: "Approve change", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await security
      .getByText("Security passkey added. Other sessions were signed out.", {
        exact: true,
      })
      .waitFor();
    await root
      .getByText(
        "Sandbox balances refreshed. Simulated withdrawals require manual operator review.",
        { exact: true },
      )
      .waitFor();
    const saved = (await context.cookies(origin)).find(
      (cookie) => cookie.name === "session",
    );
    assert.ok(saved);
    const currentToken = saved.value;
    assert.notEqual(currentToken, identity.token);
    assert.equal((await passkeys.list(identity.userId)).length, 1);
    phase = `${name}: exactly-once grants and funded issuance`;
    await root.locator("[data-coin-initialize]").focus();
    await page.keyboard.press("Enter");
    await root.locator("[data-coin-initialize]").waitFor({ state: "hidden" });
    await root.locator("[data-coin-daily]").click();
    await root.getByText(/Daily grant:/).waitFor();
    await root.locator("[data-coin-daily]").click();
    await root
      .getByText(
        "Sandbox balances refreshed. Simulated withdrawals require manual operator review.",
        { exact: true },
      )
      .waitFor();
    assert.equal(
      (
        await ownerPool.query<{ n: number }>(
          "SELECT count(*)::int n FROM coin_grant_lots WHERE user_id=$1 AND kind='daily'",
          [identity.userId],
        )
      ).rows[0]!.n,
      1,
    );
    assert.equal(
      (
        await ownerPool.query<{ n: number }>(
          "SELECT count(*)::int n FROM coin_grant_lots WHERE user_id=$1 AND kind='welcome'",
          [identity.userId],
        )
      ).rows[0]!.n,
      1,
    );
    await root
      .locator("details:has([data-coin-funding])")
      .locator("summary")
      .click();
    page.once("dialog", (dialog) => void dialog.accept());
    await root
      .locator("[data-coin-funding]")
      .getByRole("button", { name: "Get simulated quote", exact: true })
      .click();
    await root
      .locator("[data-coin-balances] div")
      .filter({ hasText: "Purchased principal" })
      .getByText("1000 YC", { exact: true })
      .waitFor();
    const funded = await sandbox.summary({
      userId: identity.userId,
      sessionTokenHash: hashSessionToken(currentToken),
    });
    assert.equal(funded.projection.purchasedPrincipal, "10000000");
    assert.equal(funded.projection.withdrawable, "10000000");
    checks.push(
      `${name}: actual runtime-role API issues one welcome/daily grant, preserves spend-only principal, and confirms a 10 simulated USDC purchase as 1000 withdrawal-eligible YC without any grant target`,
    );
    phase = `${name}: native operation proof and manual withdrawal receipt`;
    await root
      .locator("details:has([data-coin-withdraw])")
      .locator("summary")
      .click();
    await root
      .locator("[data-coin-withdraw] input[name=destination]")
      .fill("synthetic-external-wallet");
    page.once("dialog", (dialog) => void dialog.accept());
    await root
      .locator("[data-coin-withdraw]")
      .getByRole("button", {
        name: "Review amount and network fee",
        exact: true,
      })
      .click();
    await approval
      .getByRole("heading", { name: "Approve sandbox withdrawal", exact: true })
      .waitFor();
    assert.equal(
      await approval
        .locator("select")
        .evaluate((element) => document.activeElement === element),
      true,
    );
    await approval
      .getByText(
        /Deduct 5 USDC.*including a 0\.1 USDC network fee.*receives 4\.9 USDC/,
      )
      .waitFor();
    assert.equal(
      await approval
        .getByText(
          /Destination: synthetic-external-wallet\. Network: simulation:usdc/,
        )
        .count(),
      1,
    );
    if (name === "mobile") {
      await approval
        .getByLabel("Approve with", { exact: false })
        .selectOption("password");
      await approval
        .getByLabel("Current password", { exact: true })
        .fill(fixturePassword);
    }
    await automatedA11y(page);
    await page.screenshot({
      path: resolve(evidenceDirectory, `withdrawal-approval-${name}.png`),
      fullPage: true,
    });
    await approval
      .getByRole("button", { name: "Approve change", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await root
      .locator("[data-coin-receipts]")
      .getByText(
        /withdrawal · review · deduct 5\.0 USDC, fee 0\.1 USDC, receive 4\.9 USDC/,
      )
      .waitFor();
    const withdrawn = await sandbox.summary({
      userId: identity.userId,
      sessionTokenHash: hashSessionToken(currentToken),
    });
    assert.equal(withdrawn.balances.cashAvailable, "5000000");
    assert.equal(withdrawn.balances.reserved, "5000000");
    assert.equal(withdrawn.balances.pending, "0");
    const request = withdrawn.requests.find(
      (entry) => entry.kind === "withdrawal",
    );
    assert.ok(request);
    assert.equal(request.status, "review");
    assert.deepEqual(
      [request.terms.gross, request.terms.fee, request.terms.net],
      ["5000000", "100000", "4900000"],
    );
    assert.equal(
      await root
        .locator("[data-coin-withdraw] button[type=submit]")
        .evaluate((element) => document.activeElement === element),
      true,
    );
    checks.push(
      `${name}: ${name === "desktop" ? "native WebAuthn" : "retained-password"} proof approves exactly 5 gross / 0.1 fee / 4.9 net USDC to the displayed destination; transactionally reserved funds await manual review with a receipt`,
    );
    phase = `${name}: independent treasury and existing debate participation`;
    const historicalCount = (
      await ownerPool.query<{ n: number }>(
        "SELECT count(*)::int n FROM a4_postings",
      )
    ).rows[0]!.n;
    for (const purpose of ["center", "promotional"] as const)
      await operator.seedSandboxTreasury({
        userId: identity.userId,
        purpose,
        amount: "50000000",
        idempotencyKey: randomUUID(),
      });
    await root
      .locator("details:has([data-coin-participate])")
      .locator("summary")
      .click();
    await root.locator("[data-coin-open]").click();
    await root.locator("[data-coin-participate]").waitFor({ state: "visible" });
    page.once("dialog", (dialog) => void dialog.accept());
    await root
      .locator("[data-coin-participate]")
      .getByRole("button", {
        name: "Review and commit participation",
        exact: true,
      })
      .click();
    await root
      .getByText(
        "Commitment recorded. Settlement occurs after the five-minute cutoff.",
        { exact: true },
      )
      .waitFor();
    assert.equal(
      (
        await ownerPool.query<{ n: number }>(
          "SELECT count(*)::int n FROM coin_debate_orders WHERE user_id=$1",
          [identity.userId],
        )
      ).rows[0]!.n,
      1,
    );
    assert.equal(
      (
        await ownerPool.query<{ n: number }>(
          "SELECT count(*)::int n FROM a4_postings",
        )
      ).rows[0]!.n,
      historicalCount,
    );
    checks.push(
      `${name}: owner-process simulated center/promotional treasury funds a real existing YES/NO round; first commitment and its source reservation are recorded without changing historical A4 tables`,
    );
    phase = `${name}: context switch during native confirmation rejects new-account spending`;
    const options = await root.locator("[data-coin-debate] option").all();
    assert.equal(options.length, 2);
    const second = await options[1]!.getAttribute("value");
    assert.ok(second);
    await root.locator("[data-coin-debate]").selectOption(second);
    await root.getByText("Debate rounds refreshed.", { exact: true }).waitFor();
    await root.locator("[data-coin-open]").click();
    await root.locator("[data-coin-participate]").waitFor({ state: "visible" });
    const rejection = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/rounds\/[^/]+\/submit$/.test(new URL(response.url()).pathname),
    );
    page.once("dialog", async (dialog) => {
      await selectCookie(context, origin, replacement.token);
      await dialog.accept();
    });
    await root
      .locator("[data-coin-participate]")
      .getByRole("button", {
        name: "Review and commit participation",
        exact: true,
      })
      .click();
    assert.equal((await rejection).status(), 409);
    assert.equal(
      (
        await ownerPool.query<{ n: number }>(
          "SELECT count(*)::int n FROM coin_debate_orders WHERE user_id=$1",
          [replacement.userId],
        )
      ).rows[0]!.n,
      0,
    );
    assert.equal(
      (
        await sandbox.summary({
          userId: replacement.userId,
          sessionTokenHash: hashSessionToken(replacement.token),
        })
      ).balances.cashAvailable,
      "0",
    );
    await announceAccount(page);
    await root.locator("[data-coin-initialize]").waitFor({ state: "visible" });
    assert.equal(await root.locator("[data-coin-refresh]").isEnabled(), true);
    await selectCookie(context, origin, currentToken);
    await announceAccount(page);
    await root
      .locator("[data-coin-balances] div")
      .filter({ hasText: "Purchased principal" })
      .getByText("500 YC", { exact: true })
      .waitFor();
    checks.push(
      `${name}: real cookie switch while the native confirmation blocks browser events is rejected by comparison-only session context; replacement account receives no stake or funds and controls recover`,
    );
    phase = `${name}: late old-account action cannot restore private balances or disabled controls`;
    const gate = { arrived: deferred(), finish: deferred() };
    dailyGate = gate;
    await root.locator("[data-coin-daily]").click();
    await gate.arrived.promise;
    await selectCookie(context, origin, replacement.token);
    await announceAccount(page);
    await root.locator("[data-coin-initialize]").waitFor({ state: "visible" });
    assert.equal(await root.locator("[data-coin-refresh]").isEnabled(), true);
    const delayed = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith("/grants/daily"),
    );
    gate.finish.release();
    await delayed;
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
    assert.equal(
      await root
        .locator("[data-coin-balances] div")
        .filter({ hasText: "Purchased principal" })
        .getByText("0 YC", { exact: true })
        .count(),
      1,
    );
    assert.equal(await root.locator("[data-coin-refresh]").isEnabled(), true);
    await selectCookie(context, origin, currentToken);
    await announceAccount(page);
    await root
      .locator("[data-coin-balances] div")
      .filter({ hasText: "Purchased principal" })
      .getByText("500 YC", { exact: true })
      .waitFor();
    checks.push(
      `${name}: delayed actual daily-claim response from the old account cannot repopulate its balances in the replacement account or leave replacement controls disabled`,
    );
    phase = `${name}: keyboard, mobile and 200 percent layout zoom acceptance`;
    await automatedA11y(page);
    await page.screenshot({
      path: resolve(evidenceDirectory, `after-${name}.png`),
      fullPage: true,
    });
    await page.evaluate(() => {
      document.documentElement.style.zoom = "2";
    });
    await automatedA11y(page);
    await page.screenshot({
      path: resolve(evidenceDirectory, `zoom-200-${name}.png`),
      fullPage: true,
    });
    await page.evaluate(() => {
      document.documentElement.style.zoom = "";
    });
    checks.push(
      `${name}: keyboard activation of retained proof and enrollment, native-dialog focus, automated WCAG2.2AA tags and no horizontal overflow at normal and CSS200% layout zoom; not screen-reader/physical-device evidence`,
    );
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
    await context.close();
  }
  assert.deepEqual(errors, []);
  phase = "verify tested source and build remained stable during browser run";
  assert.deepEqual(
    Object.fromEntries(
      await Promise.all(
        evidenceSources.map(async (path) => [path, await sourceHash(path)]),
      ),
    ),
    sourceHashes,
  );
  await writeFile(
    resolve(evidenceDirectory, "results.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        revision,
        revisionAtEnd: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        sourceHashes,
        postgres: postgresVersion,
        browser: browser.version(),
        scope:
          "Real application browser assets and runtime-role PostgreSQL API in a new disposable native cluster; synthetic identities and deterministic financial simulation; Chrome virtual WebAuthn, no genuine Privy/hosted/provider-chain/physical-device/screen-reader acceptance; CSS200% zoom is layout emulation.",
        checks,
        errors,
        expectedRejections: failures,
        accessibilityFailures,
        layoutFailures,
      },
      null,
      2,
    ) + "\n",
  );
  await rm(resolve(evidenceDirectory, "failure.png"), { force: true });
  console.log(
    JSON.stringify({ result: "PASS", checks, evidence: evidenceDirectory }),
  );
} catch (error) {
  if (lastPage && !lastPage.isClosed())
    await lastPage
      .screenshot({
        path: resolve(evidenceDirectory, "failure.png"),
        fullPage: true,
      })
      .catch(() => {});
  console.error(
    JSON.stringify({
      result: "FAIL",
      phase,
      category: error instanceof Error ? error.name : "unclassified",
      backendErrorCategories: errors,
      responseFailures: failures,
      accessibilityFailures,
      layoutFailures,
      action:
        "Inspect isolated browser harness; credentials, protocol responses and database URLs omitted.",
    }),
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((done, fail) =>
      server!.close((error) => (error ? fail(error) : done())),
    );
  }
  await Promise.all([runtime?.end(), owner?.end()]);
  if (started)
    await exec("pg_ctl", [
      "--pgdata",
      resolve(directory, "data"),
      "--mode",
      "immediate",
      "--wait",
      "stop",
    ]);
  await rm(directory, { recursive: true, force: true });
}
