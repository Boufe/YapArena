export const shorthands = undefined;

export const up = (pgm) => {
  // These timings are test parameters, not approved product economics or extension rules.
  pgm.sql(`UPDATE event_rule_versions SET enabled = false WHERE version = 'preview-1';
    INSERT INTO event_rule_versions (version, rules, enabled) VALUES
    ('prototype-media-1', '{"format":"two_speakers","initial_speaking_time_seconds":60,"extension_policy":"disabled_pending_product_approval","maximum_duration_seconds":600,"financial_terms":"not_active","prototype_only":true}', true)`);

  pgm.createTable("debate_media", {
    debate_id: {
      type: "uuid",
      primaryKey: true,
      references: "debates",
      onDelete: "CASCADE",
    },
    state: { type: "varchar(12)", notNull: true, default: "idle" },
    active_side: { type: "char(1)" },
    turn_number: { type: "integer", notNull: true, default: 0 },
    turn_deadline_at: { type: "timestamptz" },
    remaining_ms: { type: "integer" },
    active_ms: { type: "integer", notNull: true, default: 0 },
    last_resumed_at: { type: "timestamptz" },
    revision: { type: "integer", notNull: true, default: 0 },
    incident: { type: "varchar(500)" },
    egress_id: { type: "varchar(100)" },
    recording_status: {
      type: "varchar(12)",
      notNull: true,
      default: "pending",
    },
    recording_key: { type: "varchar(500)" },
    captions_vtt: { type: "text" },
    updated_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });
  pgm.addConstraint("debate_media", "debate_media_state", {
    check: "state IN ('idle', 'running', 'paused', 'ended')",
  });
  pgm.addConstraint("debate_media", "debate_media_recording_status", {
    check:
      "recording_status IN ('pending', 'recording', 'processing', 'ready', 'failed')",
  });
  pgm.addConstraint("debate_media", "debate_media_side", {
    check: "active_side IS NULL OR active_side IN ('A', 'B')",
  });
  pgm.createIndex("debate_media", ["state", "turn_deadline_at"]);
  pgm.createIndex("debate_media", "egress_id", {
    unique: true,
    where: "egress_id IS NOT NULL",
  });

  pgm.createTable(
    "media_device_checks",
    {
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
        onDelete: "CASCADE",
      },
      camera_ok: { type: "boolean", notNull: true },
      microphone_ok: { type: "boolean", notNull: true },
      checked_at: {
        type: "timestamptz",
        notNull: true,
        default: pgm.func("current_timestamp"),
      },
    },
    { constraints: { primaryKey: ["debate_id", "user_id"] } },
  );
};

export const down = (pgm) => {
  pgm.dropTable("media_device_checks");
  pgm.dropTable("debate_media");
  pgm.sql(
    "DELETE FROM event_rule_versions WHERE version = 'prototype-media-1'; UPDATE event_rule_versions SET enabled = true WHERE version = 'preview-1'",
  );
};
