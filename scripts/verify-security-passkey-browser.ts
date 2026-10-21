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
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import type {} from "pino-http";
import { provisionDatabase } from "./provision-database.ts";
import { createAccountSecurityRouter } from "../dist/platform/auth/security-router.js";
import { createSecurityPasskeyRepository } from "../dist/platform/auth/security-passkeys.js";
import { createAccountOperationRepository } from "../dist/platform/auth/account-operations.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import { createProviderAccounts } from "../dist/platform/auth/provider-accounts.js";
import { createProviderIdentityRecovery } from "../dist/platform/auth/provider-identity-recovery.js";
import { createProviderRevocation } from "../dist/platform/auth/provider-revocation.js";
import { createProviderSessionMonitor } from "../dist/platform/auth/provider-session-monitor.js";
import { providerCredentialsDigest } from "../dist/platform/auth/provider-credentials.js";
import {
  ProviderCredentialChangedError,
  ProviderUnavailableError,
  type ProviderIdentity,
} from "../dist/platform/auth/privy.js";
import { createIdentityRepository } from "../dist/features/identity/repository.js";
import { createCoinSandboxRepository } from "../dist/features/account-wallet/sandbox-repository.js";
import { createSessionToken } from "../dist/platform/auth/session-tokens.js";
import {
  createRequireAuthentication,
  createAuthRouter,
} from "../dist/platform/auth/router.js";
import { createUserRepository } from "../dist/platform/auth/users.js";
import { createProviderPasskeys } from "../dist/platform/auth/provider-passkeys.js";
import { createAccountAccessRepository } from "../dist/platform/auth/account-access.js";

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
  "docs/evidence/account-completion-baseline/security-passkey-browser/privy-only",
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
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function requestOptions(value: unknown): PublicKeyCredentialRequestOptionsJSON {
  assert.ok(object(value));
  assert.equal(typeof value.challenge, "string");
  assert.ok(typeof value.challenge === "string");
  assert.ok(typeof value.rpId === "string");
  assert.ok(typeof value.timeout === "number");
  assert.equal(value.userVerification, "required");
  assert.equal(value.extensions, undefined);
  assert.ok(Array.isArray(value.allowCredentials));
  return {
    challenge: value.challenge,
    rpId: value.rpId,
    timeout: value.timeout,
    userVerification: "required",
    allowCredentials: value.allowCredentials.map((credential: unknown) => {
      assert.ok(object(credential) && typeof credential.id === "string");
      assert.equal(credential.type, "public-key");
      assert.equal(credential.transports, undefined);
      return { type: "public-key", id: credential.id };
    }),
  };
}
function authenticationResponse(value: unknown): AuthenticationResponseJSON {
  assert.ok(
    object(value) &&
      typeof value.id === "string" &&
      typeof value.rawId === "string" &&
      value.type === "public-key" &&
      object(value.response),
  );
  assert.deepEqual(value.clientExtensionResults, {});
  const response = value.response;
  assert.ok(
    typeof response.clientDataJSON === "string" &&
      typeof response.authenticatorData === "string" &&
      typeof response.signature === "string",
  );
  assert.ok(
    response.userHandle === undefined ||
      typeof response.userHandle === "string",
  );
  return {
    id: value.id,
    rawId: value.rawId,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: response.clientDataJSON,
      authenticatorData: response.authenticatorData,
      signature: response.signature,
      ...(typeof response.userHandle === "string"
        ? { userHandle: response.userHandle }
        : {}),
    },
  };
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
  const providerAccounts = createProviderAccounts(runtimePool);
  const profiles = createIdentityRepository(runtimePool);
  const sandbox = createCoinSandboxRepository(runtimePool, {
    rail: "simulation",
  });
  const providerIdentities = new Map<string, ProviderIdentity>();
  const providerTokens = new Map<string, ProviderIdentity>();
  const syntheticFrozenAt = new Map<string, number | null>();
  const normalControlCalls: string[] = [];
  // The minimal backend does not start src/server.ts's external worker. Use
  // the real durable worker with explicitly synthetic provider controls, and
  // synchronize it as a separate fixture step before asserting refreshed UI.
  const normalRevocation = createProviderRevocation(runtimePool, {
    async state(subject) {
      return { frozenAt: syntheticFrozenAt.get(subject) ?? null };
    },
    async freeze(subject) {
      normalControlCalls.push("freeze");
      syntheticFrozenAt.set(subject, Math.floor(Date.now() / 1000));
    },
    async unfreeze(subject) {
      normalControlCalls.push("unfreeze");
      syntheticFrozenAt.set(subject, null);
    },
  });
  async function drainNormalReset(userId: string) {
    await normalRevocation.synchronize(userId);
    assert.equal(
      (
        await runtimePool.query<{ complete: boolean }>(
          `SELECT j.state='complete' AND j.control_phase='done' AND p.auth_generation=u.auth_generation AS complete
         FROM users u JOIN provider_identities p ON p.user_id=u.id
         JOIN provider_revocation_jobs j ON j.user_id=u.id AND j.generation=u.auth_generation WHERE u.id=$1`,
          [userId],
        )
      ).rows[0]?.complete,
      true,
    );
  }
  const verifier = {
    async configuration() {
      return { google: true, passkeys: true };
    },
    async verify(token: string) {
      const identity = providerTokens.get(token);
      assert.ok(identity, "synthetic provider token not configured");
      return identity;
    },
    async inspect(subject: string) {
      if (syntheticFrozenAt.get(subject))
        throw new ProviderCredentialChangedError(
          "synthetic owned provider freeze",
        );
      const identity = providerIdentities.get(subject);
      assert.ok(identity, "synthetic provider identity not configured");
      return identity;
    },
  };
  const operations = createAccountOperationRepository(runtimePool, verifier);
  const providerPasskeys = createProviderPasskeys(runtimePool, verifier);
  const providerSessions = createSessionRepository(runtimePool, {
    verifyProviderSession: createProviderSessionMonitor(runtimePool, verifier),
  });
  const providerIdentityRecovery = createProviderIdentityRecovery(
    runtimePool,
    verifier,
  );
  function providerIdentity(method: "email" | "google_oauth" = "email") {
    const identifier =
      method === "email"
        ? `${randomUUID()}@example.test`
        : `synthetic-google:${randomUUID()}`;
    const credentials = [{ type: method, id: identifier }];
    const identity: ProviderIdentity = {
      subject: `did:privy:${randomUUID()}`,
      sessionId: randomUUID(),
      email: method === "email" ? identifier : null,
      methods: [method],
      issuedAt: Math.floor(Date.now() / 1000),
      credentialsDigest: providerCredentialsDigest(credentials),
      credentials,
    };
    providerIdentities.set(identity.subject, identity);
    return identity;
  }
  async function fixture(method: "email" | "google_oauth" = "email") {
    const token = createSessionToken();
    const identity = providerIdentity(method);
    const { user } = await providerAccounts.exchange(
      identity,
      token.tokenHash,
      new Date(Date.now() + 600000),
    );
    return { userId: user.id, token: token.token, providerIdentity: identity };
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
      `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>YapArena security browser acceptance</title><link rel="stylesheet" href="/assets/site.css"><link rel="stylesheet" href="/assets/arena.css"><link rel="stylesheet" href="/assets/account-auth.css"><script defer src="/assets/session-coordination.js"></script><script defer src="/axe.js"></script></head><body><main class="container"><h1>Account security</h1><p>LOCAL REAL BACKEND · Synthetic account · Chrome virtual authenticator · No physical device or provider login</p><section id="account-security-passkeys" class="information-card account-card"></section></main><script type="module" src="/assets/account-security.bundle.js"></script></body></html>`,
    ),
  );
  app.get("/provider-sdk", (_request, response) =>
    response.send(
      `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Privy single-key local backend acceptance</title><link rel="stylesheet" href="/assets/site.css"><link rel="stylesheet" href="/assets/arena.css"><link rel="stylesheet" href="/assets/account-auth.css"><script defer src="/assets/session-coordination.js"></script></head><body><main class="container"><h1>Account settings</h1><p>LOCAL REAL BACKEND · Synthetic Privy responses · Installed SDK · Chrome virtual authenticator · No genuine provider acceptance</p><p id="account-notice" role="status"></p><div id="email-auth"></div><section id="provider-settings" class="information-card account-card"></section><section id="account-security-passkeys" class="information-card account-card"></section></main><script type="module" src="/assets/account-security.bundle.js"></script><script type="module" src="/assets/account-auth.bundle.js"></script></body></html>`,
    ),
  );
  let usingProviderBridge = false;
  const publicAppId = "cmvfjb3r800vy0hl3heg2cuvv";
  function authRoutes() {
    return createAuthRouter({
      users: createUserRepository(runtimePool),
      sessions: providerSessions,
      environment: "test",
      applicationOrigin: origin,
      provider: { appId: publicAppId, verifier, accounts: providerAccounts },
    });
  }
  let providerAuthRouter = authRoutes();
  app.use("/api/auth", (request, response, next) =>
    providerAuthRouter(request, response, next),
  );
  const authenticated: express.RequestHandler = (request, response, next) =>
    createRequireAuthentication({
      sessions: usingProviderBridge ? providerSessions : sessions,
      environment: "test",
    })(request, response, next);
  app.get("/api/auth/methods", authenticated, async (request, response) => {
    const result = await runtimePool.query<{ legacyPassword: boolean }>(
      'SELECT password_hash IS NOT NULL AS "legacyPassword" FROM users WHERE id=$1',
      [request.user!.id],
    );
    response.json({
      ...result.rows[0],
      provider: await providerAccounts.details(request.user!.id),
    });
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
  const scopedAttempts = new Map<string, number>();
  function securityRoutes(providerBridge = false) {
    return createAccountSecurityRouter({
      sessions: providerBridge ? providerSessions : sessions,
      operations,
      passkeys,
      providerIdentityRecovery,
      ...(providerBridge
        ? {
            providerPasskeys,
            authorizeProviderPasskeyAttempt: async (userId: string) => {
              assert.match(userId, /^\d+$/);
              scopedAttempts.set(userId, (scopedAttempts.get(userId) ?? 0) + 1);
            },
            access: createAccountAccessRepository(runtimePool, verifier),
          }
        : {}),
      environment: "test",
      applicationOrigin: origin,
    });
  }
  let securityRouter = securityRoutes();
  app.use("/api/auth", (request, response, next) =>
    securityRouter(request, response, next),
  );
  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => {
      void _next;
      if (error instanceof ProviderUnavailableError)
        return response
          .status(503)
          .json({ error: "provider verification is awaiting confirmation" });
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
  const metadataResponse = await fetch(
    `https://auth.privy.io/api/v1/apps/${publicAppId}`,
    {
      headers: { "privy-app-id": publicAppId },
      signal: AbortSignal.timeout(10000),
    },
  );
  assert.equal(metadataResponse.status, 200);
  const metadata: unknown = await metadataResponse.json();
  assert.ok(object(metadata));
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 1000 }],
    ["mobile", { width: 390, height: 844 }],
  ] as const) {
    phase = `${name}: installed SDK with real same-key backend`;
    usingProviderBridge = true;
    securityRouter = securityRoutes(true);
    providerAuthRouter = authRoutes();
    const context = await browser.newContext({
      viewport,
      reducedMotion: "reduce",
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
    const identity = providerIdentity();
    const now = Math.floor(Date.now() / 1000),
      email = identity.email!;
    const token = [
      Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT" })).toString(
        "base64url",
      ),
      Buffer.from(
        JSON.stringify({
          iss: "privy.io",
          aud: publicAppId,
          sub: identity.subject,
          sid: identity.sessionId,
          iat: now,
          exp: now + 600,
        }),
      ).toString("base64url"),
      "synthetic-provider-signature",
    ].join(".");
    providerTokens.set(token, identity);
    let providerInitCalls = 0,
      providerLinkCalls = 0,
      activationCalls = 0,
      registrationCount = 0;
    let credentialId: string | undefined;
    const registration = await generateRegistrationOptions({
      rpName: "Synthetic Privy provider fixture",
      rpID: new URL(origin).hostname,
      userID: new Uint8Array(randomBytes(32)),
      userName: email,
      attestationType: "none",
      supportedAlgorithmIDs: [-7],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        residentKey: "required",
        userVerification: "required",
      },
    });
    function acceptLinkedKey(id: string, key: Uint8Array) {
      credentialId = id;
      identity.credentials = [
        ...identity.credentials!,
        { type: "passkey", id },
      ];
      identity.methods = ["email", "passkey"];
      identity.credentialsDigest = providerCredentialsDigest(
        identity.credentials,
      );
      identity.passkeys = [
        { credentialId: id, publicKey: Buffer.from(key).toString("base64") },
      ];
    }
    async function verifyFixtureRegistration(
      response: RegistrationResponseJSON,
    ) {
      const verified = await verifyRegistrationResponse({
        response,
        expectedChallenge: registration.challenge,
        expectedOrigin: origin,
        expectedRPID: new URL(origin).hostname,
        requireUserVerification: true,
      });
      assert.equal(verified.verified, true);
      assert.ok(verified.registrationInfo);
      registrationCount++;
      acceptLinkedKey(
        verified.registrationInfo.credential.id,
        verified.registrationInfo.credential.publicKey,
      );
    }
    const providerUser = () => ({
      id: identity.subject,
      is_guest: false,
      created_at: now - 100,
      has_accepted_terms: true,
      mfa_methods: [],
      linked_accounts: [
        {
          type: "email",
          address: email,
          verified_at: now,
          first_verified_at: now - 100,
          latest_verified_at: now,
        },
        ...(credentialId
          ? [
              {
                type: "passkey",
                credential_id: credentialId,
                authenticator_name: "Synthetic Chrome authenticator",
                verified_at: now,
                first_verified_at: now,
                latest_verified_at: now,
              },
            ]
          : []),
      ],
    });
    const providerSession = () => ({
      user: providerUser(),
      token,
      privy_access_token: token,
      refresh_token: "synthetic-refresh-not-provider-issued",
      is_new_user: false,
      session_update_action: "set",
    });
    const unexpectedPaths: string[] = [];
    await context.route(
      (url) =>
        url.origin === "https://auth.privy.io" &&
        url.pathname.startsWith("/api/"),
      async (route) => {
        const path = new URL(route.request().url()).pathname;
        const headers = {
          "access-control-allow-origin": origin,
          "access-control-allow-credentials": "true",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers":
            route.request().headers()["access-control-request-headers"] ??
            "authorization, content-type, privy-app-id",
        };
        if (route.request().method() === "OPTIONS")
          return route.fulfill({ status: 204, headers });
        if (path === `/api/v1/apps/${publicAppId}`)
          return route.fulfill({
            headers,
            json: {
              ...metadata,
              captcha_enabled: false,
              enabled_captcha_provider: null,
            },
          });
        if (
          path === "/api/v1/passwordless/init" ||
          path === "/api/v1/analytics_events" ||
          path === "/api/v1/sessions/logout"
        )
          return route.fulfill({ headers, json: { success: true } });
        if (
          path === "/api/v1/passwordless/authenticate" ||
          path === "/api/v1/sessions"
        )
          return route.fulfill({ headers, json: providerSession() });
        if (path === "/api/v1/users/me")
          return route.fulfill({ headers, json: { user: providerUser() } });
        if (path === "/api/v1/passkeys/link/init") {
          providerInitCalls++;
          return route.fulfill({
            headers,
            json: {
              relying_party: origin,
              options: {
                rp: registration.rp,
                user: {
                  id: registration.user.id,
                  name: registration.user.name,
                  display_name: registration.user.displayName,
                },
                challenge: registration.challenge,
                pub_key_cred_params: registration.pubKeyCredParams,
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
          const body: unknown = route.request().postDataJSON();
          assert.ok(object(body) && object(body.authenticator_response));
          const credential = body.authenticator_response;
          assert.ok(
            typeof credential.id === "string" && object(credential.response),
          );
          const response = credential.response;
          assert.ok(
            typeof response.client_data_json === "string" &&
              typeof response.attestation_object === "string",
          );
          await verifyFixtureRegistration({
            id: credential.id,
            rawId: credential.id,
            type: "public-key",
            clientExtensionResults: {},
            response: {
              clientDataJSON: response.client_data_json,
              attestationObject: response.attestation_object,
            },
          });
          return route.fulfill({ headers, json: providerUser() });
        }
        unexpectedPaths.push(path);
        return route.abort();
      },
    );
    const completedBodies: { path: string; body: unknown }[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (
        request.method() === "POST" &&
        path.includes("/provider/passkeys/") &&
        path.endsWith("/complete")
      )
        completedBodies.push({ path, body: request.postDataJSON() as unknown });
      if (request.method() === "POST" && path.endsWith("/activation"))
        activationCalls++;
    });
    await page.goto(`${origin}/provider-sdk`);
    if (name === "mobile") {
      // Existing-provider-key mode: create a native fixture credential once,
      // before the synthetic provider login. This is not a product registration.
      const { extensions, ...creation } = registration;
      assert.deepEqual(extensions, { credProps: true });
      const response = await page.evaluate(
        async (options) => {
          const key = await navigator.credentials.create({
            publicKey:
              PublicKeyCredential.parseCreationOptionsFromJSON(options),
          });
          if (
            !(key instanceof PublicKeyCredential) ||
            !(key.response instanceof AuthenticatorAttestationResponse)
          )
            throw new Error("fixture provider credential missing");
          const json = key.toJSON();
          return json;
        },
        { ...creation, extensions: { credProps: true } },
      );
      assert.ok(
        object(response) &&
          object(response.response) &&
          typeof response.id === "string" &&
          typeof response.response.clientDataJSON === "string" &&
          typeof response.response.attestationObject === "string",
      );
      await verifyFixtureRegistration({
        id: response.id,
        rawId: response.id,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: response.response.clientDataJSON,
          attestationObject: response.response.attestationObject,
        },
      });
    }
    const auth = page.locator("#email-auth");
    phase = `${name}: synthetic SDK email login into real application router`;
    await auth.getByLabel("Email address", { exact: true }).fill(email);
    await auth
      .getByRole("button", { name: "Continue with email", exact: false })
      .click();
    await auth.getByLabel("Verification code", { exact: true }).fill("123456");
    await auth
      .getByRole("button", { name: "Verify and continue", exact: false })
      .click();
    await page
      .getByText("You’re signed in. Your profile is optional.", { exact: true })
      .waitFor();
    const originalCookie = (await context.cookies()).find(
      (entry) => entry.name === "session",
    );
    assert.ok(originalCookie);
    const originalHash = createHash("sha256")
      .update(originalCookie.value)
      .digest("hex");
    const account = await sessions.findUserByTokenHash(originalHash);
    assert.ok(account);
    // This deliberately minimal SDK page has no account.ts controller. Supply
    // its comparison hint only after an actual successful cookie-authenticated
    // GET; the bridge still derives and verifies the owner independently.
    await page.evaluate(async () => {
      const response = await fetch("/api/auth/me", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok)
        throw new Error("fixture current account verification failed");
      const value: { user?: { id?: unknown } } = await response.json();
      if (typeof value.user?.id !== "string")
        throw new Error("fixture current account ID missing");
      window.yapRememberSessionAccount?.(value.user.id);
    });
    const countBefore = (
      await runtimePool.query<{ count: number }>(
        "SELECT count(*)::int count FROM users",
      )
    ).rows[0]!.count;
    await page.screenshot({
      path: resolve(evidenceDirectory, `provider-${name}-before.png`),
      fullPage: true,
    });
    const activationFinished = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.includes("/provider/passkeys/") &&
        new URL(response.url()).pathname.endsWith("/complete") &&
        response.status() === 200,
    );
    if (name === "desktop") {
      phase = `${name}: installed SDK native provider registration`;
      await page
        .getByRole("button", { name: "Add a passkey", exact: true })
        .click();
    } else {
      phase = `${name}: existing provider-key native activation`;
      await page
        .getByRole("button", { name: "Finish passkey setup", exact: true })
        .click();
    }
    await activationFinished;
    const controlsBefore = normalControlCalls.length;
    await drainNormalReset(account.id);
    assert.deepEqual(normalControlCalls.slice(controlsBefore), [
      "freeze",
      "unfreeze",
    ]);
    await page.evaluate(() =>
      window.dispatchEvent(new Event("yap:account-changed")),
    );
    phase = `${name}: real provider-key bridge completion notice`;
    await page
      .getByText(
        "Passkey ready for sign-in and account approvals. Other sessions were signed out.",
        { exact: true },
      )
      .waitFor();
    await page
      .getByText("Passkey · Ready for sign-in and account approvals", {
        exact: true,
      })
      .waitFor();
    assert.equal(
      await page.locator("#account-security-passkeys").isHidden(),
      true,
    );
    assert.equal(registrationCount, 1);
    assert.equal(providerInitCalls, name === "desktop" ? 1 : 0);
    assert.equal(providerLinkCalls, name === "desktop" ? 1 : 0);
    assert.ok(activationCalls >= 1);
    const keys = await passkeys.list(account.id);
    assert.equal(keys.length, 1);
    const key = keys[0]!;
    assert.equal(key.credentialId, credentialId);
    assert.equal(key.provenance, "privy");
    assert.equal(
      (
        await runtimePool.query<{ count: number }>(
          "SELECT count(*)::int count FROM users",
        )
      ).rows[0]!.count,
      countBefore,
    );
    const currentCookie = (await context.cookies()).find(
      (entry) => entry.name === "session",
    );
    assert.ok(currentCookie);
    assert.notEqual(currentCookie.value, originalCookie.value);
    assert.equal(await sessions.findUserByTokenHash(originalHash), null);
    const currentHash = createHash("sha256")
      .update(currentCookie.value)
      .digest("hex");
    assert.equal(
      (await providerSessions.findUserByTokenHash(currentHash))?.id,
      account.id,
    );
    assert.equal(completedBodies.length, 1);
    assert.equal(scopedAttempts.get(account.id), 1);
    const completed = completedBodies[0]!;
    assert.equal(
      (
        await context.request.post(`${origin}${completed.path}`, {
          headers: { origin, authorization: `Bearer ${token}` },
          data: completed.body,
        })
      ).status(),
      410,
    );
    const outsider = await browser.newContext();
    const other = await fixture();
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
        await outsider.request.post(`${origin}${completed.path}`, {
          headers: { origin, authorization: `Bearer ${token}` },
          data: completed.body,
        })
      ).status(),
      410,
    );
    await outsider.close();
    checks.push(
      `${name}: installed SDK ${name === "desktop" ? "registers one native virtual credential" : "uses the existing native fixture credential"}; real same-key bridge activates its exported COSE key, rotates one application cookie and rejects completion replay/cross-account use without creating another user`,
    );
    const terms = {
      amount: "5000000",
      asset: "USDC",
      destination: "fixture-only-destination",
    };
    const proof = await operations.create({
      userId: account.id,
      sessionTokenHash: currentHash,
      origin,
      purpose: "withdrawal.request",
      terms,
      credential: { type: "passkey", keyId: key.id },
    });
    assert.ok(proof.authenticationOptions);
    const authentication = authenticationResponse(
      await page.evaluate(async (options) => {
        const value = await navigator.credentials.get({
          publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options),
        });
        if (
          !(value instanceof PublicKeyCredential) ||
          !(value.response instanceof AuthenticatorAssertionResponse)
        )
          throw new Error("native operation proof missing");
        return value.toJSON();
      }, requestOptions(proof.authenticationOptions)),
    );
    const approval = await operations.prepare({
      userId: account.id,
      sessionTokenHash: currentHash,
      origin,
      id: proof.id,
      purpose: "withdrawal.request",
      terms,
      rpcUrls: {},
      authentication,
    });
    const connection = await runtimePool.connect();
    try {
      await connection.query("BEGIN");
      await approval.consume(connection, async () => {});
      await connection.query("COMMIT");
    } finally {
      connection.release();
    }
    await assert.rejects(
      operations.prepare({
        userId: account.id,
        sessionTokenHash: currentHash,
        origin,
        id: proof.id,
        purpose: "withdrawal.request",
        terms,
        rpcUrls: {},
        authentication,
      }),
      (error) => object(error) && error.status === 410,
    );
    await assert.rejects(
      operations.create({
        userId: account.id,
        sessionTokenHash: currentHash,
        origin,
        purpose: "provider.credentials.change",
        terms: {
          action: "remove",
          method: "passkey",
          target: key.credentialId,
        },
        credential: { type: "passkey", keyId: key.id },
      }),
      (error) => object(error) && error.status === 403,
    );
    assert.equal(
      (await cdp.send("WebAuthn.getCredentials", { authenticatorId }))
        .credentials.length,
      1,
    );
    assert.deepEqual(unexpectedPaths, []);
    await page.screenshot({
      path: resolve(evidenceDirectory, `provider-${name}-after.png`),
      fullPage: true,
    });
    checks.push(
      `${name}: the exact same native credential signs a fresh amount/asset/destination-bound application proof; PostgreSQL consumes it once, replay and self-removal authorization fail, and no second credential or financial transfer is created`,
    );
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
    await context.close();
  }
  usingProviderBridge = false;

  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 1000 }],
    ["mobile", { width: 390, height: 844 }],
  ] as const) {
    // Each viewport is an independent application fixture. Keep its real
    // 30-request mutation limiter intact without spending the next fixture's
    // IP budget on the preceding desktop scenario.
    securityRouter = securityRoutes();
    phase = `${name}: real browser security ceremony`;
    const identity = await fixture(
      name === "mobile" ? "google_oauth" : "email",
    );
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
    await page.waitForFunction(
      () => typeof window.yapApproveProviderChange === "function",
    );
    assert.equal(await root.isHidden(), true);
    assert.equal(
      await root
        .getByRole("button", { name: "Add security passkey", exact: true })
        .count(),
      0,
    );
    async function legacyEnrollment(
      prepare?: (
        operation: Awaited<ReturnType<typeof passkeys.enrollmentOptions>>,
      ) => Promise<unknown>,
    ) {
      const cookie = (await context.cookies()).find(
        (entry) => entry.name === "session",
      );
      assert.ok(cookie);
      const input = {
        userId: identity.userId,
        sessionTokenHash: createHash("sha256")
          .update(cookie.value)
          .digest("hex"),
        origin,
      };
      // A fixture-only native ceremony preserves acceptance for already retained
      // legacy credentials. The removed product enrollment UI is not exercised.
      const operation = await passkeys.enrollmentOptions(input);
      const approval = prepare ? await prepare(operation) : undefined;
      const { extensions, ...creationOptions } = operation.options;
      assert.deepEqual(extensions, { credProps: true });
      const response = await page.evaluate(
        async (options) => {
          const credential = await navigator.credentials.create({
            publicKey:
              PublicKeyCredential.parseCreationOptionsFromJSON(options),
          });
          if (
            !(credential instanceof PublicKeyCredential) ||
            !(credential.response instanceof AuthenticatorAttestationResponse)
          )
            throw new Error("native legacy fixture registration missing");
          return credential.toJSON();
        },
        { ...creationOptions, extensions: { credProps: true } },
      );
      const path = `/api/auth/security/passkeys/enrollment/${operation.id}/complete`,
        body = { response, ...(approval ? { approval } : {}) };
      const completed = await context.request.post(`${origin}${path}`, {
        headers: { origin },
        data: body,
      });
      assert.equal(completed.status(), 200);
      completions.push({ path, body });
      await drainNormalReset(identity.userId);
      await page.evaluate(() =>
        window.dispatchEvent(new Event("yap:account-changed")),
      );
    }
    phase = `${name}: fixture-only native legacy key preparation`;
    await legacyEnrollment();
    await root
      .getByRole("button", { name: /^Remove existing security key added/ })
      .waitFor();
    assert.equal(await root.isVisible(), true);
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
      `${name}: fixture-only native legacy registration verified by real runtime PostgreSQL backend (not a current enrollment UI); session rotated; replay and cross-account completion rejected`,
    );
    phase = `${name}: cancel generated retained-approval dialog`;
    await page.evaluate(
      (terms) => {
        const button = document.createElement("button");
        button.id = "legacy-fixture-approval";
        button.textContent = "Synthetic retained-approval fixture";
        button.addEventListener("click", () => {
          void window.yapPrepareProviderPasskey?.(terms).catch(() => {
            button.dataset.cancelled = "true";
          });
        });
        document.querySelector("main")?.append(button);
      },
      {
        intentId: randomUUID(),
        subject: identity.providerIdentity.subject,
        beforeDigest: identity.providerIdentity.credentialsDigest,
      },
    );
    const add = page.locator("#legacy-fixture-approval"),
      approval = page.getByRole("dialog");
    await add.click();
    await approval
      .getByRole("heading", { name: "Approve Privy passkey", exact: true })
      .waitFor();
    await approval.press("Escape");
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLElement>("#legacy-fixture-approval")?.dataset
          .cancelled === "true",
    );
    assert.equal((await passkeys.list(identity.userId)).length, 1);
    assert.equal(
      await add.evaluate((element) => document.activeElement === element),
      true,
    );
    await add.evaluate((element) => element.remove());
    phase = `${name}: retain native legacy two-key protocol acceptance`;
    let secondAuthenticator: { authenticatorId: string } | undefined;
    await legacyEnrollment(async (challenge) => {
      const cookie = (await context.cookies()).find(
        (entry) => entry.name === "session",
      );
      assert.ok(cookie);
      const operation = await operations.create({
        userId: identity.userId,
        sessionTokenHash: createHash("sha256")
          .update(cookie.value)
          .digest("hex"),
        origin,
        purpose: "security.passkey.enroll",
        terms: { challengeId: challenge.id },
        credential: {
          type: "passkey",
          keyId: (await passkeys.list(identity.userId))[0]!.id,
        },
      });
      assert.ok(operation.authenticationOptions);
      const authentication = await page.evaluate(async (options) => {
        const credential = await navigator.credentials.get({
          publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options),
        });
        if (
          !(credential instanceof PublicKeyCredential) ||
          !(credential.response instanceof AuthenticatorAssertionResponse)
        )
          throw new Error("native retained-key assertion missing");
        return credential.toJSON();
      }, requestOptions(operation.authenticationOptions));
      await cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
        authenticatorId,
        enabled: false,
      });
      secondAuthenticator = await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          transport: "usb",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });
      return { id: operation.id, authentication };
    });
    assert.ok(secondAuthenticator);
    await root
      .getByRole("button", { name: /^Remove existing security key added/ })
      .nth(1)
      .waitFor();
    assert.equal((await passkeys.list(identity.userId)).length, 2);
    phase = `${name}: authorize key removal with retained key`;
    await root
      .getByRole("button", { name: /^Remove existing security key added/ })
      .first()
      .click();
    await approval
      .getByRole("button", { name: "Approve change", exact: true })
      .click();
    await root
      .getByText(
        "Existing security key removed. Other sessions were signed out.",
        {
          exact: true,
        },
      )
      .waitFor();
    assert.equal((await passkeys.list(identity.userId)).length, 1);
    checks.push(
      `${name}: fixture-only native two-key protocol preserves legacy enrollment acceptance; generated current UI authorizes retained-key removal and cancellation preserves credentials/focus`,
    );
    await drainNormalReset(identity.userId);
    await page.evaluate(() =>
      window.dispatchEvent(new Event("yap:account-changed")),
    );
    phase = `${name}: final-key, origin and accessibility checks`;
    await root
      .getByRole("button", { name: /^Remove existing security key added/ })
      .click();
    await approval
      .getByRole("heading", {
        name: "Remove existing security key",
        exact: true,
      })
      .waitFor();
    assert.equal(
      await approval
        .getByRole("button", { name: "Approve change", exact: true })
        .isDisabled(),
      true,
    );
    await approval
      .getByText(
        "An existing trusted credential is required. Recover your retained passkey or linked wallet before changing account security.",
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
    phase = `${name}: preserve a funded account through retained-key provider recovery`;
    const currentCookie = (await context.cookies()).find(
      (entry) => entry.name === "session",
    );
    assert.ok(currentCookie);
    const oldSessionHash = createHash("sha256")
      .update(currentCookie.value)
      .digest("hex");
    const oldContext = {
      userId: identity.userId,
      sessionTokenHash: oldSessionHash,
    };
    await profiles.createProfile(
      identity.userId,
      `recover-${randomUUID().slice(0, 12)}`,
      "Synthetic preserved recovery profile",
      "This profile must remain on the same internal account.",
    );
    await sandbox.initialize(oldContext);
    const funding = await sandbox.quoteFunding(oldContext, {
      idempotencyKey: randomUUID(),
      amount: "10000000",
    });
    await sandbox.confirmSimulatedFunding(oldContext, {
      requestId: funding.id,
    });
    const profileBefore = await profiles.getProfile(identity.userId);
    const summaryBefore = await sandbox.summary(oldContext);
    const countBefore = (
      await runtimePool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM users",
      )
    ).rows[0]!.count;
    const journalCountBefore = (
      await runtimePool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM coin_journals",
      )
    ).rows[0]!.count;
    const retainedKeys = await passkeys.list(identity.userId);
    assert.equal(retainedKeys.length, 1);
    const replacement = providerIdentity();
    const replacementToken = secret();
    providerTokens.set(replacementToken, replacement);
    const headers = {
      origin,
      authorization: `Bearer ${replacementToken}`,
    };
    const candidateResponse = await context.request.post(
      `${origin}/api/auth/security/provider/recovery/candidate`,
      { headers, data: {} },
    );
    assert.equal(candidateResponse.status(), 200);
    const candidate: unknown = await candidateResponse.json();
    assert.ok(object(candidate));
    assert.equal(candidate.oldMethod, identity.providerIdentity.methods[0]);
    assert.equal(candidate.newEmail, replacement.email);
    const optionsResponse = await context.request.post(
      `${origin}/api/auth/security/provider/recovery`,
      {
        headers,
        data: { credential: { type: "passkey", keyId: retainedKeys[0]!.id } },
      },
    );
    assert.equal(optionsResponse.status(), 200);
    const options: unknown = await optionsResponse.json();
    assert.ok(object(options) && typeof options.id === "string");
    assert.deepEqual(options.terms, candidate.terms);
    for (const id of [randomUUID(), options.id])
      await assert.rejects(
        runtimePool.query(
          "SELECT yaparena.apply_provider_identity_recovery($1)",
          [id],
        ),
        (error: unknown) => object(error) && error.code === "23514",
      );
    const revokedKey = (
      await runtimePool.query<{ id: string }>(
        "SELECT id FROM account_security_keys WHERE user_id=$1 AND revoked_at IS NOT NULL ORDER BY id LIMIT 1",
        [identity.userId],
      )
    ).rows[0];
    assert.ok(revokedKey);
    for (const invalid of ["purpose", "expired", "key"] as const) {
      const id = randomUUID();
      const clone = () =>
        runtimePool.query(
          `INSERT INTO account_operations(id,user_id,session_token_hash,auth_generation,purpose,terms,
        terms_digest,nonce,credential_type,authorizing_passkey_id,created_at,expires_at)
        SELECT $1,user_id,session_token_hash,auth_generation,CASE WHEN $3='purpose' THEN 'security.passkey.enroll' ELSE purpose END,
        terms,terms_digest,nonce,credential_type,CASE WHEN $3='key' THEN $4::uuid ELSE authorizing_passkey_id END,
        CASE WHEN $3='expired' THEN clock_timestamp()-interval '10 minutes' ELSE created_at END,
        CASE WHEN $3='expired' THEN clock_timestamp()-interval '6 minutes' ELSE expires_at END
        FROM account_operations WHERE id=$2`,
          [id, options.id, invalid, revokedKey.id],
        );
      await clone();
      await assert.rejects(
        runtimePool.query(
          "SELECT yaparena.apply_provider_identity_recovery($1)",
          [id],
        ),
        (error: unknown) => object(error) && error.code === "23514",
      );
    }
    assert.equal(
      (await sessions.findUserByTokenHash(oldSessionHash))?.id,
      identity.userId,
    );
    assert.equal(
      (await providerAccounts.details(identity.userId))?.subject,
      identity.providerIdentity.subject,
    );
    checks.push(
      `${name}: actual runtime SQL rejects a missing, wrong-purpose, expired or revoked-key proof; even a correctly scoped live proof cannot commit identity replacement without atomic proof consumption, leaving the original session and mapping intact`,
    );
    const publicKey = requestOptions(options.authenticationOptions);
    const authentication = await page.evaluate(async (json) => {
      const credential = await navigator.credentials.get({
        publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(json),
      });
      if (!(credential instanceof PublicKeyCredential))
        throw new Error("native recovery assertion missing");
      if (!(credential.response instanceof AuthenticatorAssertionResponse))
        throw new Error("native recovery did not authenticate");
      return credential.toJSON();
    }, publicKey);
    const preparedRecoveryApproval = { id: options.id, authentication };
    const completionPath = `/api/auth/security/provider/recovery/${options.id}/complete`;
    const foreign = await browser.newContext();
    await foreign.addCookies([
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
        await foreign.request.post(`${origin}${completionPath}`, {
          headers,
          data: { approval: preparedRecoveryApproval },
        })
      ).status(),
      409,
    );
    await foreign.close();
    const priorCompletions = completions.length;
    const recoveryDone = page
      .evaluate(async (token) => {
        if (!window.yapRecoverProviderIdentity)
          throw new Error("provider recovery control unavailable");
        await window.yapRecoverProviderIdentity(token);
      }, replacementToken)
      .then(
        () => true,
        () => false,
      );
    const recoveryDialog = page.getByRole("dialog");
    await recoveryDialog
      .getByRole("heading", { name: "Replace lost sign-in", exact: true })
      .waitFor();
    assert.ok(replacement.email);
    await recoveryDialog
      .getByText(replacement.email, { exact: false })
      .waitFor();
    assert.match(await recoveryDialog.innerText(), /[Pp]ermanently retire/);
    assert.match(
      await recoveryDialog.innerText(),
      /does not authorize a payment/,
    );
    assert.equal(
      await recoveryDialog.getByRole("combobox").locator("option").count(),
      1,
    );
    assert.deepEqual(
      await page.evaluate(async () =>
        (
          await window.axe.run(["main", "dialog[open]"], {
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
      path: resolve(evidenceDirectory, `recovery-${name}.png`),
      fullPage: true,
    });
    await recoveryDialog
      .getByRole("button", { name: "Approve change", exact: true })
      .click();
    assert.equal(await recoveryDone, true);
    await root
      .getByText(
        "Lost sign-in replaced. Your account and balances were preserved; the old sign-in is permanently retired.",
        { exact: true },
      )
      .waitFor();
    const completed = completions
      .slice(priorCompletions)
      .find((entry) =>
        entry.path.startsWith("/api/auth/security/provider/recovery/"),
      );
    assert.ok(
      completed && object(completed.body) && object(completed.body.approval),
    );
    const completedApproval = completed.body.approval;
    assert.ok(typeof completedApproval.id === "string");
    const newCookie = (await context.cookies()).find(
      (entry) => entry.name === "session",
    );
    assert.ok(newCookie && newCookie.value !== currentCookie.value);
    const newSessionHash = createHash("sha256")
      .update(newCookie.value)
      .digest("hex");
    assert.equal(
      (await sessions.findUserByTokenHash(newSessionHash))?.id,
      identity.userId,
    );
    assert.equal(await sessions.findUserByTokenHash(oldSessionHash), null);
    const summaryAfter = await sandbox.summary({
      userId: identity.userId,
      sessionTokenHash: newSessionHash,
    });
    for (const field of [
      "book",
      "version",
      "projection",
      "balances",
      "requests",
    ] as const)
      assert.deepEqual(summaryAfter[field], summaryBefore[field]);
    assert.deepEqual(await profiles.getProfile(identity.userId), profileBefore);
    assert.deepEqual(await passkeys.list(identity.userId), retainedKeys);
    assert.equal(
      (
        await runtimePool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM users",
        )
      ).rows[0]!.count,
      countBefore,
    );
    assert.equal(
      (
        await runtimePool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM coin_journals",
        )
      ).rows[0]!.count,
      journalCountBefore,
    );
    const mapping = await providerAccounts.details(identity.userId);
    assert.ok(mapping);
    assert.equal(mapping.subject, replacement.subject);
    assert.equal(mapping.email, replacement.email);
    checks.push(
      `${name}: a native user-verified retained app key replaces a synthetic sole ${identity.providerIdentity.methods[0]} provider identity with a separately verified synthetic email DID; the same internal account, profile, retained key and funded source/ledger balances survive with no extra user or cash journal`,
    );
    phase = `${name}: fence delayed retired-provider jobs from the replacement`;
    await owner.query(
      `INSERT INTO provider_revocation_jobs(user_id,subject,generation)
      SELECT id,$2,auth_generation FROM users WHERE id=$1`,
      [identity.userId, identity.providerIdentity.subject],
    );
    let providerCalls = 0;
    await createProviderRevocation(runtimePool, {
      async state() {
        providerCalls++;
        return { frozenAt: null };
      },
      async freeze() {
        providerCalls++;
      },
      async unfreeze() {
        providerCalls++;
      },
    }).synchronize(identity.userId);
    assert.equal(providerCalls, 0);
    assert.deepEqual(
      (
        await runtimePool.query<{ state: string; reason: string }>(
          `SELECT j.state,j.failure_reason AS reason FROM provider_revocation_jobs j JOIN users u ON u.id=j.user_id
          WHERE u.id=$1 AND j.generation=u.auth_generation`,
          [identity.userId],
        )
      ).rows,
      [{ state: "complete", reason: "retired_identity" }],
    );
    await owner.query(
      `UPDATE provider_revocation_jobs SET state='manual',failure_reason='uncertain_provider_outcome'
      WHERE user_id=$1 AND subject=$2`,
      [identity.userId, identity.providerIdentity.subject],
    );
    await createProviderSessionMonitor(runtimePool, verifier)(
      identity.userId,
      newSessionHash,
    );
    assert.equal(
      (await sessions.findUserByTokenHash(newSessionHash))?.id,
      identity.userId,
    );
    assert.equal(
      (await providerAccounts.details(identity.userId))?.subject,
      replacement.subject,
    );
    checks.push(
      `${name}: an adversarial current-generation job for the retired DID completes without any external provider call; an old-subject manual fence cannot invalidate the replacement identity's current session monitor`,
    );
    phase = `${name}: permanently fence recovered provider identity and replay`;
    assert.equal(
      (
        await context.request.post(`${origin}${completed.path}`, {
          headers,
          data: { approval: completedApproval },
        })
      ).status(),
      409,
    );
    await assert.rejects(
      providerAccounts.exchange(
        { ...identity.providerIdentity, sessionId: randomUUID() },
        createSessionToken().tokenHash,
        new Date(Date.now() + 600000),
      ),
      { name: "Error", status: 403 },
    );
    await assert.rejects(
      providerAccounts.exchange(
        replacement,
        createSessionToken().tokenHash,
        new Date(Date.now() + 600000),
      ),
      { name: "Error", status: 401 },
    );
    const recovery = (
      await runtimePool.query<{
        userId: string;
        consumed: boolean;
        retired: boolean;
      }>(
        `SELECT r.user_id::text AS "userId",o.consumed_at IS NOT NULL AS consumed,
        p.user_id IS NULL AND p.email IS NULL AND p.credentials_snapshot IS NULL AS retired
        FROM provider_identity_recoveries r JOIN account_operations o ON o.id=r.id
        JOIN provider_identities p ON p.subject=r.old_subject AND p.provider=r.provider WHERE r.id=$1`,
        [completedApproval.id],
      )
    ).rows;
    assert.deepEqual(recovery, [
      { userId: identity.userId, consumed: true, retired: true },
    ]);
    checks.push(
      `${name}: recovery rejects another actual account before proof consumption; consumed-proof replay and the replacement provider SID are rejected, and even a fresh session of the retired original DID cannot reprovision or reopen the account`,
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
              "public/account-auth.bundle.js",
              "public/session-coordination.js",
              "public/account-auth.css",
              "frontend/account-security.ts",
              "frontend/account-auth.tsx",
              "frontend/session-coordination.ts",
              "frontend/auth-events.ts",
              "src/platform/auth/security-passkeys.ts",
              "src/platform/auth/security-router.ts",
              "src/platform/auth/account-operations.ts",
              "src/platform/auth/provider-identity-recovery.ts",
              "src/platform/auth/provider-accounts.ts",
              "src/platform/auth/provider-credentials.ts",
              "src/platform/auth/provider-revocation.ts",
              "src/platform/auth/provider-session-monitor.ts",
              "src/platform/auth/provider-passkeys.ts",
              "src/platform/auth/privy.ts",
              "src/features/identity/repository.ts",
              "src/features/account-wallet/sandbox-repository.ts",
              "migrations/1792426011000_add-provider-identity-recovery.js",
              "migrations/1792426012000_add-provider-passkey-provenance.js",
              "dist/platform/auth/security-passkeys.js",
              "dist/platform/auth/security-router.js",
              "dist/platform/auth/account-operations.js",
              "dist/platform/auth/provider-identity-recovery.js",
              "dist/platform/auth/provider-accounts.js",
              "dist/platform/auth/provider-credentials.js",
              "dist/platform/auth/provider-revocation.js",
              "dist/platform/auth/provider-session-monitor.js",
              "dist/platform/auth/provider-passkeys.js",
              "dist/platform/auth/privy.js",
              "dist/features/identity/repository.js",
              "dist/features/account-wallet/sandbox-repository.js",
            ].map(async (path) => [path, await sourceHash(path)]),
          ),
        ),
        postgres: version,
        scope:
          "Installed Privy SDK, actual navigator.credentials registration/authentication, Chrome virtual CTAP2 and real authentication/bridge/operation repositories with runtime-role PostgreSQL; all provider authentication, OTP verification and user GET responses are synthetic intercepted fixtures. Retained legacy credentials are prepared by explicitly labelled fixture ceremonies, not removed product enrollment UI. Not genuine Privy token verification/enrollment/export availability, hosted acceptance, screen-reader or physical-device evidence.",
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
