import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { ProviderCredential } from "../src/platform/auth/provider-credentials.ts";

// Fixed-target read-only operator verifier. No .env
// loading, provider mutations, wallet creation/signing/funding or database writes.
const repository = fileURLToPath(new URL("../", import.meta.url));
const projectRef = "ypteqfmjietdqjzyvgtk";
const appId = "cmvfjb3r800vy0hl3heg2cuvv";
const serviceId = "srv-datv1kjncjis73a500cg";
const serviceName = "yaparena-staging-web";
const webOrigin = "https://yaparena-staging-web.onrender.com";
const ownerPath = "/private/tmp/yaparena-auth-operator/role-recovery.json";
const renderKeyPath = "/Users/felixboucher/.render/cli.yaml";
const outputDirectory =
  "/private/tmp/yaparena-auth-operator/embedded-wallet-verification";
const sourceFiles = [
  "scripts/verify-embedded-wallet-staging.ts",
  "package.json",
  "package-lock.json",
  "src/platform/auth/embedded-wallet-provider.ts",
  "src/platform/auth/embedded-wallet-provisioning.ts",
  "src/platform/auth/provider-credentials.ts",
] as const;
const maximumResponseBytes = 512 * 1024;
const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
type ObjectValue = Record<string, unknown>;
type Login = { user: string; password: string };
type Configuration = {
  projectRef: string;
  host: string;
  port: number;
  database: string;
  owner: Login;
  runtime: Login;
  caPath: string;
};
type Job = {
  subject: string;
  externalId: string;
  state: "pending" | "running" | "ready" | "retry_wait" | "review_required";
  walletId: string | null;
  address: string | null;
  creationStarted: boolean;
};
type Snapshot = {
  userId: string;
  subject: string;
  authGeneration: string;
  providerGeneration: string;
  email: string | null;
  methods: string[];
  credentialsDigest: string;
  credentialsSnapshot: ProviderCredential[] | null;
  schemaPresent: boolean;
  job: Job | null;
};
type Result = "PASS" | "PENDING" | "REVIEW_REQUIRED" | "UNAVAILABLE" | "FAIL";
type Reason =
  | "confirmed_user_owned_wallet"
  | "wallet_job_pending"
  | "ownership_review"
  | "credential_verification_required"
  | "provider_unavailable"
  | "concurrent_change"
  | "guard_rejected";
type Facts = {
  expectedRevision: string | null;
  deployedRevisionVerified: boolean;
  fixedTargetsVerified: boolean;
  ownerRoleVerified: boolean;
  tlsVerified: boolean;
  databaseReadOnlyVerified: boolean;
  ownerConnectionsClosedBeforeProvider: boolean;
  activeMappings: number;
  jobPresent: boolean;
  state: Job["state"] | "absent";
  generationMatch: boolean;
  acceptedCredentialSnapshot: boolean;
  providerCredentialsMatch: boolean;
  userOnlyOwnerVerified: boolean;
  noAdditionalSignerOrPolicyVerified: boolean;
  repeatedProviderReadsAgree: boolean;
  repeatedDatabaseReadsAgree: boolean;
  providerRequests: number;
  providerMutationAttemptsBlocked: number;
  renderRequests: number;
  databaseSnapshots: number;
  moduleHashes: Record<string, string>;
};
function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function string(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024;
}
function nullableString(value: unknown): value is string | null {
  return value === null || string(value);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 32 && value.every(string);
}
function login(value: unknown): value is Login {
  return object(value) && string(value.user) && string(value.password);
}
function configuration(value: unknown): value is Configuration {
  return (
    object(value) &&
    value.projectRef === projectRef &&
    string(value.host) &&
    value.port === 5432 &&
    value.database === "postgres" &&
    login(value.owner) &&
    login(value.runtime) &&
    string(value.caPath)
  );
}
async function sourceModules() {
  // Literal source imports preserve strict types and avoid stale dist code.
  // Inspection calls this only after checking exact committed source bytes.
  const provider =
      await import("../src/platform/auth/embedded-wallet-provider.ts"),
    credentials = await import("../src/platform/auth/provider-credentials.ts");
  return { ...provider, ...credentials };
}
async function privateRead(path: string, privateParent = true) {
  assert.equal(await realpath(path), path);
  const file = await lstat(path);
  assert.ok(file.isFile() && !file.isSymbolicLink());
  assert.equal(file.mode & 0o777, 0o600);
  if (process.getuid) assert.equal(file.uid, process.getuid());
  if (privateParent)
    assert.equal((await lstat(dirname(path))).mode & 0o777, 0o700);
  return readFile(path, "utf8");
}
async function boundedJson(response: Response): Promise<unknown> {
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^application\/json\b/i,
  );
  const length = response.headers.get("content-length");
  if (length !== null) {
    assert.match(length, /^\d+$/);
    assert.ok(Number(length) <= maximumResponseBytes);
  }
  assert.ok(response.body);
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      assert.ok(bytes <= maximumResponseBytes);
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
function providerShape(path: string, value: unknown, subject: string) {
  assert.ok(object(value));
  if (path === `/v1/apps/${appId}`) {
    assert.equal(typeof value.email_auth, "boolean");
    assert.equal(typeof value.merge_accounts_by_email, "boolean");
  } else if (path === `/v1/users/${subject}`) {
    assert.equal(value.id, subject);
    assert.equal(typeof value.is_guest, "boolean");
    assert.ok(Object.hasOwn(value, "frozen_at"));
    assert.ok(
      value.frozen_at === null ||
        (typeof value.frozen_at === "number" &&
          Number.isSafeInteger(value.frozen_at) &&
          value.frozen_at > 0),
    );
    assert.ok(Array.isArray(value.linked_accounts));
    assert.ok(value.linked_accounts.length <= 32);
    for (const account of value.linked_accounts) {
      assert.ok(object(account));
      assert.ok(
        ["email", "google_oauth", "passkey", "wallet"].includes(
          String(account.type),
        ),
      );
      if (account.type === "email") assert.ok(string(account.address));
      if (account.type === "google_oauth") assert.ok(string(account.subject));
      if (account.type === "passkey") assert.ok(string(account.credential_id));
      if (account.type === "wallet") {
        assert.ok(string(account.address));
        assert.ok(string(account.chain_type));
      }
    }
  } else if (path.startsWith("/v1/wallets/")) {
    assert.ok(string(value.id) && string(value.address));
    assert.ok(string(value.chain_type));
    assert.ok(nullableString(value.owner_id));
    assert.ok(Array.isArray(value.additional_signers));
    assert.ok(Array.isArray(value.policy_ids));
  } else {
    assert.ok(path.startsWith("/v1/key_quorums/"));
    assert.ok(string(value.id));
    assert.ok(
      value.authorization_threshold === null ||
        (typeof value.authorization_threshold === "number" &&
          Number.isSafeInteger(value.authorization_threshold) &&
          value.authorization_threshold >= 1),
    );
    assert.ok(Array.isArray(value.authorization_keys));
    assert.ok(strings(value.user_ids));
    assert.ok(
      value.key_quorum_ids === undefined || strings(value.key_quorum_ids),
    );
  }
}
function readOnlyProviderFetch(input: {
  subject: string;
  externalId: string;
  signal: AbortSignal;
  facts: Facts;
  transport: typeof globalThis.fetch;
}): typeof globalThis.fetch {
  return async (url, options) => {
    const request = new Request(url, options),
      target = new URL(request.url);
    // Validate BEFORE any transport, including requests initiated by an SDK.
    if (request.method !== "GET" || request.body !== null) {
      input.facts.providerMutationAttemptsBlocked++;
      throw new Error("Provider mutation prohibited");
    }
    assert.equal(target.origin, "https://api.privy.io");
    assert.equal(
      target.username + target.password + target.search + target.hash,
      "",
    );
    const path = decodeURIComponent(target.pathname);
    assert.ok(
      path === `/v1/apps/${appId}` ||
        path === `/v1/users/${input.subject}` ||
        path === `/v1/wallets/ext_wal_${input.externalId}` ||
        /^\/v1\/(?:wallets|key_quorums)\/[A-Za-z0-9_-]{1,256}$/.test(path),
    );
    assert.ok(input.facts.providerRequests < 16);
    input.signal.throwIfAborted();
    input.facts.providerRequests++;
    const response = await input.transport(request, {
      redirect: "error",
      signal: AbortSignal.any([
        input.signal,
        request.signal,
        AbortSignal.timeout(5000),
      ]),
    });
    if (response.status === 404 && path.startsWith("/v1/wallets/")) {
      await response.body?.cancel();
      return new Response('{"error":"not found"}', {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    const value = await boundedJson(response);
    providerShape(path, value, input.subject);
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}
function facts(): Facts {
  return {
    expectedRevision: null,
    deployedRevisionVerified: false,
    fixedTargetsVerified: false,
    ownerRoleVerified: false,
    tlsVerified: false,
    databaseReadOnlyVerified: false,
    ownerConnectionsClosedBeforeProvider: false,
    activeMappings: 0,
    jobPresent: false,
    state: "absent",
    generationMatch: false,
    acceptedCredentialSnapshot: false,
    providerCredentialsMatch: false,
    userOnlyOwnerVerified: false,
    noAdditionalSignerOrPolicyVerified: false,
    repeatedProviderReadsAgree: false,
    repeatedDatabaseReadsAgree: false,
    providerRequests: 0,
    providerMutationAttemptsBlocked: 0,
    renderRequests: 0,
    databaseSnapshots: 0,
    moduleHashes: {},
  };
}
function report(result: Result, reason: Reason, state: Facts) {
  // Construct explicitly. Never serialize configuration, snapshots or responses.
  return {
    result,
    reason,
    observedAt: new Date().toISOString(),
    revision: state.expectedRevision,
    deployedRevisionVerified: state.deployedRevisionVerified,
    fixedTargetsVerified: state.fixedTargetsVerified,
    ownerRoleVerified: state.ownerRoleVerified,
    tlsVerified: state.tlsVerified,
    databaseReadOnlyVerified: state.databaseReadOnlyVerified,
    ownerConnectionsClosedBeforeProvider:
      state.ownerConnectionsClosedBeforeProvider,
    activeMappings: state.activeMappings,
    jobPresent: state.jobPresent,
    state: state.state,
    generationMatch: state.generationMatch,
    acceptedCredentialSnapshot: state.acceptedCredentialSnapshot,
    providerCredentialsMatch: state.providerCredentialsMatch,
    userOnlyOwnerVerified: state.userOnlyOwnerVerified,
    noAdditionalSignerOrPolicyVerified:
      state.noAdditionalSignerOrPolicyVerified,
    repeatedProviderReadsAgree: state.repeatedProviderReadsAgree,
    repeatedDatabaseReadsAgree: state.repeatedDatabaseReadsAgree,
    providerRequests: state.providerRequests,
    providerMutationAttemptsBlocked: state.providerMutationAttemptsBlocked,
    renderRequests: state.renderRequests,
    databaseSnapshots: state.databaseSnapshots,
    moduleHashes: state.moduleHashes,
    liveFundingVerified: false,
    physicalDeviceVerified: false,
    mutations: 0,
  };
}
async function save(result: Result, reason: Reason, state: Facts) {
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  assert.equal(await realpath(outputDirectory), outputDirectory);
  assert.equal((await lstat(outputDirectory)).mode & 0o077, 0);
  const value = report(result, reason, state),
    name = `embedded-wallet-${Date.now()}.json`;
  await writeFile(
    resolve(outputDirectory, name),
    `${JSON.stringify(value, null, 2)}\n`,
    {
      flag: "wx",
      mode: 0o600,
    },
  );
  console.log(
    JSON.stringify({ result, reason, state: state.state, artifact: name }),
  );
  process.exitCode = result === "PASS" ? 0 : result === "FAIL" ? 1 : 2;
}
function job(value: unknown): value is Job {
  return (
    object(value) &&
    string(value.subject) &&
    string(value.externalId) &&
    ["pending", "running", "ready", "retry_wait", "review_required"].includes(
      String(value.state),
    ) &&
    nullableString(value.walletId) &&
    nullableString(value.address) &&
    typeof value.creationStarted === "boolean"
  );
}
async function snapshot(
  settings: Configuration,
  ca: string,
  signal: AbortSignal,
  state: Facts,
): Promise<Snapshot> {
  signal.throwIfAborted();
  const client = new pg.Client({
    host: settings.host,
    port: settings.port,
    database: settings.database,
    user: settings.owner.user,
    password: settings.owner.password,
    ssl: { ca, rejectUnauthorized: true, servername: settings.host },
    connectionTimeoutMillis: 8000,
    query_timeout: 8000,
    statement_timeout: 5000,
    options: "-c search_path=pg_catalog,yaparena,pg_temp",
    application_name: "yaparena-embedded-wallet-readonly-acceptance",
  });
  // Queries/connections still reject normally. Suppress raw asynchronous driver
  // event text so an outage cannot export a private endpoint through stderr.
  client.on("error", () => {});
  const abort = () => void client.end().catch(() => {});
  signal.addEventListener("abort", abort, { once: true });
  try {
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const identity = (
      await client.query<{
        correct: boolean;
        readOnly: boolean;
        unprivileged: boolean;
      }>(
        `SELECT current_user='yaparena_owner' AND session_user='yaparena_owner' AND current_database()='postgres' AS correct,
         current_setting('transaction_read_only')='on' AS "readOnly",
         NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication) AS unprivileged
         FROM pg_roles r WHERE r.rolname=current_user`,
      )
    ).rows[0];
    assert.deepEqual(identity, {
      correct: true,
      readOnly: true,
      unprivileged: true,
    });
    state.ownerRoleVerified = true;
    state.tlsVerified = true;
    state.databaseReadOnlyVerified = true;
    const mappings = await client.query<
      Omit<Snapshot, "schemaPresent" | "job">
    >(
      `SELECT u.id::text AS "userId",p.subject,u.auth_generation::text AS "authGeneration",p.auth_generation::text AS "providerGeneration",
       p.email,p.methods,p.credentials_digest AS "credentialsDigest",p.credentials_snapshot AS "credentialsSnapshot"
       FROM yaparena.users u JOIN yaparena.provider_identities p ON p.user_id=u.id
       WHERE p.provider='privy' AND u.account_status='active'`,
    );
    state.activeMappings = mappings.rows.length;
    assert.equal(mappings.rows.length, 1);
    const mapping = mappings.rows[0];
    assert.ok(mapping && /^did:privy:[A-Za-z0-9_-]+$/.test(mapping.subject));
    assert.match(mapping.userId, /^\d+$/);
    const schema = (
      await client.query<{ present: boolean }>(
        "SELECT to_regclass('yaparena.embedded_wallet_provisioning') IS NOT NULL AS present",
      )
    ).rows[0];
    assert.ok(schema);
    let currentJob: Job | null = null;
    if (schema.present) {
      const jobs = await client.query<Record<string, unknown>>(
        `SELECT subject,external_id AS "externalId",state,wallet_id AS "walletId",address,
         creation_started_at IS NOT NULL AS "creationStarted"
         FROM yaparena.embedded_wallet_provisioning WHERE user_id=$1`,
        [mapping.userId],
      );
      assert.ok(jobs.rows.length <= 1);
      if (jobs.rows.length) {
        const candidate: unknown = jobs.rows[0];
        assert.ok(job(candidate));
        currentJob = candidate;
      }
    }
    await client.query("ROLLBACK");
    state.databaseSnapshots++;
    return { ...mapping, schemaPresent: schema.present, job: currentJob };
  } finally {
    signal.removeEventListener("abort", abort);
    await client.end();
  }
}
function equalSnapshots(first: Snapshot, second: Snapshot) {
  return JSON.stringify(first) === JSON.stringify(second);
}
async function inspect() {
  const state = facts(),
    deadline = AbortSignal.timeout(60000);
  try {
    const expected = process.env.ACCOUNT_EMBEDDED_WALLET_EXPECTED_REVISION;
    assert.ok(expected && /^[a-f0-9]{40}$/.test(expected));
    state.expectedRevision = expected;
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repository,
        encoding: "utf8",
      }).trim(),
      expected,
    );
    for (const file of sourceFiles) {
      const bytes = await readFile(resolve(repository, file)),
        committed = execFileSync("git", ["show", `${expected}:${file}`], {
          cwd: repository,
          maxBuffer: 1024 * 1024,
        });
      assert.ok(bytes.equals(committed));
      state.moduleHashes[file] = sha(bytes);
    }
    state.moduleHashes.verifier = sha(await readFile(new URL(import.meta.url)));
    const {
      createPrivyEmbeddedWalletProvider,
      EmbeddedWalletProviderError,
      verifiedStoredCredentials,
    } = await sourceModules();
    const parsed: unknown = JSON.parse(await privateRead(ownerPath));
    assert.ok(configuration(parsed));
    const settings = parsed,
      pooler = settings.host.endsWith(".pooler.supabase.com");
    assert.ok(settings.host === `db.${projectRef}.supabase.co` || pooler);
    assert.equal(
      settings.owner.user,
      `yaparena_owner${pooler ? `.${projectRef}` : ""}`,
    );
    assert.equal(
      settings.runtime.user,
      `yaparena_runtime${pooler ? `.${projectRef}` : ""}`,
    );
    assert.notEqual(settings.owner.password, settings.runtime.password);
    const ca = await readFile(
      process.env.ACCOUNT_STAGING_CA_PATH ?? settings.caPath,
      "utf8",
    );
    assert.match(ca, /-----BEGIN CERTIFICATE-----/);
    const cli = await privateRead(renderKeyPath, false),
      match = cli.match(/^\s*key:\s*(.+)$/m);
    assert.ok(match?.[1]);
    const encoded = match[1].trim(),
      key: unknown = encoded.startsWith('"') ? JSON.parse(encoded) : encoded;
    assert.ok(string(key) && key.length > 20);
    async function render(path: string) {
      assert.ok(
        [
          `/services/${serviceId}`,
          `/services/${serviceId}/env-vars?limit=100`,
          `/services/${serviceId}/deploys?limit=1`,
        ].includes(path),
      );
      deadline.throwIfAborted();
      state.renderRequests++;
      const response = await fetch(`https://api.render.com/v1${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.any([deadline, AbortSignal.timeout(12000)]),
      });
      return boundedJson(response);
    }
    async function deployment() {
      const rows = await render(`/services/${serviceId}/deploys?limit=1`);
      assert.ok(Array.isArray(rows) && rows.length === 1);
      const entry: unknown = rows[0];
      assert.ok(object(entry) && object(entry.deploy));
      assert.ok(object(entry.deploy.commit));
      assert.equal(entry.deploy.status, "live");
      assert.equal(entry.deploy.commit.id, expected);
    }
    const service = await render(`/services/${serviceId}`);
    assert.ok(object(service) && object(service.serviceDetails));
    assert.equal(service.id, serviceId);
    assert.equal(service.name, serviceName);
    assert.equal(service.type, "web_service");
    assert.equal(service.suspended, "not_suspended");
    assert.equal(service.serviceDetails.url, webOrigin);
    state.deployedRevisionVerified = false;
    await deployment();
    state.deployedRevisionVerified = true;
    const environment = await render(
      `/services/${serviceId}/env-vars?limit=100`,
    );
    assert.ok(Array.isArray(environment) && environment.length < 100);
    const variables = new Map<string, string>();
    for (const row of environment) {
      assert.ok(object(row) && object(row.envVar));
      assert.ok(string(row.envVar.key) && typeof row.envVar.value === "string");
      assert.equal(variables.has(row.envVar.key), false);
      variables.set(row.envVar.key, row.envVar.value);
    }
    assert.equal(variables.get("PRIVY_APP_ID"), appId);
    const appSecret = variables.get("PRIVY_APP_SECRET"),
      database = variables.get("DATABASE_URL");
    assert.ok(string(appSecret) && appSecret.length >= 16);
    assert.ok(database);
    const databaseUrl = new URL(database);
    assert.equal(databaseUrl.protocol, "postgresql:");
    assert.ok(
      databaseUrl.hostname === `db.${projectRef}.supabase.co` ||
        databaseUrl.hostname.endsWith(".pooler.supabase.com"),
    );
    assert.equal(
      decodeURIComponent(databaseUrl.username),
      `yaparena_runtime${databaseUrl.hostname.endsWith(".pooler.supabase.com") ? `.${projectRef}` : ""}`,
    );
    assert.equal(databaseUrl.pathname, "/postgres");
    assert.equal(
      decodeURIComponent(databaseUrl.password),
      settings.runtime.password,
    );
    state.fixedTargetsVerified = true;
    const before = await snapshot(settings, ca, deadline, state);
    state.ownerConnectionsClosedBeforeProvider = true;
    state.jobPresent = before.job !== null;
    state.state = before.job?.state ?? "absent";
    state.generationMatch = before.authGeneration === before.providerGeneration;
    state.acceptedCredentialSnapshot =
      verifiedStoredCredentials(before) !== null;
    if (!state.generationMatch || !state.acceptedCredentialSnapshot) {
      await save("PENDING", "credential_verification_required", state);
      return;
    }
    if (!before.job) {
      await save("PENDING", "wallet_job_pending", state);
      return;
    }
    if (
      before.job.subject !== before.subject ||
      before.job.state === "review_required"
    ) {
      await save("REVIEW_REQUIRED", "ownership_review", state);
      return;
    }
    const provider = createPrivyEmbeddedWalletProvider({
      appId,
      appSecret,
      fetch: readOnlyProviderFetch({
        subject: before.subject,
        externalId: before.job.externalId,
        signal: deadline,
        facts: state,
        transport: globalThis.fetch,
      }),
    });
    let first: Awaited<ReturnType<typeof provider.inspect>>,
      second: Awaited<ReturnType<typeof provider.inspect>>;
    try {
      first = await provider.inspect({
        subject: before.subject,
        externalId: before.job.externalId,
        signal: deadline,
      });
      second = await provider.inspect({
        subject: before.subject,
        externalId: before.job.externalId,
        signal: deadline,
      });
    } catch (error) {
      await save(
        error instanceof EmbeddedWalletProviderError &&
          error.code === "review_required"
          ? "REVIEW_REQUIRED"
          : "UNAVAILABLE",
        error instanceof EmbeddedWalletProviderError &&
          error.code === "review_required"
          ? "ownership_review"
          : "provider_unavailable",
        state,
      );
      return;
    }
    state.repeatedProviderReadsAgree =
      JSON.stringify(first) === JSON.stringify(second);
    state.providerCredentialsMatch =
      first.credentialsDigest === before.credentialsDigest &&
      second.credentialsDigest === before.credentialsDigest;
    const after = await snapshot(settings, ca, deadline, state);
    state.repeatedDatabaseReadsAgree = equalSnapshots(before, after);
    state.deployedRevisionVerified = false;
    await deployment();
    state.deployedRevisionVerified = true;
    if (
      !state.repeatedDatabaseReadsAgree ||
      !state.repeatedProviderReadsAgree
    ) {
      await save("PENDING", "concurrent_change", state);
      return;
    }
    if (!state.providerCredentialsMatch) {
      await save("PENDING", "credential_verification_required", state);
      return;
    }
    if (!first.wallet) {
      await save(
        before.job.state === "ready" ? "REVIEW_REQUIRED" : "PENDING",
        before.job.state === "ready"
          ? "ownership_review"
          : "wallet_job_pending",
        state,
      );
      return;
    }
    if (before.job.state !== "ready") {
      await save("PENDING", "wallet_job_pending", state);
      return;
    }
    if (
      first.wallet.id !== before.job.walletId ||
      first.wallet.address.toLowerCase() !== before.job.address?.toLowerCase()
    ) {
      await save("REVIEW_REQUIRED", "ownership_review", state);
      return;
    }
    state.userOnlyOwnerVerified = true;
    state.noAdditionalSignerOrPolicyVerified = true;
    await save("PASS", "confirmed_user_owned_wallet", state);
  } catch {
    await save("FAIL", "guard_rejected", state);
  }
}

async function selfTest() {
  let networkCalls = 0,
    checks = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    networkCalls++;
    throw new Error("Network forbidden during self-test");
  };
  try {
    const {
      createPrivyEmbeddedWalletProvider,
      EmbeddedWalletProviderError,
      providerCredentialsDigest,
    } = await sourceModules();
    const subject = "did:privy:synthetic-wallet-inspection",
      externalId = "synthetic-external-reference",
      address = "0x1234567890123456789012345678901234567890",
      credentials = [
        {
          type: "email",
          id: "synthetic@example.invalid",
        } satisfies ProviderCredential,
      ],
      state = facts(),
      calls: Request[] = [],
      response = (value: unknown) =>
        new Response(JSON.stringify(value), {
          headers: { "Content-Type": "application/json" },
        }),
      fixture: typeof globalThis.fetch = async (url, options) => {
        const request = new Request(url, options),
          path = decodeURIComponent(new URL(request.url).pathname);
        calls.push(request);
        assert.equal(request.method, "GET");
        assert.equal(request.redirect, "error");
        if (path === `/v1/apps/${appId}`)
          return response({ email_auth: true, merge_accounts_by_email: false });
        if (path === `/v1/users/${subject}`)
          return response({
            id: subject,
            is_guest: false,
            frozen_at: null,
            linked_accounts: [
              { type: "email", address: credentials[0]!.id },
              {
                type: "wallet",
                id: "synthetic-wallet",
                chain_type: "ethereum",
                address,
                wallet_client_type: "privy",
                connector_type: "embedded",
                user_can_sign: true,
              },
            ],
          });
        if (path === `/v1/wallets/ext_wal_${externalId}`)
          return response({
            id: "synthetic-wallet",
            chain_type: "ethereum",
            address,
            external_id: externalId,
            archived_at: null,
            additional_signers: [],
            policy_ids: [],
            owner_id: "synthetic-quorum",
          });
        if (path === "/v1/key_quorums/synthetic-quorum")
          return response({
            id: "synthetic-quorum",
            authorization_threshold: 1,
            authorization_keys: [],
            user_ids: [subject],
            key_quorum_ids: [],
          });
        throw new Error("Unexpected synthetic route");
      },
      guarded = readOnlyProviderFetch({
        subject,
        externalId,
        signal: new AbortController().signal,
        facts: state,
        transport: fixture,
      });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      await assert.rejects(
        guarded("https://api.privy.io/v1/wallets", { method, body: "{}" }),
      );
      assert.equal(calls.length, 0);
      checks++;
    }
    for (const url of [
      "https://other.invalid/v1/wallets/synthetic",
      "http://api.privy.io/v1/wallets/synthetic",
      `https://api.privy.io/v1/apps/${appId}?secret=hidden`,
      "https://api.privy.io/v1/users/not-the-account",
      "https://api.privy.io/v1/wallets/synthetic/rpc",
    ]) {
      await assert.rejects(guarded(url));
      assert.equal(calls.length, 0);
      checks++;
    }
    const provider = createPrivyEmbeddedWalletProvider({
      appId,
      appSecret: "synthetic-secret-only",
      fetch: guarded,
    });
    assert.deepEqual(
      await provider.inspect({
        subject,
        externalId,
        signal: new AbortController().signal,
      }),
      {
        credentialsDigest: providerCredentialsDigest(credentials),
        wallet: { id: "synthetic-wallet", address },
      },
    );
    assert.equal(calls.length, 4);
    checks++;
    await assert.rejects(
      provider.create({
        subject,
        externalId,
        idempotencyKey: "synthetic-attempt",
        signal: new AbortController().signal,
      }),
      EmbeddedWalletProviderError,
    );
    assert.equal(calls.length, 4);
    assert.equal(state.providerMutationAttemptsBlocked, 5);
    checks++;
    const malformed = readOnlyProviderFetch({
      subject,
      externalId,
      signal: new AbortController().signal,
      facts: facts(),
      transport: async () =>
        response({ linked_accounts: "private-untrusted-response" }),
    });
    await assert.rejects(malformed(`https://api.privy.io/v1/users/${subject}`));
    checks++;
    for (const frozenAt of [undefined, "unconfirmed", 0, -1, 1.5]) {
      const malformedFreeze = readOnlyProviderFetch({
        subject,
        externalId,
        signal: new AbortController().signal,
        facts: facts(),
        transport: async () =>
          response({
            id: subject,
            is_guest: false,
            frozen_at: frozenAt,
            linked_accounts: [{ type: "email", address: credentials[0]!.id }],
          }),
      });
      await assert.rejects(
        malformedFreeze(`https://api.privy.io/v1/users/${subject}`),
      );
      checks++;
    }
    await assert.rejects(
      boundedJson(
        new Response("x".repeat(maximumResponseBytes + 1), {
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    await assert.rejects(
      boundedJson(
        new Response("{}", {
          status: 302,
          headers: { Location: "https://other.invalid" },
        }),
      ),
    );
    checks += 2;
    const encoded = JSON.stringify(
      report("PENDING", "wallet_job_pending", state),
    );
    for (const secret of [
      subject,
      externalId,
      address,
      "synthetic-secret-only",
      "private-untrusted-response",
    ])
      assert.equal(encoded.includes(secret), false);
    checks++;
    assert.equal(networkCalls, 0);
    console.log(
      JSON.stringify({
        result: "PASS",
        mode: "self-test",
        checks,
        networkCalls,
        providerMutations: 0,
        databaseConnections: 0,
      }),
    );
  } finally {
    globalThis.fetch = original;
  }
}
try {
  assert.equal(process.argv.length, 3);
  assert.match(process.versions.node, /^24\./);
  assert.ok(process.execArgv.includes("--experimental-transform-types"));
  const mode = process.argv[2];
  assert.ok(mode === "inspect" || mode === "self-test");
  if (mode === "self-test") await selfTest();
  else await inspect();
} catch {
  console.error(
    JSON.stringify({
      result: "FAIL",
      reason: "guard_rejected",
      privateDetailsWithheld: true,
    }),
  );
  process.exitCode = 1;
}
