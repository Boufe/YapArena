/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const publicBotTables = [
  "a4_public_publishers",
  "a4_synthetic_debates",
  "a4_synthetic_rounds",
];
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE yaparena.a4_public_publishers (
      user_id bigint PRIMARY KEY REFERENCES yaparena.users(id) ON DELETE CASCADE,
      consented_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE yaparena.a4_synthetic_debates (
      debate_id uuid PRIMARY KEY REFERENCES yaparena.debates(id) ON DELETE CASCADE,
      arguments jsonb NOT NULL CHECK(jsonb_typeof(arguments)='array' AND jsonb_array_length(arguments) BETWEEN 2 AND 12),
      category text NOT NULL CHECK(length(category) BETWEEN 1 AND 40),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE yaparena.a4_synthetic_rounds (
      id uuid PRIMARY KEY, debate_id uuid NOT NULL REFERENCES yaparena.a4_synthetic_debates(debate_id) ON DELETE CASCADE,
      seed_key text NOT NULL UNIQUE, simulated_at timestamptz NOT NULL, seed text NOT NULL,
      result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX a4_synthetic_rounds_recent ON yaparena.a4_synthetic_rounds(debate_id,simulated_at DESC,id);
    CREATE INDEX a4_public_settled_rounds ON yaparena.a4_rounds(session_id,revealed_at DESC,id) WHERE state='settled' AND revealed_at IS NOT NULL;
  `);
  for (const table of publicBotTables)
    pgm.sql(`
    ALTER TABLE yaparena.${table} ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON yaparena.${table} FROM PUBLIC;
    GRANT SELECT ON yaparena.${table} TO yaparena_runtime;
    CREATE POLICY backend_runtime ON yaparena.${table} TO yaparena_runtime USING(true) WITH CHECK(true);
  `);
  pgm.sql(`GRANT INSERT,DELETE ON yaparena.a4_public_publishers TO yaparena_runtime;
    DO $$ DECLARE r text; BEGIN
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
        EXECUTE format('REVOKE ALL ON yaparena.a4_public_publishers,yaparena.a4_synthetic_debates,yaparena.a4_synthetic_rounds FROM %I',r);
      END LOOP;
    END $$;`);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const down = () => {
  throw new Error(
    "Preserve simulation consent/history; use a forward migration",
  );
};
