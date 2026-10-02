import type { Pool, PoolClient } from "pg";

export type ProductEventType =
  | "discovery_view"
  | "match_requested"
  | "match_accepted"
  | "debate_completed"
  | "replay_started"
  | "follow_created"
  | "report_submitted"
  | "return_visit";
export type DiscoverySurface =
  "home" | "debates" | "topics" | "debate" | "topic" | "profile" | "match";
export type WatchMode = "live" | "replay";
export type Affiliation = "founder" | "independent" | "unclassified";
export type ProductAction =
  | { type: "match_requested"; requestId: string }
  | { type: "match_accepted"; debateId: string }
  | { type: "follow_created"; targetType: "topic" | "profile"; slug: string }
  | { type: "report_submitted"; caseId: string };

interface TargetRow {
  debateId: string | null;
  topicId: string | null;
}
interface SummaryRow {
  eventType: ProductEventType;
  affiliation: "founder" | "independent" | "unclassified";
  count: string;
}
interface WatchSummaryRow {
  mode: WatchMode;
  affiliation: "founder" | "independent" | "unclassified";
  sessions: string;
  watchedSeconds: string;
}
interface AffiliationRow {
  handle: string;
  affiliation: "founder" | "independent";
  reason: string;
  updatedAt: Date;
}

async function transaction<T>(
  pool: Pool,
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function lockConsent(client: PoolClient, tokenHash: string) {
  const consent = await client.query(
    `SELECT 1 FROM product_measurement_consents
     WHERE token_hash = $1 AND last_seen_at > CURRENT_TIMESTAMP - INTERVAL '180 days'
     FOR UPDATE`,
    [tokenHash],
  );
  if (!consent.rowCount) return false;
  await client.query(
    `UPDATE product_measurement_consents SET last_seen_at = CURRENT_TIMESTAMP
     WHERE token_hash = $1`,
    [tokenHash],
  );
  return true;
}

async function publicTarget(
  client: PoolClient,
  surface: DiscoverySurface,
  id: string | null,
): Promise<TargetRow | null> {
  if (surface === "debate") {
    if (!id) return null;
    const result = await client.query<TargetRow>(
      `SELECT id AS "debateId", topic_id AS "topicId"
       FROM debates WHERE id = $1 AND publication_state = 'published' AND NOT is_demo`,
      [id],
    );
    return result.rows[0] ?? null;
  }
  if (surface === "topic") {
    if (!id) return null;
    const result = await client.query<TargetRow>(
      `SELECT NULL::uuid AS "debateId", id AS "topicId"
       FROM topics WHERE id = $1 AND publication_state = 'published' AND NOT is_demo`,
      [id],
    );
    return result.rows[0] ?? null;
  }
  if (id) return null;
  return { debateId: null, topicId: null };
}

export function createMeasurementRepository(pool: Pool) {
  return Object.freeze({
    async grant(tokenHash: string) {
      await pool.query(
        `INSERT INTO product_measurement_consents (token_hash) VALUES ($1)
         ON CONFLICT (token_hash) DO UPDATE SET last_seen_at = CURRENT_TIMESTAMP`,
        [tokenHash],
      );
    },

    async hasConsent(tokenHash: string) {
      const result = await pool.query(
        `SELECT 1 FROM product_measurement_consents
         WHERE token_hash = $1 AND last_seen_at > CURRENT_TIMESTAMP - INTERVAL '180 days'`,
        [tokenHash],
      );
      return Boolean(result.rowCount);
    },

    async withdraw(tokenHash: string) {
      const result = await pool.query(
        "DELETE FROM product_measurement_consents WHERE token_hash = $1",
        [tokenHash],
      );
      return result.rowCount ?? 0;
    },

    async recordDiscovery(
      tokenHash: string,
      userId: string | null,
      surface: DiscoverySurface,
      id: string | null,
    ) {
      return transaction(pool, async (client) => {
        if (!(await lockConsent(client, tokenHash))) return false;
        const target = await publicTarget(client, surface, id);
        if (!target) return false;
        // One view per browser, surface, and target per UTC day prevents refresh inflation.
        const duplicate = await client.query(
          `SELECT 1 FROM product_measurement_events
           WHERE token_hash = $1 AND event_type = 'discovery_view' AND surface = $2
             AND debate_id IS NOT DISTINCT FROM $3::uuid
             AND topic_id IS NOT DISTINCT FROM $4::uuid
             AND occurred_at >= date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
           LIMIT 1`,
          [tokenHash, surface, target.debateId, target.topicId],
        );
        if (duplicate.rowCount) return true;
        await client.query(
          `INSERT INTO product_measurement_events
           (token_hash, user_id, event_type, surface, debate_id, topic_id)
           VALUES ($1, $2, 'discovery_view', $3, $4, $5)`,
          [tokenHash, userId, surface, target.debateId, target.topicId],
        );
        if (target.debateId || target.topicId) {
          await client.query(
            `INSERT INTO product_measurement_events
             (token_hash, user_id, event_type, surface, debate_id, topic_id)
             SELECT $1, $2, 'return_visit', $3, $4, $5
             WHERE EXISTS (
               SELECT 1 FROM product_measurement_events prior
               WHERE prior.token_hash = $1 AND prior.user_id IS NOT DISTINCT FROM $2::bigint
                 AND prior.event_type = 'discovery_view'
                 AND prior.occurred_at < date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                 AND prior.occurred_at >= CURRENT_TIMESTAMP - INTERVAL '28 days'
                 AND (
                   ($4::uuid IS NOT NULL AND prior.debate_id IS NOT NULL AND prior.debate_id <> $4::uuid)
                   OR ($5::uuid IS NOT NULL AND prior.topic_id IS NOT NULL AND prior.topic_id <> $5::uuid)
                 )
             ) ON CONFLICT DO NOTHING`,
            [tokenHash, userId, surface, target.debateId, target.topicId],
          );
        }
        return true;
      });
    },

    async recordAction(
      tokenHash: string,
      userId: string,
      action: ProductAction,
    ) {
      return transaction(pool, async (client) => {
        if (!(await lockConsent(client, tokenHash))) return false;
        let target:
          | (TargetRow & {
              requestId?: string;
              caseId?: string;
              profileId?: string;
            })
          | null;
        if (action.type === "match_requested") {
          const result = await client.query<TargetRow & { requestId: string }>(
            `SELECT r.id AS "requestId", NULL::uuid AS "debateId", r.topic_id AS "topicId"
             FROM match_requests r JOIN topics t ON t.id = r.topic_id
             WHERE r.id = $1 AND r.initiator_user_id = $2 AND NOT t.is_demo`,
            [action.requestId, userId],
          );
          target = result.rows[0] ?? null;
        } else if (action.type === "match_accepted") {
          const result = await client.query<TargetRow>(
            `SELECT d.id AS "debateId", d.topic_id AS "topicId"
             FROM debates d JOIN event_participants p ON p.debate_id = d.id
             WHERE d.id = $1 AND p.user_id = $2 AND NOT d.is_demo`,
            [action.debateId, userId],
          );
          target = result.rows[0] ?? null;
        } else if (action.type === "report_submitted") {
          const result = await client.query<TargetRow & { caseId: string }>(
            `SELECT c.id AS "caseId", c.debate_id AS "debateId", d.topic_id AS "topicId"
             FROM moderation_cases c JOIN debates d ON d.id = c.debate_id
             WHERE c.id = $1 AND c.reporter_user_id = $2 AND NOT d.is_demo`,
            [action.caseId, userId],
          );
          target = result.rows[0] ?? null;
        } else if (action.targetType === "topic") {
          const result = await client.query<TargetRow>(
            `SELECT NULL::uuid AS "debateId", t.id AS "topicId"
             FROM follows f JOIN topics t ON t.id = f.topic_id
             WHERE f.user_id = $1 AND t.slug = $2 AND NOT t.is_demo`,
            [userId, action.slug],
          );
          target = result.rows[0] ?? null;
        } else {
          const result = await client.query<TargetRow & { profileId: string }>(
            `SELECT NULL::uuid AS "debateId", NULL::uuid AS "topicId",
               p.id AS "profileId"
             FROM follows f JOIN public_profiles p ON p.id = f.profile_id
             WHERE f.user_id = $1 AND p.handle = $2 AND NOT p.is_demo`,
            [userId, action.slug],
          );
          target = result.rows[0] ?? null;
        }
        if (!target) return false;
        await client.query(
          `INSERT INTO product_measurement_events
           (token_hash, user_id, event_type, debate_id, topic_id, request_id, case_id, profile_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            tokenHash,
            userId,
            action.type,
            target.debateId,
            target.topicId,
            target.requestId ?? null,
            target.caseId ?? null,
            target.profileId ?? null,
          ],
        );
        return true;
      });
    },

    async startWatch(
      tokenHash: string,
      userId: string | null,
      id: string,
      debateId: string,
      mode: WatchMode,
    ) {
      return transaction(pool, async (client) => {
        if (!(await lockConsent(client, tokenHash))) return false;
        const result = await client.query(
          `INSERT INTO product_measurement_watch_sessions
           (id, token_hash, user_id, debate_id, mode)
           SELECT $1::uuid, $2::char(64), $3::bigint, d.id, $5::varchar(8) FROM debates d
           LEFT JOIN debate_media m ON m.debate_id = d.id
           WHERE d.id = $4 AND d.publication_state = 'published' AND NOT d.is_demo
             AND (($5::varchar(8) = 'live' AND d.status = 'live')
               OR ($5::varchar(8) = 'replay' AND d.status = 'replay' AND m.recording_status = 'ready'))
           ON CONFLICT (id) DO NOTHING RETURNING id`,
          [id, tokenHash, userId, debateId, mode],
        );
        if (!result.rowCount) return false;
        if (mode === "replay") {
          await client.query(
            `INSERT INTO product_measurement_events
             (token_hash, user_id, event_type, debate_id, topic_id)
             SELECT $1, $2, 'replay_started', d.id, d.topic_id
             FROM debates d WHERE d.id = $3`,
            [tokenHash, userId, debateId],
          );
        }
        return true;
      });
    },

    async progressWatch(tokenHash: string, id: string, end = false) {
      return transaction(pool, async (client) => {
        if (!(await lockConsent(client, tokenHash))) return false;
        const result = await client.query(
          `UPDATE product_measurement_watch_sessions SET
             watched_seconds = LEAST(14400, watched_seconds + LEAST(30,
               GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - last_seen_at)))::integer))),
             last_seen_at = CURRENT_TIMESTAMP,
             ended_at = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE ended_at END
           WHERE id = $1 AND token_hash = $2 AND ended_at IS NULL
             AND started_at > CURRENT_TIMESTAMP - INTERVAL '4 hours'
           RETURNING id`,
          [id, tokenHash, end],
        );
        return Boolean(result.rowCount);
      });
    },

    async summary() {
      const [events, watch] = await Promise.all([
        pool.query<SummaryRow>(
          `WITH completion_affiliation AS (
             SELECT p.debate_id,
               CASE WHEN bool_or(a.affiliation = 'founder') THEN 'founder'
                 WHEN count(*) = 2 AND bool_and(a.affiliation = 'independent') THEN 'independent'
                 ELSE 'unclassified' END AS affiliation
             FROM event_participants p
             LEFT JOIN product_measurement_affiliations a ON a.user_id = p.user_id
             GROUP BY p.debate_id
           )
           SELECT e.event_type AS "eventType",
             CASE WHEN e.event_type = 'debate_completed'
               THEN COALESCE(c.affiliation, 'unclassified')
               ELSE COALESCE(a.affiliation, 'unclassified') END AS affiliation,
             count(*)::text AS count
           FROM product_measurement_events e
           LEFT JOIN product_measurement_affiliations a ON a.user_id = e.user_id
           LEFT JOIN completion_affiliation c ON c.debate_id = e.debate_id
           WHERE e.occurred_at >= CURRENT_TIMESTAMP - INTERVAL '28 days'
           GROUP BY 1, 2 ORDER BY 1, 2`,
        ),
        pool.query<WatchSummaryRow>(
          `SELECT w.mode, COALESCE(a.affiliation, 'unclassified') AS affiliation,
             count(*)::text AS sessions,
             COALESCE(sum(w.watched_seconds), 0)::text AS "watchedSeconds"
           FROM product_measurement_watch_sessions w
           LEFT JOIN product_measurement_affiliations a ON a.user_id = w.user_id
           WHERE w.started_at >= CURRENT_TIMESTAMP - INTERVAL '28 days'
           GROUP BY 1, 2 ORDER BY 1, 2`,
        ),
      ]);
      return {
        windowDays: 28,
        events: events.rows.map((row) => ({
          eventType: row.eventType,
          affiliation: row.affiliation,
          count: Number(row.count),
        })),
        watch: watch.rows.map((row) => ({
          mode: row.mode,
          affiliation: row.affiliation,
          sessions: Number(row.sessions),
          watchedSeconds: Number(row.watchedSeconds),
        })),
      };
    },

    async listAffiliations() {
      const result = await pool.query<AffiliationRow>(
        `SELECT p.handle, a.affiliation, a.reason, a.updated_at AS "updatedAt"
         FROM product_measurement_affiliations a
         JOIN public_profiles p ON p.user_id = a.user_id
         ORDER BY a.updated_at DESC, p.handle LIMIT 100`,
      );
      return result.rows;
    },

    async setAffiliation(
      handle: string,
      affiliation: Affiliation,
      reason: string,
      reviewerUserId: string,
    ) {
      return transaction(pool, async (client) => {
        const profile = await client.query<{ userId: string }>(
          `SELECT user_id AS "userId" FROM public_profiles
           WHERE handle = $1 AND user_id IS NOT NULL AND NOT is_demo FOR UPDATE`,
          [handle],
        );
        const userId = profile.rows[0]?.userId;
        if (!userId) return false;
        const previous = await client.query<{ affiliation: string }>(
          `SELECT affiliation FROM product_measurement_affiliations
           WHERE user_id = $1 FOR UPDATE`,
          [userId],
        );
        if (affiliation === "unclassified") {
          await client.query(
            "DELETE FROM product_measurement_affiliations WHERE user_id = $1",
            [userId],
          );
        } else {
          await client.query(
            `INSERT INTO product_measurement_affiliations
             (user_id, affiliation, reason, reviewed_by) VALUES ($1, $2, $3, $4)
             ON CONFLICT (user_id) DO UPDATE SET affiliation = EXCLUDED.affiliation,
               reason = EXCLUDED.reason, reviewed_by = EXCLUDED.reviewed_by,
               updated_at = CURRENT_TIMESTAMP`,
            [userId, affiliation, reason, reviewerUserId],
          );
        }
        await client.query(
          `INSERT INTO product_measurement_affiliation_audit
           (user_id, previous_affiliation, affiliation, reason, reviewed_by)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            userId,
            previous.rows[0]?.affiliation ?? null,
            affiliation,
            reason,
            reviewerUserId,
          ],
        );
        return true;
      });
    },

    async pruneExpired() {
      const events = await pool.query(
        `DELETE FROM product_measurement_events
         WHERE occurred_at < CURRENT_TIMESTAMP - INTERVAL '90 days'`,
      );
      const watch = await pool.query(
        `DELETE FROM product_measurement_watch_sessions
         WHERE started_at < CURRENT_TIMESTAMP - INTERVAL '90 days'`,
      );
      const consents = await pool.query(
        `DELETE FROM product_measurement_consents
         WHERE last_seen_at < CURRENT_TIMESTAMP - INTERVAL '180 days'`,
      );
      const audit = await pool.query(
        `DELETE FROM product_measurement_affiliation_audit
         WHERE occurred_at < CURRENT_TIMESTAMP - INTERVAL '365 days'`,
      );
      return {
        events: events.rowCount ?? 0,
        watch: watch.rowCount ?? 0,
        consents: consents.rowCount ?? 0,
        audit: audit.rowCount ?? 0,
      };
    },
  });
}
