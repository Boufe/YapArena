import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { verifiedStoredCredentials } from "./provider-credentials.ts";
import {
  EmbeddedWalletProviderError,
  type EmbeddedWallet,
  type EmbeddedWalletProvider,
} from "./embedded-wallet-provider.ts";

export type EmbeddedWalletProjection = {
  accountId: string;
  subject: string | null;
  state:
    | "pending"
    | "provisioning"
    | "ready"
    | "retry_wait"
    | "review_required"
    | "unavailable";
  chain: "ethereum";
  address: string | null;
  canRetry: boolean;
  retryAt: string | null;
};
type Job = {
  userId: string;
  subject: string;
  externalId: string;
  state: "pending" | "running" | "ready" | "retry_wait" | "review_required";
  attempts: number;
  attemptKey: string;
  leaseId: string | null;
  walletId: string | null;
  address: string | null;
  nextAttemptAt: Date;
  lastFailure:
    | "provider_unavailable"
    | "account_verification"
    | "ownership_review"
    | "attempts_exhausted"
    | null;
};
const columns = `user_id AS "userId",subject,external_id AS "externalId",state,attempts,attempt_key AS "attemptKey",lease_id AS "leaseId",wallet_id AS "walletId",address,next_attempt_at AS "nextAttemptAt",last_failure AS "lastFailure"`;

// Called inside the account-locked provisioning/accepted-credential transaction.
// A new DID cannot replace the original immutable wallet owner. Rearming a
// parked job additionally requires the caller's freshly accepted exact digest.
export async function enqueueEmbeddedWalletProvisioning(
  client: PoolClient,
  userId: string,
  subject: string,
  acceptedCredentialsDigest?: string,
) {
  await client.query(
    `INSERT INTO embedded_wallet_provisioning(user_id,subject)
     SELECT u.id,p.subject FROM users u JOIN provider_identities p ON p.user_id=u.id
     WHERE u.id=$1 AND p.subject=$2 AND p.provider='privy' AND u.account_status='active'
       AND p.auth_generation=u.auth_generation
       AND ($3::text IS NULL OR p.credentials_digest=$3)
     ON CONFLICT(user_id) DO UPDATE SET state='pending',last_failure=NULL,
       next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
     WHERE embedded_wallet_provisioning.subject=EXCLUDED.subject
       AND embedded_wallet_provisioning.state='retry_wait'
       AND embedded_wallet_provisioning.last_failure='account_verification'
       AND embedded_wallet_provisioning.attempts<8 AND $3::text IS NOT NULL`,
    [userId, subject, acceptedCredentialsDigest ?? null],
  );
}

export function createEmbeddedWalletProvisioning(
  database: Pool,
  provider: EmbeddedWalletProvider,
) {
  async function mapping(client: PoolClient, userId: string, lock = false) {
    if (lock)
      await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
        userId,
      ]);
    return (
      await client.query<{
        subject: string;
        active: boolean;
        generationMatch: boolean;
        email: string | null;
        methods: string[];
        credentialsDigest: string;
        credentialsSnapshot: Parameters<
          typeof verifiedStoredCredentials
        >[0]["credentialsSnapshot"];
      }>(
        `SELECT p.subject,u.account_status='active' AS active,p.auth_generation=u.auth_generation AS "generationMatch",
       p.email,p.methods,p.credentials_digest AS "credentialsDigest",p.credentials_snapshot AS "credentialsSnapshot"
       FROM users u JOIN provider_identities p ON p.user_id=u.id AND p.provider='privy' WHERE u.id=$1`,
        [userId],
      )
    ).rows[0];
  }
  function project(
    job: Job | undefined,
    owner: Awaited<ReturnType<typeof mapping>>,
    userId: string,
  ): EmbeddedWalletProjection {
    const empty = {
      accountId: userId,
      subject: owner?.subject ?? null,
      chain: "ethereum" as const,
      address: null,
      canRetry: false,
      retryAt: null,
    };
    if (
      !owner?.active ||
      !owner.generationMatch ||
      !verifiedStoredCredentials(owner)
    )
      return { ...empty, state: "unavailable" };
    if (!job) return { ...empty, state: "pending", canRetry: true };
    if (owner.subject !== job.subject || job.state === "review_required")
      return { ...empty, state: "review_required" };
    return {
      accountId: userId,
      subject: owner.subject,
      chain: "ethereum",
      state: job.state === "running" ? "provisioning" : job.state,
      address: job.state === "ready" ? job.address : null,
      canRetry:
        (job.state === "pending" || job.state === "retry_wait") &&
        job.attempts < 8 &&
        job.nextAttemptAt.getTime() <= Date.now(),
      retryAt:
        job.state === "retry_wait" && job.lastFailure !== "account_verification"
          ? job.nextAttemptAt.toISOString()
          : null,
    };
  }
  async function get(userId: string): Promise<EmbeddedWalletProjection> {
    const client = await database.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const owner = await mapping(client, userId);
      const job = (
        await client.query<Job>(
          `SELECT ${columns} FROM embedded_wallet_provisioning WHERE user_id=$1`,
          [userId],
        )
      ).rows[0];
      await client.query("COMMIT");
      return project(job, owner, userId);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async function requestRetry(
    userId: string,
  ): Promise<EmbeddedWalletProjection> {
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      const owner = await mapping(client, userId, true);
      if (
        owner?.active &&
        owner.generationMatch &&
        verifiedStoredCredentials(owner)
      ) {
        await enqueueEmbeddedWalletProvisioning(
          client,
          userId,
          owner.subject,
          owner.credentialsDigest,
        );
        await client.query(
          `UPDATE embedded_wallet_provisioning SET state='pending',updated_at=clock_timestamp()
           WHERE user_id=$1 AND subject=$2 AND state IN ('pending','retry_wait') AND attempts<8 AND next_attempt_at<=clock_timestamp()`,
          [userId, owner.subject],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return get(userId);
  }
  async function claim(
    userId?: string,
  ): Promise<{ job: Job | null; reviewed: number }> {
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      const exhausted = await client.query(
        `UPDATE embedded_wallet_provisioning SET state='review_required',last_failure='attempts_exhausted',lease_id=NULL,updated_at=clock_timestamp()
         WHERE state='running' AND attempts>=8 AND lease_until<clock_timestamp() AND ($1::bigint IS NULL OR user_id=$1)`,
        [userId ?? null],
      );
      const selected = (
        await client.query<Job>(
          `SELECT ${columns} FROM embedded_wallet_provisioning
         WHERE ($1::bigint IS NULL OR user_id=$1) AND attempts<8 AND ((state IN ('pending','retry_wait')
           AND last_failure IS DISTINCT FROM 'account_verification' AND next_attempt_at<=clock_timestamp())
           OR (state='running' AND lease_until<clock_timestamp()))
         ORDER BY next_attempt_at,created_at,user_id FOR UPDATE SKIP LOCKED LIMIT 1`,
          [userId ?? null],
        )
      ).rows[0];
      if (!selected) {
        await client.query("COMMIT");
        return { job: null, reviewed: exhausted.rowCount ?? 0 };
      }
      const leaseId = randomUUID();
      const result = (
        await client.query<Job>(
          `UPDATE embedded_wallet_provisioning SET state='running',attempts=attempts+1,lease_id=$2,
         lease_until=clock_timestamp()+INTERVAL '90 seconds',updated_at=clock_timestamp() WHERE user_id=$1 RETURNING ${columns}`,
          [selected.userId, leaseId],
        )
      ).rows[0];
      await client.query("COMMIT");
      return { job: result ?? null, reviewed: exhausted.rowCount ?? 0 };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async function checkpoint(
    job: Job,
    digest: string | null,
    action: "check" | "create" | "ready",
    wallet?: EmbeddedWallet,
    externalAttempted = false,
  ) {
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      const owner = await mapping(client, job.userId, true);
      const current = (
        await client.query<Job>(
          `SELECT ${columns} FROM embedded_wallet_provisioning WHERE user_id=$1 FOR UPDATE`,
          [job.userId],
        )
      ).rows[0];
      if (
        !current ||
        current.state !== "running" ||
        current.leaseId !== job.leaseId
      ) {
        await client.query("COMMIT");
        return { valid: false, attemptKey: null, reviewed: false };
      }
      if (!owner || owner.subject !== job.subject) {
        await client.query(
          "UPDATE embedded_wallet_provisioning SET state='review_required',last_failure='ownership_review',lease_id=NULL,updated_at=clock_timestamp() WHERE user_id=$1",
          [job.userId],
        );
        await client.query("COMMIT");
        return { valid: false, attemptKey: null, reviewed: true };
      }
      if (
        !owner.active ||
        !owner.generationMatch ||
        !verifiedStoredCredentials(owner) ||
        (digest !== null && owner.credentialsDigest !== digest)
      ) {
        await client.query(
          `UPDATE embedded_wallet_provisioning SET
           state=CASE WHEN $2::boolean AND attempts>=8 THEN 'review_required' ELSE 'retry_wait' END,
           attempts=GREATEST(attempts-CASE WHEN $2::boolean THEN 0 ELSE 1 END,0),
           last_failure=CASE WHEN $2::boolean AND attempts>=8 THEN 'attempts_exhausted' ELSE 'account_verification' END,
           next_attempt_at=clock_timestamp(),lease_id=NULL,updated_at=clock_timestamp()
           WHERE user_id=$1`,
          [job.userId, externalAttempted],
        );
        await client.query("COMMIT");
        return {
          valid: false,
          attemptKey: null,
          reviewed: externalAttempted && current.attempts >= 8,
        };
      }
      let attemptKey = current.attemptKey;
      if (action === "create") {
        // Inspection just confirmed no unique external reference or existing
        // user wallet. A fresh attempt key avoids replaying a cached 5xx; the
        // permanent, app-unique external ID remains the duplicate fence.
        attemptKey = randomUUID();
        await client.query(
          "UPDATE embedded_wallet_provisioning SET attempt_key=$2,creation_started_at=clock_timestamp(),updated_at=clock_timestamp() WHERE user_id=$1",
          [job.userId, attemptKey],
        );
      }
      if (action === "ready") {
        if (!wallet) throw new Error("Confirmed wallet required");
        await client.query(
          "UPDATE embedded_wallet_provisioning SET state='ready',wallet_id=$2,address=$3,completed_at=clock_timestamp(),last_failure=NULL,lease_id=NULL,updated_at=clock_timestamp() WHERE user_id=$1",
          [job.userId, wallet.id, wallet.address],
        );
        await client.query(
          "INSERT INTO identity_audit_events(user_id,event_type,subject_id,metadata) VALUES($1,'embedded_wallet.provisioned',$1::bigint::text,$2::jsonb)",
          [
            job.userId,
            JSON.stringify({
              chain: "ethereum",
              attempts: current.attempts,
              outcome: "ready",
            }),
          ],
        );
      }
      await client.query("COMMIT");
      return { valid: true, attemptKey, reviewed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async function fail(job: Job, review: boolean) {
    const state =
      review || job.attempts >= 8 ? "review_required" : "retry_wait";
    await database.query(
      `UPDATE embedded_wallet_provisioning SET state=$3,last_failure=$4,lease_id=NULL,
       next_attempt_at=clock_timestamp()+($5::integer*INTERVAL '1 second'),updated_at=clock_timestamp()
       WHERE user_id=$1 AND state='running' AND lease_id=$2`,
      [
        job.userId,
        job.leaseId,
        state,
        review
          ? "ownership_review"
          : job.attempts >= 8
            ? "attempts_exhausted"
            : "provider_unavailable",
        Math.min(3600, 30 * 2 ** (job.attempts - 1)),
      ],
    );
    return state;
  }
  async function process(limit = 1, userId?: string) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 3)
      throw new Error(
        "Wallet provisioning limit must be between one and three",
      );
    const result = { processed: 0, ready: 0, retry: 0, review: 0 };
    for (let index = 0; index < limit; index++) {
      const claimed = await claim(userId);
      result.review += claimed.reviewed;
      const job = claimed.job;
      if (!job) break;
      result.processed++;
      try {
        const initial = await checkpoint(job, null, "check");
        if (!initial.valid) {
          if (initial.reviewed) result.review++;
          else result.retry++;
          continue;
        }
        const signal = AbortSignal.timeout(60_000);
        let inspected = await provider.inspect({
          subject: job.subject,
          externalId: job.externalId,
          signal,
        });
        let externalAttempted = false;
        if (!inspected.wallet) {
          const current = await checkpoint(
            job,
            inspected.credentialsDigest,
            "create",
          );
          if (!current.valid || !current.attemptKey) {
            if (current.reviewed) result.review++;
            else result.retry++;
            continue;
          }
          externalAttempted = true;
          await provider.create({
            subject: job.subject,
            externalId: job.externalId,
            idempotencyKey: current.attemptKey,
            signal,
          });
          inspected = await provider.inspect({
            subject: job.subject,
            externalId: job.externalId,
            signal,
          });
        }
        if (!inspected.wallet)
          throw new EmbeddedWalletProviderError("unavailable");
        const finished = await checkpoint(
          job,
          inspected.credentialsDigest,
          "ready",
          inspected.wallet,
          externalAttempted,
        );
        if (finished.valid) result.ready++;
        else if (finished.reviewed) result.review++;
        else result.retry++;
      } catch (error) {
        const state = await fail(
          job,
          error instanceof EmbeddedWalletProviderError &&
            error.code === "review_required",
        );
        if (state === "review_required") result.review++;
        else result.retry++;
      }
    }
    return result;
  }
  return Object.freeze({ get, requestRetry, process });
}
