export const shorthands = undefined;
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE yaparena.coin_sandbox_reports (
      id uuid PRIMARY KEY,
      user_id bigint NOT NULL REFERENCES yaparena.account_subjects(id),
      request_id uuid NOT NULL,
      rail text NOT NULL CHECK(rail IN ('simulation','base-sepolia')),
      reference char(64) NOT NULL UNIQUE,
      terms_digest char(64) NOT NULL,
      message text NOT NULL CHECK(char_length(message) BETWEEN 1 AND 2000),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(id,user_id),
      FOREIGN KEY(request_id,user_id) REFERENCES yaparena.coin_sandbox_requests(id,user_id)
    );
    CREATE INDEX coin_sandbox_reports_account ON yaparena.coin_sandbox_reports(user_id,created_at,id);
    CREATE TABLE yaparena.coin_sandbox_report_events (
      id uuid PRIMARY KEY,
      sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      report_id uuid NOT NULL,
      user_id bigint NOT NULL,
      kind text NOT NULL CHECK(kind IN ('review','recovery_consent','correction_authorized','compensated')),
      reference char(64) NOT NULL UNIQUE,
      terms_digest char(64) NOT NULL,
      terms jsonb NOT NULL CHECK(jsonb_typeof(terms)='object' AND char_length(terms::text)<=16384),
      session_id bigint,
      auth_generation bigint,
      cash_journal_id uuid,
      environment text NOT NULL DEFAULT 'sandbox' CHECK(environment='sandbox'),
      asset text NOT NULL DEFAULT 'USDC' CHECK(asset='USDC'),
      actor_role name NOT NULL DEFAULT current_user,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      FOREIGN KEY(report_id,user_id) REFERENCES yaparena.coin_sandbox_reports(id,user_id),
      FOREIGN KEY(cash_journal_id,environment,asset) REFERENCES yaparena.coin_journals(id,environment,asset),
      CHECK((kind='recovery_consent' AND session_id IS NOT NULL AND auth_generation IS NOT NULL)
        OR (kind<>'recovery_consent' AND session_id IS NULL AND auth_generation IS NULL)),
      CHECK((kind='compensated')=(cash_journal_id IS NOT NULL))
    );
    CREATE INDEX coin_sandbox_report_history ON yaparena.coin_sandbox_report_events(report_id,sequence);
    CREATE UNIQUE INDEX coin_sandbox_report_one_consent ON yaparena.coin_sandbox_report_events(report_id,(terms->>'quoteId')) WHERE kind='recovery_consent';
    CREATE FUNCTION yaparena.coin_sandbox_report_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    DECLARE quote_id uuid;
    BEGIN
      IF NEW.actor_role<>current_user OR current_user NOT IN ('yaparena_runtime','yaparena_owner') THEN
        RAISE EXCEPTION 'sandbox report actor is unavailable' USING ERRCODE='42501';
      END IF;
      IF NEW.kind='recovery_consent' THEN
        IF current_user<>'yaparena_runtime' OR NOT EXISTS(
          SELECT 1 FROM yaparena.sessions s JOIN yaparena.users u ON u.id=s.user_id
          WHERE s.id=NEW.session_id AND u.id=NEW.user_id AND u.account_status='active'
            AND s.auth_generation=u.auth_generation AND NEW.auth_generation=u.auth_generation
            AND s.expires_at>clock_timestamp()) THEN
          RAISE EXCEPTION 'sandbox recovery consent session is unavailable' USING ERRCODE='23514';
        END IF;
        SELECT e.id INTO quote_id FROM yaparena.coin_sandbox_report_events e
          WHERE e.report_id=NEW.report_id AND e.kind='review' ORDER BY e.sequence DESC LIMIT 1;
        IF NOT EXISTS(SELECT 1 FROM yaparena.coin_sandbox_report_events e WHERE e.id=quote_id
          AND e.id::text=NEW.terms->>'quoteId' AND e.terms_digest=NEW.terms->>'quoteDigest'
          AND e.terms->>'outcome'='recovery_quote'
          AND (e.terms->'quote'->>'expiresAt')::timestamptz>clock_timestamp()) THEN
          RAISE EXCEPTION 'sandbox recovery quote is expired or superseded' USING ERRCODE='23514';
        END IF;
      ELSIF current_user<>'yaparena_owner' THEN
        RAISE EXCEPTION 'sandbox report review requires its owner process' USING ERRCODE='42501';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER coin_sandbox_report_event_guard BEFORE INSERT ON yaparena.coin_sandbox_report_events
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_sandbox_report_guard();
    CREATE TRIGGER coin_sandbox_report_immutable BEFORE UPDATE OR DELETE ON yaparena.coin_sandbox_reports
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_immutable();
    CREATE TRIGGER coin_sandbox_report_event_immutable BEFORE UPDATE OR DELETE ON yaparena.coin_sandbox_report_events
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_immutable();
    REVOKE ALL ON FUNCTION yaparena.coin_sandbox_report_guard() FROM PUBLIC;
    GRANT SELECT,INSERT ON yaparena.coin_sandbox_reports,yaparena.coin_sandbox_report_events TO yaparena_runtime;
    GRANT USAGE ON SEQUENCE yaparena.coin_sandbox_report_events_sequence_seq TO yaparena_runtime;
  `);
  for (const table of ["coin_sandbox_reports", "coin_sandbox_report_events"])
    pgm.sql(`ALTER TABLE yaparena.${table} ENABLE ROW LEVEL SECURITY;
      CREATE POLICY backend_access ON yaparena.${table} TO yaparena_runtime USING(true) WITH CHECK(true)`);
};
export const down = () => {
  throw new Error(
    "Sandbox error reports and consent are retained; forward-fix",
  );
};
