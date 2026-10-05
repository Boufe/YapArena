import type { Pool } from "pg";

export interface PublicUser {
  id: string;
  email: string | null;
  createdAt: Date;
}

export interface StoredUser extends PublicUser {
  passwordHash: string | null;
  authGeneration: string;
}

export interface AuthenticationUser extends PublicUser {
  authGeneration: string;
}

export function publicUser(user: PublicUser): PublicUser {
  return { id: user.id, email: user.email, createdAt: user.createdAt };
}

export function createUserRepository(database: Pool) {
  return Object.freeze({
    async create(
      email: string,
      passwordHash: string,
    ): Promise<AuthenticationUser> {
      const result = await database.query<AuthenticationUser>(
        `INSERT INTO users (email, password_hash)
         VALUES ($1, $2)
         RETURNING id, email, created_at AS "createdAt", auth_generation AS "authGeneration"`,
        [email, passwordHash],
      );

      if (!result.rows[0]) throw new Error("created user was not returned");
      return result.rows[0];
    },

    async findByEmail(email: string): Promise<StoredUser | null> {
      const result = await database.query<StoredUser>(
        `SELECT id, email, password_hash AS "passwordHash",
                created_at AS "createdAt", auth_generation AS "authGeneration"
         FROM users
         WHERE email = $1`,
        [email],
      );

      return result.rows[0] ?? null;
    },
  });
}
