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
import { chromium, type Browser, type Page } from "playwright-core";
import axe from "axe-core";
import type {} from "pino-http";
import { provisionDatabase } from "./provision-database.ts";
import { createAccountSecurityRouter } from "../dist/platform/auth/security-router.js";
import { createSecurityPasskeyRepository } from "../dist/platform/auth/security-passkeys.js";
import { createAccountOperationRepository } from "../dist/platform/auth/account-operations.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import { createProviderAccounts } from "../dist/platform/auth/provider-accounts.js";
import { createSessionToken } from "../dist/platform/auth/session-tokens.js";
import { createRequireAuthentication } from "../dist/platform/auth/router.js";

// No .env or external database URL is read. All credentials and provider
// identities are synthetic, in a new loopback-only PostgreSQL cluster. Browser
// WebAuthn uses Chrome's virtual authenticator and the real application backend.
const exec = promisify(execFile);
const secret = () => randomBytes(24).toString("hex");
const passwords = {
  postgres: secret(),
  yaparena_owner: secret(),
  yaparena_runtime: secret(),
};
const databaseName = "revocation_test_security_browser";
const quiet = { info() {}, warn() {}, error() {} };
const directory = await mkdtemp("/private/tmp/yaparena-security-browser-");
const evidenceDirectory = resolve(
  "docs/evidence/account-completion-baseline/security-passkey-browser",
);
await mkdir(evidenceDirectory, { recursive: true });
let started = false;
let browser: Browser | undefined;
let lastPage: Page | undefined;
let runtime: pg.Pool | undefined;
let owner: pg.Pool | undefined;
let httpServer: ReturnType<express.Express["listen"]> | undefined;
let phase = "start disposable PostgreSQL";
const checks: string[] = [];
const errors: string[] = [];
const responseFailures: { route: string; status: number }[] = [];

async function availablePort() {
  const reserved = createServer();
  reserved.listen(0, "127.0.0.1");
  await once(reserved, "listening");
  const port = (reserved.address() as AddressInfo).port;
  await new Promise<void>((done, fail) =>
    reserved.close((error) => (error ? fail(error) : done())),
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

try {
  const version = (await exec("pg_config", ["--version"])).stdout.trim();
  assert.match(version, /^PostgreSQL (17|18)\./);
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
  const administrator = new pg.Client({
    connectionString: databaseUrl(port, "postgres", "postgres"),
  });
  await administrator.connect();
  try {
    await administrator.query(`CREATE DATABASE ${databaseName}`);
  } finally {
    await administrator.end();
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
  const runtimePool = runtime;
  const sessions = createSessionRepository(runtimePool);
  const passkeys = createSecurityPasskeyRepository(runtimePool);
  const operations = createAccountOperationRepository(runtimePool);
  const providerAccounts = createProviderAccounts(runtimePool);
  async function fixture() {
    const token = createSessionToken();
    const { user } = await providerAccounts.exchange(
      {
        subject: `did:privy:${randomUUID()}`,
        sessionId: randomUUID(),
        email: `${randomUUID()}@example.test`,
        methods: ["email"],
        issuedAt: Math.floor(Date.now() / 1000),
        credentialsDigest: "a".repeat(64),
      },
      token.tokenHash,
      new Date(Date.now() + 600000),
    );
    return { userId: user.id, token: token.token };
  }
  const applicationPort = await availablePort();
  const origin = `http://localhost:${applicationPort}`;
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
      `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>YapArena security browser acceptance</title><link rel="stylesheet" href="/assets/site.css"><link rel="stylesheet" href="/assets/arena.css"><link rel="stylesheet" href="/assets/account-auth.css"><script defer src="/axe.js"></script></head><body><main class="container"><h1>Account security</h1><p>LOCAL REAL BACKEND · Synthetic account · Chrome virtual authenticator · No physical device or provider login</p><section id="account-security-passkeys" class="information-card account-card"></section></main><script type="module" src="/assets/account-security.bundle.js"></script></body></html>`,
    ),
  );
  const authenticated = createRequireAuthentication({
    sessions,
    environment: "test",
  });
  app.get("/api/auth/methods", authenticated, async (request, response) => {
    const result = await runtimePool.query<{ legacyPassword: boolean }>(
      'SELECT password_hash IS NOT NULL AS "legacyPassword" FROM users WHERE id=$1',
      [request.user!.id],
    );
    response.json(result.rows[0]);
  });
  app.get("/api/auth/wallets", authenticated, async (request, response) => {
    const result = await runtimePool.query<{
      id: string;
      address: string;
      chainId: string;
    }>(
      'SELECT id,address,chain_id AS "chainId" FROM wallet_identities WHERE user_id=$1 ORDER BY id',
      [request.user!.id],
    );
    response.json({ wallets: result.rows });
  });
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
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => {
      void _next;
      errors.push(
        error instanceof Error ? error.name : "unclassified backend error",
      );
      response.status(500).json({ error: "isolated backend failure" });
    },
  );
  httpServer = app.listen(applicationPort, "127.0.0.1");
  await once(httpServer, "listening");
  browser = await chromium.launch({
    executablePath:
      process.env.BROWSER_CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 1000 }],
    ["mobile", { width: 390, height: 844 }],
  ] as const) {
    phase = `${name}: real browser security ceremony`;
    const identity = await fixture();
    const context = await browser.newContext({
      viewport,
      reducedMotion: "reduce",
    });
    await context.addCookies([
      {
        name: "session",
        value: identity.token,
        url: origin,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    // Model a person authenticating with an existing device, then selecting a
    // different device for enrollment. Only scheduling is instrumented: the
    // original native WebAuthn API generates every protocol response.
    await context.addInitScript(() => {
      const nativeCreate = CredentialsContainer.prototype.create;
      let registrations = 0;
      CredentialsContainer.prototype.create = async function (
        this: CredentialsContainer,
        options?: CredentialCreationOptions,
      ) {
        if (++registrations > 1)
          await new Promise<void>((done) => {
            Reflect.set(window, "__continueSecurityRegistration", done);
          });
        return nativeCreate.call(this, options);
      };
    });
    const page = await context.newPage();
    lastPage = page;
    page.on("pageerror", (error) => errors.push(error.name));
    page.on("response", (response) => {
      if (response.status() >= 400)
        responseFailures.push({
          route: new URL(response.url()).pathname.replace(
            /[0-9a-f]{8}-[0-9a-f-]{27,}/g,
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
    const completions: { path: string; body: unknown }[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST" && path.endsWith("/complete"))
        completions.push({ path, body: request.postDataJSON() as unknown });
    });
    await page.goto(origin);
    phase = `${name}: load security passkey controls`;
    const root = page.locator("#account-security-passkeys");
    const add = root.getByRole("button", {
      name: "Add security passkey",
      exact: true,
    });
    await root
      .getByText("No security passkey added yet.", { exact: true })
      .waitFor();
    phase = `${name}: first key registration`;
    await add.click();
    await root
      .getByText("Security passkey added. Other sessions were signed out.", {
        exact: true,
      })
      .waitFor();
    assert.equal((await passkeys.list(identity.userId)).length, 1);
    phase = `${name}: replay, old-session and cross-account rejection`;
    assert.equal(completions.length, 1);
    const first = completions[0]!;
    assert.equal(
      (
        await context.request.post(`${origin}${first.path}`, {
          headers: { origin },
          data: first.body,
        })
      ).status(),
      410,
    );
    assert.equal(
      await sessions.findUserByTokenHash(
        createHash("sha256").update(identity.token).digest("hex"),
      ),
      null,
    );
    const other = await fixture();
    const outsider = await browser.newContext();
    await outsider.addCookies([
      {
        name: "session",
        value: other.token,
        url: origin,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    assert.equal(
      (
        await outsider.request.post(`${origin}${first.path}`, {
          headers: { origin },
          data: first.body,
        })
      ).status(),
      410,
    );
    await outsider.close();
    checks.push(
      `${name}: actual navigator.credentials registration verified by real runtime PostgreSQL backend; session rotated; replay and cross-account completion rejected`,
    );
    phase = `${name}: cancel second-key approval`;
    await add.click();
    const approval = page.getByRole("dialog");
    await approval
      .getByRole("heading", { name: "Add security passkey", exact: true })
      .waitFor();
    await approval.press("Escape");
    await root
      .getByText("Security passkey setup cancelled.", { exact: true })
      .waitFor();
    assert.equal((await passkeys.list(identity.userId)).length, 1);
    assert.equal(
      await add.evaluate((element) => document.activeElement === element),
      true,
    );
    phase = `${name}: authorize second-key registration`;
    await add.click();
    await approval
      .getByRole("button", { name: "Approve change", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        typeof Reflect.get(window, "__continueSecurityRegistration") ===
        "function",
    );
    await cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
      authenticatorId,
      enabled: false,
    });
    const secondAuthenticator = await cdp.send(
      "WebAuthn.addVirtualAuthenticator",
      {
        options: {
          protocol: "ctap2",
          transport: "usb",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      },
    );
    await page.evaluate(() => {
      const resume: unknown = Reflect.get(
        window,
        "__continueSecurityRegistration",
      );
      if (typeof resume !== "function")
        throw new Error("native registration pause missing");
      Reflect.deleteProperty(window, "__continueSecurityRegistration");
      resume();
    });
    await root
      .getByText("Security passkey added. Other sessions were signed out.", {
        exact: true,
      })
      .waitFor();
    assert.equal((await passkeys.list(identity.userId)).length, 2);
    phase = `${name}: authorize key removal with retained key`;
    await root
      .getByRole("button", { name: /^Remove security passkey added/ })
      .first()
      .click();
    await approval
      .getByRole("button", { name: "Approve change", exact: true })
      .click();
    await root
      .getByText("Security passkey removed. Other sessions were signed out.", {
        exact: true,
      })
      .waitFor();
    assert.equal((await passkeys.list(identity.userId)).length, 1);
    checks.push(
      `${name}: browser-generated operation authentication adds a second key and authorizes removal using a retained key; cancellation preserves credentials and restores focus`,
    );
    phase = `${name}: final-key, origin and accessibility checks`;
    await root
      .getByRole("button", { name: /^Remove security passkey added/ })
      .click();
    await approval
      .getByRole("heading", { name: "Remove security passkey", exact: true })
      .waitFor();
    assert.equal(
      await approval
        .getByRole("button", { name: "Approve change", exact: true })
        .isDisabled(),
      true,
    );
    await approval
      .getByText(
        "An existing trusted credential is required. Recover your security passkey or linked wallet before changing account security.",
        { exact: true },
      )
      .waitFor();
    await approval.press("Escape");
    assert.equal((await passkeys.list(identity.userId)).length, 1);
    const attempted = await context.request.post(
      `${origin}/api/auth/security/passkeys/enrollment`,
      { headers: { origin: "https://untrusted.invalid" }, data: {} },
    );
    assert.equal(attempted.status(), 403);
    await page.waitForFunction(() => Boolean(window.axe));
    assert.deepEqual(
      await page.evaluate(async () =>
        (
          await window.axe.run("main", {
            runOnly: {
              type: "tag",
              values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
            },
          })
        ).violations.map((entry) => ({ id: entry.id, impact: entry.impact })),
      ),
      [],
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: resolve(evidenceDirectory, `${name}.png`),
      fullPage: true,
    });
    checks.push(
      `${name}: final key cannot approve its own removal; cross-origin mutation rejected; automated WCAG tags and no horizontal overflow pass`,
    );
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
    await cdp.send("WebAuthn.removeVirtualAuthenticator", {
      authenticatorId: secondAuthenticator.authenticatorId,
    });
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(evidenceDirectory, "results.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        revision: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        sourceHashes: Object.fromEntries(
          await Promise.all(
            [
              "scripts/verify-security-passkey-browser.ts",
              "public/account-security.bundle.js",
              "src/platform/auth/security-passkeys.ts",
              "src/platform/auth/security-router.ts",
              "src/platform/auth/account-operations.ts",
              "dist/platform/auth/security-passkeys.js",
              "dist/platform/auth/security-router.js",
              "dist/platform/auth/account-operations.js",
            ].map(async (path) => [path, await sourceHash(path)]),
          ),
        ),
        postgres: version,
        scope:
          "Real browser WebAuthn API, Chrome virtual CTAP2 authenticator and real runtime-role PostgreSQL application backend; synthetic provider identity/session setup; not genuine Privy authentication, hosted acceptance, screen-reader or physical-device evidence.",
        checks,
        errors,
      },
      null,
      2,
    ) + "\n",
  );
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
      responseFailures,
      action:
        "Inspect isolated harness; credentials, protocol responses and database URLs omitted.",
    }),
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (httpServer) {
    httpServer.closeAllConnections();
    await new Promise<void>((done, fail) =>
      httpServer!.close((error) => (error ? fail(error) : done())),
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
