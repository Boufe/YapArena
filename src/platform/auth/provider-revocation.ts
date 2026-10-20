import type { Pool } from "pg";
import type { ProviderSessionControl } from "./privy.ts";

// PostgreSQL commits the local fence before any provider call. Claims about
// iat become useful ONLY after Privy confirms that all old refresh sessions
// have been revoked. A failed/uncertain provider call leaves the local fence up.
export function createProviderRevocation(
  database: Pool,
  provider: ProviderSessionControl,
) {
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
      await client.query("BEGIN");
      const latest = (
        await client.query<{ generation: string; status: string }>(
          "SELECT auth_generation AS generation,account_status AS status FROM users WHERE id=$1 FOR UPDATE",
          [userId],
        )
      ).rows[0];
      if (!latest || latest.generation !== generation) {
        await client.query(
          "UPDATE provider_revocation_jobs SET state='complete' WHERE user_id=$1 AND generation=$2",
          [userId, generation],
        );
        await client.query("COMMIT");
        return;
      }
      const mapping = await client.query<{ subject: string }>(
        "SELECT subject FROM provider_identities WHERE user_id=$1 AND provider='privy'",
        [userId],
      );
      if (mapping.rows[0]?.subject !== job.subject) {
        await client.query(
          "UPDATE provider_revocation_jobs SET state='complete',failure_reason='retired_identity' WHERE user_id=$1 AND generation=$2",
          [userId, generation],
        );
        await client.query("COMMIT");
        return;
      }
      const claimed = (
        await client.query<{ attempts: number; state: string }>(
          "SELECT attempts,state FROM provider_revocation_jobs WHERE user_id=$1 AND generation=$2 FOR UPDATE",
          [userId, generation],
        )
      ).rows[0];
      if (
        !claimed ||
        claimed.state !== "running" ||
        claimed.attempts !== job.attempts + 1
      ) {
        await client.query("ROLLBACK");
        return;
      }
      const inherited = await client.query(
        "SELECT 1 FROM provider_revocation_jobs WHERE user_id=$1 AND generation<$2 AND subject=$3 AND state IN ('manual','running') LIMIT 1",
        [userId, generation, job.subject],
      );
      if (inherited.rowCount) {
        await client.query(
          "UPDATE provider_revocation_jobs SET state='manual',failure_reason='inherited_manual' WHERE user_id=$1 AND generation=$2",
          [userId, generation],
        );
        await client.query("COMMIT");
        return;
      }
      // Keep the account ordering lock across the bounded provider calls. A
      // newer generation cannot otherwise distinguish our older in-flight
      // freeze from an independent incident freeze, and could remain fenced
      // indefinitely. A shared deadline bounds all four provider calls together;
      // SDK calls also have individual five-second timeouts and no retries.
      const options = { signal: AbortSignal.timeout(20_000) };
      let initial;
      try {
        initial = await provider.state(job.subject, options);
      } catch (error) {
        // This attempt has made no mutation. A durable pending state permits a
        // retry; an abandoned running attempt instead requires reconciliation.
        await client.query(
          "UPDATE provider_revocation_jobs SET state='pending' WHERE user_id=$1 AND generation=$2",
          [userId, generation],
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
        return;
      }
      try {
        await provider.freeze(job.subject, options);
        const frozen = await provider.state(job.subject, options);
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
          await provider.unfreeze(job.subject, options);
          await client.query(
            "UPDATE provider_identities SET auth_generation=$2,minimum_issued_at=GREATEST(minimum_issued_at,$3) WHERE user_id=$1 AND subject=$4",
            [userId, generation, frozen.frozenAt + 1, job.subject],
          );
        }
        await client.query(
          "UPDATE provider_revocation_jobs SET state='complete' WHERE user_id=$1 AND generation=$2",
          [userId, generation],
        );
        await client.query("COMMIT");
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
    } finally {
      client.release();
    }
  }
  return {
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
