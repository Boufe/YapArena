import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import pg from "pg";
import {
  createPrivySessionControl,
  createPrivyVerifier,
  createPrivyOperatorInspector,
} from "../dist/platform/auth/privy.js";
import {
  createProviderRevocation,
  ProviderResetRetryError,
} from "../dist/platform/auth/provider-revocation.js";
import { createFirstPasskeyResetRepair } from "../dist/platform/auth/provider-passkey-reset-repair.js";

// Explicit fixed-staging operator action. No .env, account selector, browser
// identity evidence, generation shortcut, secret output or automatic retry.
const project = "ypteqfmjietdqjzyvgtk";
const service = "srv-datv1kjncjis73a500cg";
const appId = "cmvfjb3r800vy0hl3heg2cuvv";
const rolePath = "/private/tmp/yaparena-auth-operator/role-recovery.json";
const renderPath = "/Users/felixboucher/.render/cli.yaml";
const deadline = AbortSignal.timeout(60_000);
let database: pg.Pool | undefined;
let step = "input";
let resetStarted = false;
let lastHttpError: number | undefined;
const watchdog = setTimeout(() => {
  console.log(
    JSON.stringify({
      status: "stopped",
      step,
      outcome: resetStarted ? "unknown" : "not_started",
      reason: "deadline",
    }),
  );
  process.exit(1);
}, 65_000).unref();
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function string(value: unknown): string {
  assert.ok(typeof value === "string" && value.length > 0);
  return value;
}
async function privateFile(path: string, privateDirectory = false) {
  assert.equal(await realpath(path), path);
  const file = await lstat(path);
  assert.ok(file.isFile() && !file.isSymbolicLink() && file.size < 128_000);
  assert.equal(file.mode & 0o077, 0);
  if (privateDirectory)
    assert.equal((await lstat(dirname(path))).mode & 0o077, 0);
  return readFile(path, "utf8");
}
function providerTransport(
  subject: string,
  send: typeof fetch,
  mode: "retry" | "reconcile" | "finalize" = "retry",
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init),
      url = new URL(request.url);
    assert.equal(url.origin, "https://api.privy.io");
    assert.equal(url.username + url.password, "");
    assert.ok(!url.search && !url.hash);
    // Accept encoded and unencoded forms of this exact selected provider ID.
    // The installed SDK currently preserves its colons in the path.
    const path = decodeURIComponent(url.pathname),
      expected = `/v1/users/${subject}`;
    if (request.method === "GET") assert.equal(path, expected);
    else {
      assert.ok(
        (mode !== "finalize" && request.method === "DELETE") ||
          (mode === "retry" && request.method === "POST"),
      );
      assert.equal(path, `${expected}/freeze`);
      assert.equal(
        request.headers
          .get("content-type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase(),
        "application/json",
      );
      const body: unknown = JSON.parse(await request.clone().text());
      assert.ok(object(body) && Object.keys(body).length === 0);
    }
    lastHttpError = undefined;
    const response = await send(request, {
      redirect: "error",
      signal: AbortSignal.any([
        request.signal,
        deadline,
        AbortSignal.timeout(5_000),
      ]),
    });
    if (response.status >= 400 && response.status <= 599)
      lastHttpError = response.status;
    return response;
  };
}
async function verifyTransport() {
  step = "offline_transport";
  process.env.PRIVY_API_LOG = "off";
  const subject = "did:privy:offline-reset-fixture",
    calls: string[] = [];
  const stub: typeof fetch = async (input, init) => {
    const request = new Request(input, init),
      url = new URL(request.url);
    assert.equal(
      decodeURIComponent(url.pathname),
      `/v1/users/${subject}${request.method === "GET" ? "" : "/freeze"}`,
    );
    calls.push(request.method);
    return new Response(
      JSON.stringify(
        request.method === "GET"
          ? { id: subject, frozen_at: null }
          : { success: true },
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const guarded = providerTransport(subject, stub);
  const control = createPrivySessionControl({
    appId: "synthetic-offline-app",
    appSecret: "synthetic-offline-secret",
    fetch: guarded,
  });
  await control.state(subject);
  await control.freeze(subject);
  await control.unfreeze(subject);
  assert.deepEqual(calls, ["GET", "POST", "DELETE"]);
  const bad: {
    method: string;
    path: string;
    body?: string;
    contentType?: string;
  }[] = [
    {
      method: "POST",
      path: `/v1/users/${subject}/unfreeze`,
      body: "{}",
      contentType: "application/json",
    },
    {
      method: "DELETE",
      path: `/v1/users/${subject}`,
      body: "{}",
      contentType: "application/json",
    },
    {
      method: "PUT",
      path: `/v1/users/${subject}/freeze`,
      body: "{}",
      contentType: "application/json",
    },
    { method: "GET", path: `/v1/users/${subject}/freeze` },
    { method: "GET", path: "/v1/users/did:privy:other-offline-fixture" },
    {
      method: "POST",
      path: `/v1/users/${subject}/freeze`,
      body: '{"unsupported":true}',
      contentType: "application/json",
    },
    {
      method: "DELETE",
      path: `/v1/users/${subject}/freeze`,
      body: "{}",
      contentType: "text/plain",
    },
  ];
  for (const entry of bad)
    await assert.rejects(() =>
      guarded(`https://api.privy.io${entry.path}`, {
        method: entry.method,
        ...(entry.body ? { body: entry.body } : {}),
        headers: entry.contentType
          ? { "content-type": entry.contentType }
          : undefined,
      }),
    );
  assert.equal(
    calls.length,
    3,
    "rejected operations never reached even the injected offline sender",
  );
  const reconcile = providerTransport(subject, stub, "reconcile"),
    reconcileControl = createPrivySessionControl({
      appId: "synthetic-offline-app",
      appSecret: "synthetic-offline-secret",
      fetch: reconcile,
    });
  await reconcileControl.state(subject);
  await reconcileControl.unfreeze(subject);
  await assert.rejects(reconcileControl.freeze(subject));
  assert.deepEqual(calls, ["GET", "POST", "DELETE", "GET", "DELETE"]);
  const finalizeControl = createPrivySessionControl({
    appId: "synthetic-offline-app",
    appSecret: "synthetic-offline-secret",
    fetch: providerTransport(subject, stub, "finalize"),
  });
  await finalizeControl.state(subject);
  await assert.rejects(finalizeControl.freeze(subject));
  await assert.rejects(finalizeControl.unfreeze(subject));
  assert.deepEqual(calls, ["GET", "POST", "DELETE", "GET", "DELETE", "GET"]);
  console.log(
    JSON.stringify({
      status: "transport_verified",
      sdkMethods: calls.slice(0, 3),
      reconcileSdkMethods: calls.slice(3, 5),
      finalizeSdkMethods: calls.slice(5),
      rejectedRequests: bad.length + 3,
      networkCalls: 0,
    }),
  );
}
async function main() {
  const mode = process.argv[2];
  assert.ok(
    mode === "retry-uncertain" ||
      mode === "reconcile-delayed" ||
      mode === "finalize-reviewed" ||
      mode === "repair-first-passkey" ||
      mode === "finalize-first-passkey",
  );
  assert.equal(process.argv.length, mode === "retry-uncertain" ? 4 : 6);
  assert.equal(process.env.ACCOUNT_STAGING_PROVIDER_ACTION, mode);
  const requestId = string(process.argv[3]).toLowerCase();
  assert.match(
    requestId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
  let reviewDigest: string | undefined;
  let firstPasskeyReview:
    | {
        evidenceDigest: string;
        noIndependentFreeze: true;
        frozenAt: number;
        expectedGeneration: string;
        expectedAttempts: number;
      }
    | undefined;
  if (mode !== "retry-uncertain") {
    const path = string(process.argv[4]);
    reviewDigest = string(process.argv[5]).toLowerCase();
    assert.match(reviewDigest, /^[0-9a-f]{64}$/);
    const contents = await privateFile(path);
    assert.equal(
      createHash("sha256").update(contents).digest("hex"),
      reviewDigest,
    );
    const review: unknown = JSON.parse(contents);
    assert.ok(object(review));
    assert.equal(review.projectRef, project);
    assert.equal(review.serviceId, service);
    assert.equal(review.appId, appId);
    assert.equal(review.requestId, requestId);
    assert.equal(review.noIndependentFreeze, true);
    assert.equal(review.activityReviewed, true);
    if (mode === "repair-first-passkey" || mode === "finalize-first-passkey") {
      assert.equal(review.scope, "unfinished-first-Privy-passkey-reset-only");
      assert.equal(review.preserveAcceptedCredentialSnapshot, true);
      assert.equal(review.requiresFreshNativePasskeyVerification, true);
      assert.ok(
        typeof review.frozenAt === "number" &&
          Number.isSafeInteger(review.frozenAt) &&
          review.frozenAt > 0,
      );
      assert.ok(
        typeof review.expectedGeneration === "string" &&
          /^[1-9][0-9]{0,18}$/.test(review.expectedGeneration),
      );
      assert.ok(
        typeof review.expectedAttempts === "number" &&
          Number.isSafeInteger(review.expectedAttempts) &&
          review.expectedAttempts > 0,
      );
      firstPasskeyReview = {
        evidenceDigest: reviewDigest,
        noIndependentFreeze: true,
        frozenAt: review.frozenAt,
        expectedGeneration: review.expectedGeneration,
        expectedAttempts: review.expectedAttempts,
      };
    }
  }
  // The SDK reads this documented setting when its clients are constructed.
  // Disable inherited debug output before either provider factory is called.
  process.env.PRIVY_API_LOG = "off";
  assert.ok(
    !process.env.PRIVY_API_BASE_URL ||
      process.env.PRIVY_API_BASE_URL === "https://api.privy.io",
  );
  step = "private_configuration";
  const role: unknown = JSON.parse(await privateFile(rolePath, true));
  assert.ok(object(role) && object(role.owner));
  assert.equal(role.projectRef, project);
  assert.equal(role.port, 5432);
  assert.equal(role.database, "postgres");
  const host = string(role.host);
  assert.ok(
    host === `db.${project}.supabase.co` ||
      /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(host),
  );
  assert.equal(
    role.owner.user,
    `yaparena_owner${host.endsWith(".pooler.supabase.com") ? `.${project}` : ""}`,
  );
  const ca = await readFile(
    process.env.ACCOUNT_STAGING_CA_PATH ?? string(role.caPath),
    "utf8",
  );
  assert.match(ca, /-----BEGIN CERTIFICATE-----/);
  database = new pg.Pool({
    host,
    port: 5432,
    database: "postgres",
    user: string(role.owner.user),
    password: string(role.owner.password),
    ssl: { ca, rejectUnauthorized: true, servername: host },
    options: "-c search_path=pg_catalog,yaparena,pg_temp",
    connectionTimeoutMillis: 8_000,
    query_timeout: 8_000,
    statement_timeout: 5_000,
    max: 2,
    idleTimeoutMillis: 5_000,
    application_name: "yaparena-provider-guarded-retry",
  });
  database.on("error", () => {});
  step = "read_only_selection";
  const connection = await database.connect();
  let selected: { userId: string; subject: string };
  try {
    await connection.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const identity = (
      await connection.query<{ valid: boolean }>(
        `SELECT current_user='yaparena_owner' AND session_user='yaparena_owner'
       AND current_database()='postgres' AND current_setting('transaction_read_only')='on'
       AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
       AS valid FROM pg_roles r WHERE r.rolname=current_user`,
      )
    ).rows[0];
    assert.equal(identity?.valid, true);
    const firstPasskeyMode =
      mode === "repair-first-passkey" || mode === "finalize-first-passkey";
    const audit = (
      await connection.query<{ userId: string; subject: string }>(
        `SELECT u.id::text AS "userId",p.subject FROM yaparena.identity_audit_events a
       JOIN yaparena.users u ON u.id=a.user_id
       JOIN yaparena.provider_identities p ON p.user_id=u.id AND p.provider='privy'
       WHERE a.event_type=$2 AND a.metadata->>'requestId'=$1
         AND u.account_status='active' LIMIT 2`,
        [
          requestId,
          firstPasskeyMode
            ? "provider.passkey.reset_repair_requested"
            : "provider.reset.retry_requested",
        ],
      )
    ).rows;
    assert.ok(audit.length <= 1);
    if (audit[0]) selected = audit[0];
    else {
      assert.equal(
        mode === "retry-uncertain" || mode === "repair-first-passkey",
        true,
        "reconciliation requires its exact original retry audit",
      );
      const candidates = (
        await connection.query<{ userId: string; subject: string }>(
          `SELECT u.id::text AS "userId",p.subject FROM yaparena.users u
         JOIN yaparena.provider_identities p ON p.user_id=u.id AND p.provider='privy'
         JOIN yaparena.provider_revocation_jobs j ON j.user_id=u.id
           AND j.subject=p.subject AND j.generation=u.auth_generation
         WHERE u.account_status='active' AND p.auth_generation<>u.auth_generation
           AND j.state='manual' AND j.failure_reason='uncertain_provider_outcome'
           AND j.confirmed_frozen_at IS NULL AND j.lease_until<clock_timestamp()
         ORDER BY u.id LIMIT 2`,
        )
      ).rows;
      assert.equal(candidates.length, 1);
      selected = candidates[0]!;
    }
    await connection.query("ROLLBACK");
  } finally {
    connection.release();
  }

  step = "fixed_render_configuration";
  const configuration = await privateFile(renderPath),
    match = configuration.match(/^\s*key:\s*(.+)$/m);
  assert.ok(match?.[1]);
  const encoded = match[1].trim();
  const key: unknown = encoded.startsWith('"') ? JSON.parse(encoded) : encoded;
  assert.ok(typeof key === "string" && key.length > 20);
  async function render(path: string): Promise<unknown> {
    const response = await fetch(
      `https://api.render.com/v1/services/${service}${path}`,
      {
        headers: { Authorization: `Bearer ${key}` },
        redirect: "error",
        signal: AbortSignal.any([deadline, AbortSignal.timeout(12_000)]),
      },
    );
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(Buffer.byteLength(body) < 1_048_576);
    return JSON.parse(body) as unknown;
  }
  const target = await render("");
  assert.ok(object(target));
  assert.equal(target.id, service);
  assert.equal(target.name, "yaparena-staging-web");
  assert.equal(target.type, "web_service");
  const rows = await render("/env-vars?limit=100");
  assert.ok(Array.isArray(rows) && rows.length < 100);
  const variables = new Map<string, string>();
  for (const row of rows) {
    assert.ok(object(row) && object(row.envVar));
    variables.set(string(row.envVar.key), string(row.envVar.value));
  }
  assert.equal(variables.get("PRIVY_APP_ID"), appId);
  const providerFetch = providerTransport(
    selected.subject,
    fetch,
    mode === "finalize-reviewed" || mode === "finalize-first-passkey"
      ? "finalize"
      : mode === "reconcile-delayed" || mode === "repair-first-passkey"
        ? "reconcile"
        : "retry",
  );
  const providerConfiguration = {
    appId,
    appSecret: string(variables.get("PRIVY_APP_SECRET")),
    fetch: providerFetch,
  };
  step = "operator_api";
  const revocation = createProviderRevocation(
    database,
    createPrivySessionControl(providerConfiguration),
    {
      operatorInspector: createPrivyVerifier(providerConfiguration),
      operatorFrozenInspector: createPrivyOperatorInspector(
        providerConfiguration,
      ),
    },
  );
  if (mode === "repair-first-passkey" || mode === "finalize-first-passkey") {
    assert.ok(firstPasskeyReview);
    const repair = createFirstPasskeyResetRepair(
      database,
      createPrivyOperatorInspector(providerConfiguration),
      createPrivySessionControl(providerConfiguration),
      { origin: "https://yaparena-staging-web.onrender.com" },
    );
    resetStarted = true;
    const input = {
      userId: selected.userId,
      requestId,
      activityReview: firstPasskeyReview,
    };
    const result =
      mode === "repair-first-passkey"
        ? await repair.repair(input)
        : await repair.finalize(input);
    assert.equal(result.state, "complete");
    console.log(
      JSON.stringify({
        status: "complete",
        action: mode,
        fixedStagingTarget: true,
        acceptedCredentialsUnchanged: true,
        requiresFreshPasskeyVerification: true,
      }),
    );
    return;
  }
  resetStarted = true;
  const result =
    mode === "finalize-reviewed"
      ? await revocation.finalizeReviewed({
          userId: selected.userId,
          requestId,
          activityReview: {
            evidenceDigest: string(reviewDigest),
            noIndependentFreeze: true,
          },
        })
      : mode === "reconcile-delayed"
        ? await revocation.reconcileUncertain({
            userId: selected.userId,
            requestId,
            activityReview: {
              evidenceDigest: string(reviewDigest),
              noIndependentFreeze: true,
            },
          })
        : await revocation.retryUncertain({
            userId: selected.userId,
            requestId,
          });
  assert.equal(result.state, "complete");
  console.log(
    JSON.stringify({
      status: "complete",
      action: mode,
      fixedStagingTarget: true,
    }),
  );
}
try {
  if (process.argv.length === 3 && process.argv[2] === "--verify-transport")
    await verifyTransport();
  else await main();
} catch (error) {
  const stage = error instanceof ProviderResetRetryError ? error.stage : step;
  const status =
    error instanceof ProviderResetRetryError
      ? (error.providerStatus ?? lastHttpError)
      : lastHttpError;
  console.log(
    JSON.stringify({
      status: "stopped",
      stage,
      outcome: resetStarted ? "inspect_before_retry" : "not_started",
      ...(status !== undefined &&
      Number.isInteger(status) &&
      status >= 400 &&
      status <= 599
        ? { providerHttpStatus: status }
        : {}),
      details: "private diagnostics withheld",
    }),
  );
  process.exitCode = 1;
} finally {
  await database?.end().catch(() => {});
  clearTimeout(watchdog);
}
