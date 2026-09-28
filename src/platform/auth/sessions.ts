import type { Pool } from "pg";
import type { PublicUser } from "./users.ts";

interface StoredSession {
  id: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
}

export function createSessionRepository(database: Pool) {
  return Object.freeze({
    async create(
      userId: string,
      tokenHash: string,
      expiresAt: Date,
    ): Promise<StoredSession> {
      const result = await database.query<StoredSession>(
        `INSERT INTO sessions (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)
         RETURNING id, user_id AS "userId", expires_at AS "expiresAt",
                   created_at AS "createdAt"`,
        [userId, tokenHash, expiresAt],
      );

      if (!result.rows[0]) throw new Error("created session was not returned");
      return result.rows[0];
    },

    async findUserByTokenHash(tokenHash: string): Promise<PublicUser | null> {
      const result = await database.query<PublicUser>(
        `SELECT users.id, users.email, users.created_at AS "createdAt"
         FROM sessions
         INNER JOIN users ON users.id = sessions.user_id
         WHERE sessions.token_hash = $1
           AND sessions.expires_at > CURRENT_TIMESTAMP`,
        [tokenHash],
      );

      return result.rows[0] ?? null;
    },

    async deleteByTokenHash(tokenHash: string) {
      const result = await database.query(
        `DELETE FROM sessions
         WHERE token_hash = $1
         RETURNING id`,
        [tokenHash],
      );

      return (result.rowCount ?? 0) > 0;
    },

    async deleteExpired() {
      const result = await database.query(
        `DELETE FROM sessions
         WHERE expires_at <= CURRENT_TIMESTAMP`,
      );

      return result.rowCount ?? 0;
    },
  });
}
