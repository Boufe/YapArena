/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.createTable("users", {
    id: {
      type: "bigserial",
      primaryKey: true,
    },
    email: {
      type: "varchar(254)",
      notNull: true,
      unique: true,
    },
    password_hash: {
      type: "text",
      notNull: true,
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });

  pgm.createTable("sessions", {
    id: {
      type: "bigserial",
      primaryKey: true,
    },
    user_id: {
      type: "bigint",
      notNull: true,
      references: "users",
      onDelete: "CASCADE",
    },
    token_hash: {
      type: "char(64)",
      notNull: true,
      unique: true,
    },
    expires_at: {
      type: "timestamptz",
      notNull: true,
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });

  pgm.createIndex("sessions", "user_id");
  pgm.createIndex("sessions", "expires_at");

  pgm.addColumns("messages", {
    user_id: {
      type: "bigint",
      references: "users",
      onDelete: "CASCADE",
    },
  });
  pgm.sql(
    "CREATE INDEX messages_user_created_idx ON messages (user_id, created_at DESC, id DESC)",
  );
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.dropColumn("messages", "user_id");
  pgm.dropTable("sessions");
  pgm.dropTable("users");
};
