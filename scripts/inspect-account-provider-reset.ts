import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { APIError, PrivyClient } from "@privy-io/node";
import pg from "pg";
import { parseProviderPasskeyPublicKey } from "../dist/platform/auth/provider-passkeys.js";
import {
  providerCredentialsDigest,
  verifiedStoredCredentials,
  type ProviderCredential,
} from "../src/platform/auth/provider-credentials.ts";

// Fixed staging, read-only diagnosis. No .env, user/token creation, provider
// controls, account mutation or private identifiers in output or saved files.
const project = "ypteqfmjietdqjzyvgtk";
const service = "srv-datv1kjncjis73a500cg";
const appId = "cmvfjb3r800vy0hl3heg2cuvv";
const rolePath = "/private/tmp/yaparena-auth-operator/role-recovery.json";
const renderPath = "/Users/felixboucher/.render/cli.yaml";
const deadline = AbortSignal.timeout(60_000);
let step = "private configuration";
let database: pg.Client | undefined;
const watchdog = setTimeout(() => {
  console.log(JSON.stringify({ status: "failed", step, reason: "deadline" }));
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
function credentials(value: unknown): ProviderCredential[] | null {
  if (!Array.isArray(value)) return null;
  const result: ProviderCredential[] = [];
  for (const entry of value) {
    if (
      !object(entry) ||
      !["email", "google_oauth", "passkey"].includes(String(entry.type)) ||
      typeof entry.id !== "string" ||
      !entry.id
    )
      return null;
    if (
      entry.type === "email" ||
      entry.type === "google_oauth" ||
      entry.type === "passkey"
    )
      result.push({ type: entry.type, id: entry.id });
  }
  return result.length ? result : null;
}
type Mapping = {
  userId: string;
  subject: string;
  email: string | null;
  methods: unknown;
  credentialsDigest: string;
  credentialsSnapshot: unknown;
  generationMatch: boolean;
  currentJob: string | null;
  failureReason: string | null;
  confirmedFrozenAt: string | null;
  confirmedCutoffPreserved: boolean | null;
  generation: string;
  mappedGeneration: string;
  jobAttempts: string | null;
  auditPresent: boolean;
  auditGeneration: string | null;
  auditAttempts: string | null;
  auditSubjectDigest: string | null;
  auditCredentialsDigest: string | null;
  auditStartedSeconds: string | null;
  leaseEndSeconds: string | null;
};

async function main() {
  assert.equal(process.argv.length, 2);
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
  step = "private certificate configuration";
  const ca = await readFile(
    process.env.ACCOUNT_STAGING_CA_PATH ?? string(role.caPath),
    "utf8",
  );
  assert.match(ca, /-----BEGIN CERTIFICATE-----/);
  step = "read-only TLS database snapshot";
  database = new pg.Client({
    host,
    port: 5432,
    database: "postgres",
    user: string(role.owner.user),
    password: string(role.owner.password),
    ssl: { ca, rejectUnauthorized: true, servername: host },
    connectionTimeoutMillis: 8_000,
    query_timeout: 8_000,
    statement_timeout: 5_000,
    application_name: "yaparena-provider-readonly-diagnostic",
  });
  await database.connect();
  await database.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const identity = (
    await database.query<{ valid: boolean }>(
      `SELECT current_user='yaparena_owner' AND session_user='yaparena_owner'
       AND current_database()='postgres'
       AND current_setting('transaction_read_only')='on'
       AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
       AS valid FROM pg_roles r WHERE r.rolname=current_user`,
    )
  ).rows[0];
  assert.equal(identity?.valid, true);
  const mappings = (
    await database.query<Mapping>(
      `SELECT p.user_id::text AS "userId",p.subject,p.email,p.methods,p.credentials_digest AS "credentialsDigest",
       p.credentials_snapshot AS "credentialsSnapshot",
       p.auth_generation=u.auth_generation AS "generationMatch",
       j.state AS "currentJob",j.failure_reason AS "failureReason",
       j.confirmed_frozen_at::text AS "confirmedFrozenAt",
       CASE WHEN j.confirmed_frozen_at IS NOT NULL THEN p.minimum_issued_at>=j.confirmed_frozen_at+1 END AS "confirmedCutoffPreserved",
       u.auth_generation::text AS generation,p.auth_generation::text AS "mappedGeneration",
       j.attempts::text AS "jobAttempts",a.id IS NOT NULL AS "auditPresent",
       a.metadata->>'authGeneration' AS "auditGeneration",a.metadata->>'attempts' AS "auditAttempts",
       a.metadata->>'providerSubjectDigest' AS "auditSubjectDigest",
       a.metadata->>'credentialsDigest' AS "auditCredentialsDigest",
       extract(epoch FROM a.occurred_at)::text AS "auditStartedSeconds",
       extract(epoch FROM j.lease_until)::text AS "leaseEndSeconds"
       FROM yaparena.provider_identities p JOIN yaparena.users u ON u.id=p.user_id
       LEFT JOIN yaparena.provider_revocation_jobs j
         ON j.user_id=u.id AND j.generation=u.auth_generation AND j.subject=p.subject
       LEFT JOIN LATERAL (
         SELECT e.id,e.metadata,e.occurred_at FROM yaparena.identity_audit_events e
         WHERE e.user_id=u.id AND e.event_type='provider.reset.retry_requested'
           AND e.metadata->>'actorDatabaseRole'='yaparena_owner'
         ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1
       ) a ON true
       WHERE p.provider='privy' AND u.account_status='active'
       ORDER BY u.id LIMIT 5`,
    )
  ).rows;
  assert.ok(mappings.length <= 4, "fixed staging account bound exceeded");
  // Raw account/key locators stay inside this process, solely to compare the
  // authoritative provider evidence with this read-only database snapshot.
  const userIds = mappings.map((mapping) => mapping.userId);
  const localKeys = (
    await database.query<{
      userId: string;
      provenance: "yaparena" | "privy";
      subject: string | null;
      credentialId: string;
      publicKeyDigest: string | null;
      rpId: string | null;
      revoked: boolean;
    }>(
      `SELECT user_id::text AS "userId",provenance,provider_subject AS subject,
       credential_id AS "credentialId",provider_public_key_digest AS "publicKeyDigest",
       rp_id AS "rpId",revoked_at IS NOT NULL AS revoked
       FROM yaparena.account_security_keys WHERE user_id=ANY($1::bigint[])
       ORDER BY id LIMIT 101`,
      [userIds],
    )
  ).rows;
  assert.ok(localKeys.length <= 100, "fixed diagnostic key bound exceeded");
  type SetupCounts = {
    total: number;
    consumed: number;
    unconsumedLive: number;
    unconsumedExpired: number;
    candidateCaptured: number;
    candidateMissing: number;
    addition: number;
    existing: number;
    generationMatch: number;
    originalSessionActive: number;
  };
  const setupIntents = (
    await database.query<SetupCounts>(
      `SELECT count(*)::int AS total,
       count(*) FILTER(WHERE i.consumed_at IS NOT NULL)::int AS consumed,
       count(*) FILTER(WHERE i.consumed_at IS NULL AND i.expires_at>clock_timestamp())::int AS "unconsumedLive",
       count(*) FILTER(WHERE i.consumed_at IS NULL AND i.expires_at<=clock_timestamp())::int AS "unconsumedExpired",
       count(*) FILTER(WHERE i.candidate_digest IS NOT NULL)::int AS "candidateCaptured",
       count(*) FILTER(WHERE i.candidate_digest IS NULL)::int AS "candidateMissing",
       count(*) FILTER(WHERE i.intent_mode='addition')::int AS addition,
       count(*) FILTER(WHERE i.intent_mode='existing')::int AS existing,
       count(*) FILTER(WHERE i.auth_generation=u.auth_generation)::int AS "generationMatch",
       count(*) FILTER(WHERE EXISTS(SELECT 1 FROM yaparena.sessions s
         WHERE s.user_id=i.user_id AND s.token_hash=i.session_token_hash
           AND s.auth_generation=i.auth_generation AND u.auth_generation=i.auth_generation
           AND s.expires_at>clock_timestamp()))::int AS "originalSessionActive"
       FROM yaparena.provider_passkey_intents i JOIN yaparena.users u ON u.id=i.user_id
       WHERE i.user_id=ANY($1::bigint[])`,
      [userIds],
    )
  ).rows[0];
  const bootstrapIntents = (
    await database.query<{
      total: number;
      consumed: number;
      unconsumedLive: number;
      unconsumedExpired: number;
      generationMatch: number;
    }>(
      `SELECT count(*)::int AS total,
       count(*) FILTER(WHERE b.consumed_at IS NOT NULL)::int AS consumed,
       count(*) FILTER(WHERE b.consumed_at IS NULL AND b.expires_at>clock_timestamp())::int AS "unconsumedLive",
       count(*) FILTER(WHERE b.consumed_at IS NULL AND b.expires_at<=clock_timestamp())::int AS "unconsumedExpired",
       count(*) FILTER(WHERE b.auth_generation=u.auth_generation)::int AS "generationMatch"
       FROM yaparena.provider_passkey_bootstraps b JOIN yaparena.users u ON u.id=b.user_id
       WHERE b.user_id=ANY($1::bigint[])`,
      [userIds],
    )
  ).rows[0];
  const recentPasskeyAudit = (
    await database.query<{ eventType: string; count: number }>(
      `SELECT event_type AS "eventType",count(*)::int AS count
       FROM yaparena.identity_audit_events
       WHERE user_id=ANY($1::bigint[]) AND occurred_at>clock_timestamp()-interval '30 minutes'
         AND event_type=ANY($2::text[]) GROUP BY event_type ORDER BY event_type LIMIT 16`,
      [
        userIds,
        [
          "provider.passkey.activated",
          "provider.passkey.bootstrap_completed",
          "security.passkey.enrolled",
          "security.passkey.revoked",
          "provider.credentials.reconciled",
        ],
      ],
    )
  ).rows;
  assert.ok(setupIntents && bootstrapIntents);
  const timelineSetupIntents = (
    await database.query<{
      mode: "addition" | "existing";
      createdAt: string;
      expiresAt: string;
      consumedAt: string | null;
      generationDelta: string;
      candidateCaptured: boolean;
    }>(
      `SELECT i.intent_mode AS mode,i.created_at::text AS "createdAt",i.expires_at::text AS "expiresAt",
       i.consumed_at::text AS "consumedAt",(i.auth_generation-u.auth_generation)::text AS "generationDelta",
       i.candidate_digest IS NOT NULL AS "candidateCaptured"
       FROM yaparena.provider_passkey_intents i JOIN yaparena.users u ON u.id=i.user_id
       WHERE i.user_id=ANY($1::bigint[]) ORDER BY i.created_at DESC LIMIT 10`,
      [userIds],
    )
  ).rows.reverse();
  const auditTypes = [
    "sessions.logout_all",
    "sessions.logout_others",
    "sessions.incident",
    "sessions.logout",
    "sessions.revoked",
    "provider.credentials.reconciled",
    "security.passkey.enrolled",
    "security.passkey.revoked",
    "provider.passkey.activated",
    "provider.passkey.bootstrap_completed",
    "provider.reset.retry_requested",
    "provider.reset.reconciliation_requested",
    "provider.reset.reconciled",
    "provider.identity.recovered",
  ];
  const timelineAudit = (
    await database.query<{
      eventType: string;
      at: string;
      generationDelta: string | null;
      outcome: string;
    }>(
      `WITH bounds AS(SELECT coalesce(min(created_at)-interval '2 minutes',clock_timestamp()-interval '24 hours') AS since
         FROM yaparena.provider_passkey_intents WHERE user_id=ANY($1::bigint[]))
       SELECT e.event_type AS "eventType",e.occurred_at::text AS at,
       CASE WHEN e.metadata->>'authGeneration' ~ '^[0-9]{1,18}$'
         THEN ((e.metadata->>'authGeneration')::bigint-u.auth_generation)::text END AS "generationDelta",
       CASE WHEN e.metadata->>'outcome' IN ('success','failure','uncertain')
         THEN e.metadata->>'outcome' ELSE 'unavailable' END AS outcome
       FROM yaparena.identity_audit_events e JOIN yaparena.users u ON u.id=e.user_id CROSS JOIN bounds
       WHERE e.user_id=ANY($1::bigint[]) AND e.occurred_at>=bounds.since
         AND e.event_type=ANY($2::text[]) ORDER BY e.occurred_at DESC,e.id DESC LIMIT 30`,
      [userIds, auditTypes],
    )
  ).rows.reverse();
  const timelineResetJobs = (
    await database.query<{
      generationDelta: string;
      mappedGenerationDelta: string;
      state: string;
      failureReason: string | null;
      attempts: number;
      leaseUntil: string;
      confirmedFrozenAt: string | null;
      currentSubject: boolean;
    }>(
      `SELECT (j.generation-u.auth_generation)::text AS "generationDelta",
       (j.generation-p.auth_generation)::text AS "mappedGenerationDelta",
       j.state,j.failure_reason AS "failureReason",j.attempts,j.lease_until::text AS "leaseUntil",
       j.confirmed_frozen_at::text AS "confirmedFrozenAt",j.subject=p.subject AS "currentSubject"
       FROM yaparena.provider_revocation_jobs j JOIN yaparena.users u ON u.id=j.user_id
       JOIN yaparena.provider_identities p ON p.user_id=u.id AND p.provider='privy'
       WHERE j.user_id=ANY($1::bigint[]) ORDER BY j.generation DESC LIMIT 10`,
      [userIds],
    )
  ).rows.reverse();
  await database.query("ROLLBACK");
  await database.end();
  database = undefined;

  step = "fixed Render configuration GET";
  const text = await privateFile(renderPath),
    match = text.match(/^\s*key:\s*(.+)$/m);
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
  const subjects = new Set(mappings.map((mapping) => mapping.subject));
  const readonlyFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init),
      url = new URL(request.url);
    assert.equal(request.method, "GET");
    assert.equal(url.origin, "https://api.privy.io");
    assert.ok(
      url.pathname.startsWith("/v1/users/") && !url.search && !url.hash,
    );
    assert.ok(
      subjects.has(decodeURIComponent(url.pathname.slice("/v1/users/".length))),
    );
    return fetch(request, {
      redirect: "error",
      signal: AbortSignal.any([
        request.signal,
        deadline,
        AbortSignal.timeout(5_000),
      ]),
    });
  };
  const provider = new PrivyClient({
    appId,
    appSecret: string(variables.get("PRIVY_APP_SECRET")),
    apiUrl: "https://api.privy.io",
    timeout: 5_000,
    maxRetries: 0,
    logLevel: "off",
    fetch: readonlyFetch,
  });
  const providerFrozenAtSeconds: number[] = [];
  const result = {
    activeMappings: mappings.length,
    resetReviewCandidates: mappings
      .filter(
        (mapping) =>
          mapping.currentJob === "manual" &&
          mapping.failureReason === "uncertain_provider_outcome" &&
          mapping.jobAttempts !== null,
      )
      .map((mapping) => ({
        expectedGeneration: mapping.generation,
        expectedAttempts: Number(mapping.jobAttempts),
      })),
    generationMatch: 0,
    generationMismatch: 0,
    confirmedCutoffPreserved: mappings.filter(
      (mapping) => mapping.confirmedCutoffPreserved === true,
    ).length,
    storedDigestValid: 0,
    storedCredentialsVerifiable: 0,
    providerFrozen: 0,
    providerUnfrozen: 0,
    providerStateInvalid: 0,
    providerStateUnknown: 0,
    frozenAtField: {
      present: 0,
      absent: 0,
      explicitNull: 0,
      undefined: 0,
      positiveSafeInteger: 0,
      otherNumber: 0,
      string: 0,
      boolean: 0,
      objectOrArray: 0,
      other: 0,
    },
    retryAudit: {
      present: 0,
      attemptMatchesJob: 0,
      generationMatchesAccount: 0,
      generationMatchesMapping: 0,
      subjectAndCredentialsMatchMapping: 0,
      positiveFrozenStatesCompared: 0,
      frozenAtWithinExactAuditLeaseWindow: 0,
      frozenAtWithinSecondResolutionAuditLeaseWindow: 0,
    },
    passkeyEvidence: {
      providerPasskeys: 0,
      publicKeyPresent: 0,
      publicKeyMissing: 0,
      publicKeySupported: 0,
      publicKeyUnsupported: 0,
      relyingPartyExpectedHost: 0,
      relyingPartyExpectedOrigin: 0,
      relyingPartyMissing: 0,
      relyingPartyOther: 0,
      activeLocalProviderKeysMatch: 0,
      activeLocalProviderKeysMissing: 0,
      activeLocalProviderKeysMismatch: 0,
      activeLocalProviderKeysUnverifiable: 0,
    },
    localPasskeys: {
      total: localKeys.length,
      activePrivy: localKeys.filter(
        (key) => !key.revoked && key.provenance === "privy",
      ).length,
      activeYapArena: localKeys.filter(
        (key) => !key.revoked && key.provenance === "yaparena",
      ).length,
      revoked: localKeys.filter((key) => key.revoked).length,
    },
    setupIntents,
    bootstrapIntents,
    recentPasskeyAudit,
    timeline: {
      scope:
        "mapped accounts; setup10, allowlisted audit30 since earliest intent minus2minutes, resetjobs10 maximum",
      setupIntents: timelineSetupIntents,
      audit: timelineAudit,
      resetJobs: timelineResetJobs,
      providerFrozenAtSeconds,
    },
    currentCredentialsValid: 0,
    digestEqual: 0,
    digestDifferent: 0,
    currentJobs: {
      none: 0,
      pending: 0,
      running: 0,
      complete: 0,
      manual: 0,
      other: 0,
    },
    currentManual: {
      uncertain: 0,
      inherited: 0,
      independentFreeze: 0,
      other: 0,
    },
    confirmedFrozenRecorded: 0,
    confirmedFrozenMatchesProvider: 0,
    providerGet: {
      success: 0,
      notFound: 0,
      unauthenticated: 0,
      forbidden: 0,
      rateLimited: 0,
      serverError: 0,
      otherHttp: 0,
      networkOrTimeout: 0,
    },
  };
  step = "bounded read-only Privy GETs";
  for (const mapping of mappings) {
    if (mapping.generationMatch) result.generationMatch++;
    else result.generationMismatch++;
    if (/^[0-9a-f]{64}$/.test(mapping.credentialsDigest))
      result.storedDigestValid++;
    const methods =
      Array.isArray(mapping.methods) &&
      mapping.methods.every((v): v is string => typeof v === "string")
        ? mapping.methods
        : [];
    if (
      verifiedStoredCredentials({
        ...mapping,
        methods,
        credentialsSnapshot: credentials(mapping.credentialsSnapshot),
      })
    )
      result.storedCredentialsVerifiable++;
    const job = mapping.currentJob;
    if (job === null) result.currentJobs.none++;
    else if (
      job === "pending" ||
      job === "running" ||
      job === "complete" ||
      job === "manual"
    )
      result.currentJobs[job]++;
    else result.currentJobs.other++;
    if (job === "manual") {
      if (mapping.failureReason === "uncertain_provider_outcome")
        result.currentManual.uncertain++;
      else if (mapping.failureReason === "inherited_manual")
        result.currentManual.inherited++;
      else if (mapping.failureReason === "independent_provider_freeze")
        result.currentManual.independentFreeze++;
      else result.currentManual.other++;
    }
    if (mapping.confirmedFrozenAt !== null) result.confirmedFrozenRecorded++;
    if (mapping.auditPresent) {
      result.retryAudit.present++;
      if (
        mapping.auditAttempts !== null &&
        mapping.auditAttempts === mapping.jobAttempts
      )
        result.retryAudit.attemptMatchesJob++;
      if (mapping.auditGeneration === mapping.generation)
        result.retryAudit.generationMatchesAccount++;
      if (mapping.auditGeneration === mapping.mappedGeneration)
        result.retryAudit.generationMatchesMapping++;
      if (
        mapping.auditSubjectDigest ===
          createHash("sha256").update(mapping.subject).digest("hex") &&
        mapping.auditCredentialsDigest === mapping.credentialsDigest
      )
        result.retryAudit.subjectAndCredentialsMatchMapping++;
    }
    try {
      const user = await provider
        .users()
        ._get(mapping.subject, { signal: deadline });
      result.providerGet.success++;
      // The installed SDK returns the parsed GET JSON unchanged (internal/parse).
      // Its schema says frozen_at is not included in every response. Absence is
      // unknown, never evidence that this identity is currently unfrozen.
      const present = Object.prototype.hasOwnProperty.call(user, "frozen_at");
      const frozen: unknown = Reflect.get(user, "frozen_at");
      if (present) result.frozenAtField.present++;
      else result.frozenAtField.absent++;
      if (!present) result.providerStateUnknown++;
      else if (frozen === null) {
        result.frozenAtField.explicitNull++;
        result.providerUnfrozen++;
      } else if (
        typeof frozen === "number" &&
        Number.isSafeInteger(frozen) &&
        frozen > 0
      ) {
        result.frozenAtField.positiveSafeInteger++;
        result.providerFrozen++;
        result.timeline.providerFrozenAtSeconds.push(frozen);
        if (mapping.confirmedFrozenAt === String(frozen))
          result.confirmedFrozenMatchesProvider++;
        const start = Number(mapping.auditStartedSeconds),
          end = Number(mapping.leaseEndSeconds);
        if (
          mapping.auditPresent &&
          mapping.auditGeneration === mapping.generation &&
          mapping.auditAttempts !== null &&
          mapping.auditAttempts === mapping.jobAttempts &&
          mapping.auditStartedSeconds !== null &&
          mapping.leaseEndSeconds !== null &&
          Number.isFinite(start) &&
          Number.isFinite(end)
        ) {
          result.retryAudit.positiveFrozenStatesCompared++;
          if (frozen >= start && frozen <= end)
            result.retryAudit.frozenAtWithinExactAuditLeaseWindow++;
          // frozen_at has one-second resolution; audit/lease timestamps retain
          // fractional seconds. Neither comparison authorizes an unfreeze.
          if (frozen >= Math.floor(start) && frozen <= Math.ceil(end))
            result.retryAudit.frozenAtWithinSecondResolutionAuditLeaseWindow++;
        }
      } else {
        result.providerStateInvalid++;
        if (frozen === undefined) result.frozenAtField.undefined++;
        else if (typeof frozen === "number") result.frozenAtField.otherNumber++;
        else if (typeof frozen === "string") result.frozenAtField.string++;
        else if (typeof frozen === "boolean") result.frozenAtField.boolean++;
        else if (typeof frozen === "object")
          result.frozenAtField.objectOrArray++;
        else result.frozenAtField.other++;
      }
      const trustedKeys = new Map<string, string | null>();
      for (const linked of user.linked_accounts) {
        if (linked.type !== "passkey") continue;
        const evidence = result.passkeyEvidence;
        evidence.providerPasskeys++;
        const exported: unknown = Reflect.get(linked, "public_key");
        let keyDigest: string | null = null;
        if (typeof exported !== "string" || !exported)
          evidence.publicKeyMissing++;
        else {
          evidence.publicKeyPresent++;
          try {
            keyDigest = parseProviderPasskeyPublicKey(exported).publicKeyDigest;
            evidence.publicKeySupported++;
          } catch {
            evidence.publicKeyUnsupported++;
          }
        }
        trustedKeys.set(linked.credential_id, keyDigest);
        const rp: unknown = Reflect.get(linked, "relying_party");
        if (rp === "yaparena-staging-web.onrender.com")
          evidence.relyingPartyExpectedHost++;
        else if (rp === "https://yaparena-staging-web.onrender.com")
          evidence.relyingPartyExpectedOrigin++;
        else if (rp === undefined || rp === null)
          evidence.relyingPartyMissing++;
        else evidence.relyingPartyOther++;
      }
      for (const local of localKeys) {
        if (
          local.userId !== mapping.userId ||
          local.revoked ||
          local.provenance !== "privy"
        )
          continue;
        const evidence = result.passkeyEvidence;
        if (!trustedKeys.has(local.credentialId))
          evidence.activeLocalProviderKeysMissing++;
        else if (trustedKeys.get(local.credentialId) === null)
          evidence.activeLocalProviderKeysUnverifiable++;
        else if (
          local.subject === mapping.subject &&
          local.publicKeyDigest === trustedKeys.get(local.credentialId) &&
          local.rpId === "yaparena-staging-web.onrender.com"
        )
          evidence.activeLocalProviderKeysMatch++;
        else evidence.activeLocalProviderKeysMismatch++;
      }
      // Same canonical digest utility as the verifier, without treating a frozen
      // identity as authorized. No raw linked-account fields leave this process.
      const current: ProviderCredential[] = [];
      let valid = user.id === mapping.subject && !user.is_guest;
      for (const linked of user.linked_accounts) {
        if (linked.type === "email")
          current.push({ type: "email", id: linked.address });
        else if (linked.type === "google_oauth")
          current.push({ type: "google_oauth", id: linked.subject });
        else if (linked.type === "passkey")
          current.push({ type: "passkey", id: linked.credential_id });
        else valid = false;
      }
      if (valid && current.length) {
        result.currentCredentialsValid++;
        if (providerCredentialsDigest(current) === mapping.credentialsDigest)
          result.digestEqual++;
        else result.digestDifferent++;
      }
    } catch (failure) {
      const status = failure instanceof APIError ? failure.status : undefined;
      if (status === 404) result.providerGet.notFound++;
      else if (status === 401) result.providerGet.unauthenticated++;
      else if (status === 403) result.providerGet.forbidden++;
      else if (status === 429) result.providerGet.rateLimited++;
      else if (status !== undefined && status >= 500)
        result.providerGet.serverError++;
      else if (status !== undefined) result.providerGet.otherHttp++;
      else result.providerGet.networkOrTimeout++;
    }
  }
  const audits = result.retryAudit;
  const allAuditsPresent =
    result.activeMappings > 0 && audits.present === result.activeMappings;
  const frozenWindowKnown =
    result.providerFrozen > 0 &&
    audits.positiveFrozenStatesCompared === result.providerFrozen;
  console.log(
    JSON.stringify(
      {
        status: "inspected",
        at: new Date().toISOString(),
        helperSha256: createHash("sha256")
          .update(await readFile(new URL(import.meta.url)))
          .digest("hex"),
        parserSha256: createHash("sha256")
          .update(
            await readFile(
              new URL(
                "../dist/platform/auth/provider-passkeys.js",
                import.meta.url,
              ),
            ),
          )
          .digest("hex"),
        readOnly: true,
        diagnosticOnly: true,
        ...result,
        retryAuditSummary: {
          allAuditsPresent,
          attemptsMatchCurrentJobs:
            allAuditsPresent && audits.attemptMatchesJob === audits.present,
          generationsMatchCurrentAccounts:
            allAuditsPresent &&
            audits.generationMatchesAccount === audits.present,
          generationsMatchCurrentMappings:
            allAuditsPresent &&
            audits.generationMatchesMapping === audits.present,
          subjectsAndCredentialsMatchCurrentMappings:
            allAuditsPresent &&
            audits.subjectAndCredentialsMatchMapping === audits.present,
          frozenWindowKnown,
          frozenAtWithinExactAuditLeaseWindow:
            frozenWindowKnown &&
            audits.frozenAtWithinExactAuditLeaseWindow ===
              audits.positiveFrozenStatesCompared,
          frozenAtWithinSecondResolutionAuditLeaseWindow:
            frozenWindowKnown &&
            audits.frozenAtWithinSecondResolutionAuditLeaseWindow ===
              audits.positiveFrozenStatesCompared,
        },
      },
      null,
      2,
    ),
  );
}
try {
  await main();
} catch {
  console.log(
    JSON.stringify({
      status: "failed",
      step,
      details: "private diagnostics withheld",
    }),
  );
  process.exitCode = 1;
} finally {
  await database?.end().catch(() => {});
  clearTimeout(watchdog);
}
