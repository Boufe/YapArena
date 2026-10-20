import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { IdentityVerifier, ProviderSessionControl } from "./privy.ts";

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
  }: { operatorInspector?: Pick<IdentityVerifier, "inspect"> } = {},
) {
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
        const frozen = await provider.state(claim.subject, options);
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
  async function process(userId: string, generation: string) {
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      const user = (
        await client.query<{ generation: string }>(
          "SELECT auth_generation AS generation FROM users WHERE id=$1 FOR UPDATE",
          [userId],
        )
      ).rows[0];
      const job = (
        await client.query<{
          subject: string;
          attempts: number;
          available: boolean;
          state: string;
        }>(
          "SELECT subject,attempts,state,lease_until<clock_timestamp() AS available FROM provider_revocation_jobs WHERE user_id=$1 AND generation=$2 FOR UPDATE",
          [userId, generation],
        )
      ).rows[0];
      if (
        !user ||
        !job ||
        !job.available ||
        job.state === "complete" ||
        job.state === "manual"
      ) {
        await client.query("ROLLBACK");
        return;
      }
      if (job.state === "running") {
        await client.query(
          "UPDATE provider_revocation_jobs SET state='manual',failure_reason='uncertain_provider_outcome' WHERE user_id=$1 AND generation=$2",
          [userId, generation],
        );
        await client.query("COMMIT");
        return;
      }
      if (user.generation !== generation) {
        await client.query(
          "UPDATE provider_revocation_jobs SET state='complete' WHERE user_id=$1 AND generation=$2",
          [userId, generation],
        );
        await client.query("COMMIT");
        return;
      }
      await client.query(
        "UPDATE provider_revocation_jobs SET state='running',attempts=attempts+1,lease_until=clock_timestamp()+interval '30 seconds' WHERE user_id=$1 AND generation=$2",
        [userId, generation],
      );
      await client.query("COMMIT");
      await performClaimed(client, {
        userId,
        generation,
        subject: job.subject,
        attempts: job.attempts + 1,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
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
  return {
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
         WHERE state IN ('pending','running') AND lease_until<clock_timestamp()
           AND ($1::bigint IS NULL OR user_id=$1) ORDER BY generation DESC LIMIT 10`,
        [userId ?? null],
      );
      for (const job of jobs.rows) await process(job.userId, job.generation);
    },
  };
}
