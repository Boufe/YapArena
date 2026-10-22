import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Fixed staging targets, plus the background-jobs worker once it exists: it is
// found by exact name, type and workspace because its ID is not fixed here.
// Secrets and raw API bodies remain in memory.
// inspect never mutates. Every other mode needs its exact explicit action flag.
// https://api-docs.render.com/reference/suspend-service-1
// https://api-docs.render.com/reference/resume-service-1
// https://api-docs.render.com/reference/update-env-var
// https://api-docs.render.com/reference/create-deploy
type Target = {
  id: string;
  name: string;
  type: "web_service" | "background_worker";
};
const fixedTargets: readonly Target[] = [
  {
    id: "srv-datv1kjncjis73a500cg",
    name: "yaparena-staging-web",
    type: "web_service",
  },
  {
    id: "srv-db38jiid0e5s73ffr2cg",
    name: "yaparena-replay-worker",
    type: "background_worker",
  },
];
const jobsWorkerName = "yaparena-staging-jobs";
let targets: readonly Target[] = fixedTargets;
const mode = process.argv[2] ?? "inspect";
assert.ok(
  ["inspect", "suspend", "resume", "configure-sandbox", "deploy"].includes(
    mode,
  ),
);
assert.ok(process.argv.length <= 3);
if (mode !== "inspect")
  assert.equal(process.env.ACCOUNT_STAGING_RENDER_ACTION, mode);
const directory = resolve(
    "docs/evidence/account-completion-baseline/embedded-wallet-release",
  ),
  lockPath = "/private/tmp/yaparena-auth-operator/render-release.lock";
type Json = Record<string, unknown>;
type Service = {
  id: string;
  name: string;
  type: string;
  suspended: "suspended" | "not_suspended";
  autoDeploy: "yes" | "no" | "unknown";
  branch: "main" | "feat/email-first-accounts" | "other" | null;
  plan: string | null;
};
type Snapshot = {
  service: Service;
  variables: Map<string, string>;
  latest: { id: string; status: string; commit: string | null } | null;
};
function object(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function string(value: unknown) {
  assert.ok(typeof value === "string");
  return value;
}
let key: string | undefined,
  lock: Awaited<ReturnType<typeof open>> | undefined,
  step = "load private Render CLI credential";
const overallDeadline = AbortSignal.timeout(60000);
async function request(
  path: string,
  method = "GET",
  body?: Json,
  statuses = [200],
): Promise<unknown> {
  assert.ok(key && /^\/services(?:\/srv-[a-z0-9]+(?:\/.*)?)?\??/.test(path));
  const response = await fetch(`https://api.render.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.any([AbortSignal.timeout(12000), overallDeadline]),
    redirect: "error",
  });
  assert.ok(
    statuses.includes(response.status),
    "Render operation rejected; response body withheld",
  );
  const bytes = await response.text();
  assert.ok(Buffer.byteLength(bytes) < 1024 * 1024);
  return bytes.trim() ? (JSON.parse(bytes) as unknown) : null;
}
async function findJobsWorker(): Promise<Target | undefined> {
  const web = await request(`/services/${fixedTargets[0]!.id}`);
  assert.ok(object(web));
  const ownerId = string(web.ownerId);
  assert.match(ownerId, /^tea-[a-z0-9]+$/);
  const rows = await request(
    `/services?name=${jobsWorkerName}&type=background_worker&ownerId=${ownerId}&limit=20`,
  );
  assert.ok(Array.isArray(rows) && rows.length <= 1);
  const row: unknown = rows[0];
  if (row === undefined) return undefined;
  assert.ok(object(row) && object(row.service));
  const id = string(row.service.id);
  assert.match(id, /^srv-[a-z0-9]+$/);
  assert.equal(row.service.ownerId, ownerId);
  return { id, name: jobsWorkerName, type: "background_worker" };
}
async function snapshot(target: Target): Promise<Snapshot> {
  const service = await request(`/services/${target.id}`);
  assert.ok(object(service));
  assert.equal(service.id, target.id);
  assert.equal(service.name, target.name);
  assert.equal(service.type, target.type);
  assert.ok(
    service.suspended === "suspended" || service.suspended === "not_suspended",
  );
  const rows = await request(`/services/${target.id}/env-vars?limit=100`),
    variables = new Map<string, string>();
  assert.ok(Array.isArray(rows) && rows.length < 100);
  for (const row of rows) {
    assert.ok(object(row) && object(row.envVar));
    variables.set(string(row.envVar.key), string(row.envVar.value));
  }
  const deployments = await request(`/services/${target.id}/deploys?limit=1`);
  assert.ok(Array.isArray(deployments));
  let latest: Snapshot["latest"] = null;
  if (deployments.length) {
    const row: unknown = deployments[0];
    assert.ok(object(row) && object(row.deploy));
    const deploy = row.deploy;
    latest = {
      id: string(deploy.id),
      status: string(deploy.status),
      commit:
        object(deploy.commit) && typeof deploy.commit.id === "string"
          ? deploy.commit.id
          : null,
    };
  }
  return {
    service: {
      id: target.id,
      name: target.name,
      type: target.type,
      suspended: service.suspended,
      autoDeploy:
        service.autoDeploy === "yes" || service.autoDeploy === "no"
          ? service.autoDeploy
          : "unknown",
      branch:
        service.branch === "main" ||
        service.branch === "feat/email-first-accounts"
          ? service.branch
          : typeof service.branch === "string"
            ? "other"
            : null,
      plan:
        object(service.serviceDetails) &&
        typeof service.serviceDetails.plan === "string" &&
        /^[a-z0-9_-]{1,40}$/.test(service.serviceDetails.plan)
          ? service.serviceDetails.plan
          : null,
    },
    variables,
    latest,
  };
}
function database(value: string | undefined) {
  assert.ok(value);
  const url = new URL(value),
    mode = url.searchParams.get("sslmode"),
    allowedModes = [
      "disable",
      "allow",
      "prefer",
      "require",
      "verify-ca",
      "verify-full",
      "no-verify",
    ];
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  return {
    runtimeRole:
      decodeURIComponent(url.username).split(".")[0] === "yaparena_runtime",
    expectedProject:
      decodeURIComponent(url.username).endsWith(".ypteqfmjietdqjzyvgtk") ||
      url.hostname === "db.ypteqfmjietdqjzyvgtk.supabase.co",
    sslmode:
      mode === null
        ? "absent"
        : allowedModes.includes(mode)
          ? mode
          : "unrecognized",
    certificateParameterPresent: url.searchParams.has("sslrootcert"),
    certificateContentParameter:
      url.searchParams.get("sslrootcert")?.includes("BEGIN CERTIFICATE") ??
      false,
  };
}
function safe(state: Snapshot, webDatabase: string | undefined) {
  const vars = state.variables;
  return {
    ...state.service,
    latestDeploy: state.latest,
    database: {
      ...database(vars.get("DATABASE_URL")),
      sameAsWeb: vars.get("DATABASE_URL") === webDatabase,
    },
    tlsEnvironment: {
      validationExplicitlyDisabled:
        vars.get("NODE_TLS_REJECT_UNAUTHORIZED") === "0",
      extraCaPathConfigured: Boolean(vars.get("NODE_EXTRA_CA_CERTS")),
      pgRootCertConfigured: Boolean(vars.get("PGSSLROOTCERT")),
    },
    coinSandboxEnabled: vars.get("COIN_SANDBOX_ENABLED") === "true",
    sandboxWebhookConfigured: Boolean(vars.get("COIN_SANDBOX_WEBHOOK_SECRET")),
    backgroundJobsEnabledByConfiguration:
      (vars.get("RUN_BACKGROUND_JOBS") ?? "true") === "true",
  };
}
async function all() {
  return Promise.all(targets.map(snapshot));
}
async function waitSuspended(expected: Service["suspended"]) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const states = await all();
    if (states.every((state) => state.service.suspended === expected))
      return states;
    await delay(1000);
  }
  throw new Error(
    "Service action did not reach expected state within bounded inspection",
  );
}
try {
  const path = "/Users/felixboucher/.render/cli.yaml",
    metadata = await lstat(path);
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink());
  assert.equal(metadata.mode & 0o077, 0);
  const text = await readFile(path, "utf8"),
    match = text.match(/^\s*key:\s*(.+)$/m);
  assert.ok(match?.[1]);
  const encoded = match[1].trim(),
    parsed: unknown = encoded.startsWith('"') ? JSON.parse(encoded) : encoded;
  assert.ok(typeof parsed === "string" && parsed.length > 20);
  key = parsed;
  if (mode !== "inspect") lock = await open(lockPath, "wx", 0o600);
  step = "find the optional background-jobs worker by exact name";
  const jobsWorker = await findJobsWorker();
  if (jobsWorker) targets = [...fixedTargets, jobsWorker];
  step = "inspect exact staging services without exposing environment values";
  let states = await all();
  const web = states.find((state) => state.service.id === fixedTargets[0]!.id);
  assert.ok(web);
  assert.ok(
    states.every(
      (state) =>
        state.variables.get("DATABASE_URL") ===
        web.variables.get("DATABASE_URL"),
    ),
  );
  for (const state of states) {
    const db = database(state.variables.get("DATABASE_URL"));
    assert.equal(db.runtimeRole, true);
    assert.equal(db.expectedProject, true);
  }
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    operations: { service: string; operation: string; accepted: boolean }[] =
      [];
  if (mode === "suspend" || mode === "resume") {
    step = `request ${mode} only for the named staging services`;
    for (const target of targets) {
      await request(`/services/${target.id}/${mode}`, "POST", undefined, [202]);
      operations.push({
        service: target.name,
        operation: mode,
        accepted: true,
      });
    }
    states = await waitSuspended(
      mode === "suspend" ? "suspended" : "not_suspended",
    );
  } else if (mode === "configure-sandbox") {
    step =
      "enable only the web deterministic sandbox while writers remain suspended";
    assert.ok(states.every((state) => state.service.suspended === "suspended"));
    const source = execFileSync("git", ["show", `${revision}:src/server.ts`], {
      encoding: "utf8",
    });
    assert.match(
      source,
      /createCoinSandboxRepository\(database,\s*\{\s*rail:\s*"simulation"\s*\}\)/,
    );
    for (const [name, value] of web.variables)
      if (
        /^(?:COIN|FINANCIAL|REDEMPTION|PAYOUT|FUNDING)_/.test(name) &&
        name !== "COIN_SANDBOX_ENABLED" &&
        name !== "COIN_SANDBOX_WEBHOOK_SECRET"
      )
        assert.ok(
          value === "false" || value === "simulation",
          "unexpected financial setting requires review",
        );
    await request(
      `/services/${fixedTargets[0]!.id}/env-vars/COIN_SANDBOX_ENABLED`,
      "PUT",
      { value: "true" },
    );
    operations.push({
      service: fixedTargets[0]!.name,
      operation: "enable deterministic sandbox only",
      accepted: true,
    });
    states = await all();
    assert.equal(states[0]?.variables.get("COIN_SANDBOX_ENABLED"), "true");
  } else if (mode === "deploy") {
    step = "require web or a running jobs worker to run background jobs";
    const jobs = states.find((state) => state.service.name === jobsWorkerName);
    assert.ok(
      (web.variables.get("RUN_BACKGROUND_JOBS") ?? "true") === "true" ||
        jobs?.service.suspended === "not_suspended",
      "web or a running jobs worker must process account and media revocation",
    );
    step =
      "deploy explicitly supplied current repository commit to web and the jobs worker";
    assert.equal(process.env.ACCOUNT_STAGING_RENDER_COMMIT, revision);
    assert.match(revision, /^[a-f0-9]{40}$/);
    // The jobs worker verifies the same migrations as web, so both get HEAD.
    for (const target of [web.service, ...(jobs ? [jobs.service] : [])]) {
      const deploy = await request(
        `/services/${target.id}/deploys`,
        "POST",
        { commitId: revision, clearCache: "do_not_clear" },
        [201, 202],
      );
      assert.ok(object(deploy) && typeof deploy.id === "string");
      operations.push({
        service: target.name,
        operation: "deploy exact HEAD (acceptance only; not live confirmation)",
        accepted: true,
      });
    }
    states = await all();
  }
  const report = {
    at: new Date().toISOString(),
    mode,
    revision,
    helperSha256: createHash("sha256")
      .update(await readFile(new URL(import.meta.url)))
      .digest("hex"),
    mutations: operations,
    services: states.map((state) =>
      safe(state, states[0]?.variables.get("DATABASE_URL")),
    ),
    limitations: [
      "Control-plane configuration evidence; URL sslmode/CA flags alone do not prove the running driver's TLS handshake.",
      "No raw environment values, URLs, credentials, owner identities, deploy messages or error bodies are exported.",
      "Deploy acceptance is not live-revision/readiness/browser acceptance; verify that separately.",
      "No plan, provider identity, live funds, retained account, recording, egress, allowlist or SSH configuration is changed.",
    ],
  };
  await mkdir(directory, { recursive: true });
  const artifactPath = resolve(directory, `render-account-${mode}.json`);
  await writeFile(
    `${artifactPath}.next`,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await rename(`${artifactPath}.next`, artifactPath);
  console.log(
    JSON.stringify({
      result: "PASS",
      mode,
      operations,
      services: report.services,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      result: "FAIL",
      mode,
      step,
      category: error instanceof Error ? error.name : "unclassified",
      detail:
        "Private credentials, endpoints and API response bodies are withheld. Inspect current service state before retrying an uncertain mutation.",
    }),
  );
  process.exitCode = 1;
} finally {
  key = undefined;
  await lock?.close();
  if (lock) await rm(lockPath);
}
