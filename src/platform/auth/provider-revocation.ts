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
      if (user.generation !== generation) {
        await client.query(
          "UPDATE provider_revocation_jobs SET state='complete' WHERE user_id=$1 AND generation=$2",
          [userId, generation],
        );
        await client.query("COMMIT");
        return;
      }
      // A freeze that predates this job may be an independent provider incident
      // control. Never silently undo it. Retrying our own uncertain call is safe.
      if (
        job.attempts === 0 &&
        (await provider.state(job.subject)).frozenAt !== null
      ) {
        await client.query(
          "UPDATE provider_revocation_jobs SET state='manual' WHERE user_id=$1 AND generation=$2",
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
      await provider.freeze(job.subject);
      const frozen = await provider.state(job.subject);
      if (
        !Number.isSafeInteger(frozen.frozenAt) ||
        frozen.frozenAt === null ||
        frozen.frozenAt < 1
      )
        throw new Error("provider revocation confirmation unavailable");
      await client.query("BEGIN");
      const latest = (
        await client.query<{ generation: string; status: string }>(
          "SELECT auth_generation AS generation,account_status AS status FROM users WHERE id=$1 FOR UPDATE",
          [userId],
        )
      ).rows[0];
      if (!latest || latest.generation !== generation) {
        await client.query("ROLLBACK");
        return;
      }
      if (latest.status === "active") {
        await provider.unfreeze(job.subject);
        await client.query(
          "UPDATE provider_identities SET auth_generation=$2,minimum_issued_at=GREATEST(minimum_issued_at,$3) WHERE user_id=$1",
          [userId, generation, frozen.frozenAt + 1],
        );
      }
      await client.query(
        "UPDATE provider_revocation_jobs SET state='complete' WHERE user_id=$1 AND generation=$2",
        [userId, generation],
      );
      await client.query("COMMIT");
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
