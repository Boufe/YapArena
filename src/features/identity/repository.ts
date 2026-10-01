import type { Pool } from "pg";

export interface OwnedProfile {
  id: string;
  handle: string;
  displayName: string;
  bio: string | null;
  publicationState: "draft" | "published" | "hidden";
  createdAt: Date;
  updatedAt: Date;
}

export interface FollowItem {
  id: string;
  targetType: "topic" | "profile";
  slug: string;
  title: string;
  createdAt: Date;
}

export interface ActivityItem {
  id: string;
  eventType: string;
  occurredAt: Date;
}

function page<T>(rows: T[], limit: number, offset: number) {
  return {
    items: rows.slice(0, limit),
    pagination: { limit, offset, hasMore: rows.length > limit },
  };
}

const profileFields = `id, handle, display_name AS "displayName", bio,
  publication_state AS "publicationState", created_at AS "createdAt",
  updated_at AS "updatedAt"`;

export function createIdentityRepository(database: Pool) {
  return Object.freeze({
    async getProfile(userId: string): Promise<OwnedProfile | null> {
      const result = await database.query<OwnedProfile>(
        `SELECT ${profileFields} FROM public_profiles WHERE user_id = $1`,
        [userId],
      );
      return result.rows[0] ?? null;
    },

    async createProfile(
      userId: string,
      handle: string,
      displayName: string,
      bio: string | null,
    ) {
      const result = await database.query<OwnedProfile>(
        `INSERT INTO public_profiles (user_id, handle, display_name, bio)
         VALUES ($1, $2, $3, $4) RETURNING ${profileFields}`,
        [userId, handle, displayName, bio],
      );
      if (!result.rows[0]) throw new Error("created profile was not returned");
      return result.rows[0];
    },

    async updateProfile(
      userId: string,
      changes: {
        displayName?: string;
        bio?: string | null;
        publicationState?: "draft" | "published";
      },
    ): Promise<OwnedProfile | null> {
      const result = await database.query<OwnedProfile>(
        `UPDATE public_profiles SET
           display_name = CASE WHEN $2 THEN $3 ELSE display_name END,
           bio = CASE WHEN $4 THEN $5 ELSE bio END,
           publication_state = CASE WHEN $6 THEN $7 ELSE publication_state END,
           updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1 AND publication_state <> 'hidden' AND is_demo = false
         RETURNING ${profileFields}`,
        [
          userId,
          "displayName" in changes,
          changes.displayName ?? null,
          "bio" in changes,
          changes.bio ?? null,
          "publicationState" in changes,
          changes.publicationState ?? null,
        ],
      );
      return result.rows[0] ?? null;
    },

    async getRoles(userId: string): Promise<string[]> {
      const result = await database.query<{ role: string }>(
        "SELECT role FROM account_roles WHERE user_id = $1 ORDER BY role",
        [userId],
      );
      return result.rows.map((row) => row.role);
    },

    async follow(
      userId: string,
      type: "topic" | "profile",
      slug: string,
    ): Promise<"created" | "exists" | "missing" | "self"> {
      const targetTable = type === "topic" ? "topics" : "public_profiles";
      const targetColumn = type === "topic" ? "topic_id" : "profile_id";
      const identifier = type === "topic" ? "slug" : "handle";
      const selfCheck =
        type === "profile" ? "AND (user_id IS NULL OR user_id <> $1)" : "";
      const ownerSelect =
        type === "profile" ? "user_id" : "NULL::bigint AS user_id";
      const result = await database.query<{
        result: "created" | "exists" | "missing" | "self";
      }>(
        `WITH visible AS (
           SELECT id FROM ${targetTable}
           WHERE ${identifier} = $2 AND publication_state = 'published' ${selfCheck}
         ), target AS (
           SELECT id, ${ownerSelect} FROM ${targetTable} WHERE ${identifier} = $2
         ), inserted AS (
           INSERT INTO follows (user_id, ${targetColumn})
           SELECT $1, id FROM visible ON CONFLICT DO NOTHING RETURNING id
         )
         SELECT CASE
           WHEN EXISTS (SELECT 1 FROM inserted) THEN 'created'
           WHEN EXISTS (SELECT 1 FROM visible) THEN 'exists'
           WHEN $3 = 'profile' AND EXISTS (SELECT 1 FROM target WHERE user_id = $1) THEN 'self'
           ELSE 'missing' END AS result`,
        [userId, slug, type],
      );
      return result.rows[0]?.result ?? "missing";
    },

    async unfollow(
      userId: string,
      type: "topic" | "profile",
      slug: string,
    ): Promise<void> {
      const targetTable = type === "topic" ? "topics" : "public_profiles";
      const targetColumn = type === "topic" ? "topic_id" : "profile_id";
      const identifier = type === "topic" ? "slug" : "handle";
      await database.query(
        `DELETE FROM follows f USING ${targetTable} target
         WHERE f.user_id = $1 AND f.${targetColumn} = target.id AND target.${identifier} = $2`,
        [userId, slug],
      );
    },

    async isFollowing(
      userId: string,
      type: "topic" | "profile",
      slug: string,
    ): Promise<boolean> {
      const targetTable = type === "topic" ? "topics" : "public_profiles";
      const targetColumn = type === "topic" ? "topic_id" : "profile_id";
      const identifier = type === "topic" ? "slug" : "handle";
      const result = await database.query<{ following: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM follows f JOIN ${targetTable} target
             ON target.id = f.${targetColumn}
           WHERE f.user_id = $1 AND target.${identifier} = $2
             AND target.publication_state = 'published'
         ) AS following`,
        [userId, slug],
      );
      return result.rows[0]?.following ?? false;
    },

    async listFollows(userId: string, limit: number, offset: number) {
      const result = await database.query<FollowItem>(
        `SELECT f.id, 'topic' AS "targetType", t.slug, t.title, f.created_at AS "createdAt"
         FROM follows f JOIN topics t ON t.id = f.topic_id AND t.publication_state = 'published'
         WHERE f.user_id = $1
         UNION ALL
         SELECT f.id, 'profile' AS "targetType", p.handle AS slug,
           p.display_name AS title, f.created_at AS "createdAt"
         FROM follows f JOIN public_profiles p ON p.id = f.profile_id
           AND p.publication_state = 'published'
         WHERE f.user_id = $1
         ORDER BY "createdAt" DESC, id DESC LIMIT $2 OFFSET $3`,
        [userId, limit + 1, offset],
      );
      return page(result.rows, limit, offset);
    },

    async listActivity(userId: string, limit: number, offset: number) {
      const result = await database.query<ActivityItem>(
        `SELECT id, event_type AS "eventType", occurred_at AS "occurredAt"
         FROM identity_audit_events WHERE user_id = $1
         ORDER BY occurred_at DESC, id DESC LIMIT $2 OFFSET $3`,
        [userId, limit + 1, offset],
      );
      return page(result.rows, limit, offset);
    },

    async deleteExpiredAudit() {
      const result = await database.query(
        "DELETE FROM identity_audit_events WHERE occurred_at < CURRENT_TIMESTAMP - INTERVAL '90 days'",
      );
      return result.rowCount ?? 0;
    },
  });
}
