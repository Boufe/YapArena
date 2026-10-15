export const a4Tables = [
  "a4_assets",
  "a4_controls",
  "a4_sessions",
  "a4_rounds",
  "a4_submissions",
  "a4_accounts",
  "a4_journals",
  "a4_postings",
  "a4_requests",
  "a4_audit",
];
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE yaparena.a4_assets (id text PRIMARY KEY, precision integer NOT NULL CHECK (precision BETWEEN 0 AND 18), face numeric(40,0) NOT NULL CHECK (face>0), mode text NOT NULL CHECK (mode='play'));
    INSERT INTO yaparena.a4_assets VALUES ('YAP',6,1000000,'play');
    CREATE TABLE yaparena.a4_controls (id boolean PRIMARY KEY DEFAULT true CHECK (id), enabled boolean NOT NULL DEFAULT false, bots_enabled boolean NOT NULL DEFAULT false);
    INSERT INTO yaparena.a4_controls DEFAULT VALUES;
    CREATE TABLE yaparena.a4_sessions (
      id uuid PRIMARY KEY, creator_id bigint NOT NULL REFERENCES yaparena.users(id) ON DELETE RESTRICT,
      debate_id uuid NOT NULL REFERENCES yaparena.debates(id) ON DELETE RESTRICT,
      asset text NOT NULL REFERENCES yaparena.a4_assets(id), mode text NOT NULL CHECK (mode IN ('human','mixed','observer')),
      state text NOT NULL CHECK (state IN ('running','paused','complete','archived')),
      config jsonb NOT NULL, seed text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      reveal_at timestamptz NOT NULL, speed integer NOT NULL DEFAULT 1 CHECK (speed IN (1,5,20)),
      UNIQUE(id,asset)
    );
    CREATE UNIQUE INDEX a4_one_human_session ON yaparena.a4_sessions(debate_id) WHERE mode='human' AND state IN ('running','paused');
    CREATE INDEX a4_sessions_creator ON yaparena.a4_sessions(creator_id,created_at DESC,id);
    CREATE INDEX a4_sessions_debate ON yaparena.a4_sessions(debate_id,created_at DESC,id);
    CREATE TABLE yaparena.a4_rounds (
      id uuid PRIMARY KEY, session_id uuid NOT NULL, asset text NOT NULL,
      period integer NOT NULL CHECK (period BETWEEN 1 AND 10), state text NOT NULL CHECK (state IN ('scheduled','open','locked','priced','pending','settled','void')),
      opens_at timestamptz NOT NULL, closes_at timestamptz NOT NULL, seed text NOT NULL,
      seed_commitment text NOT NULL, snapshot jsonb, snapshot_hash text, pricing jsonb,
      revealed_at timestamptz, locked_at timestamptz,
      CHECK(opens_at<closes_at), UNIQUE(session_id,period), UNIQUE(id,asset),
      FOREIGN KEY(session_id,asset) REFERENCES yaparena.a4_sessions(id,asset) ON DELETE RESTRICT
    );
    CREATE INDEX a4_rounds_due ON yaparena.a4_rounds(state,closes_at,id) WHERE state NOT IN ('settled','void');
    CREATE TABLE yaparena.a4_submissions (
      round_id uuid NOT NULL, asset text NOT NULL, participant text NOT NULL,
      user_id bigint REFERENCES yaparena.users(id) ON DELETE RESTRICT,
      kind text NOT NULL CHECK (kind IN ('human','bot')), side text NOT NULL CHECK (side IN ('YES','NO')),
      limit_value text NOT NULL CHECK (limit_value ~ '^(0([.][0-9]{1,6})?|1([.]0{1,6})?)$'),
      quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 100), request_key text NOT NULL,
      outcome jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CHECK((kind='human' AND user_id IS NOT NULL AND participant='user:'||user_id::text) OR (kind='bot' AND user_id IS NULL AND participant ~ '^bot:[0-9]+$')),
      PRIMARY KEY(round_id,participant), UNIQUE(round_id,user_id), UNIQUE(round_id,request_key),
      FOREIGN KEY(round_id,asset) REFERENCES yaparena.a4_rounds(id,asset) ON DELETE RESTRICT
    );
    CREATE INDEX a4_submissions_user ON yaparena.a4_submissions(user_id,created_at DESC,round_id) WHERE user_id IS NOT NULL;
    CREATE TABLE yaparena.a4_accounts (
      id text PRIMARY KEY, scope text NOT NULL, asset text NOT NULL REFERENCES yaparena.a4_assets(id),
      user_id bigint REFERENCES yaparena.users(id) ON DELETE RESTRICT,
      kind text NOT NULL CHECK(kind IN ('available','reserved','center','collateral','fees_pending','fees','issuer')),
      amount numeric(40,0) NOT NULL DEFAULT 0, CHECK(kind='issuer' OR amount>=0)
    );
    CREATE INDEX a4_accounts_user ON yaparena.a4_accounts(user_id,scope,kind);
    CREATE TABLE yaparena.a4_journals (
      reference text PRIMARY KEY, scope text NOT NULL, asset text NOT NULL REFERENCES yaparena.a4_assets(id),
      kind text NOT NULL, metadata jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE yaparena.a4_postings (
      reference text NOT NULL REFERENCES yaparena.a4_journals(reference) ON DELETE RESTRICT,
      account_id text NOT NULL REFERENCES yaparena.a4_accounts(id) ON DELETE RESTRICT,
      amount numeric(40,0) NOT NULL, PRIMARY KEY(reference,account_id)
    );
    CREATE INDEX a4_postings_account ON yaparena.a4_postings(account_id,reference);
    CREATE TABLE yaparena.a4_requests (
      user_id bigint NOT NULL REFERENCES yaparena.users(id) ON DELETE RESTRICT,
      request_key text NOT NULL, operation text NOT NULL, payload_hash text NOT NULL, response jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(user_id,request_key)
    );
    CREATE TABLE yaparena.a4_audit (
      id uuid PRIMARY KEY, session_id uuid REFERENCES yaparena.a4_sessions(id) ON DELETE RESTRICT,
      actor_id bigint REFERENCES yaparena.users(id) ON DELETE RESTRICT,
      action text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX a4_audit_session ON yaparena.a4_audit(session_id,created_at,id);
    CREATE FUNCTION yaparena.a4_balanced_journal() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
      SET search_path=pg_catalog,yaparena,pg_temp AS $$
      DECLARE ref text:=NEW.reference;
      BEGIN
        IF NOT EXISTS(SELECT 1 FROM a4_postings WHERE reference=ref) OR
          (SELECT sum(amount) FROM a4_postings WHERE reference=ref)<>0 OR EXISTS (
            SELECT 1 FROM a4_postings p JOIN a4_accounts a ON a.id=p.account_id
            JOIN a4_journals j ON j.reference=p.reference
            WHERE p.reference=ref AND (a.asset<>j.asset OR a.scope<>j.scope)) THEN
          RAISE EXCEPTION 'A4 unbalanced or mixed-asset journal' USING ERRCODE='23514';
        END IF;
        RETURN NULL;
      END $$;
    CREATE CONSTRAINT TRIGGER a4_journal_balance AFTER INSERT ON yaparena.a4_journals
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION yaparena.a4_balanced_journal();
    REVOKE ALL ON FUNCTION yaparena.a4_balanced_journal() FROM PUBLIC,yaparena_runtime;
  `);
  for (const table of a4Tables) {
    pgm.sql(`ALTER TABLE yaparena.${table} ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON yaparena.${table} FROM PUBLIC;
      GRANT SELECT ON yaparena.${table} TO yaparena_runtime;
      CREATE POLICY backend_runtime ON yaparena.${table} TO yaparena_runtime USING(true) WITH CHECK(true);`);
  }
  pgm.sql(`
    GRANT INSERT ON yaparena.a4_sessions,yaparena.a4_rounds,yaparena.a4_submissions,yaparena.a4_accounts,yaparena.a4_journals,yaparena.a4_postings,yaparena.a4_requests,yaparena.a4_audit TO yaparena_runtime;
    GRANT UPDATE(state,speed) ON yaparena.a4_sessions TO yaparena_runtime;
    GRANT UPDATE(state,snapshot,snapshot_hash,pricing,revealed_at,locked_at) ON yaparena.a4_rounds TO yaparena_runtime;
    GRANT UPDATE(outcome) ON yaparena.a4_submissions TO yaparena_runtime;
    GRANT UPDATE(amount) ON yaparena.a4_accounts TO yaparena_runtime;
    DO $$ DECLARE role_name text; BEGIN
      FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION yaparena.a4_balanced_journal() FROM %I',role_name);
      END LOOP;
    END $$;
  `);
};
export const down = () => {
  throw new Error("Retain A4 financial audit history; use a forward fix");
};
