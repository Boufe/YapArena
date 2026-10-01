export const shorthands = undefined;

export const up = (pgm) => {
  pgm.createTable("event_like_changes", {
    id: { type: "bigserial", primaryKey: true },
    debate_id: {
      type: "uuid",
      notNull: true,
      references: "debates",
      onDelete: "RESTRICT",
    },
    user_id: {
      type: "bigint",
      notNull: true,
      references: "users",
      onDelete: "RESTRICT",
    },
    action: { type: "varchar(8)", notNull: true },
    changed_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });
  pgm.addConstraint("event_like_changes", "event_like_changes_action", {
    check: "action IN ('like', 'unlike')",
  });
  pgm.createIndex("event_like_changes", ["user_id", "changed_at"]);
  pgm.createIndex("event_like_changes", ["debate_id", "changed_at"]);
  pgm.sql("ALTER TABLE event_like_changes ENABLE ROW LEVEL SECURITY");
};

export const down = (pgm) => {
  pgm.dropTable("event_like_changes");
};
