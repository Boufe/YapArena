import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export type ReplayJob = {
  id: string;
  debateId: string;
  sourceKey: string;
  captionHash: string;
  captionsVtt: string | null;
  attempts: number;
  leaseId: string;
  packageKey: string;
  sourceEtag: string | null;
};
export type ReplayCleanup = { id: string; packageKey: string; token: string };
const hash =
  "encode(sha256(convert_to(COALESCE(m.captions_vtt,''),'UTF8')),'hex')";
const eligible = `m.state='ended' AND m.recording_status='ready' AND m.egress_id IS NOT NULL
  AND d.publication_state='published' AND NOT d.is_demo
  AND d.status IN ('ended','replay','finalized') AND t.publication_state='published'`;
const current = `EXISTS (SELECT 1 FROM yaparena.debate_media m
  JOIN yaparena.debates d ON d.id=m.debate_id JOIN yaparena.topics t ON t.id=d.topic_id
  WHERE m.debate_id=j.debate_id AND m.recording_key=j.source_key AND ${hash}=j.caption_hash AND ${eligible})`;
function bounded(value: number, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new RangeError("invalid replay queue bound");
  return value;
}

export function createReplayJobs(db: Pick<Pool, "query" | "connect">) {
  return Object.freeze({
    // A periodic bounded scan closes missed wake-ups. No dependency on NOTIFY,
    // webhook delivery order or an application process staying alive.
    async reconcile(limit = 100) {
      bounded(limit, 1, 1000);
      await db.query(
        `WITH due AS (
        SELECT id FROM yaparena.media_replay_jobs WHERE state='processing'
          AND lease_expires_at<=clock_timestamp() ORDER BY lease_expires_at,id LIMIT $1 FOR UPDATE SKIP LOCKED)
        UPDATE yaparena.media_replay_jobs j SET state=CASE WHEN attempts>=5 THEN 'failed' ELSE 'queued' END,
          lease_id=NULL,lease_expires_at=NULL,package_key=NULL,
          next_attempt_at=clock_timestamp()+INTERVAL '5 seconds',failure_code='lease_expired',updated_at=clock_timestamp()
        FROM due WHERE j.id=due.id`,
        [limit],
      );
      await db.query(
        `WITH obsolete AS (
        SELECT j.id FROM yaparena.media_replay_jobs j WHERE j.state<>'cancelled' AND NOT ${current}
          ORDER BY j.id LIMIT $1 FOR UPDATE OF j SKIP LOCKED)
        UPDATE yaparena.media_replay_jobs j SET state='cancelled',lease_expires_at=NULL,updated_at=clock_timestamp()
        FROM obsolete WHERE j.id=obsolete.id`,
        [limit],
      );
      await db.query(
        `WITH abandoned AS (
        SELECT a.id FROM yaparena.media_replay_attempts a JOIN yaparena.media_replay_jobs j ON j.id=a.job_id
        WHERE a.state IN ('writing','ready') AND NOT
          (j.lease_id=a.id AND (j.state='ready' OR (j.state='processing' AND j.lease_expires_at>clock_timestamp())))
        ORDER BY a.id LIMIT $1 FOR UPDATE OF a SKIP LOCKED)
        UPDATE yaparena.media_replay_attempts a SET state='cleanup',cleanup_after=GREATEST(protect_until,clock_timestamp())
        FROM abandoned WHERE a.id=abandoned.id`,
        [limit],
      );
      // cancelled inputs may be republished by a newer authorized change. A new
      // job/prefix is created; neither old packages nor old retry budgets revive.
      const inserted = await db.query(
        `INSERT INTO yaparena.media_replay_jobs(id,debate_id,source_key,caption_hash)
        SELECT gen_random_uuid(),m.debate_id,m.recording_key,${hash} FROM yaparena.debate_media m
        JOIN yaparena.debates d ON d.id=m.debate_id JOIN yaparena.topics t ON t.id=d.topic_id
        WHERE ${eligible} AND m.recording_key ~ '^debates/[0-9a-f-]{36}/[a-zA-Z0-9-]+[.]mp4$'
          AND split_part(m.recording_key,'/',2)=m.debate_id::text
          AND NOT EXISTS (SELECT 1 FROM yaparena.media_replay_jobs j WHERE j.debate_id=m.debate_id
            AND j.source_key=m.recording_key AND j.caption_hash=${hash} AND j.state<>'cancelled')
        ORDER BY m.debate_id LIMIT $1
        ON CONFLICT (debate_id,source_key,caption_hash) WHERE state<>'cancelled' DO NOTHING RETURNING id`,
        [limit],
      );
      return inserted.rowCount ?? 0;
    },
    async claim(leaseMs = 60_000, maxJobMs = 30 * 60 * 1000) {
      bounded(leaseMs, 5000, 300_000);
      bounded(maxJobMs, leaseMs, 2 * 60 * 60 * 1000);
      const leaseId = randomUUID();
      const result = await db.query<ReplayJob>(
        `WITH due AS (
        SELECT j.id FROM yaparena.media_replay_jobs j WHERE state='queued' AND attempts<5
          AND next_attempt_at<=clock_timestamp() AND ${current}
        ORDER BY next_attempt_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED), claimed AS (
        UPDATE yaparena.media_replay_jobs j SET state='processing',attempts=attempts+1,lease_id=$1::uuid,
          lease_expires_at=clock_timestamp()+$2*INTERVAL '1 millisecond',
          package_key='debates/'||debate_id::text||'/package-'||$1::uuid::text||'.mp4',updated_at=clock_timestamp()
        FROM due WHERE j.id=due.id RETURNING j.*), attempt AS (
        INSERT INTO yaparena.media_replay_attempts(id,job_id,package_key,protect_until)
          SELECT $1::uuid,id,package_key,clock_timestamp()+($3+120000)*INTERVAL '1 millisecond' FROM claimed RETURNING id)
        SELECT j.id,j.debate_id AS "debateId",j.source_key AS "sourceKey",j.caption_hash AS "captionHash",
          j.attempts,j.lease_id AS "leaseId",j.package_key AS "packageKey",j.source_etag AS "sourceEtag",
          m.captions_vtt AS "captionsVtt" FROM claimed j JOIN attempt a ON a.id=j.lease_id
          JOIN yaparena.debate_media m ON m.debate_id=j.debate_id`,
        [leaseId, leaseMs, maxJobMs],
      );
      return result.rows[0] ?? null;
    },
    async heartbeat(job: ReplayJob, leaseMs = 60_000) {
      bounded(leaseMs, 5000, 300_000);
      const result = await db.query(
        `UPDATE yaparena.media_replay_jobs j SET
        lease_expires_at=clock_timestamp()+$3*INTERVAL '1 millisecond',updated_at=clock_timestamp()
        WHERE id=$1 AND lease_id=$2 AND state='processing' AND lease_expires_at>clock_timestamp() AND ${current}
        RETURNING id`,
        [job.id, job.leaseId, leaseMs],
      );
      return result.rowCount === 1;
    },
    async bindSource(job: ReplayJob, etag: string) {
      if (!etag || etag.length > 200)
        throw new RangeError("invalid source identity");
      const result = await db.query(
        `UPDATE yaparena.media_replay_jobs j SET source_etag=$3
        WHERE id=$1 AND lease_id=$2 AND state='processing' AND lease_expires_at>clock_timestamp()
          AND (source_etag IS NULL OR source_etag=$3) AND ${current} RETURNING id`,
        [job.id, job.leaseId, etag],
      );
      return result.rowCount === 1;
    },
    async complete(job: ReplayJob, manifestDigest: string) {
      if (!/^[0-9a-f]{64}$/.test(manifestDigest))
        throw new RangeError("invalid manifest digest");
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'",
        );
        // Visibility changes serialize before publication. The topic may move
        // while acquiring these locks; the locked event must still reference it.
        const topic = await client.query<{ id: string }>(
          `SELECT t.id FROM yaparena.topics t
          JOIN yaparena.debates d ON d.topic_id=t.id WHERE d.id=$1 AND t.publication_state='published'
          FOR SHARE OF t`,
          [job.debateId],
        );
        const event = await client.query<{ status: string; topic_id: string }>(
          `SELECT status,topic_id
          FROM yaparena.debates WHERE id=$1 AND publication_state='published' AND NOT is_demo
          AND status IN ('ended','replay','finalized') FOR UPDATE`,
          [job.debateId],
        );
        if (!topic.rows[0] || event.rows[0]?.topic_id !== topic.rows[0].id) {
          await client.query("ROLLBACK");
          return false;
        }
        await client.query(
          "SELECT debate_id FROM yaparena.debate_media WHERE debate_id=$1 FOR UPDATE",
          [job.debateId],
        );
        // Domain -> community room -> queue job -> attempt is the common lock
        // order. No transaction or row lock spans download/encoding/upload.
        await client.query(
          "INSERT INTO yaparena.community_rooms(room_id) VALUES($1) ON CONFLICT DO NOTHING",
          [job.debateId],
        );
        await client.query(
          "SELECT room_id FROM yaparena.community_rooms WHERE room_id=$1 FOR UPDATE",
          [job.debateId],
        );
        const valid = await client.query(
          `SELECT j.id FROM yaparena.media_replay_jobs j
          WHERE j.id=$1 AND j.lease_id=$2 AND j.state='processing' AND j.source_etag IS NOT NULL
          AND j.lease_expires_at>clock_timestamp() AND ${current} FOR UPDATE OF j`,
          [job.id, job.leaseId],
        );
        const attempt = await client.query(
          `SELECT id FROM yaparena.media_replay_attempts
          WHERE job_id=$1 AND id=$2 AND state='writing' FOR UPDATE`,
          [job.id, job.leaseId],
        );
        if (!valid.rowCount || !attempt.rowCount) {
          await client.query("ROLLBACK");
          return false;
        }
        await client.query(
          `UPDATE yaparena.media_replay_jobs SET state='ready',lease_expires_at=NULL,
          manifest_digest=$2,failure_code=NULL,updated_at=clock_timestamp() WHERE id=$1`,
          [job.id, manifestDigest],
        );
        await client.query(
          "UPDATE yaparena.media_replay_attempts SET state='ready' WHERE id=$1",
          [job.leaseId],
        );
        if (event.rows[0]!.status === "ended") {
          await client.query(
            "UPDATE yaparena.debates SET status='replay',updated_at=clock_timestamp() WHERE id=$1",
            [job.debateId],
          );
          await client.query(
            `INSERT INTO yaparena.event_history(debate_id,action,from_status,to_status,reason)
            VALUES($1,'automatic_replay','ended','replay','verified adaptive replay available')`,
            [job.debateId],
          );
        }
        await client.query("COMMIT");
        return true;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async fail(job: ReplayJob, code: string, retryable = true) {
      if (!/^[a-z_]{1,40}$/.test(code))
        throw new RangeError("invalid replay failure code");
      await db.query(
        `UPDATE yaparena.media_replay_jobs SET
        state=CASE WHEN $4 AND attempts<5 THEN 'queued' ELSE 'failed' END,
        lease_expires_at=NULL,lease_id=NULL,package_key=NULL,failure_code=$3,
        next_attempt_at=clock_timestamp()+(LEAST(60000,1000*power(2,attempts))*(0.75+random()*0.5))*INTERVAL '1 millisecond',
        updated_at=clock_timestamp() WHERE id=$1 AND lease_id=$2 AND state='processing'`,
        [job.id, job.leaseId, code, retryable],
      );
      // The caller has drained/aborted all I/O before releasing this protection.
      // An uncertain successful COMMIT leaves attempt state ready, so it is safe.
      await db.query(
        `UPDATE yaparena.media_replay_attempts SET state='cleanup',protect_until=clock_timestamp(),
        cleanup_after=clock_timestamp() WHERE id=$1 AND job_id=$2 AND state='writing'`,
        [job.leaseId, job.id],
      );
    },
    async ready(debateId: string, sourceKey: string) {
      const result = await db.query<{
        packageKey: string;
        hasCaptions: boolean;
      }>(
        `SELECT
        j.package_key AS "packageKey",m.captions_vtt IS NOT NULL AS "hasCaptions"
        FROM yaparena.media_replay_jobs j JOIN yaparena.debate_media m ON m.debate_id=j.debate_id
        WHERE j.debate_id=$1 AND j.source_key=$2 AND j.state='ready' AND ${current}`,
        [debateId, sourceKey],
      );
      return result.rows[0] ?? null;
    },
    async claimCleanup(leaseMs = 60_000) {
      bounded(leaseMs, 5000, 300_000);
      const token = randomUUID();
      const result = await db.query<ReplayCleanup>(
        `WITH due AS (
        SELECT id FROM yaparena.media_replay_attempts WHERE (state='cleanup' OR
          (state='cleaning' AND cleanup_lease_at<=clock_timestamp())) AND cleanup_after<=clock_timestamp()
        ORDER BY cleanup_after,id LIMIT 1 FOR UPDATE SKIP LOCKED)
        UPDATE yaparena.media_replay_attempts a SET state='cleaning',cleanup_token=$1,
          cleanup_lease_at=clock_timestamp()+$2*INTERVAL '1 millisecond'
        FROM due WHERE a.id=due.id RETURNING a.id,a.package_key AS "packageKey",a.cleanup_token AS token`,
        [token, leaseMs],
      );
      return result.rows[0] ?? null;
    },
    async finishCleanup(attempt: ReplayCleanup, success: boolean) {
      const result = await db.query(
        `UPDATE yaparena.media_replay_attempts SET
        state=CASE WHEN $3 THEN 'cleaned' ELSE 'cleanup' END,cleanup_token=NULL,cleanup_lease_at=NULL,
        cleanup_after=clock_timestamp()+INTERVAL '1 minute' WHERE id=$1 AND cleanup_token=$2 AND state='cleaning'
        RETURNING id`,
        [attempt.id, attempt.token, success],
      );
      return result.rowCount === 1;
    },
    async prune(limit = 100) {
      bounded(limit, 1, 1000);
      // Failed inputs remain until a source/caption/visibility change cancels
      // them; pruning must never reset a failed input's five-attempt budget.
      const result = await db.query(
        `WITH expired AS (
        SELECT j.id FROM yaparena.media_replay_jobs j WHERE j.state='cancelled'
          AND j.updated_at<clock_timestamp()-INTERVAL '30 days'
          AND NOT EXISTS (SELECT 1 FROM yaparena.media_replay_attempts a WHERE a.job_id=j.id AND a.state<>'cleaned')
        ORDER BY j.id LIMIT $1 FOR UPDATE OF j SKIP LOCKED), removed AS (
        DELETE FROM yaparena.media_replay_attempts a USING expired e WHERE a.job_id=e.id RETURNING a.id)
        DELETE FROM yaparena.media_replay_jobs j USING expired e WHERE j.id=e.id
          AND (SELECT COUNT(*) FROM removed)>=0 RETURNING j.id`,
        [limit],
      );
      return result.rowCount ?? 0;
    },
  });
}
