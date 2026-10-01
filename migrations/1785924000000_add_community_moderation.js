export const shorthands = undefined;

export const up = (pgm) => {
  pgm.createTable("event_chat_controls", {
    debate_id: {
      type: "uuid",
      primaryKey: true,
      references: "debates",
      onDelete: "CASCADE",
    },
    state: { type: "varchar(12)", notNull: true, default: "open" },
    pause_case_id: { type: "uuid" },
    updated_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });
  pgm.addConstraint("event_chat_controls", "event_chat_controls_state", {
    check: "state IN ('open', 'paused')",
  });

  pgm.createTable("event_chat_messages", {
    id: { type: "bigserial", primaryKey: true },
    debate_id: {
      type: "uuid",
      notNull: true,
      references: "debates",
      onDelete: "RESTRICT",
    },
    author_user_id: {
      type: "bigint",
      notNull: true,
      references: "users",
      onDelete: "RESTRICT",
    },
    body: { type: "varchar(500)", notNull: true },
    state: { type: "varchar(12)", notNull: true, default: "visible" },
    removal_case_id: { type: "uuid" },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });
  pgm.addConstraint("event_chat_messages", "event_chat_messages_state", {
    check: "state IN ('visible', 'removed')",
  });
  pgm.createIndex("event_chat_messages", ["debate_id", "id"], {
    where: "state = 'visible'",
  });
  pgm.createIndex("event_chat_messages", ["author_user_id", "created_at"]);

  pgm.createTable("event_likes", {
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
      onDelete: "CASCADE",
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });
  pgm.addConstraint("event_likes", "event_likes_pkey", {
    primaryKey: ["debate_id", "user_id"],
  });
  pgm.createIndex("event_likes", ["user_id", "created_at"]);

  pgm.createTable("moderation_cases", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    reporter_user_id: {
      type: "bigint",
      notNull: true,
      references: "users",
      onDelete: "RESTRICT",
    },
    debate_id: {
      type: "uuid",
      notNull: true,
      references: "debates",
      onDelete: "RESTRICT",
    },
    target_type: { type: "varchar(12)", notNull: true },
    target_chat_id: {
      type: "bigint",
      references: "event_chat_messages",
      onDelete: "RESTRICT",
    },
    reason_code: { type: "varchar(20)", notNull: true },
    detail: { type: "varchar(500)", notNull: true },
    status: { type: "varchar(12)", notNull: true, default: "open" },
    action: { type: "varchar(24)" },
    reviewer_user_id: {
      type: "bigint",
      references: "users",
      onDelete: "RESTRICT",
    },
    decision_reason: { type: "varchar(20)" },
    decision_note: { type: "varchar(500)" },
    decided_at: { type: "timestamptz" },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });
  pgm.addConstraint("moderation_cases", "moderation_cases_target", {
    check:
      "(target_type = 'event' AND target_chat_id IS NULL) OR (target_type = 'chat' AND target_chat_id IS NOT NULL)",
  });
  pgm.addConstraint("moderation_cases", "moderation_cases_reason", {
    check:
      "reason_code IN ('harassment', 'hate', 'threat', 'spam', 'privacy', 'other') AND (decision_reason IS NULL OR decision_reason IN ('harassment', 'hate', 'threat', 'spam', 'privacy', 'other'))",
  });
  pgm.addConstraint("moderation_cases", "moderation_cases_status", {
    check: "status IN ('open', 'dismissed', 'actioned')",
  });
  pgm.addConstraint("moderation_cases", "moderation_cases_action", {
    check:
      "action IS NULL OR action IN ('dismiss', 'remove_chat', 'restrict_account', 'pause_chat')",
  });
  pgm.sql(
    "CREATE UNIQUE INDEX moderation_cases_one_chat_report ON moderation_cases (reporter_user_id, target_chat_id) WHERE target_type = 'chat'",
  );
  pgm.sql(
    "CREATE UNIQUE INDEX moderation_cases_one_event_report ON moderation_cases (reporter_user_id, debate_id) WHERE target_type = 'event'",
  );
  pgm.createIndex("moderation_cases", ["status", "created_at", "id"]);
  pgm.createIndex("moderation_cases", ["reporter_user_id", "created_at"]);

  pgm.createTable("community_restrictions", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    user_id: {
      type: "bigint",
      notNull: true,
      references: "users",
      onDelete: "RESTRICT",
    },
    case_id: {
      type: "uuid",
      notNull: true,
      unique: true,
      references: "moderation_cases",
      onDelete: "CASCADE",
    },
    expires_at: { type: "timestamptz", notNull: true },
    revoked_at: { type: "timestamptz" },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });
  pgm.createIndex("community_restrictions", ["user_id", "expires_at"], {
    where: "revoked_at IS NULL",
  });

  pgm.createTable("moderation_appeals", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    case_id: {
      type: "uuid",
      notNull: true,
      unique: true,
      references: "moderation_cases",
      onDelete: "CASCADE",
    },
    appellant_user_id: {
      type: "bigint",
      notNull: true,
      references: "users",
      onDelete: "RESTRICT",
    },
    reason: { type: "varchar(500)", notNull: true },
    status: { type: "varchar(12)", notNull: true, default: "open" },
    reviewer_user_id: {
      type: "bigint",
      references: "users",
      onDelete: "RESTRICT",
    },
    decision_note: { type: "varchar(500)" },
    decided_at: { type: "timestamptz" },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });
  pgm.addConstraint("moderation_appeals", "moderation_appeals_status", {
    check: "status IN ('open', 'upheld', 'overturned')",
  });
  pgm.createIndex("moderation_appeals", ["status", "created_at", "id"]);

  pgm.createTable("community_audit_events", {
    id: { type: "bigserial", primaryKey: true },
    case_id: {
      type: "uuid",
      notNull: true,
      references: "moderation_cases",
      onDelete: "CASCADE",
    },
    appeal_id: {
      type: "uuid",
      references: "moderation_appeals",
      onDelete: "CASCADE",
    },
    actor_user_id: {
      type: "bigint",
      notNull: true,
      references: "users",
      onDelete: "RESTRICT",
    },
    action: { type: "varchar(32)", notNull: true },
    note: { type: "varchar(500)" },
    occurred_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });
  pgm.createIndex("community_audit_events", ["case_id", "occurred_at", "id"]);

  for (const table of [
    "event_chat_controls",
    "event_chat_messages",
    "event_likes",
    "moderation_cases",
    "community_restrictions",
    "moderation_appeals",
    "community_audit_events",
  ])
    pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
};

export const down = (pgm) => {
  pgm.dropTable("community_audit_events");
  pgm.dropTable("moderation_appeals");
  pgm.dropTable("community_restrictions");
  pgm.dropTable("moderation_cases");
  pgm.dropTable("event_likes");
  pgm.dropTable("event_chat_messages");
  pgm.dropTable("event_chat_controls");
};
