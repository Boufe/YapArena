import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ProviderSessionControl } from "./privy.ts";
import { enqueueEmbeddedWalletProvisioning } from "./embedded-wallet-provisioning.ts";

type Phase =
  | "legacy"
  | "preflight"
  | "freeze_intent"
  | "freeze_confirm"
  | "unfreeze_intent"
  | "unfreeze_confirm"
  | "done";
type Job = {
  userId: string;
  generation: string;
  accountGeneration: string;
  accountStatus: string;
  subject: string;
  mappedSubject: string | null;
  digest: string | null;
  attempts: number;
  state: string;
  phase: Phase;
  controlId: string | null;
  controlDigest: string | null;
  controlAttempt: number | null;
  leaseId: string | null;
  available: boolean;
  legacyAvailable: boolean;
  leaseValid: boolean;
  deadlineValid: boolean;
  reads: number;
  frozenAt: string | null;
  freezeRequested: Date | null;
};
type Action = { job: Job; kind: "read" | "freeze" | "unfreeze" };
const fields = `SELECT j.user_id::text AS "userId",j.generation::text AS generation,
 u.auth_generation::text AS "accountGeneration",u.account_status AS "accountStatus",
 j.subject,p.subject AS "mappedSubject",p.credentials_digest AS digest,j.attempts,j.state,
 j.control_phase AS phase,j.control_id AS "controlId",j.control_credentials_digest AS "controlDigest",
 j.control_attempt AS "controlAttempt",j.control_lease_id AS "leaseId",
 j.control_lease_until<clock_timestamp() AND j.control_next_check_at<=clock_timestamp() AS available,
 j.lease_until<clock_timestamp() AS "legacyAvailable",
 j.control_lease_until>clock_timestamp() AS "leaseValid",
 j.control_deadline_at>clock_timestamp() AS "deadlineValid",j.control_reads AS reads,
 j.confirmed_frozen_at::text AS "frozenAt",j.freeze_requested_at AS "freezeRequested"
 FROM provider_revocation_jobs j JOIN users u ON u.id=j.user_id
 LEFT JOIN provider_identities p ON p.user_id=u.id AND p.provider='privy'
 WHERE j.user_id=$1 AND j.generation=$2`;

// Only positively acknowledged mutations enter resumable confirmation phases.
// An intent is durable before its one external call; a crash or unknown response
// leaves that intent manual, never eligible for automatic mutation replay.
export function createProviderControlPhases(
  database: Pool,
  provider: ProviderSessionControl,
) {
  async function locked<T>(
    userId: string,
    generation: string,
    action: (client: PoolClient, job: Job | undefined) => Promise<T>,
  ) {
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT 1 FROM users WHERE id=$1 FOR UPDATE", [
        userId,
      ]);
      const job = (
        await client.query<Job>(`${fields} FOR UPDATE OF j`, [
          userId,
          generation,
        ])
      ).rows[0];
      const result = await action(client, job);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async function manual(
    client: PoolClient,
    job: Job,
    reason = "uncertain_provider_outcome",
  ) {
    await client.query(
      `UPDATE provider_revocation_jobs SET state='manual',failure_reason=$3,
       control_lease_until='-infinity' WHERE user_id=$1 AND generation=$2`,
      [job.userId, job.generation, reason],
    );
  }
  async function validLocal(client: PoolClient, job: Job) {
    if (job.mappedSubject !== job.subject) {
      await client.query(
        `UPDATE provider_revocation_jobs SET state='complete',failure_reason='retired_identity'
         WHERE user_id=$1 AND generation=$2`,
        [job.userId, job.generation],
      );
      return false;
    }
    if (job.accountGeneration !== job.generation) {
      if (job.freezeRequested) await manual(client, job);
      else
        await client.query(
          "UPDATE provider_revocation_jobs SET state='complete' WHERE user_id=$1 AND generation=$2",
          [job.userId, job.generation],
        );
      return false;
    }
    if (
      !job.digest ||
      (job.controlDigest !== null && job.digest !== job.controlDigest) ||
      (job.controlAttempt !== null && job.attempts !== job.controlAttempt)
    ) {
      await manual(client, job);
      return false;
    }
    const older = await client.query(
      `SELECT 1 FROM provider_revocation_jobs WHERE user_id=$1 AND generation<$2
       AND subject=$3 AND (state='manual' OR (state='running'
         AND (control_phase='legacy' OR freeze_requested_at IS NOT NULL)) OR (state='pending'
         AND (freeze_requested_at IS NOT NULL OR (control_phase='legacy' AND attempts>0)))) LIMIT 1`,
      [job.userId, job.generation, job.subject],
    );
    if (older.rowCount) {
      await manual(client, job, "inherited_manual");
      return false;
    }
    return true;
  }
  async function freshJob(client: PoolClient, job: Job) {
    return (await client.query<Job>(fields, [job.userId, job.generation]))
      .rows[0]!;
  }
  async function claim(
    userId: string,
    generation: string,
  ): Promise<Action | null> {
    return locked(userId, generation, async (client, initial) => {
      if (!initial || !["pending", "running"].includes(initial.state))
        return null;
      let job = initial;
      // An owner-reviewed retry deliberately increments the legacy attempt and
      // uses its bounded legacy lease. Old phase metadata cannot authorize a
      // normal worker to steal or cancel that live reviewed attempt.
      if (
        job.state === "running" &&
        job.controlAttempt !== null &&
        job.controlAttempt !== job.attempts &&
        !job.legacyAvailable
      )
        return null;
      if (job.phase === "legacy" || job.controlId === null) {
        // Legacy manual/running attempts and old-code claims have no durable
        // acknowledgement. Migration must never turn them into safe retries.
        if (!job.legacyAvailable) return null;
        if (job.state !== "pending" || job.attempts !== 0 || job.frozenAt) {
          await manual(client, job);
          return null;
        }
        if (!(await validLocal(client, job))) return null;
        await client.query(
          `UPDATE provider_revocation_jobs SET control_phase='preflight',control_id=$3,
           control_credentials_digest=$4,attempts=attempts+1,control_attempt=attempts+1,
           control_deadline_at=clock_timestamp()+interval '120 seconds',control_reads=0
           WHERE user_id=$1 AND generation=$2`,
          [userId, generation, randomUUID(), job.digest],
        );
        job = await freshJob(client, job);
      }
      if (!job.available) return null;
      if (!(await validLocal(client, job))) return null;
      if (
        job.phase === "freeze_intent" ||
        job.phase === "unfreeze_intent" ||
        job.phase === "done" ||
        !job.deadlineValid ||
        job.reads >= 8
      ) {
        await manual(client, job);
        return null;
      }
      await client.query(
        `UPDATE provider_revocation_jobs SET state='running',control_lease_id=$3,
         control_lease_until=clock_timestamp()+interval '30 seconds',control_reads=control_reads+1
         WHERE user_id=$1 AND generation=$2`,
        [userId, generation, randomUUID()],
      );
      return { kind: "read", job: await freshJob(client, job) };
    });
  }
  function owns(current: Job | undefined, claimed: Job) {
    return Boolean(
      current &&
      current.state === "running" &&
      current.controlId === claimed.controlId &&
      current.leaseId === claimed.leaseId &&
      current.phase === claimed.phase &&
      current.reads === claimed.reads &&
      current.attempts === claimed.attempts,
    );
  }
  async function defer(client: PoolClient, job: Job) {
    if (!job.deadlineValid || job.reads >= 8) return manual(client, job);
    await client.query(
      `UPDATE provider_revocation_jobs SET state='pending',control_lease_until='-infinity',
       control_next_check_at=clock_timestamp()+interval '10 seconds'
       WHERE user_id=$1 AND generation=$2`,
      [job.userId, job.generation],
    );
  }
  async function intent(
    client: PoolClient,
    job: Job,
    kind: "freeze" | "unfreeze",
  ): Promise<Action> {
    if (kind === "freeze")
      await client.query(
        `UPDATE provider_revocation_jobs SET control_phase='freeze_intent',freeze_requested_at=clock_timestamp(),
         lease_until=clock_timestamp()+interval '30 seconds',control_lease_until=clock_timestamp()+interval '30 seconds',
         control_lease_id=$3 WHERE user_id=$1 AND generation=$2`,
        [job.userId, job.generation, randomUUID()],
      );
    else
      await client.query(
        `UPDATE provider_revocation_jobs SET control_phase='unfreeze_intent',unfreeze_requested_at=clock_timestamp(),
         control_lease_until=clock_timestamp()+interval '30 seconds',control_lease_id=$3
         WHERE user_id=$1 AND generation=$2`,
        [job.userId, job.generation, randomUUID()],
      );
    return { kind, job: await freshJob(client, job) };
  }
  async function readResult(
    action: Action,
    result: { frozenAt: number | null } | null,
  ): Promise<Action | null> {
    const claimed = action.job;
    return locked(claimed.userId, claimed.generation, async (client, job) => {
      if (!owns(job, claimed) || !job) return null;
      if (!(await validLocal(client, job))) return null;
      if (!job.deadlineValid || !job.leaseValid) {
        await manual(client, job);
        return null;
      }
      if (!result) {
        await defer(client, job);
        return null;
      }
      const frozenAt = result.frozenAt;
      if (
        frozenAt !== null &&
        (!Number.isSafeInteger(frozenAt) || frozenAt <= 0)
      ) {
        await manual(client, job);
        return null;
      }
      if (job.phase === "preflight") {
        if (frozenAt !== null) {
          await manual(client, job, "independent_provider_freeze");
          return null;
        }
        return intent(client, job, "freeze");
      }
      if (job.phase === "freeze_confirm") {
        if (frozenAt === null) {
          await defer(client, job);
          return null;
        }
        const window = await client.query<{ valid: boolean }>(
          `SELECT freeze_acknowledged_at IS NOT NULL AND to_timestamp($3)>=date_trunc('second',freeze_requested_at)
           AND to_timestamp($3)<lease_until AS valid FROM provider_revocation_jobs WHERE user_id=$1 AND generation=$2`,
          [job.userId, job.generation, frozenAt],
        );
        if (!window.rows[0]?.valid) {
          await manual(client, job);
          return null;
        }
        await client.query(
          "UPDATE provider_revocation_jobs SET confirmed_frozen_at=$3 WHERE user_id=$1 AND generation=$2",
          [job.userId, job.generation, frozenAt],
        );
        if (job.accountStatus !== "active") {
          await client.query(
            "UPDATE provider_revocation_jobs SET state='complete',control_phase='done' WHERE user_id=$1 AND generation=$2",
            [job.userId, job.generation],
          );
          return null;
        }
        return intent(client, await freshJob(client, job), "unfreeze");
      }
      if (job.phase === "unfreeze_confirm") {
        if (
          frozenAt === null &&
          job.frozenAt !== null &&
          job.controlDigest !== null
        ) {
          await client.query(
            `UPDATE provider_identities SET auth_generation=$2,minimum_issued_at=GREATEST(minimum_issued_at,$3::bigint+1)
             WHERE user_id=$1 AND subject=$4 AND credentials_digest=$5`,
            [
              job.userId,
              job.generation,
              job.frozenAt,
              job.subject,
              job.controlDigest,
            ],
          );
          await client.query(
            `UPDATE provider_revocation_jobs SET state='complete',control_phase='done',control_lease_until='-infinity'
             WHERE user_id=$1 AND generation=$2`,
            [job.userId, job.generation],
          );
          // A credential change parks wallet creation until its accepted
          // baseline and provider reset are both synchronized. Wake only that
          // exact account-owned job, without changing its retry budget.
          await enqueueEmbeddedWalletProvisioning(
            client,
            job.userId,
            job.subject,
            job.controlDigest,
          );
        } else if (frozenAt !== null && String(frozenAt) === job.frozenAt)
          await defer(client, job);
        else await manual(client, job);
        return null;
      }
      await manual(client, job);
      return null;
    });
  }
  async function mutate(action: Action, signal: AbortSignal) {
    const claimed = action.job;
    return locked(claimed.userId, claimed.generation, async (client, job) => {
      if (!owns(job, claimed) || !job) return false;
      if (!(await validLocal(client, job))) return false;
      const live = await client.query<{ valid: boolean }>(
        `SELECT control_lease_until>clock_timestamp() AND control_deadline_at>clock_timestamp() AS valid FROM provider_revocation_jobs
         WHERE user_id=$1 AND generation=$2`,
        [job.userId, job.generation],
      );
      if (!live.rows[0]?.valid || signal.aborted) {
        await manual(client, job);
        return false;
      }
      // Only this bounded mutation window holds the account lock. Read-only
      // propagation polling releases both the lock and pool connection.
      try {
        if (action.kind === "freeze")
          await provider.freeze(job.subject, { signal });
        else {
          const current = await provider.state(job.subject, { signal });
          if (
            current.frozenAt === null ||
            String(current.frozenAt) !== job.frozenAt
          ) {
            await manual(client, job);
            return false;
          }
          await provider.unfreeze(job.subject, { signal });
        }
        if (action.kind === "freeze")
          await client.query(
            `UPDATE provider_revocation_jobs SET control_phase='freeze_confirm',freeze_acknowledged_at=clock_timestamp(),
             control_deadline_at=clock_timestamp()+interval '120 seconds',control_reads=0,state='pending',
             control_lease_until='-infinity',control_next_check_at='-infinity' WHERE user_id=$1 AND generation=$2`,
            [job.userId, job.generation],
          );
        else
          await client.query(
            `UPDATE provider_revocation_jobs SET control_phase='unfreeze_confirm',unfreeze_acknowledged_at=clock_timestamp(),
             control_deadline_at=clock_timestamp()+interval '120 seconds',control_reads=0,state='pending',
             control_lease_until='-infinity',control_next_check_at='-infinity' WHERE user_id=$1 AND generation=$2`,
            [job.userId, job.generation],
          );
        return true;
      } catch {
        await manual(client, job);
        return false;
      }
    });
  }
  return {
    async process(userId: string, generation: string) {
      const signal = AbortSignal.timeout(20_000);
      // Immediate provider reads can complete in one tick. Propagation delays
      // return to the durable queue, never sleep or repeat a mutation here.
      for (let step = 0; step < 4 && !signal.aborted; step++) {
        const action = await claim(userId, generation);
        if (!action) return;
        let result: { frozenAt: number | null } | null = null;
        try {
          result = await provider.state(action.job.subject, { signal });
        } catch {
          // A read error has no mutation ambiguity and uses the finite budget.
        }
        const next = await readResult(action, result);
        if (!next || !(await mutate(next, signal))) return;
      }
    },
  };
}
