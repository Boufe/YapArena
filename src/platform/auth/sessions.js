export function createSessionRepository(database) {
  return Object.freeze({
    async create(userId, tokenHash, expiresAt) {
      const result = await database.query(
        `INSERT INTO sessions (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)
         RETURNING id, user_id AS "userId", expires_at AS "expiresAt",
                   created_at AS "createdAt"`,
        [userId, tokenHash, expiresAt],
      );

      return result.rows[0];
    },

    async findUserByTokenHash(tokenHash) {
      const result = await database.query(
        `SELECT users.id, users.email, users.created_at AS "createdAt"
         FROM sessions
         INNER JOIN users ON users.id = sessions.user_id
         WHERE sessions.token_hash = $1
           AND sessions.expires_at > CURRENT_TIMESTAMP`,
        [tokenHash],
      );

      return result.rows[0] ?? null;
    },

    async deleteByTokenHash(tokenHash) {
      const result = await database.query(
        `DELETE FROM sessions
         WHERE token_hash = $1
         RETURNING id`,
        [tokenHash],
      );

      return result.rowCount > 0;
    },

    async deleteExpired() {
      const result = await database.query(
        `DELETE FROM sessions
         WHERE expires_at <= CURRENT_TIMESTAMP`,
      );

      return result.rowCount;
    },
  });
}
