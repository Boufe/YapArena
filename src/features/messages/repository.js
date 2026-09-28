export function createMessageRepository(database) {
  return Object.freeze({
    async create(userId, name, message) {
      const result = await database.query(
        `INSERT INTO messages (user_id, name, message)
         VALUES ($1, $2, $3)
         RETURNING id, name, message, created_at AS "createdAt"`,
        [userId, name, message],
      );

      return result.rows[0];
    },

    async isReady() {
      await database.query("SELECT 1");
    },

    async list({ userId, limit, offset }) {
      const result = await database.query(
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
