import type { Pool } from "pg";

export interface PublicUser {
  id: string;
  email: string;
  createdAt: Date;
}

export interface StoredUser extends PublicUser {
  passwordHash: string;
}

export function createUserRepository(database: Pool) {
  return Object.freeze({
    async create(email: string, passwordHash: string): Promise<PublicUser> {
      const result = await database.query<PublicUser>(
        `INSERT INTO users (email, password_hash)
         VALUES ($1, $2)
         RETURNING id, email, created_at AS "createdAt"`,
        [email, passwordHash],
      );

      if (!result.rows[0]) throw new Error("created user was not returned");
      return result.rows[0];
    },

    async findByEmail(email: string): Promise<StoredUser | null> {
      const result = await database.query<StoredUser>(
        `SELECT id, email, password_hash AS "passwordHash",
                created_at AS "createdAt"
         FROM users
         WHERE email = $1`,
        [email],
      );

      return result.rows[0] ?? null;
    },
  });
}
