import type { Pool } from "pg";

export type DebateStatus =
  | "draft"
  | "accepted"
  | "scheduled"
  | "ready"
  | "live"
  | "ended"
  | "replay"
  | "void_review"
  | "finalized"
  | "cancelled";

export interface PublicTopic {
  id: string;
  slug: string;
  title: string;
  summary: string;
  sideALabel: string;
  sideBLabel: string;
  isDemo: boolean;
  createdAt: Date;
}

export interface PublicProfile {
  id: string;
  handle: string;
  displayName: string;
  bio: string | null;
  isDemo: boolean;
}

export interface PublicDebate {
  id: string;
  slug: string;
  proposition: string;
  status: DebateStatus;
  rulesVersion: string;
  scheduledAt: Date | null;
  liveStartedAt: Date | null;
  liveEndedAt: Date | null;
  isDemo: boolean;
  createdAt: Date;
  topic: Pick<PublicTopic, "slug" | "title" | "sideALabel" | "sideBLabel">;
  speakerA: Pick<PublicProfile, "handle" | "displayName"> | null;
  speakerB: Pick<PublicProfile, "handle" | "displayName"> | null;
  sponsor: { name: string; disclosure: string } | null;
}

export interface PublicList<T> {
  items: T[];
  pagination: { limit: number; offset: number; hasMore: boolean };
}

type TopicRow = PublicTopic;
type ProfileRow = PublicProfile;
interface DebateRow extends Omit<
  PublicDebate,
  "topic" | "speakerA" | "speakerB" | "sponsor"
> {
  topicSlug: string;
  topicTitle: string;
  sideALabel: string;
  sideBLabel: string;
  speakerAHandle: string | null;
  speakerADisplayName: string | null;
  speakerBHandle: string | null;
  speakerBDisplayName: string | null;
  sponsorName: string | null;
  sponsorDisclosure: string | null;
}

function page<T>(rows: T[], limit: number, offset: number): PublicList<T> {
  return {
    items: rows.slice(0, limit),
    pagination: { limit, offset, hasMore: rows.length > limit },
  };
}

function mapDebate(row: DebateRow): PublicDebate {
  return {
    id: row.id,
    slug: row.slug,
    proposition: row.proposition,
    status: row.status,
    rulesVersion: row.rulesVersion,
    scheduledAt: row.scheduledAt,
    liveStartedAt: row.liveStartedAt,
    liveEndedAt: row.liveEndedAt,
    isDemo: row.isDemo,
    createdAt: row.createdAt,
    topic: {
      slug: row.topicSlug,
      title: row.topicTitle,
      sideALabel: row.sideALabel,
      sideBLabel: row.sideBLabel,
    },
    speakerA:
      row.speakerAHandle && row.speakerADisplayName
        ? { handle: row.speakerAHandle, displayName: row.speakerADisplayName }
        : null,
    speakerB:
      row.speakerBHandle && row.speakerBDisplayName
        ? { handle: row.speakerBHandle, displayName: row.speakerBDisplayName }
        : null,
    sponsor:
      row.sponsorName && row.sponsorDisclosure
        ? { name: row.sponsorName, disclosure: row.sponsorDisclosure }
        : null,
  };
}

const topicColumns = `id, slug, title, summary,
  side_a_label AS "sideALabel", side_b_label AS "sideBLabel",
  is_demo AS "isDemo", created_at AS "createdAt"`;

const debateColumns = `d.id, d.slug, d.proposition, d.status,
  d.rules_version AS "rulesVersion", d.scheduled_at AS "scheduledAt",
  d.live_started_at AS "liveStartedAt", d.live_ended_at AS "liveEndedAt",
  d.is_demo AS "isDemo", d.created_at AS "createdAt",
  t.slug AS "topicSlug", t.title AS "topicTitle",
  t.side_a_label AS "sideALabel", t.side_b_label AS "sideBLabel",
  pa.handle AS "speakerAHandle", pa.display_name AS "speakerADisplayName",
  pb.handle AS "speakerBHandle", pb.display_name AS "speakerBDisplayName",
  s.name AS "sponsorName", s.disclosure AS "sponsorDisclosure"`;

const debateJoins = `FROM debates d
  INNER JOIN topics t ON t.id = d.topic_id AND t.publication_state = 'published'
  LEFT JOIN public_profiles pa ON pa.id = d.speaker_a_profile_id AND pa.publication_state = 'published'
  LEFT JOIN public_profiles pb ON pb.id = d.speaker_b_profile_id AND pb.publication_state = 'published'
  LEFT JOIN sponsors s ON s.id = d.sponsor_id`;

export function createDiscoveryRepository(database: Pool) {
  return Object.freeze({
    async listTopics({
      query = "",
      limit = 12,
      offset = 0,
    }: {
      query?: string;
      limit?: number;
      offset?: number;
    }): Promise<PublicList<PublicTopic>> {
      const result = await database.query<TopicRow>(
        `SELECT ${topicColumns}
         FROM topics
         WHERE publication_state = 'published'
           AND ($1 = '' OR to_tsvector('simple', title || ' ' || summary)
             @@ websearch_to_tsquery('simple', $1))
         ORDER BY created_at DESC, id DESC
         LIMIT $2 OFFSET $3`,
        [query, limit + 1, offset],
      );
      return page(result.rows, limit, offset);
    },

    async getTopic(slug: string): Promise<PublicTopic | null> {
      const result = await database.query<TopicRow>(
        `SELECT ${topicColumns}
         FROM topics WHERE slug = $1 AND publication_state = 'published'`,
        [slug],
      );
      return result.rows[0] ?? null;
    },

    async getProfile(handle: string): Promise<PublicProfile | null> {
      const result = await database.query<ProfileRow>(
        `SELECT id, handle, display_name AS "displayName", bio,
                is_demo AS "isDemo"
         FROM public_profiles
         WHERE handle = $1 AND publication_state = 'published'`,
        [handle],
      );
      return result.rows[0] ?? null;
    },

    async listDebates({
      query = "",
      status,
      topicSlug,
      profileHandle,
      limit = 12,
      offset = 0,
    }: {
      query?: string;
      status?: DebateStatus;
      topicSlug?: string;
      profileHandle?: string;
      limit?: number;
      offset?: number;
    }): Promise<PublicList<PublicDebate>> {
      const result = await database.query<DebateRow>(
        `SELECT ${debateColumns}
         ${debateJoins}
         WHERE d.publication_state = 'published'
           AND ($1 = '' OR to_tsvector('simple', d.proposition)
             @@ websearch_to_tsquery('simple', $1)
             OR to_tsvector('simple', t.title || ' ' || t.summary)
             @@ websearch_to_tsquery('simple', $1))
           AND ($2::text IS NULL OR d.status = $2)
           AND ($3::text IS NULL OR t.slug = $3)
           AND ($4::text IS NULL OR pa.handle = $4 OR pb.handle = $4)
         ORDER BY CASE d.status
           WHEN 'live' THEN 0 WHEN 'scheduled' THEN 1
           WHEN 'replay' THEN 2 WHEN 'finalized' THEN 3 ELSE 4 END,
           CASE WHEN d.status = 'scheduled' THEN d.scheduled_at END ASC NULLS LAST,
           d.created_at DESC, d.id DESC
         LIMIT $5 OFFSET $6`,
        [
          query,
          status ?? null,
          topicSlug ?? null,
          profileHandle ?? null,
          limit + 1,
          offset,
        ],
      );
      const mapped = result.rows.map(mapDebate);
      return page(mapped, limit, offset);
    },

    async getDebate(slug: string): Promise<PublicDebate | null> {
      const result = await database.query<DebateRow>(
        `SELECT ${debateColumns}
         ${debateJoins}
         WHERE d.slug = $1 AND d.publication_state = 'published'`,
        [slug],
      );
      return result.rows[0] ? mapDebate(result.rows[0]) : null;
    },
  });
}
