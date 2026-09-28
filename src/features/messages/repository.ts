import type { Pool } from "pg";

export interface Message {
  id: string;
  name: string;
  message: string;
  createdAt: Date;
}

export function createMessageRepository(database: Pool) {
  return Object.freeze({
    async create(
      userId: string,
      name: string,
      message: string,
    ): Promise<Message> {
      const result = await database.query<Message>(
        `INSERT INTO messages (user_id, name, message)
         VALUES ($1, $2, $3)
         RETURNING id, name, message, created_at AS "createdAt"`,
        [userId, name, message],
      );

      if (!result.rows[0]) throw new Error("created message was not returned");
      return result.rows[0];
    },

    async isReady() {
      await database.query("SELECT 1");
    },

    async list({
      userId,
      limit,
      offset,
    }: {
      userId: string;
      limit: number;
      offset: number;
    }): Promise<Message[]> {
      const result = await database.query<Message>(
        `SELECT id, name, message, created_at AS "createdAt"
         FROM messages
         WHERE user_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset],
      );

      return result.rows;
    },
  });
}
