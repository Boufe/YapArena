export const shorthands = undefined;

export const up = (pgm) => {
  pgm.createTable("public_profiles", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    user_id: {
      type: "bigint",
      unique: true,
      references: "users",
      onDelete: "SET NULL",
    },
    handle: { type: "varchar(40)", notNull: true, unique: true },
    display_name: { type: "varchar(80)", notNull: true },
    bio: { type: "varchar(500)" },
    publication_state: { type: "varchar(12)", notNull: true, default: "draft" },
    is_demo: { type: "boolean", notNull: true, default: false },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });
  pgm.addConstraint("public_profiles", "public_profiles_handle_format", {
    check: "handle ~ '^[a-z0-9][a-z0-9-]{2,39}$'",
  });
  pgm.addConstraint("public_profiles", "public_profiles_publication_state", {
    check: "publication_state IN ('draft', 'published', 'hidden')",
  });

  pgm.createTable("topics", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    slug: { type: "varchar(80)", notNull: true, unique: true },
    title: { type: "varchar(140)", notNull: true },
    summary: { type: "varchar(600)", notNull: true },
    side_a_label: { type: "varchar(80)", notNull: true },
    side_b_label: { type: "varchar(80)", notNull: true },
    publication_state: { type: "varchar(12)", notNull: true, default: "draft" },
    is_demo: { type: "boolean", notNull: true, default: false },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });
  pgm.addConstraint("topics", "topics_slug_format", {
    check: "slug ~ '^[a-z0-9][a-z0-9-]{2,79}$'",
  });
  pgm.addConstraint("topics", "topics_publication_state", {
    check: "publication_state IN ('draft', 'published', 'hidden')",
  });
  pgm.sql(
    "CREATE INDEX topics_search_idx ON topics USING gin (to_tsvector('simple', title || ' ' || summary))",
  );

  pgm.createTable("sponsors", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    name: { type: "varchar(120)", notNull: true },
    disclosure: { type: "varchar(240)", notNull: true },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });

  pgm.createTable("debates", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    slug: { type: "varchar(100)", notNull: true, unique: true },
    topic_id: {
      type: "uuid",
      notNull: true,
      references: "topics",
      onDelete: "RESTRICT",
    },
    proposition: { type: "varchar(240)", notNull: true },
    speaker_a_profile_id: {
      type: "uuid",
      references: "public_profiles",
      onDelete: "RESTRICT",
    },
    speaker_b_profile_id: {
      type: "uuid",
      references: "public_profiles",
      onDelete: "RESTRICT",
    },
    sponsor_id: { type: "uuid", references: "sponsors", onDelete: "SET NULL" },
    status: { type: "varchar(12)", notNull: true, default: "scheduled" },
    publication_state: { type: "varchar(12)", notNull: true, default: "draft" },
    rules_version: { type: "varchar(40)", notNull: true },
    scheduled_at: { type: "timestamptz" },
    live_started_at: { type: "timestamptz" },
    live_ended_at: { type: "timestamptz" },
    is_demo: { type: "boolean", notNull: true, default: false },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });
  pgm.addConstraint("debates", "debates_slug_format", {
    check: "slug ~ '^[a-z0-9][a-z0-9-]{2,99}$'",
  });
  pgm.addConstraint("debates", "debates_status", {
    check:
      "status IN ('scheduled', 'live', 'replay', 'finalized', 'cancelled')",
  });
  pgm.addConstraint("debates", "debates_publication_state", {
    check: "publication_state IN ('draft', 'published', 'hidden')",
  });
  pgm.addConstraint("debates", "debates_distinct_speakers", {
    check:
      "speaker_a_profile_id IS NULL OR speaker_b_profile_id IS NULL OR speaker_a_profile_id <> speaker_b_profile_id",
  });
  pgm.createIndex("debates", ["topic_id", "created_at"]);
  pgm.createIndex("debates", ["publication_state", "status", "scheduled_at"]);
  pgm.sql(
    "CREATE INDEX debates_search_idx ON debates USING gin (to_tsvector('simple', proposition))",
  );

  pgm.createTable("follows", {
    user_id: {
      type: "bigint",
      notNull: true,
      references: "users",
      onDelete: "CASCADE",
    },
    topic_id: { type: "uuid", references: "topics", onDelete: "CASCADE" },
    profile_id: {
      type: "uuid",
      references: "public_profiles",
      onDelete: "CASCADE",
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });
  pgm.addConstraint("follows", "follows_exactly_one_target", {
    check: "(topic_id IS NOT NULL) <> (profile_id IS NOT NULL)",
  });
  pgm.sql(
    "CREATE UNIQUE INDEX follows_topic_unique ON follows (user_id, topic_id) WHERE topic_id IS NOT NULL",
  );
  pgm.sql(
    "CREATE UNIQUE INDEX follows_profile_unique ON follows (user_id, profile_id) WHERE profile_id IS NOT NULL",
  );
};

export const down = (pgm) => {
  pgm.dropTable("follows");
  pgm.dropTable("debates");
  pgm.dropTable("sponsors");
  pgm.dropTable("topics");
  pgm.dropTable("public_profiles");
};
