import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Pool, PoolClient } from "pg";
import type { IdentityVerifier, ProviderSessionControl } from "./privy.ts";
import { createProviderControlPhases } from "./provider-control-phases.ts";
import { parseProviderPasskeyPublicKey } from "./provider-passkeys.ts";

type RetryStage =
  | "owner"
  | "input"
  | "snapshot"
  | "provider_inspection"
  | "claim"
  | "perform"
  | "provider_state"
  | "freeze"
  | "freeze_confirmation"
  | "unfreeze"
  | "unfreeze_confirmation"
  | "activity_review"
  | "commit"
  | "result";
export class ProviderResetRetryError extends Error {
  constructor(
    readonly stage: RetryStage,
    readonly providerStatus?: number,
  ) {
    super(`provider reset retry stopped at ${stage}`);
  }
}
type Claim = {
  userId: string;
  generation: string;
  subject: string;
  attempts: number;
  credentialsDigest?: string;
};
type RetrySnapshot = {
  generation: string;
  mappedGeneration: string;
  status: string;
  subject: string;
  credentialsDigest: string;
  attempts: number;
  state: string;
  failureReason: string | null;
  confirmedFrozenAt: string | null;
  available: boolean;
};
type RetryAudit = {
  userId: string;
  requestId: string;
  authGeneration: string;
  providerSubjectDigest: string;
  credentialsDigest: string;
  attempts: number;
};
type LogoutResetReview = {
  evidenceDigest: string;
  expectedFingerprint: string;
  expectedGeneration: string;
  expectedAttempts: number;
  knownOwnFreezeReviewed: true;
};
type LogoutResetSnapshot = {
  generation: string;
  mappedGeneration: string;
  subject: string;
  credentialsDigest: string;
  fingerprint: string;
  status: string;
  keys: { credentialId: string; keyDigest: string; subject: string }[];
  jobs: {
    generation: string;
    subject: string;
    state: string;
    phase: string;
    attempts: number;
    controlAttempt: number | null;
    controlId: string | null;
    controlDigest: string | null;
    failure: string | null;
    freezeRequested: boolean;
    freezeAcknowledged: boolean;
    unfreezeRequested: boolean;
    unfreezeAcknowledged: boolean;
    leaseAvailable: boolean;
  }[];
  logoutAuditValid: boolean;
};
const subjectDigest = (subject: string) =>
  createHash("sha256").update(subject).digest("hex");
function providerStatus(error: unknown) {
  if (
    error !== null &&
    typeof error === "object" &&
    "status" in error &&
    typeof error.status === "number" &&
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status <= 599
  )
    return error.status;
  return undefined;
}

// PostgreSQL commits the local fence before any provider call. Claims about
// iat become useful ONLY after Privy confirms that all old refresh sessions
// have been revoked. A failed/uncertain provider call leaves the local fence up.
export function createProviderRevocation(
  database: Pool,
  provider: ProviderSessionControl,
  {
    operatorInspector,
    operatorFrozenInspector,
  }: {
    operatorInspector?: Pick<IdentityVerifier, "inspect">;
    operatorFrozenInspector?: Pick<IdentityVerifier, "inspect">;
  } = {},
) {
  async function requireLogoutResetOwner() {
    const role = (
      await database.query<{ owner: boolean }>(
        `SELECT current_user='yaparena_owner' AND session_user='yaparena_owner'
       AND NOT(rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication) AS owner
       FROM pg_roles WHERE rolname=current_user`,
      )
    ).rows[0];
    if (!role?.owner) throw new ProviderResetRetryError("owner");
  }
  async function logoutResetSnapshot(
    client: Pool | PoolClient,
    userId: string,
  ) {
    const row = (
      await client.query<LogoutResetSnapshot>(
        `SELECT u.auth_generation::text AS generation,p.auth_generation::text AS "mappedGeneration",
       u.account_status AS status,p.subject,p.credentials_digest AS "credentialsDigest",
       (SELECT COALESCE(jsonb_agg(jsonb_build_object('credentialId',credential_id,
         'keyDigest',provider_public_key_digest,'subject',provider_subject) ORDER BY id),'[]'::jsonb)
        FROM account_security_keys WHERE user_id=u.id AND revoked_at IS NULL AND provenance='privy') AS keys,
       (SELECT COALESCE(jsonb_agg(jsonb_build_object('generation',j.generation::text,'subject',j.subject,
         'state',j.state,'phase',j.control_phase,'attempts',j.attempts,'controlAttempt',j.control_attempt,
         'controlId',j.control_id,'controlDigest',j.control_credentials_digest,'failure',j.failure_reason,
         'freezeRequested',j.freeze_requested_at IS NOT NULL,'freezeAcknowledged',j.freeze_acknowledged_at IS NOT NULL,
         'unfreezeRequested',j.unfreeze_requested_at IS NOT NULL,'unfreezeAcknowledged',j.unfreeze_acknowledged_at IS NOT NULL,
         'leaseAvailable',j.lease_until<clock_timestamp() AND j.control_lease_until<clock_timestamp())
         ORDER BY j.generation),'[]'::jsonb) FROM provider_revocation_jobs j WHERE j.user_id=u.id AND j.state<>'complete') AS jobs,
       EXISTS(SELECT 1 FROM identity_audit_events e WHERE e.user_id=u.id
         AND e.event_type IN('sessions.logout_all','sessions.logout_others')
         AND e.metadata->>'authGeneration'=u.auth_generation::text AND e.metadata->>'outcome'='success'
         AND e.metadata->>'actorUserId'=u.id::text AND e.metadata->>'actorDatabaseRole'='yaparena_runtime'
         AND e.metadata ? 'actorSessionId') AS "logoutAuditValid",
       encode(sha256(convert_to(jsonb_build_object('account',to_jsonb(u),'mapping',to_jsonb(p),
         'jobs',(SELECT jsonb_agg(to_jsonb(j) ORDER BY generation) FROM provider_revocation_jobs j WHERE j.user_id=u.id),
         'keys',(SELECT jsonb_agg(to_jsonb(k) ORDER BY id) FROM account_security_keys k WHERE k.user_id=u.id),
         'audit',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM identity_audit_events e WHERE e.user_id=u.id
           AND (e.metadata->>'authGeneration'=u.auth_generation::text OR e.event_type='provider.reset.logout_resumed'))
       )::text,'UTF8')),'hex') AS fingerprint
       FROM users u JOIN provider_identities p ON p.user_id=u.id AND p.provider='privy' WHERE u.id=$1`,
        [userId],
      )
    ).rows[0];
    if (
      !row ||
      row.status !== "active" ||
      BigInt(row.mappedGeneration) >= BigInt(row.generation) ||
      !row.logoutAuditValid ||
      row.keys.length === 0 ||
      row.keys.some(
        (key) =>
          key.subject !== row.subject || !/^[0-9a-f]{64}$/.test(key.keyDigest),
      ) ||
      row.jobs.length !== 2
    )
      throw new ProviderResetRetryError("snapshot");
    const [old, latest] = row.jobs;
    if (
      !old ||
      !latest ||
      old.subject !== row.subject ||
      latest.subject !== row.subject ||
      BigInt(old.generation) + 1n !== BigInt(row.generation) ||
      latest.generation !== row.generation ||
      old.state !== "manual" ||
      old.phase !== "freeze_confirm" ||
      old.failure !== "uncertain_provider_outcome" ||
      !old.freezeRequested ||
      !old.freezeAcknowledged ||
      old.unfreezeRequested ||
      old.unfreezeAcknowledged ||
      !old.controlId ||
      old.controlDigest !== row.credentialsDigest ||
      old.controlAttempt !== old.attempts ||
      old.attempts < 1 ||
      !old.leaseAvailable ||
      !latest.leaseAvailable ||
      latest.state !== "manual" ||
      latest.phase !== "preflight" ||
      latest.failure !== "inherited_manual" ||
      latest.attempts !== 0 ||
      latest.controlId !== null ||
      latest.freezeRequested ||
      latest.freezeAcknowledged ||
      latest.unfreezeRequested ||
      latest.unfreezeAcknowledged
    )
      throw new ProviderResetRetryError("snapshot");
    if (
      (
        await client.query(
          `SELECT 1 FROM identity_audit_events WHERE user_id=$1 AND event_type='provider.reset.logout_resumed'
      AND metadata->>'controlIdDigest'=$2 LIMIT 1`,
          [userId, subjectDigest(old.controlId)],
        )
      ).rowCount
    )
      throw new ProviderResetRetryError("snapshot");
    return row;
  }
  async function logoutResetReplay(
    client: Pool | PoolClient,
    userId: string,
    requestId: string,
    termsDigest: string,
  ) {
    const history = (
      await client.query<{ userId: string; termsDigest: string }>(
        `SELECT user_id::text AS "userId",metadata->>'termsDigest' AS "termsDigest" FROM identity_audit_events
       WHERE event_type='provider.reset.logout_resumed' AND metadata->>'requestId'=$1`,
        [requestId],
      )
    ).rows;
    if (history.length === 0) return false;
    if (
      history.length !== 1 ||
      history[0]?.userId !== userId ||
      history[0]?.termsDigest !== termsDigest
    )
      throw new ProviderResetRetryError("input");
    return true;
  }
  async function confirmState(
    subject: string,
    frozen: boolean,
    options: { signal: AbortSignal },
    expectedFreeze?: number,
  ) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const state = await provider.state(subject, options);
      if (
        frozen
          ? Number.isSafeInteger(state.frozenAt) &&
            state.frozenAt !== null &&
            state.frozenAt > 0
          : state.frozenAt === null
      )
        return state;
      if (
        !frozen &&
        expectedFreeze !== undefined &&
        state.frozenAt !== expectedFreeze
      )
        throw new Error("provider freeze changed before confirmation");
      // Real provider reads can lag a successful control response. Keep the
      // same read count and cumulative deadline while allowing propagation.
      if (attempt < 5) await delay(1500, undefined, { signal: options.signal });
    }
    throw new Error("provider state confirmation unavailable");
  }
  async function performClaimed(
    client: PoolClient,
    claim: Claim,
    reportStage: (stage: RetryStage) => void = () => {},
  ): Promise<boolean> {
    const { userId, generation } = claim;
    try {
      reportStage("perform");
      await client.query("BEGIN");
      const latest = (
        await client.query<{ generation: string; status: string }>(
          "SELECT auth_generation AS generation,account_status AS status FROM users WHERE id=$1 FOR UPDATE",
          [userId],
        )
      ).rows[0];
      const claimed = (
        await client.query<{
          subject: string;
          attempts: number;
          state: string;
          leaseValid: boolean;
        }>(
          `SELECT subject,attempts,state,lease_until>clock_timestamp() AS "leaseValid"
           FROM provider_revocation_jobs WHERE user_id=$1 AND generation=$2 FOR UPDATE`,
          [userId, generation],
        )
      ).rows[0];
      if (
        !claimed ||
        claimed.subject !== claim.subject ||
        claimed.state !== "running" ||
        claimed.attempts !== claim.attempts
      ) {
        await client.query("ROLLBACK");
        return false;
      }
      if (!claimed.leaseValid) {
        await client.query(
          "UPDATE provider_revocation_jobs SET state='manual',failure_reason='uncertain_provider_outcome' WHERE user_id=$1 AND generation=$2",
          [userId, generation],
        );
        await client.query("COMMIT");
        return false;
      }
      if (!latest || latest.generation !== generation) {
        await client.query(
          "UPDATE provider_revocation_jobs SET state='complete' WHERE user_id=$1 AND generation=$2",
          [userId, generation],
        );
        await client.query("COMMIT");
        return false;
      }
      const mapping = await client.query<{
        subject: string;
        credentialsDigest: string;
      }>(
        `SELECT subject,credentials_digest AS "credentialsDigest" FROM provider_identities WHERE user_id=$1 AND provider='privy'`,
        [userId],
      );
      if (mapping.rows[0]?.subject !== claim.subject) {
        await client.query(
          "UPDATE provider_revocation_jobs SET state='complete',failure_reason='retired_identity' WHERE user_id=$1 AND generation=$2",
          [userId, generation],
        );
        await client.query("COMMIT");
        return false;
      }
      if (
        claim.credentialsDigest &&
        (latest.status !== "active" ||
          mapping.rows[0].credentialsDigest !== claim.credentialsDigest)
      ) {
        await client.query(
          "UPDATE provider_revocation_jobs SET state='manual',failure_reason='uncertain_provider_outcome' WHERE user_id=$1 AND generation=$2",
          [userId, generation],
        );
        await client.query("COMMIT");
        return false;
      }
      const inherited = await client.query(
        "SELECT 1 FROM provider_revocation_jobs WHERE user_id=$1 AND generation<$2 AND subject=$3 AND state IN ('manual','running') LIMIT 1",
        [userId, generation, claim.subject],
      );
      if (inherited.rowCount) {
        await client.query(
          "UPDATE provider_revocation_jobs SET state='manual',failure_reason='inherited_manual' WHERE user_id=$1 AND generation=$2",
          [userId, generation],
        );
        await client.query("COMMIT");
        return false;
      }
      // Keep the account ordering lock across the bounded provider calls. A
      // newer generation cannot otherwise distinguish our older in-flight
      // freeze from an independent incident freeze, and could remain fenced
      // indefinitely. A shared deadline bounds all four provider calls together;
      // SDK calls also have individual five-second timeouts and no retries.
      const options = { signal: AbortSignal.timeout(20_000) };
      let initial;
      try {
        reportStage("provider_state");
        initial = await provider.state(claim.subject, options);
      } catch (error) {
        // Normal automation can retry a read-only failure. An owner-admitted
        // uncertain reset stays manual so an older deployed worker cannot
        // take over that reviewed attempt using a different transport.
        await client.query(
          "UPDATE provider_revocation_jobs SET state=$3 WHERE user_id=$1 AND generation=$2",
          [userId, generation, claim.credentialsDigest ? "manual" : "pending"],
        );
        await client.query("COMMIT");
        throw error;
      }
      if (initial.frozenAt !== null) {
        await client.query(
          "UPDATE provider_revocation_jobs SET state='manual',failure_reason='independent_provider_freeze' WHERE user_id=$1 AND generation=$2",
          [userId, generation],
        );
        await client.query("COMMIT");
        return false;
      }
      try {
        reportStage("freeze");
        await provider.freeze(claim.subject, options);
        reportStage("freeze_confirmation");
        const frozen = await confirmState(claim.subject, true, options);
        if (
          !Number.isSafeInteger(frozen.frozenAt) ||
          frozen.frozenAt === null ||
          frozen.frozenAt < 1
        )
          throw new Error("provider revocation confirmation unavailable");
        await client.query(
          "UPDATE provider_revocation_jobs SET confirmed_frozen_at=$3 WHERE user_id=$1 AND generation=$2",
          [userId, generation, frozen.frozenAt],
        );
        if (latest.status === "active") {
          reportStage("unfreeze");
          await provider.unfreeze(claim.subject, options);
          reportStage("unfreeze_confirmation");
          await confirmState(claim.subject, false, options, frozen.frozenAt);
          await client.query(
            "UPDATE provider_identities SET auth_generation=$2,minimum_issued_at=GREATEST(minimum_issued_at,$3) WHERE user_id=$1 AND subject=$4",
            [userId, generation, frozen.frozenAt + 1, claim.subject],
          );
        }
        await client.query(
          "UPDATE provider_revocation_jobs SET state='complete' WHERE user_id=$1 AND generation=$2",
          [userId, generation],
        );
        reportStage("commit");
        await client.query("COMMIT");
        return true;
      } catch (error) {
        // A response timeout cannot establish whether the provider changed
        // state. Its API has no operation/ownership ID for a freeze. Never
        // silently unfreeze a possibly independent incident control on retry.
        await client.query(
          "UPDATE provider_revocation_jobs SET state='manual',failure_reason='uncertain_provider_outcome' WHERE user_id=$1 AND generation=$2",
          [userId, generation],
        );
        await client.query("COMMIT");
        throw error;
      }
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  const phases = createProviderControlPhases(database, provider);
  async function retrySnapshot(
    connection: Pick<Pool | PoolClient, "query">,
    userId: string,
  ) {
    return (
      await connection.query<RetrySnapshot>(
        `SELECT u.auth_generation AS generation,u.account_status AS status,p.subject,
          p.auth_generation AS "mappedGeneration",p.credentials_digest AS "credentialsDigest",
          j.attempts,j.state,j.failure_reason AS "failureReason",j.confirmed_frozen_at::text AS "confirmedFrozenAt",
          j.lease_until<clock_timestamp() AS available
         FROM users u JOIN provider_identities p ON p.user_id=u.id AND p.provider='privy'
         JOIN provider_revocation_jobs j ON j.user_id=u.id AND j.subject=p.subject AND j.generation=u.auth_generation
         WHERE u.id=$1`,
        [userId],
      )
    ).rows[0];
  }
  async function retryAudit(
    connection: Pick<Pool | PoolClient, "query">,
    requestId: string,
  ) {
    const rows = (
      await connection.query<RetryAudit>(
        `SELECT user_id AS "userId",metadata->>'requestId' AS "requestId",metadata->>'authGeneration' AS "authGeneration",
          metadata->>'providerSubjectDigest' AS "providerSubjectDigest",metadata->>'credentialsDigest' AS "credentialsDigest",
          (metadata->>'attempts')::integer AS attempts
         FROM identity_audit_events WHERE event_type='provider.reset.retry_requested' AND metadata->>'requestId'=$1`,
        [requestId],
      )
    ).rows;
    if (rows.length > 1) throw new ProviderResetRetryError("snapshot");
    return rows[0];
  }
  function completedRetry(
    snapshot: RetrySnapshot | undefined,
    audit: RetryAudit | undefined,
    userId: string,
  ) {
    return Boolean(
      snapshot &&
      audit &&
      audit.userId === userId &&
      snapshot.status === "active" &&
      snapshot.generation === snapshot.mappedGeneration &&
      snapshot.state === "complete" &&
      snapshot.confirmedFrozenAt !== null &&
      snapshot.generation === audit.authGeneration &&
      snapshot.credentialsDigest === audit.credentialsDigest &&
      subjectDigest(snapshot.subject) === audit.providerSubjectDigest &&
      snapshot.attempts === audit.attempts,
    );
  }
  async function reviewHistory(
    connection: Pick<Pool | PoolClient, "query">,
    requestId: string,
  ) {
    return (
      await connection.query<{
        userId: string;
        eventType: string;
        evidenceDigest: string;
        generation: string;
        attempts: number;
        frozenAt: string;
        ownerReviewed: boolean;
      }>(
        `SELECT user_id AS "userId",event_type AS "eventType",metadata->>'evidenceDigest' AS "evidenceDigest",
       metadata->>'authGeneration' AS generation,(metadata->>'attempts')::integer AS attempts,
       metadata->>'frozenAt' AS "frozenAt",
       metadata->>'actorDatabaseRole'='yaparena_owner' AND metadata->'noIndependentFreeze'='true'::jsonb AS "ownerReviewed"
       FROM identity_audit_events
       WHERE event_type IN ('provider.reset.reconciliation_requested','provider.reset.reconciled')
         AND metadata->>'requestId'=$1`,
        [requestId],
      )
    ).rows;
  }
  async function inRetryWindow(
    connection: Pick<Pool | PoolClient, "query">,
    input: { userId: string; requestId: string },
    frozenAt: number,
  ) {
    return (
      (
        await connection.query<{ allowed: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM identity_audit_events a JOIN provider_revocation_jobs j ON j.user_id=a.user_id
       AND j.generation=(a.metadata->>'authGeneration')::bigint AND j.attempts=(a.metadata->>'attempts')::integer
       WHERE a.user_id=$1 AND a.event_type='provider.reset.retry_requested' AND a.metadata->>'requestId'=$2
       AND CASE WHEN isfinite(j.lease_until) THEN to_timestamp($3::double precision)>=date_trunc('second',a.occurred_at)
         AND to_timestamp($3::double precision)<j.lease_until ELSE false END) AS allowed`,
          [input.userId, input.requestId, frozenAt],
        )
      ).rows[0]?.allowed === true
    );
  }
  return {
    async prepareAcknowledgedLogoutReset(input: { userId: string }) {
      await requireLogoutResetOwner();
      if (!/^[1-9][0-9]{0,18}$/.test(input.userId))
        throw new ProviderResetRetryError("input");
      const snapshot = await logoutResetSnapshot(database, input.userId);
      return {
        fingerprint: snapshot.fingerprint,
        expectedGeneration: snapshot.generation,
        expectedAttempts: snapshot.jobs[0]!.attempts,
      };
    },
    async resumeAcknowledgedLogoutReset(input: {
      userId: string;
      requestId: string;
      review: LogoutResetReview;
    }): Promise<{ state: "rearmed"; created: boolean }> {
      let stage: RetryStage = "owner";
      try {
        await requireLogoutResetOwner();
        stage = "input";
        if (
          !operatorFrozenInspector ||
          !/^[1-9][0-9]{0,18}$/.test(input.userId) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            input.requestId,
          ) ||
          input.review.knownOwnFreezeReviewed !== true ||
          !/^[0-9a-f]{64}$/.test(input.review.evidenceDigest) ||
          !/^[0-9a-f]{64}$/.test(input.review.expectedFingerprint) ||
          !/^[1-9][0-9]{0,18}$/.test(input.review.expectedGeneration) ||
          !Number.isSafeInteger(input.review.expectedAttempts) ||
          input.review.expectedAttempts < 1
        )
          throw new ProviderResetRetryError(stage);
        const termsDigest = subjectDigest(
          JSON.stringify({
            userId: input.userId,
            requestId: input.requestId,
            evidenceDigest: input.review.evidenceDigest,
            expectedFingerprint: input.review.expectedFingerprint,
            expectedGeneration: input.review.expectedGeneration,
            expectedAttempts: input.review.expectedAttempts,
            knownOwnFreezeReviewed: true,
          }),
        );
        if (
          await logoutResetReplay(
            database,
            input.userId,
            input.requestId,
            termsDigest,
          )
        )
          return { state: "rearmed", created: false };
        stage = "snapshot";
        const initial = await logoutResetSnapshot(database, input.userId);
        if (
          initial.fingerprint !== input.review.expectedFingerprint ||
          initial.generation !== input.review.expectedGeneration ||
          initial.jobs[0]!.attempts !== input.review.expectedAttempts
        )
          throw new ProviderResetRetryError(stage);
        // No checked-out database connection or ordering lock spans remote I/O.
        stage = "provider_inspection";
        const [identity, state] = await Promise.all([
          operatorFrozenInspector.inspect(initial.subject),
          provider.state(initial.subject, {
            signal: AbortSignal.timeout(5000),
          }),
        ]);
        if (
          identity.subject !== initial.subject ||
          identity.credentialsDigest !== initial.credentialsDigest ||
          state.frozenAt === null ||
          !Number.isSafeInteger(state.frozenAt) ||
          state.frozenAt <= 0 ||
          !initial.keys.every((key) => {
            const linked = identity.passkeys?.filter(
              (entry) => entry.credentialId === key.credentialId,
            );
            return (
              linked?.length === 1 &&
              linked[0] !== undefined &&
              parseProviderPasskeyPublicKey(linked[0].publicKey)
                .publicKeyDigest === key.keyDigest
            );
          })
        )
          throw new ProviderResetRetryError(stage);
        const client = await database.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [`provider.reset.logout:${input.requestId}`],
          );
          await client.query("SELECT 1 FROM users WHERE id=$1 FOR UPDATE", [
            input.userId,
          ]);
          await client.query(
            "SELECT generation FROM provider_revocation_jobs WHERE user_id=$1 ORDER BY generation FOR UPDATE",
            [input.userId],
          );
          await client.query(
            "SELECT id FROM account_security_keys WHERE user_id=$1 ORDER BY id FOR UPDATE",
            [input.userId],
          );
          // A concurrent exact replay must return its committed audit, rather
          // than applying another fresh polling budget or remote operation.
          if (
            await logoutResetReplay(
              client,
              input.userId,
              input.requestId,
              termsDigest,
            )
          ) {
            await client.query("COMMIT");
            return { state: "rearmed", created: false };
          }
          stage = "claim";
          const current = await logoutResetSnapshot(client, input.userId);
          if (current.fingerprint !== initial.fingerprint)
            throw new ProviderResetRetryError(stage);
          const old = current.jobs[0]!;
          const window = (
            await client.query<{ valid: boolean }>(
              `SELECT freeze_acknowledged_at IS NOT NULL AND to_timestamp($3)>=date_trunc('second',freeze_requested_at)
             AND to_timestamp($3)<lease_until AS valid FROM provider_revocation_jobs WHERE user_id=$1 AND generation=$2`,
              [input.userId, old.generation, state.frozenAt],
            )
          ).rows[0];
          if (!window?.valid)
            throw new ProviderResetRetryError("activity_review");
          const changed = await client.query(
            `UPDATE provider_revocation_jobs SET state='pending',failure_reason=NULL,control_deadline_at=clock_timestamp()+interval '120 seconds',
             control_reads=0,control_lease_id=NULL,control_lease_until='-infinity',control_next_check_at='-infinity'
             WHERE user_id=$1 AND generation=$2 AND state='manual' AND control_phase='freeze_confirm' RETURNING generation`,
            [input.userId, old.generation],
          );
          if (changed.rowCount !== 1) throw new ProviderResetRetryError(stage);
          const latest = await client.query(
            `UPDATE provider_revocation_jobs SET state='pending',failure_reason=NULL,control_next_check_at='-infinity'
             WHERE user_id=$1 AND generation=$2 AND state='manual' AND control_phase='preflight' AND attempts=0 RETURNING generation`,
            [input.userId, current.generation],
          );
          if (latest.rowCount !== 1) throw new ProviderResetRetryError(stage);
          stage = "commit";
          await client.query(
            `INSERT INTO identity_audit_events(user_id,event_type,subject_id,metadata)
             VALUES($1,'provider.reset.logout_resumed',$1::bigint::text,$2::jsonb)`,
            [
              input.userId,
              JSON.stringify({
                requestId: input.requestId,
                actorDatabaseRole: "yaparena_owner",
                termsDigest,
                evidenceDigest: input.review.evidenceDigest,
                expectedFingerprint: input.review.expectedFingerprint,
                authGeneration: current.generation,
                oldGeneration: old.generation,
                attempts: old.attempts,
                controlIdDigest: subjectDigest(old.controlId!),
                providerSubjectDigest: subjectDigest(current.subject),
                knownOwnFreezeReviewed: true,
                outcome: "confirmation_only_rearmed",
              }),
            ],
          );
          await client.query("COMMIT");
          return { state: "rearmed", created: true };
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      } catch (error) {
        if (error instanceof ProviderResetRetryError) throw error;
        throw new ProviderResetRetryError(stage, providerStatus(error));
      }
    },
    async finalizeReviewed(input: {
      userId: string;
      requestId: string;
      activityReview: { evidenceDigest: string; noIndependentFreeze: true };
    }): Promise<{ state: "complete" }> {
      let stage: RetryStage = "owner";
      try {
        if (
          (
            await database.query<{ owner: boolean }>(
              "SELECT current_user='yaparena_owner' AS owner",
            )
          ).rows[0]?.owner !== true
        )
          throw new ProviderResetRetryError(stage);
        stage = "input";
        if (
          !operatorFrozenInspector ||
          !/^[1-9][0-9]{0,18}$/.test(input.userId) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            input.requestId,
          ) ||
          input.activityReview?.noIndependentFreeze !== true ||
          !/^[0-9a-f]{64}$/.test(input.activityReview.evidenceDigest)
        )
          throw new ProviderResetRetryError(stage);
        stage = "snapshot";
        const initial = await retrySnapshot(database, input.userId),
          audit = await retryAudit(database, input.requestId),
          history = await reviewHistory(database, input.requestId);
        const matches = (
          snapshot: RetrySnapshot | undefined,
          events: typeof history,
        ) =>
          Boolean(
            snapshot &&
            audit &&
            audit.userId === input.userId &&
            snapshot.status === "active" &&
            snapshot.generation === audit.authGeneration &&
            snapshot.attempts === audit.attempts &&
            snapshot.credentialsDigest === audit.credentialsDigest &&
            subjectDigest(snapshot.subject) === audit.providerSubjectDigest &&
            snapshot.confirmedFrozenAt !== null &&
            events.every(
              (event) =>
                event.userId === input.userId &&
                event.ownerReviewed &&
                event.evidenceDigest === input.activityReview.evidenceDigest &&
                event.generation === snapshot.generation &&
                event.attempts === snapshot.attempts &&
                event.frozenAt === snapshot.confirmedFrozenAt,
            ),
          );
        const complete = (
          snapshot: RetrySnapshot | undefined,
          events: typeof history,
        ) =>
          matches(snapshot, events) &&
          completedRetry(snapshot, audit, input.userId) &&
          events.length === 2 &&
          events.some(
            (event) => event.eventType === "provider.reset.reconciled",
          );
        if (complete(initial, history)) return { state: "complete" };
        if (
          !initial ||
          !matches(initial, history) ||
          history.length !== 1 ||
          history[0]?.eventType !== "provider.reset.reconciliation_requested" ||
          initial.state !== "manual" ||
          initial.failureReason !== "uncertain_provider_outcome" ||
          initial.generation === initial.mappedGeneration ||
          !initial.available
        )
          throw new ProviderResetRetryError(stage);
        const frozenAt = Number(initial.confirmedFrozenAt);
        if (
          !Number.isSafeInteger(frozenAt) ||
          frozenAt <= 0 ||
          !(await inRetryWindow(database, input, frozenAt))
        )
          throw new ProviderResetRetryError(stage);
        // Only trusted GETs are allowed here. The previous durable intent is
        // the sole mutation attempt; finalization must never repeat it.
        stage = "provider_inspection";
        const currentProvider = await operatorFrozenInspector.inspect(
          initial.subject,
        );
        if (
          currentProvider.subject !== initial.subject ||
          currentProvider.credentialsDigest !== initial.credentialsDigest ||
          (
            await provider.state(initial.subject, {
              signal: AbortSignal.timeout(5000),
            })
          ).frozenAt !== null
        )
          throw new ProviderResetRetryError(stage);
        const client = await database.connect();
        try {
          stage = "claim";
          await client.query("BEGIN");
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [`provider-reset-reconcile:${input.requestId}`],
          );
          await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
            input.userId,
          ]);
          await client.query(
            "SELECT subject FROM provider_identities WHERE user_id=$1 FOR UPDATE",
            [input.userId],
          );
          await client.query(
            "SELECT generation FROM provider_revocation_jobs WHERE user_id=$1 AND generation=$2 FOR UPDATE",
            [input.userId, initial.generation],
          );
          const locked = await retrySnapshot(client, input.userId),
            lockedAudit = await retryAudit(client, input.requestId),
            lockedHistory = await reviewHistory(client, input.requestId);
          if (complete(locked, lockedHistory)) {
            await client.query("COMMIT");
            return { state: "complete" };
          }
          if (
            JSON.stringify(locked) !== JSON.stringify(initial) ||
            JSON.stringify(lockedAudit) !== JSON.stringify(audit) ||
            JSON.stringify(lockedHistory) !== JSON.stringify(history)
          )
            throw new ProviderResetRetryError(stage);
          if (
            (
              await client.query(
                "SELECT 1 FROM provider_revocation_jobs WHERE user_id=$1 AND subject=$2 AND generation<$3 AND state<>'complete' LIMIT 1",
                [input.userId, initial.subject, initial.generation],
              )
            ).rowCount
          )
            throw new ProviderResetRetryError(stage);
          stage = "provider_state";
          if (
            (
              await provider.state(initial.subject, {
                signal: AbortSignal.timeout(5000),
              })
            ).frozenAt !== null
          )
            throw new ProviderResetRetryError(stage);
          stage = "commit";
          const changed = await client.query(
            `UPDATE provider_identities SET auth_generation=$2,minimum_issued_at=GREATEST(minimum_issued_at,$3)
            WHERE user_id=$1 AND provider='privy' AND subject=$4 AND credentials_digest=$5 AND auth_generation=$6 RETURNING subject`,
            [
              input.userId,
              initial.generation,
              frozenAt + 1,
              initial.subject,
              initial.credentialsDigest,
              initial.mappedGeneration,
            ],
          );
          if (!changed.rowCount) throw new ProviderResetRetryError("result");
          await client.query(
            "UPDATE provider_revocation_jobs SET state='complete' WHERE user_id=$1 AND generation=$2",
            [input.userId, initial.generation],
          );
          await client.query(
            "INSERT INTO identity_audit_events(user_id,event_type,subject_id,metadata) VALUES($1,'provider.reset.reconciled',$1::bigint::text,$2::jsonb)",
            [
              input.userId,
              JSON.stringify({
                requestId: input.requestId,
                actorDatabaseRole: "yaparena_owner",
                noIndependentFreeze: true,
                evidenceDigest: input.activityReview.evidenceDigest,
                authGeneration: initial.generation,
                attempts: initial.attempts,
                frozenAt: String(frozenAt),
                outcome: "read_only_finalized",
              }),
            ],
          );
          await client.query("COMMIT");
          return { state: "complete" };
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      } catch (error) {
        if (error instanceof ProviderResetRetryError) throw error;
        throw new ProviderResetRetryError(stage, providerStatus(error));
      }
    },
    async reconcileUncertain(input: {
      userId: string;
      requestId: string;
      activityReview: { evidenceDigest: string; noIndependentFreeze: true };
    }): Promise<{ state: "complete" }> {
      let stage: RetryStage = "owner";
      try {
        if (
          (
            await database.query<{ owner: boolean }>(
              "SELECT current_user='yaparena_owner' AS owner",
            )
          ).rows[0]?.owner !== true
        )
          throw new ProviderResetRetryError(stage);
        stage = "input";
        if (
          !operatorFrozenInspector ||
          !/^[1-9][0-9]{0,18}$/.test(input.userId) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            input.requestId,
          ) ||
          input.activityReview?.noIndependentFreeze !== true ||
          !/^[0-9a-f]{64}$/.test(input.activityReview.evidenceDigest)
        )
          throw new ProviderResetRetryError(stage);
        stage = "snapshot";
        const initial = await retrySnapshot(database, input.userId),
          audit = await retryAudit(database, input.requestId),
          history = await reviewHistory(database, input.requestId);
        const reviewedComplete = (
          snapshot: RetrySnapshot | undefined,
          events: typeof history,
        ) =>
          completedRetry(snapshot, audit, input.userId) &&
          events.length === 2 &&
          events.every(
            (event) =>
              event.userId === input.userId &&
              event.ownerReviewed &&
              event.evidenceDigest === input.activityReview.evidenceDigest &&
              event.generation === snapshot!.generation &&
              event.attempts === snapshot!.attempts &&
              event.frozenAt === snapshot!.confirmedFrozenAt,
          ) &&
          events.some(
            (event) => event.eventType === "provider.reset.reconciled",
          );
        if (history.length) {
          if (reviewedComplete(initial, history)) return { state: "complete" };
          throw new ProviderResetRetryError(stage);
        }
        if (
          !initial ||
          !audit ||
          audit.userId !== input.userId ||
          initial.status !== "active" ||
          initial.generation === initial.mappedGeneration ||
          initial.state !== "manual" ||
          initial.failureReason !== "uncertain_provider_outcome" ||
          initial.confirmedFrozenAt !== null ||
          !initial.available ||
          initial.generation !== audit.authGeneration ||
          initial.attempts !== audit.attempts ||
          initial.credentialsDigest !== audit.credentialsDigest ||
          subjectDigest(initial.subject) !== audit.providerSubjectDigest
        )
          throw new ProviderResetRetryError(stage);
        stage = "provider_inspection";
        const inspected = await operatorFrozenInspector.inspect(
          initial.subject,
        );
        if (
          inspected.subject !== initial.subject ||
          inspected.credentialsDigest !== initial.credentialsDigest
        )
          throw new ProviderResetRetryError(stage);
        const frozen = await provider.state(initial.subject, {
          signal: AbortSignal.timeout(5000),
        });
        if (
          frozen.frozenAt === null ||
          !Number.isSafeInteger(frozen.frozenAt) ||
          frozen.frozenAt <= 0 ||
          !(await inRetryWindow(database, input, frozen.frozenAt))
        )
          throw new ProviderResetRetryError(stage);
        stage = "claim";
        const client = await database.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [`provider-reset-reconcile:${input.requestId}`],
          );
          await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
            input.userId,
          ]);
          await client.query(
            "SELECT subject FROM provider_identities WHERE user_id=$1 FOR UPDATE",
            [input.userId],
          );
          await client.query(
            "SELECT generation FROM provider_revocation_jobs WHERE user_id=$1 AND generation=$2 FOR UPDATE",
            [input.userId, initial.generation],
          );
          const current = await retrySnapshot(client, input.userId),
            currentAudit = await retryAudit(client, input.requestId),
            currentHistory = await reviewHistory(client, input.requestId);
          if (currentHistory.length) {
            if (!reviewedComplete(current, currentHistory))
              throw new ProviderResetRetryError(stage);
            await client.query("COMMIT");
            return { state: "complete" };
          }
          if (
            !current ||
            JSON.stringify(current) !== JSON.stringify(initial) ||
            JSON.stringify(currentAudit) !== JSON.stringify(audit)
          )
            throw new ProviderResetRetryError(stage);
          const prior = await client.query(
            "SELECT 1 FROM provider_revocation_jobs WHERE user_id=$1 AND subject=$2 AND generation<$3 AND state<>'complete' LIMIT 1",
            [input.userId, current.subject, current.generation],
          );
          if (prior.rowCount) throw new ProviderResetRetryError(stage);
          const options = { signal: AbortSignal.timeout(20000) };
          stage = "provider_state";
          const fresh = await provider.state(current.subject, options);
          if (
            fresh.frozenAt !== frozen.frozenAt ||
            !(await inRetryWindow(client, input, frozen.frozenAt))
          )
            throw new ProviderResetRetryError(stage);
          stage = "activity_review";
          const metadata = {
            requestId: input.requestId,
            actorDatabaseRole: "yaparena_owner",
            evidenceDigest: input.activityReview.evidenceDigest,
            noIndependentFreeze: true,
            authGeneration: current.generation,
            attempts: current.attempts,
            frozenAt: String(frozen.frozenAt),
          };
          await client.query(
            "INSERT INTO identity_audit_events(user_id,event_type,subject_id,metadata) VALUES($1,'provider.reset.reconciliation_requested',$1::bigint::text,$2::jsonb)",
            [input.userId, JSON.stringify(metadata)],
          );
          await client.query(
            "UPDATE provider_revocation_jobs SET confirmed_frozen_at=$3 WHERE user_id=$1 AND generation=$2",
            [input.userId, current.generation, frozen.frozenAt],
          );
          // Persist the reviewed mutation intent before external I/O. Neither a
          // crash nor a later SQL rollback may erase the one-attempt marker.
          // The job remains manual, so ordinary workers cannot claim it.
          await client.query("COMMIT");
          await client.query("BEGIN");
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [`provider-reset-reconcile:${input.requestId}`],
          );
          await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
            input.userId,
          ]);
          await client.query(
            "SELECT subject FROM provider_identities WHERE user_id=$1 FOR UPDATE",
            [input.userId],
          );
          await client.query(
            "SELECT generation FROM provider_revocation_jobs WHERE user_id=$1 AND generation=$2 FOR UPDATE",
            [input.userId, initial.generation],
          );
          const admitted = await retrySnapshot(client, input.userId),
            admittedHistory = await reviewHistory(client, input.requestId);
          if (
            JSON.stringify(admitted) !==
              JSON.stringify({
                ...current,
                confirmedFrozenAt: String(frozen.frozenAt),
              }) ||
            admittedHistory.length !== 1 ||
            admittedHistory[0]?.userId !== input.userId ||
            !admittedHistory[0]?.ownerReviewed ||
            admittedHistory[0]?.evidenceDigest !==
              input.activityReview.evidenceDigest ||
            admittedHistory[0]?.eventType !==
              "provider.reset.reconciliation_requested"
          )
            throw new ProviderResetRetryError("claim");
          try {
            stage = "provider_state";
            if (
              (await provider.state(current.subject, options)).frozenAt !==
              frozen.frozenAt
            )
              throw new ProviderResetRetryError(stage);
            stage = "unfreeze";
            await provider.unfreeze(current.subject, options);
            stage = "unfreeze_confirmation";
            await confirmState(
              current.subject,
              false,
              options,
              frozen.frozenAt,
            );
            stage = "commit";
            const updated = await client.query(
              `UPDATE provider_identities SET auth_generation=$2,
              minimum_issued_at=GREATEST(minimum_issued_at,$3) WHERE user_id=$1 AND provider='privy'
              AND subject=$4 AND credentials_digest=$5 AND auth_generation=$6 RETURNING subject`,
              [
                input.userId,
                current.generation,
                frozen.frozenAt + 1,
                current.subject,
                current.credentialsDigest,
                current.mappedGeneration,
              ],
            );
            if (!updated.rowCount) throw new ProviderResetRetryError("result");
            await client.query(
              "UPDATE provider_revocation_jobs SET state='complete' WHERE user_id=$1 AND generation=$2",
              [input.userId, current.generation],
            );
            await client.query(
              "INSERT INTO identity_audit_events(user_id,event_type,subject_id,metadata) VALUES($1,'provider.reset.reconciled',$1::bigint::text,$2::jsonb)",
              [input.userId, JSON.stringify(metadata)],
            );
            stage = "commit";
            await client.query("COMMIT");
            return { state: "complete" };
          } catch (error) {
            // The durable review remains manual even if an external success
            // cannot be confirmed. No second invocation may repeat unfreeze.
            await client.query("ROLLBACK");
            throw error;
          }
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      } catch (error) {
        if (error instanceof ProviderResetRetryError) throw error;
        throw new ProviderResetRetryError(stage, providerStatus(error));
      }
    },
    async retryUncertain(input: {
      userId: string;
      requestId: string;
    }): Promise<{ state: "complete" }> {
      let stage: RetryStage = "owner";
      try {
        const role = await database.query<{ owner: boolean }>(
          "SELECT current_user='yaparena_owner' AS owner",
        );
        if (role.rows[0]?.owner !== true)
          throw new ProviderResetRetryError(stage);
        stage = "input";
        if (
          !/^[1-9][0-9]{0,18}$/.test(input.userId) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            input.requestId,
          ) ||
          !operatorInspector
        )
          throw new ProviderResetRetryError(stage);
        stage = "snapshot";
        const initial = await retrySnapshot(database, input.userId),
          earlier = await retryAudit(database, input.requestId);
        if (earlier) {
          if (completedRetry(initial, earlier, input.userId))
            return { state: "complete" };
          throw new ProviderResetRetryError(stage);
        }
        if (
          !initial ||
          initial.status !== "active" ||
          initial.generation === initial.mappedGeneration ||
          initial.state !== "manual" ||
          initial.failureReason !== "uncertain_provider_outcome" ||
          initial.confirmedFrozenAt !== null ||
          !initial.available
        )
          throw new ProviderResetRetryError(stage);
        // These are provider GETs only; neither holds a pool connection or a
        // local authorization lock. The exact local snapshot is fenced below.
        stage = "provider_inspection";
        const inspected = await operatorInspector.inspect(initial.subject);
        if (
          inspected.subject !== initial.subject ||
          inspected.credentialsDigest !== initial.credentialsDigest
        )
          throw new ProviderResetRetryError(stage);
        const state = await provider.state(initial.subject, {
          signal: AbortSignal.timeout(5000),
        });
        if (state.frozenAt !== null) throw new ProviderResetRetryError(stage);
        stage = "claim";
        const client = await database.connect();
        let claim: Claim;
        try {
          await client.query("BEGIN");
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [`provider-reset-retry:${input.requestId}`],
          );
          await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
            input.userId,
          ]);
          await client.query(
            "SELECT subject FROM provider_identities WHERE user_id=$1 FOR UPDATE",
            [input.userId],
          );
          await client.query(
            "SELECT generation FROM provider_revocation_jobs WHERE user_id=$1 AND generation=$2 FOR UPDATE",
            [input.userId, initial.generation],
          );
          const current = await retrySnapshot(client, input.userId),
            audit = await retryAudit(client, input.requestId);
          if (audit) {
            if (!completedRetry(current, audit, input.userId))
              throw new ProviderResetRetryError(stage);
            await client.query("COMMIT");
            return { state: "complete" };
          }
          if (!current || JSON.stringify(current) !== JSON.stringify(initial))
            throw new ProviderResetRetryError(stage);
          const prior = await client.query(
            "SELECT 1 FROM provider_revocation_jobs WHERE user_id=$1 AND subject=$2 AND generation<$3 AND state<>'complete' LIMIT 1",
            [input.userId, current.subject, current.generation],
          );
          if (prior.rowCount) throw new ProviderResetRetryError(stage);
          const changed = await client.query<{ attempts: number }>(
            `UPDATE provider_revocation_jobs SET state='running',attempts=attempts+1,
              lease_until=clock_timestamp()+interval '30 seconds'
             WHERE user_id=$1 AND generation=$2 AND subject=$3 AND state='manual'
              AND failure_reason='uncertain_provider_outcome' AND confirmed_frozen_at IS NULL
             RETURNING attempts`,
            [input.userId, current.generation, current.subject],
          );
          if (!changed.rows[0]) throw new ProviderResetRetryError(stage);
          claim = {
            userId: input.userId,
            generation: current.generation,
            subject: current.subject,
            attempts: changed.rows[0].attempts,
            credentialsDigest: current.credentialsDigest,
          };
          await client.query(
            `INSERT INTO identity_audit_events(user_id,event_type,subject_id,metadata)
             VALUES($1,'provider.reset.retry_requested',$1::bigint::text,$2::jsonb)`,
            [
              input.userId,
              JSON.stringify({
                requestId: input.requestId,
                actorDatabaseRole: "yaparena_owner",
                authGeneration: claim.generation,
                providerSubjectDigest: subjectDigest(claim.subject),
                credentialsDigest: claim.credentialsDigest,
                attempts: claim.attempts,
                outcome: "claimed",
              }),
            ],
          );
          await client.query("COMMIT");
          const completed = await performClaimed(client, claim, (next) => {
            stage = next;
          });
          if (!completed) throw new ProviderResetRetryError("result");
          return { state: "complete" };
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      } catch (error) {
        if (error instanceof ProviderResetRetryError) throw error;
        throw new ProviderResetRetryError(stage, providerStatus(error));
      }
    },
    async synchronize(userId?: string) {
      const jobs = await database.query<{ userId: string; generation: string }>(
        `SELECT user_id AS "userId",generation FROM provider_revocation_jobs
         WHERE state IN ('pending','running')
           AND NOT(state='running' AND control_attempt IS DISTINCT FROM attempts AND lease_until>=clock_timestamp())
           AND ((control_phase='legacy' AND lease_until<clock_timestamp())
             OR (control_phase<>'legacy' AND control_lease_until<clock_timestamp() AND control_next_check_at<=clock_timestamp()))
           AND ($1::bigint IS NULL OR user_id=$1) ORDER BY generation ASC,user_id ASC LIMIT 10`,
        [userId ?? null],
      );
      for (const job of jobs.rows)
        await phases.process(job.userId, job.generation);
    },
  };
}
