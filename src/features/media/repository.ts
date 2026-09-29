import type { Pool, PoolClient } from "pg";

export class MediaConflictError extends Error {}
export class MediaNotFoundError extends Error {}

export interface MediaState {
  debateId: string;
  state: "idle" | "running" | "paused" | "ended";
  activeSide: "A" | "B" | null;
  turnNumber: number;
  turnDeadlineAt: Date | null;
  remainingMs: number | null;
  activeMs: number;
  lastResumedAt: Date | null;
  revision: number;
  incident: string | null;
  egressId: string | null;
  recordingStatus: "pending" | "recording" | "processing" | "ready" | "failed";
  recordingKey: string | null;
  hasCaptions: boolean;
}

const fields = `debate_id AS "debateId", state, active_side AS "activeSide",
  turn_number AS "turnNumber", turn_deadline_at AS "turnDeadlineAt",
  remaining_ms AS "remainingMs", active_ms AS "activeMs",
  last_resumed_at AS "lastResumedAt", revision, incident,
  egress_id AS "egressId", recording_status AS "recordingStatus",
  recording_key AS "recordingKey", captions_vtt IS NOT NULL AS "hasCaptions"`;

async function transaction<T>(
  db: Pool,
  fn: (client: PoolClient) => Promise<T>,
) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type Rules = {
  initial_speaking_time_seconds?: number;
  maximum_duration_seconds?: number;
};
function timing(rules: Rules) {
  const turn = rules.initial_speaking_time_seconds;
  const maximum = rules.maximum_duration_seconds;
  if (
    !Number.isInteger(turn) ||
    !Number.isInteger(maximum) ||
    !turn ||
    !maximum ||
    turn < 10 ||
    maximum < turn * 2 ||
    maximum > 7200
  )
    throw new MediaConflictError(
      "event rules do not specify usable media timings",
    );
  return { turnMs: turn * 1000, maximumMs: maximum * 1000 };
}

export function createMediaRepository(db: Pool) {
  return Object.freeze({
    async get(debateId: string) {
      const result = await db.query<MediaState>(
        `SELECT ${fields} FROM debate_media WHERE debate_id = $1`,
        [debateId],
      );
      return result.rows[0] ?? null;
    },
    async getPublicEvent(debateId: string) {
      const result = await db.query<{
        status: string;
        publicationState: string;
        rulesSnapshot: Rules;
      }>(
        `SELECT status, publication_state AS "publicationState", rules_snapshot AS "rulesSnapshot"
         FROM debates WHERE id = $1`,
        [debateId],
      );
      return result.rows[0] ?? null;
    },
    async sideFor(debateId: string, userId: string) {
      const result = await db.query<{ side: "A" | "B" }>(
        "SELECT side FROM event_participants WHERE debate_id = $1 AND user_id = $2",
        [debateId, userId],
      );
      return result.rows[0]?.side ?? null;
    },
    async checkDevice(
      debateId: string,
      userId: string,
      cameraOk: boolean,
      microphoneOk: boolean,
    ) {
      return transaction(db, async (client) => {
        const event = await client.query<{ status: string }>(
          "SELECT status FROM debates WHERE id = $1 FOR UPDATE",
          [debateId],
        );
        if (
          !event.rows[0] ||
          !["scheduled", "ready", "live"].includes(event.rows[0].status)
        )
          throw new MediaConflictError("event is not awaiting speakers");
        const participant = await client.query(
          "SELECT 1 FROM event_participants WHERE debate_id = $1 AND user_id = $2",
          [debateId, userId],
        );
        if (!participant.rows[0])
          throw new MediaNotFoundError("event not found");
        await client.query(
          `INSERT INTO media_device_checks (debate_id, user_id, camera_ok, microphone_ok)
          VALUES ($1, $2, $3, $4) ON CONFLICT (debate_id, user_id) DO UPDATE SET
          camera_ok = EXCLUDED.camera_ok, microphone_ok = EXCLUDED.microphone_ok, checked_at = CURRENT_TIMESTAMP`,
          [debateId, userId, cameraOk, microphoneOk],
        );
        return { cameraOk, microphoneOk };
      });
    },
    async assertDeviceReady(debateId: string, userId: string) {
      const result = await db.query(
        `SELECT 1 FROM media_device_checks WHERE debate_id = $1 AND user_id = $2
        AND camera_ok AND microphone_ok AND checked_at > CURRENT_TIMESTAMP - INTERVAL '30 minutes'`,
        [debateId, userId],
      );
      if (!result.rows[0])
        throw new MediaConflictError(
          "camera and microphone check required before readiness",
        );
    },
    async start(debateId: string, egressId: string, key: string) {
      return transaction(db, async (client) => {
        const result = await client.query<{
          status: string;
          rulesSnapshot: Rules;
        }>(
          `SELECT status, rules_snapshot AS "rulesSnapshot" FROM debates WHERE id = $1 FOR UPDATE`,
          [debateId],
        );
        const event = result.rows[0];
        if (!event) throw new MediaNotFoundError("event not found");
        if (event.status !== "ready")
          throw new MediaConflictError("both speakers must be ready");
        const scheduled = await client.query<{ allowed: boolean }>(
          "SELECT scheduled_at <= CURRENT_TIMESTAMP + INTERVAL '15 minutes' AS allowed FROM debates WHERE id = $1",
          [debateId],
        );
        if (!scheduled.rows[0]?.allowed)
          throw new MediaConflictError(
            "event cannot start before its scheduled window",
          );
        const { turnMs } = timing(event.rulesSnapshot);
        const state = await client.query<MediaState>(
          `INSERT INTO debate_media
          (debate_id, state, active_side, turn_number, turn_deadline_at, remaining_ms,
           last_resumed_at, egress_id, recording_status, recording_key)
          VALUES ($1, 'running', 'A', 1, CURRENT_TIMESTAMP + ($3::integer * INTERVAL '1 millisecond'),
                  $3, CURRENT_TIMESTAMP, $2, 'recording', $4) RETURNING ${fields}`,
          [debateId, egressId, turnMs, key],
        );
        return state.rows[0]!;
      });
    },
    async undoFailedStart(debateId: string) {
      await db.query(
        `DELETE FROM debate_media WHERE debate_id = $1
        AND (SELECT status FROM debates WHERE id = $1) = 'ready'`,
        [debateId],
      );
    },
    async stop(debateId: string, reason: string) {
      return transaction(db, async (client) => {
        const current = await client.query<MediaState>(
          `SELECT ${fields} FROM debate_media WHERE debate_id = $1 FOR UPDATE`,
          [debateId],
        );
        const state = current.rows[0];
        if (!state) throw new MediaNotFoundError("media session not found");
        if (state.state === "ended") return state;
        const result = await client.query<MediaState>(
          `UPDATE debate_media SET state = 'ended', active_side = NULL,
          active_ms = active_ms + CASE WHEN state = 'running' THEN GREATEST(0, EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - last_resumed_at)) * 1000)::integer ELSE 0 END,
          last_resumed_at = NULL, turn_deadline_at = NULL,
          recording_status = CASE WHEN recording_status = 'recording' THEN 'processing' ELSE recording_status END,
          incident = COALESCE(incident, $2),
          revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE debate_id = $1 RETURNING ${fields}`,
          [debateId, reason],
        );
        return result.rows[0]!;
      });
    },
    async pause(debateId: string, actorId: string | null, reason: string) {
      return transaction(db, async (client) => {
        const current = await client.query<MediaState>(
          `SELECT ${fields} FROM debate_media WHERE debate_id = $1 FOR UPDATE`,
          [debateId],
        );
        const state = current.rows[0];
        if (!state || state.state !== "running")
          throw new MediaConflictError("debate is not running");
        const result = await client.query<MediaState>(
          `UPDATE debate_media SET state = 'paused',
          remaining_ms = GREATEST(0, EXTRACT(EPOCH FROM (turn_deadline_at - CURRENT_TIMESTAMP)) * 1000)::integer,
          active_ms = active_ms + GREATEST(0, EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - last_resumed_at)) * 1000)::integer,
          last_resumed_at = NULL, turn_deadline_at = NULL, incident = $2,
          revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE debate_id = $1
          AND (SELECT status FROM debates WHERE id = $1) = 'live' RETURNING ${fields}`,
          [debateId, reason],
        );
        if (!result.rows[0]) throw new MediaConflictError("debate is not live");
        await client.query(
          `INSERT INTO event_history (debate_id, actor_user_id, action, from_status, to_status, reason)
          VALUES ($1, $2, 'media_paused', 'live', 'live', $3)`,
          [debateId, actorId, reason],
        );
        return result.rows[0];
      });
    },
    async resume(debateId: string, actorId: string, revision: number) {
      return transaction(db, async (client) => {
        const result = await client.query<MediaState>(
          `UPDATE debate_media SET state = 'running',
          turn_deadline_at = CURRENT_TIMESTAMP + (remaining_ms * INTERVAL '1 millisecond'),
          last_resumed_at = CURRENT_TIMESTAMP, incident = NULL, revision = revision + 1,
          updated_at = CURRENT_TIMESTAMP WHERE debate_id = $1 AND state = 'paused'
          AND recording_status = 'recording' AND revision = $2
          AND (SELECT status FROM debates WHERE id = $1) = 'live' RETURNING ${fields}`,
          [debateId, revision],
        );
        if (!result.rows[0])
          throw new MediaConflictError(
            "media state changed; refresh before resuming",
          );
        await client.query(
          `INSERT INTO event_history (debate_id, actor_user_id, action, from_status, to_status, reason)
          VALUES ($1, $2, 'media_resumed', 'live', 'live', 'operator resumed after incident')`,
          [debateId, actorId],
        );
        return result.rows[0];
      });
    },
    async tick() {
      const due = await db.query<{
        debateId: string;
      }>(`SELECT debate_id AS "debateId" FROM debate_media
        WHERE state = 'running' AND turn_deadline_at <= CURRENT_TIMESTAMP LIMIT 50`);
      const turns: Array<{ debateId: string; side: "A" | "B" }> = [];
      const ended: string[] = [];
      for (const { debateId } of due.rows) {
        await transaction(db, async (client) => {
          const eventResult = await client.query<{
            status: string;
            rulesSnapshot: Rules;
          }>(
            `SELECT status, rules_snapshot AS "rulesSnapshot" FROM debates WHERE id = $1 FOR UPDATE`,
            [debateId],
          );
          const event = eventResult.rows[0];
          if (!event || event.status !== "live") return;
          const stateResult = await client.query<MediaState>(
            `SELECT ${fields} FROM debate_media WHERE debate_id = $1 FOR UPDATE`,
            [debateId],
          );
          const state = stateResult.rows[0];
          if (
            !state ||
            state.state !== "running" ||
            !state.turnDeadlineAt ||
            new Date(state.turnDeadlineAt).getTime() > Date.now()
          )
            return;
          const { turnMs, maximumMs } = timing(event.rulesSnapshot);
          const elapsed = Math.min(
            state.remainingMs ?? turnMs,
            Math.max(0, Date.now() - new Date(state.lastResumedAt!).getTime()),
          );
          const activeMs = state.activeMs + elapsed;
          if (activeMs >= maximumMs) {
            await client.query(
              `UPDATE debates SET status = 'ended', live_ended_at = CURRENT_TIMESTAMP,
              ended_reason = 'maximum_duration', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
              [debateId],
            );
            await client.query(
              "UPDATE event_participants SET active = false WHERE debate_id = $1",
              [debateId],
            );
            await client.query(
              `UPDATE debate_media SET state = 'ended', active_side = NULL, turn_deadline_at = NULL,
              last_resumed_at = NULL, active_ms = $2,
              recording_status = CASE WHEN recording_status = 'recording' THEN 'processing' ELSE recording_status END,
              revision = revision + 1,
              updated_at = CURRENT_TIMESTAMP WHERE debate_id = $1`,
              [debateId, activeMs],
            );
            await client.query(
              `INSERT INTO event_history (debate_id, action, from_status, to_status, reason)
              VALUES ($1, 'automatic_end', 'live', 'ended', 'maximum duration reached')`,
              [debateId],
            );
            ended.push(debateId);
          } else {
            const next = state.activeSide === "A" ? "B" : "A";
            turns.push({ debateId, side: next });
            const nextMs = Math.min(turnMs, maximumMs - activeMs);
            await client.query(
              `UPDATE debate_media SET active_side = $2, turn_number = turn_number + 1,
              active_ms = $3, remaining_ms = $4, last_resumed_at = CURRENT_TIMESTAMP,
              turn_deadline_at = CURRENT_TIMESTAMP + ($4::integer * INTERVAL '1 millisecond'),
              revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE debate_id = $1`,
              [debateId, next, activeMs, nextMs],
            );
            await client.query(
              `INSERT INTO event_history (debate_id, action, from_status, to_status, reason)
              VALUES ($1, 'turn_advanced', 'live', 'live', $2)`,
              [debateId, `side ${next} turn`],
            );
          }
        });
      }
      return { turns, ended };
    },
    async claimRecordingStops() {
      const result = await db.query<{ debateId: string; egressId: string }>(
        `WITH due AS (
          SELECT debate_id FROM debate_media WHERE state = 'ended' AND recording_status = 'processing'
            AND egress_id IS NOT NULL
            AND (stop_requested_at IS NULL OR stop_requested_at < CURRENT_TIMESTAMP - INTERVAL '60 seconds')
            AND (stop_retry_at IS NULL OR stop_retry_at <= CURRENT_TIMESTAMP)
          ORDER BY updated_at LIMIT 20 FOR UPDATE SKIP LOCKED
        ) UPDATE debate_media AS m SET stop_requested_at = CURRENT_TIMESTAMP,
          stop_retry_at = NULL, updated_at = CURRENT_TIMESTAMP FROM due
          WHERE m.debate_id = due.debate_id RETURNING m.debate_id AS "debateId", m.egress_id AS "egressId"`,
      );
      return result.rows;
    },
    async recordingStopFailed(debateId: string) {
      await db.query(
        `UPDATE debate_media SET stop_requested_at = NULL,
          stop_retry_at = CURRENT_TIMESTAMP + INTERVAL '30 seconds',
          incident = 'Recording stop request failed; retrying automatically.',
          revision = revision + 1, updated_at = CURRENT_TIMESTAMP
          WHERE debate_id = $1 AND state = 'ended' AND recording_status = 'processing'`,
        [debateId],
      );
    },
    async recordingEnded(
      egressId: string,
      success: boolean,
      key: string | null,
    ) {
      const result = await db.query<MediaState>(
        `UPDATE debate_media SET recording_status = CASE
          WHEN $2 = 'ready' AND state <> 'ended' THEN 'failed'
          ELSE $2 END,
        recording_key = CASE
          WHEN $2 = 'ready' AND state = 'ended' THEN $3
          ELSE NULL END,
        revision = revision + 1, updated_at = CURRENT_TIMESTAMP
        WHERE egress_id = $1 AND recording_status IN ('recording', 'processing')
          AND ($2 = 'failed' OR recording_key = $3) RETURNING ${fields}`,
        [egressId, success ? "ready" : "failed", success ? key : null],
      );
      return result.rows[0] ?? null;
    },
    async recordingFailed(egressId: string) {
      const result = await db.query<MediaState>(
        `UPDATE debate_media SET recording_status = 'failed',
        revision = revision + 1 WHERE egress_id = $1 AND recording_status = 'recording' RETURNING ${fields}`,
        [egressId],
      );
      return result.rows[0] ?? null;
    },
    async captions(debateId: string) {
      const result = await db.query<{ captionsVtt: string }>(
        `SELECT captions_vtt AS "captionsVtt" FROM debate_media
        WHERE debate_id = $1 AND recording_status = 'ready'`,
        [debateId],
      );
      return result.rows[0]?.captionsVtt ?? null;
    },
    async setCaptions(debateId: string, vtt: string) {
      const result = await db.query(
        `UPDATE debate_media SET captions_vtt = $2, revision = revision + 1,
        updated_at = CURRENT_TIMESTAMP WHERE debate_id = $1 AND recording_status = 'ready' RETURNING debate_id`,
        [debateId, vtt],
      );
      if (!result.rows[0])
        throw new MediaConflictError(
          "recording must be ready before captions are published",
        );
    },
  });
}
