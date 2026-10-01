export const shorthands = undefined;

export const up = (pgm) => {
  pgm.addColumns("topics", {
    creator_user_id: {
      type: "bigint",
      references: "users",
      onDelete: "SET NULL",
    },
    updated_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });
  pgm.createIndex("topics", "creator_user_id");

  pgm.createTable("event_rule_versions", {
    version: { type: "varchar(40)", primaryKey: true },
    rules: { type: "jsonb", notNull: true },
    enabled: { type: "boolean", notNull: true, default: false },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });
  pgm.sql(`INSERT INTO event_rule_versions (version, rules, enabled) VALUES
    ('preview-1', '{"format":"two_speakers","initial_speaking_time_seconds":null,"extension_policy":"pending","maximum_duration_seconds":null,"financial_terms":"not_active"}', true)`);

  pgm.dropConstraint("debates", "debates_status");
  pgm.addConstraint("debates", "debates_status", {
    check:
      "status IN ('draft', 'accepted', 'scheduled', 'ready', 'live', 'ended', 'replay', 'void_review', 'finalized', 'cancelled')",
  });
  pgm.addColumns("debates", {
    rules_snapshot: { type: "jsonb" },
    ready_a_at: { type: "timestamptz" },
    ready_b_at: { type: "timestamptz" },
    ended_reason: { type: "varchar(40)" },
    updated_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });
  pgm.sql(`UPDATE debates SET rules_snapshot = r.rules
    FROM event_rule_versions r WHERE debates.rules_version = r.version`);
  pgm.alterColumn("debates", "rules_snapshot", { notNull: true });
  pgm.addConstraint("debates", "debates_rules_version_fk", {
    foreignKeys: {
      columns: "rules_version",
      references: "event_rule_versions(version)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("debates", "debates_live_timestamps_order", {
    check:
      "live_ended_at IS NULL OR (live_started_at IS NOT NULL AND live_ended_at >= live_started_at)",
  });

  pgm.createTable("match_requests", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    kind: { type: "varchar(12)", notNull: true },
    status: { type: "varchar(12)", notNull: true },
    initiator_user_id: {
      type: "bigint",
      notNull: true,
      references: "users",
      onDelete: "CASCADE",
    },
    target_user_id: {
      type: "bigint",
      references: "users",
      onDelete: "CASCADE",
    },
    topic_id: {
      type: "uuid",
      notNull: true,
      references: "topics",
      onDelete: "RESTRICT",
    },
    proposition: { type: "varchar(240)", notNull: true },
    requested_side: { type: "char(1)", notNull: true },
    scheduled_at: { type: "timestamptz", notNull: true },
    expires_at: { type: "timestamptz", notNull: true },
    debate_id: { type: "uuid", references: "debates", onDelete: "SET NULL" },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
    updated_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });
  pgm.addConstraint("match_requests", "match_requests_kind", {
    check: "kind IN ('direct', 'queue')",
  });
  pgm.addConstraint("match_requests", "match_requests_status", {
    check:
      "status IN ('open', 'accepted', 'declined', 'withdrawn', 'expired', 'conflicted')",
  });
  pgm.addConstraint("match_requests", "match_requests_side", {
    check: "requested_side IN ('A', 'B')",
  });
  pgm.addConstraint("match_requests", "match_requests_target", {
    check:
      "(kind = 'direct' AND target_user_id IS NOT NULL AND target_user_id <> initiator_user_id) OR (kind = 'queue' AND target_user_id IS NULL)",
  });
  pgm.addConstraint("match_requests", "match_requests_time", {
    check: "expires_at > created_at AND scheduled_at > created_at",
  });
  pgm.sql(
    "CREATE UNIQUE INDEX match_requests_one_open_outgoing ON match_requests (initiator_user_id) WHERE status = 'open'",
  );
  pgm.createIndex("match_requests", [
    "kind",
    "status",
    "topic_id",
    "scheduled_at",
    "requested_side",
    "created_at",
  ]);
  pgm.createIndex("match_requests", ["target_user_id", "status", "created_at"]);
  pgm.createIndex("match_requests", ["expires_at"]);

  pgm.createTable("event_participants", {
    debate_id: {
      type: "uuid",
      notNull: true,
      references: "debates",
      onDelete: "CASCADE",
    },
    user_id: {
      type: "bigint",
      notNull: true,
      references: "users",
      onDelete: "RESTRICT",
    },
    side: { type: "char(1)", notNull: true },
    active: { type: "boolean", notNull: true, default: true },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });
  pgm.addConstraint("event_participants", "event_participants_pkey", {
    primaryKey: ["debate_id", "user_id"],
  });
  pgm.addConstraint("event_participants", "event_participants_side", {
    check: "side IN ('A', 'B')",
  });
  pgm.addConstraint(
    "event_participants",
    "event_participants_debate_side_unique",
    { unique: ["debate_id", "side"] },
  );
  pgm.sql(
    "CREATE UNIQUE INDEX event_participants_one_active ON event_participants (user_id) WHERE active",
  );

  pgm.createTable("event_history", {
    id: { type: "bigserial", primaryKey: true },
    debate_id: { type: "uuid", references: "debates", onDelete: "CASCADE" },
    request_id: {
      type: "uuid",
      references: "match_requests",
      onDelete: "CASCADE",
    },
    actor_user_id: {
      type: "bigint",
      references: "users",
      onDelete: "SET NULL",
    },
    action: { type: "varchar(40)", notNull: true },
    from_status: { type: "varchar(20)" },
    to_status: { type: "varchar(20)", notNull: true },
    reason: { type: "varchar(500)" },
    occurred_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });
  pgm.addConstraint("event_history", "event_history_one_subject", {
    check: "(debate_id IS NOT NULL) <> (request_id IS NOT NULL)",
  });
  pgm.createIndex("event_history", ["debate_id", "occurred_at", "id"]);
  pgm.createIndex("event_history", ["request_id", "occurred_at", "id"]);

  pgm.createTable("account_notifications", {
    id: { type: "bigserial", primaryKey: true },
    user_id: {
      type: "bigint",
      notNull: true,
      references: "users",
      onDelete: "CASCADE",
    },
    event_type: { type: "varchar(40)", notNull: true },
    message: { type: "varchar(240)", notNull: true },
    debate_id: { type: "uuid", references: "debates", onDelete: "CASCADE" },
    request_id: {
      type: "uuid",
      references: "match_requests",
      onDelete: "CASCADE",
    },
    read_at: { type: "timestamptz" },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });
  pgm.createIndex("account_notifications", ["user_id", "created_at", "id"]);
};

export const down = (pgm) => {
  pgm.dropTable("account_notifications");
  pgm.dropTable("event_history");
  pgm.dropTable("event_participants");
  pgm.dropTable("match_requests");
  pgm.dropConstraint("debates", "debates_live_timestamps_order");
  pgm.dropConstraint("debates", "debates_rules_version_fk");
  pgm.dropColumns("debates", [
    "rules_snapshot",
    "ready_a_at",
    "ready_b_at",
    "ended_reason",
    "updated_at",
  ]);
  pgm.dropConstraint("debates", "debates_status");
  pgm.sql(
    "UPDATE debates SET status = 'scheduled' WHERE status NOT IN ('scheduled', 'live', 'replay', 'finalized', 'cancelled')",
  );
  pgm.addConstraint("debates", "debates_status", {
    check:
      "status IN ('scheduled', 'live', 'replay', 'finalized', 'cancelled')",
  });
  pgm.dropTable("event_rule_versions");
  pgm.dropColumn("topics", "creator_user_id");
  pgm.dropColumn("topics", "updated_at");
};
