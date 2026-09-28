export function createUserRepository(database) {
  return Object.freeze({
    async create(email, passwordHash) {
      const result = await database.query(
        `INSERT INTO users (email, password_hash)
         VALUES ($1, $2)
         RETURNING id, email, created_at AS "createdAt"`,
        [email, passwordHash],
      );

      return result.rows[0];
    },

    async findByEmail(email) {
      const result = await database.query(
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
