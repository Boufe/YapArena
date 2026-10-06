export const shorthands = undefined;

export const up = (pgm) => {
  pgm.createTable("product_measurement_consents", {
    token_hash: { type: "char(64)", primaryKey: true },
    granted_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
    last_seen_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });
  pgm.createIndex("product_measurement_consents", "last_seen_at");

  pgm.createTable("product_measurement_affiliations", {
    user_id: {
      type: "bigint",
      primaryKey: true,
      references: "users",
      onDelete: "CASCADE",
    },
    affiliation: { type: "varchar(12)", notNull: true },
    reason: { type: "varchar(500)", notNull: true },
    reviewed_by: {
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
  pgm.addConstraint(
    "product_measurement_affiliations",
    "product_measurement_affiliation_allowed",
    { check: "affiliation IN ('founder', 'independent')" },
  );
  pgm.createTable("product_measurement_affiliation_audit", {
    id: { type: "bigserial", primaryKey: true },
    user_id: { type: "bigint", references: "users", onDelete: "SET NULL" },
    previous_affiliation: { type: "varchar(12)" },
    affiliation: { type: "varchar(12)", notNull: true },
    reason: { type: "varchar(500)", notNull: true },
    reviewed_by: { type: "bigint", references: "users", onDelete: "SET NULL" },
    occurred_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });
  pgm.createIndex("product_measurement_affiliation_audit", "occurred_at");

  pgm.createTable("product_measurement_events", {
    id: { type: "bigserial", primaryKey: true },
    token_hash: {
      type: "char(64)",
      references: "product_measurement_consents",
      onDelete: "CASCADE",
    },
    user_id: { type: "bigint", references: "users", onDelete: "CASCADE" },
    event_type: { type: "varchar(32)", notNull: true },
    surface: { type: "varchar(16)" },
    debate_id: { type: "uuid", references: "debates", onDelete: "CASCADE" },
    topic_id: { type: "uuid", references: "topics", onDelete: "CASCADE" },
    request_id: {
      type: "uuid",
      references: "match_requests",
      onDelete: "CASCADE",
    },
    case_id: {
      type: "uuid",
      references: "moderation_cases",
      onDelete: "CASCADE",
    },
    profile_id: {
      type: "uuid",
      references: "public_profiles",
      onDelete: "CASCADE",
    },
    occurred_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });
  pgm.addConstraint(
    "product_measurement_events",
    "product_measurement_event_type",
    {
      check:
        "event_type IN ('discovery_view', 'match_requested', 'match_accepted', 'debate_completed', 'replay_started', 'follow_created', 'report_submitted', 'return_visit')",
    },
  );
  pgm.addConstraint(
    "product_measurement_events",
    "product_measurement_event_consent",
    {
      check:
        "(event_type = 'debate_completed' AND token_hash IS NULL AND user_id IS NULL) OR (event_type <> 'debate_completed' AND token_hash IS NOT NULL)",
    },
  );
  pgm.addConstraint(
    "product_measurement_events",
    "product_measurement_surface",
    {
      check:
        "surface IS NULL OR surface IN ('home', 'debates', 'topics', 'debate', 'topic', 'profile', 'match')",
    },
  );
  pgm.createIndex("product_measurement_events", ["occurred_at", "event_type"]);
  pgm.createIndex("product_measurement_events", ["token_hash", "occurred_at"]);
  pgm.createIndex("product_measurement_events", ["user_id", "occurred_at"]);
  pgm.sql(`CREATE UNIQUE INDEX product_measurement_one_completion
    ON product_measurement_events (debate_id)
    WHERE event_type = 'debate_completed'`);
  pgm.sql(`CREATE UNIQUE INDEX product_measurement_one_return_per_day
    ON product_measurement_events (token_hash, ((occurred_at AT TIME ZONE 'UTC')::date))
    WHERE event_type = 'return_visit'`);

  pgm.createTable("product_measurement_watch_sessions", {
    id: { type: "uuid", primaryKey: true },
    token_hash: {
      type: "char(64)",
      notNull: true,
      references: "product_measurement_consents",
      onDelete: "CASCADE",
    },
    user_id: { type: "bigint", references: "users", onDelete: "CASCADE" },
    debate_id: {
      type: "uuid",
      notNull: true,
      references: "debates",
      onDelete: "CASCADE",
    },
    mode: { type: "varchar(8)", notNull: true },
    started_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
    last_seen_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
    watched_seconds: { type: "integer", notNull: true, default: 0 },
    ended_at: { type: "timestamptz" },
  });
  pgm.addConstraint(
    "product_measurement_watch_sessions",
    "product_measurement_watch_mode",
    {
      check: "mode IN ('live', 'replay')",
    },
  );
  pgm.addConstraint(
    "product_measurement_watch_sessions",
    "product_measurement_watch_seconds",
    {
      check: "watched_seconds BETWEEN 0 AND 14400",
    },
  );
  pgm.createIndex("product_measurement_watch_sessions", ["started_at", "mode"]);
  pgm.createIndex("product_measurement_watch_sessions", [
    "token_hash",
    "started_at",
  ]);

  for (const table of [
    "product_measurement_consents",
    "product_measurement_affiliations",
    "product_measurement_affiliation_audit",
    "product_measurement_events",
    "product_measurement_watch_sessions",
  ]) {
    pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  }

  pgm.sql(`CREATE FUNCTION product_measurement_record_completion() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.live_ended_at IS NOT NULL AND OLD.live_ended_at IS NULL
        AND NEW.is_demo = false THEN
        INSERT INTO product_measurement_events (event_type, debate_id, topic_id)
        VALUES ('debate_completed', NEW.id, NEW.topic_id)
        ON CONFLICT DO NOTHING;
      END IF;
      RETURN NEW;
    END;
    $$`);
  pgm.sql(
    "REVOKE EXECUTE ON FUNCTION product_measurement_record_completion() FROM PUBLIC",
  );
  pgm.sql(`CREATE TRIGGER product_measurement_debate_completed
    AFTER UPDATE OF live_ended_at ON debates
    FOR EACH ROW EXECUTE FUNCTION product_measurement_record_completion()`);
};

export const down = (pgm) => {
  pgm.sql("DROP TRIGGER product_measurement_debate_completed ON debates");
  pgm.sql("DROP FUNCTION product_measurement_record_completion()");
  pgm.dropTable("product_measurement_watch_sessions");
  pgm.dropTable("product_measurement_events");
  pgm.dropTable("product_measurement_affiliation_audit");
  pgm.dropTable("product_measurement_affiliations");
  pgm.dropTable("product_measurement_consents");
};
