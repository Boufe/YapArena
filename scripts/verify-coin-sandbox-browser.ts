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
import {
  createSandboxErrorReports,
  createSandboxErrorReportOperator,
} from "../dist/features/account-wallet/sandbox-reports.js";

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
  "public/session-coordination.js",
  "public/account-security.bundle.js",
  "public/account-auth.css",
  "frontend/account-coins.ts",
  "frontend/account-security.ts",
  "frontend/session-coordination.ts",
  "frontend/auth-events.ts",
  ...[
    "sandbox-repository",
    "sandbox-router",
    "sandbox-reports",
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
      await window.axe.run("main, dialog[open]", {
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
  const dialogFits = await page.evaluate(() =>
    Array.from(document.querySelectorAll("dialog[open]")).every((dialog) => {
      const rectangle = dialog.getBoundingClientRect();
      return rectangle.left >= 0 && rectangle.right <= innerWidth;
    }),
  );
  assert.equal(dialogFits, true);
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
    reports = createSandboxErrorReports(runtimePool, "simulation"),
    reportOperator = createSandboxErrorReportOperator(ownerPool, "simulation"),
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
  let summaryGate:
    | {
        userId: string;
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
      `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>YapArena coin sandbox browser acceptance</title><link rel="stylesheet" href="/assets/site.css"><link rel="stylesheet" href="/assets/arena.css"><link rel="stylesheet" href="/assets/account-auth.css"><script defer src="/assets/session-coordination.js"></script><script defer src="/axe.js"></script></head><body class="account-page"><main class="container"><h1>Account and coins</h1><p>LOCAL REAL BACKEND · Synthetic accounts · Deterministic simulation · Chrome virtual authenticator · No live funds</p><section id="account-security-passkeys" class="information-card account-card"></section><section id="account-wallet" class="information-card account-card"></section></main><script type="module" src="/assets/account-security.bundle.js"></script><script type="module" src="/assets/account-coins.js"></script></body></html>`,
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
      const heldSummary = summaryGate;
      if (
        heldSummary &&
        request.path === "/summary" &&
        request.method === "GET" &&
        request.user?.id === heldSummary.userId
      ) {
        summaryGate = undefined;
        heldSummary.arrived.release();
        await heldSummary.finish.promise;
      }
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
      reports,
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
    await page.waitForFunction(
      () =>
        "yapApproveCoinWithdrawal" in window &&
        typeof window.yapApproveCoinWithdrawal === "function",
    );
    assert.equal(await security.isHidden(), true);
    assert.equal(
      await security
        .getByRole("button", { name: "Add security passkey", exact: true })
        .count(),
      0,
    );
    await page.screenshot({
      path: resolve(evidenceDirectory, `before-${name}.png`),
      fullPage: true,
    });
    phase = `${name}: retained password authorizes fixture-only native legacy key enrollment`;
    // Preserve financial acceptance with a deliberately retained legacy key.
    // This invokes the real API/native protocol, not a removed enrollment UI
    // and not Privy's separately tested same-key enrollment workflow.
    const enrollmentInput = {
      userId: identity.userId,
      sessionTokenHash: hashSessionToken(identity.token),
      origin,
    };
    const enrollment = await passkeys.enrollmentOptions(enrollmentInput),
      enrollmentProof = await operations.create({
        ...enrollmentInput,
        credential: { type: "password" },
        purpose: "security.passkey.enroll",
        terms: { challengeId: enrollment.id },
      });
    const { extensions, ...creationOptions } = enrollment.options;
    assert.deepEqual(extensions, { credProps: true });
    const registration = await page.evaluate(
      async (options) => {
        const credential = await navigator.credentials.create({
          publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options),
        });
        if (
          !(credential instanceof PublicKeyCredential) ||
          !(credential.response instanceof AuthenticatorAttestationResponse)
        )
          throw new Error("Native legacy fixture registration missing");
        return credential.toJSON();
      },
      { ...creationOptions, extensions: { credProps: true } },
    );
    const enrolled = await context.request.post(
      `${origin}/api/auth/security/passkeys/enrollment/${enrollment.id}/complete`,
      {
        headers: { origin },
        data: {
          response: registration,
          approval: { id: enrollmentProof.id, password: fixturePassword },
        },
      },
    );
    assert.equal(enrolled.status(), 200);
    await page.evaluate(() =>
      window.dispatchEvent(new Event("yap:account-changed")),
    );
    const approval = page.getByRole("dialog");
    await security
      .getByRole("button", { name: /^Remove existing security key added/ })
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
    phase = `${name}: public error report and private evidence review`;
    const accountContext = {
        userId: identity.userId,
        sessionTokenHash: hashSessionToken(currentToken),
      },
      reportDescription = `Synthetic ${name} payout question <img data-report-injection src=x>`,
      privateNote = `Private synthetic review ${randomUUID()}`,
      evidenceDigest = createHash("sha256").update(privateNote).digest("hex");
    async function moneyState() {
      const summary = await sandbox.summary(accountContext),
        counts = (
          await ownerPool.query<{
            journals: number;
            receipts: number;
            requests: number;
          }>(
            "SELECT (SELECT count(*)::int FROM coin_journals) AS journals,(SELECT count(*)::int FROM coin_external_receipts) AS receipts,(SELECT count(*)::int FROM coin_sandbox_requests) AS requests",
          )
        ).rows[0]!;
      return {
        balances: summary.balances,
        projection: summary.projection,
        requests: summary.requests,
        counts,
      };
    }
    const beforeReport = await moneyState();
    await root
      .locator("[data-coin-receipts] li")
      .filter({ hasText: request.id })
      .getByRole("button", { name: "Report a problem", exact: true })
      .click();
    const reportForm = root.locator("[data-coin-report]");
    assert.equal(
      await reportForm.getByLabel("Receipt ID").inputValue(),
      request.id,
    );
    assert.equal(
      await reportForm
        .getByLabel("What happened?")
        .evaluate((element) => document.activeElement === element),
      true,
    );
    await reportForm.getByLabel("What happened?").fill(reportDescription);
    await reportForm
      .getByRole("button", { name: "Submit error report", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await root
      .locator("[data-coin-report-notice]")
      .filter({
        hasText:
          "Error report recorded for evidence review. No funds were changed.",
      })
      .waitFor();
    const submitted = await reports.list(accountContext);
    assert.equal(submitted.length, 1);
    const report = submitted[0]!;
    assert.equal(report.description, reportDescription);
    assert.equal(report.requestId, request.id);
    assert.equal(await root.locator("[data-coin-reports] img").count(), 0);
    const reviewed = await reportOperator.review({
      reportId: report.id,
      idempotencyKey: randomUUID(),
      outcome: "recovery_quote",
      note: privateNote,
      publicNote: "Synthetic evidence reviewed; recovery is optional.",
      evidenceDigest,
      quote: {
        amount: "100000",
        network: "simulation:usdc",
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        description: "Synthetic quoted recovery cost",
      },
    });
    await root.locator("[data-coin-refresh]").click();
    await root
      .getByRole("button", { name: "Review recovery cost", exact: true })
      .waitFor();
    const publicReport = await context.request.get(
      `${origin}/api/coin-sandbox/reports/${report.id}`,
    );
    assert.equal(publicReport.status(), 200);
    const publicBody = await publicReport.text();
    assert.equal(publicBody.includes(privateNote), false);
    assert.equal(publicBody.includes(evidenceDigest), false);
    assert.equal(publicBody.includes("evidenceDigest"), false);
    assert.equal(
      (await root.locator("[data-coin-reports]").innerText()).includes(
        privateNote,
      ),
      false,
    );
    await selectCookie(context, origin, replacement.token);
    const foreignReport = await context.request.get(
        `${origin}/api/coin-sandbox/reports/${report.id}`,
      ),
      foreignQuote = await context.request.get(
        `${origin}/api/coin-sandbox/reports/${report.id}/recovery-quotes/${reviewed.event.id}`,
      ),
      foreignReports = await context.request.get(
        `${origin}/api/coin-sandbox/reports`,
      );
    assert.equal(foreignReport.status(), 404);
    assert.equal(foreignQuote.status(), 404);
    assert.deepEqual(await foreignReports.json(), []);
    await selectCookie(context, origin, currentToken);
    assert.deepEqual(await moneyState(), beforeReport);
    checks.push(
      `${name}: a receipt opens an accessible real error-report form; literal markup stays text, owner evidence stays private, and another actual account receives no report or cost quote; reporting/review changes no funds or external records`,
    );

    phase = `${name}: native proof records exact recovery cost consent without a charge`;
    await root
      .getByRole("button", { name: "Review recovery cost", exact: true })
      .click();
    await approval
      .getByRole("heading", {
        name: "Approve recovery cost consent",
        exact: true,
      })
      .waitFor();
    await approval
      .getByText(/quoted recovery cost of 0\.1 USDC on network simulation:usdc/)
      .waitFor();
    await approval
      .getByText(/No charge is taken and no recovery transaction is executed/)
      .waitFor();
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
      path: resolve(evidenceDirectory, `recovery-consent-${name}.png`),
      fullPage: true,
    });
    const consentResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          `/api/coin-sandbox/reports/${report.id}/recovery-consents`,
    );
    await approval
      .getByRole("button", { name: "Record consent", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    const recorded = await consentResponse;
    assert.equal(recorded.status(), 200);
    const consentBody: unknown = await recorded.json();
    assert.ok(
      consentBody !== null &&
        typeof consentBody === "object" &&
        "authorizesCharge" in consentBody &&
        "authorizesExternalRecovery" in consentBody,
    );
    assert.equal(consentBody.authorizesCharge, false);
    assert.equal(consentBody.authorizesExternalRecovery, false);
    await root
      .locator("[data-coin-reports]")
      .getByText(
        "Recovery cost consent recorded. No charge or recovery started.",
        { exact: true },
      )
      .waitFor();
    await page.waitForFunction(
      () =>
        document.activeElement?.matches("[data-coin-report-notice]") === true,
    );
    assert.equal(await approval.count(), 0);
    assert.equal(
      await root
        .getByRole("button", { name: "Review recovery cost", exact: true })
        .count(),
      0,
    );
    const consentRows = await ownerPool.query<{
      authorized: boolean;
      cashJournalId: string | null;
    }>(
      `SELECT e.cash_journal_id AS "cashJournalId",e.session_id=s.id AND e.auth_generation=u.auth_generation AS authorized FROM coin_sandbox_report_events e JOIN users u ON u.id=e.user_id JOIN sessions s ON s.token_hash=$2 WHERE e.report_id=$1 AND e.kind='recovery_consent'`,
      [report.id, hashSessionToken(currentToken)],
    );
    assert.equal(consentRows.rows.length, 1);
    assert.deepEqual(consentRows.rows[0], {
      cashJournalId: null,
      authorized: true,
    });
    assert.deepEqual(await moneyState(), beforeReport);
    checks.push(
      `${name}: ${name === "desktop" ? "real virtual-authenticator WebAuthn" : "retained-password"} authorization binds the displayed 0.1 USDC recovery quote to the current account/session; one append-only consent authorizes neither a charge nor recovery, leaves all balances/journals/receipts/requests unchanged, and restores keyboard focus to the report notice`,
    );

    phase = `${name}: recovery quote expires while its consent dialog is open`;
    const expiry = Date.now() + 7000;
    await reportOperator.review({
      reportId: report.id,
      idempotencyKey: randomUUID(),
      outcome: "recovery_quote",
      note: privateNote,
      publicNote: "Synthetic short-lived replacement quote.",
      evidenceDigest,
      quote: {
        amount: "200000",
        network: "simulation:usdc",
        expiresAt: new Date(expiry).toISOString(),
        description: "Synthetic expiring cost",
      },
    });
    await root.locator("[data-coin-refresh]").click();
    await root
      .getByRole("button", { name: "Review recovery cost", exact: true })
      .click();
    await approval
      .getByRole("heading", {
        name: "Approve recovery cost consent",
        exact: true,
      })
      .waitFor();
    await approval
      .getByLabel("Approve with", { exact: false })
      .selectOption("password");
    await approval
      .getByLabel("Current password", { exact: true })
      .fill(fixturePassword);
    await page.waitForFunction(
      (expiresAt) => Date.now() > expiresAt + 250,
      expiry,
    );
    const expiredResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          `/api/coin-sandbox/reports/${report.id}/recovery-consents/authorization`,
    );
    await approval
      .getByRole("button", { name: "Record consent", exact: true })
      .click();
    assert.equal((await expiredResponse).status(), 410);
    await approval
      .getByRole("status")
      .filter({ hasText: /expired/ })
      .waitFor();
    assert.equal(
      await approval
        .getByRole("button", { name: "Record consent", exact: true })
        .isEnabled(),
      true,
    );
    await automatedA11y(page);
    await page.keyboard.press("Escape");
    assert.equal(await approval.count(), 0);
    await root.locator("[data-coin-refresh]").click();
    await root
      .getByText(
        "Sandbox balances refreshed. Simulated withdrawals require manual operator review.",
        { exact: true },
      )
      .waitFor();
    await root
      .getByRole("button", { name: "Review recovery cost", exact: true })
      .waitFor({ state: "hidden" });
    assert.equal(
      await root
        .getByRole("button", { name: "Review recovery cost", exact: true })
        .count(),
      0,
    );
    assert.equal(
      (
        await ownerPool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM coin_sandbox_report_events WHERE report_id=$1 AND kind='recovery_consent'",
          [report.id],
        )
      ).rows[0]!.n,
      1,
    );
    assert.deepEqual(await moneyState(), beforeReport);
    checks.push(
      `${name}: a quote that genuinely expires while its dialog is open is rejected by the real server with 410, announces the error, permits keyboard cancellation, disappears after refresh and creates no second consent or financial change`,
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
    const checkingReplacement = {
      userId: replacement.userId,
      arrived: deferred(),
      finish: deferred(),
    };
    summaryGate = checkingReplacement;
    await announceAccount(page);
    await checkingReplacement.arrived.promise;
    assert.equal(await root.isVisible(), false);
    for (const selector of [
      "[data-coin-balances]",
      "[data-coin-receipts]",
      "[data-coin-rounds]",
      "[data-coin-reports]",
    ])
      assert.equal(await root.locator(selector).textContent(), "");
    assert.equal(
      await root
        .locator("[data-coin-withdraw] input[name=destination]")
        .inputValue(),
      "",
    );
    checkingReplacement.finish.release();
    await root.locator("[data-coin-initialize]").waitFor({ state: "visible" });
    await root
      .locator("[data-coin-report-notice]")
      .filter({ hasText: "No deposit or payout errors reported." })
      .waitFor();
    assert.equal(await root.locator("[data-coin-reports] li").count(), 0);
    assert.equal((await root.innerText()).includes(reportDescription), false);
    assert.equal(await root.locator("[data-coin-refresh]").isEnabled(), true);
    await selectCookie(context, origin, currentToken);
    await announceAccount(page);
    await root
      .locator("[data-coin-balances] div")
      .filter({ hasText: "Purchased principal" })
      .getByText("500 YC", { exact: true })
      .waitFor();
    checks.push(
      `${name}: real cookie switch while the native confirmation blocks browser events is rejected by comparison-only session context; a held replacement summary leaves no old balances, receipts, round, report or destination in hidden DOM, and the new account receives no stake or funds`,
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
    phase = `${name}: logout clears an unfinished retained-proof dialog`;
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
    await approval
      .getByLabel("Approve with", { exact: false })
      .selectOption("password");
    const abandonedPassword = approval.getByLabel("Current password", {
      exact: true,
    });
    await abandonedPassword.fill(fixturePassword);
    const abandonedInput = await abandonedPassword.elementHandle();
    assert.ok(abandonedInput);
    await page.evaluate(() => {
      window.dispatchEvent(new Event("yap:provider-logout"));
    });
    assert.equal(await approval.count(), 0);
    assert.equal(
      await abandonedInput.evaluate((input) =>
        input instanceof HTMLInputElement ? input.value : null,
      ),
      "",
    );
    await abandonedInput.dispose();
    assert.equal(
      (
        await sandbox.summary({
          userId: identity.userId,
          sessionTokenHash: hashSessionToken(currentToken),
        })
      ).balances.reserved,
      "5000000",
    );
    await page.evaluate(() => {
      window.dispatchEvent(new Event("yap:account-changed"));
    });
    await root
      .locator("[data-coin-balances] div")
      .filter({ hasText: "Purchased principal" })
      .getByText("500 YC", { exact: true })
      .waitFor();
    await page.waitForFunction(
      () =>
        "yapApproveCoinWithdrawal" in window &&
        typeof window.yapApproveCoinWithdrawal === "function",
    );
    checks.push(
      `${name}: the actual logout event removes unfinished security approval, erases its detached password input and does not create another reserve; a subsequent account refresh restores working controls`,
    );
    phase = `${name}: financial correction hold preserves report and quote access`;
    const fundingRequest = funded.requests.find(
      (entry) => entry.kind === "funding",
    );
    assert.ok(fundingRequest);
    const correctionReport = await reports.submit(accountContext, {
        requestId: fundingRequest.id,
        message: "Synthetic incorrect deposit evidence fixture.",
        idempotencyKey: randomUUID(),
      }),
      correctionReview = await reportOperator.review({
        reportId: correctionReport.report.id,
        idempotencyKey: randomUUID(),
        outcome: "erroneous_credit",
        note: privateNote,
        publicNote: "Synthetic deposit correction requires evidence review.",
        evidenceDigest,
      }),
      correctionKey = randomUUID(),
      correctionProof = await reportOperator.prepareCorrection({
        reportId: correctionReport.report.id,
        reviewId: correctionReview.event.id,
        requestId: fundingRequest.id,
        action: "correct",
        idempotencyKey: correctionKey,
      }),
      correction = await operator.correctFunding({
        userId: identity.userId,
        requestId: fundingRequest.id,
        idempotencyKey: correctionKey,
        reason: "incorrect_funding",
        review: correctionProof,
      });
    assert.equal(correction.status, "uncertain");
    assert.equal(correction.financialReviewRequired, true);
    await reportOperator.review({
      reportId: report.id,
      idempotencyKey: randomUUID(),
      outcome: "recovery_quote",
      note: privateNote,
      publicNote:
        "Evidence and optional recovery stay accessible during the financial hold.",
      evidenceDigest,
      quote: {
        amount: "100000",
        network: "simulation:usdc",
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        description: "Synthetic held-account recovery quote",
      },
    });
    const beforeHeldRefresh = await moneyState(),
      settlementRejection = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/coin-sandbox/settlements",
      );
    await root.locator("[data-coin-refresh]").click();
    assert.equal((await settlementRejection).status(), 403);
    phase = `${name}: correction hold refresh exposes the current quote`;
    await root
      .getByRole("button", { name: "Review recovery cost", exact: true })
      .waitFor();
    phase = `${name}: correction hold refresh announces its guard`;
    await root
      .locator("[data-coin-notice]")
      .filter({ hasText: /financial activity is paused/ })
      .waitFor();
    phase = `${name}: correction hold keeps withdrawal guard and financial state`;
    assert.equal(await root.locator("[data-coin-reports] li").count(), 2);
    const heldSummary = await sandbox.summary(accountContext),
      deniedQuote = await context.request.post(
        `${origin}/api/coin-sandbox/withdrawals/quotes`,
        {
          headers: {
            Origin: origin,
            "X-YapArena-Session": heldSummary.sessionId,
            "Idempotency-Key": randomUUID(),
          },
          data: { gross: "5000000", destination: "synthetic-external-wallet" },
        },
      );
    assert.equal(deniedQuote.status(), 403);
    assert.deepEqual(await moneyState(), beforeHeldRefresh);
    phase = `${name}: capture held-account report evidence`;
    await page.screenshot({
      path: resolve(evidenceDirectory, `financial-hold-${name}.png`),
      fullPage: true,
    });
    checks.push(
      `${name}: an actual evidence-reviewed uncertain funding correction holds financial mutations; Refresh sandbox still loads both reports and the owner's current recovery quote after settlement403, while new withdrawals remain403 and reserves/journals/receipts stay unchanged`,
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
      `${name}: keyboard activation of financial retained-proof controls, explicitly fixture-only native legacy enrollment, native-dialog focus, automated WCAG2.2AA tags and no horizontal overflow at normal and CSS200% layout zoom; not current Privy enrollment UI, screen-reader or physical-device evidence`,
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
          "Real application browser assets and runtime-role PostgreSQL API in a new disposable native cluster; synthetic identities and deterministic financial simulation; retained legacy key prepared by explicit password-authorized real API/native fixture, not removed enrollment controls or current Privy enrollment UI; Chrome virtual WebAuthn, no genuine Privy/hosted/provider-chain/physical-device/screen-reader acceptance; CSS200% zoom is layout emulation.",
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
      operation:
        error instanceof Error
          ? /^(?:locator|page|browserContext|browser)\.[a-zA-Z]+/.exec(
              error.message,
            )?.[0]
          : undefined,
      recoveryControls:
        lastPage && !lastPage.isClosed()
          ? await lastPage
              .evaluate(() =>
                Array.from(
                  document.querySelectorAll("[data-coin-reports] button"),
                ).map((button) => ({
                  expectedText: button.textContent === "Review recovery cost",
                  hiddenAncestors: Array.from(
                    document.querySelectorAll(
                      "[hidden],[inert],[aria-hidden=true]",
                    ),
                  )
                    .filter((parent) => parent.contains(button))
                    .map((parent) => parent.tagName),
                  detailsOpen: button.closest("details")?.open,
                  width: button.getBoundingClientRect().width,
                  height: button.getBoundingClientRect().height,
                })),
              )
              .catch(() => [])
          : [],
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
