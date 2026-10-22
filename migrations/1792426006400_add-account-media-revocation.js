export const shorthands = undefined;
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE yaparena.media_account_grants (
      id uuid PRIMARY KEY,
      user_id bigint NOT NULL REFERENCES yaparena.account_subjects(id),
      -- Session IDs are never reused. No FK: session deletion must retain the
      -- issued identity so its external token can still be revoked afterwards.
      session_id bigint NOT NULL CHECK(session_id>0),
      auth_generation bigint NOT NULL CHECK(auth_generation>=0),
      debate_id uuid NOT NULL REFERENCES yaparena.debates(id),
      identity text NOT NULL UNIQUE,
      state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoking','revoked')),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      CHECK(identity='speaker-'||id::text),
      CHECK(expires_at>issued_at AND expires_at<=issued_at+INTERVAL '15 minutes'),
      CHECK((state='revoked')=(revoked_at IS NOT NULL))
    );
    CREATE UNIQUE INDEX media_account_single_publisher ON yaparena.media_account_grants(user_id,debate_id)
      WHERE state IN ('active','revoking');
    CREATE INDEX media_account_session_grants ON yaparena.media_account_grants(session_id) WHERE state='active';
    CREATE TABLE yaparena.media_account_revocations (
      grant_id uuid PRIMARY KEY REFERENCES yaparena.media_account_grants(id),
      state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','complete')),
      attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
      available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      lease_until timestamptz,
      claim_token uuid,
      last_error text CHECK(last_error IN ('provider_error','provider_timeout','unsupported_token_revocation')),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      completed_at timestamptz,
      CHECK((state='running' AND claim_token IS NOT NULL AND lease_until IS NOT NULL)
        OR (state<>'running' AND claim_token IS NULL AND lease_until IS NULL)),
      CHECK((state='complete')=(completed_at IS NOT NULL))
    );
    CREATE INDEX media_account_revocations_due ON yaparena.media_account_revocations(available_at,grant_id)
      WHERE state<>'complete';
    CREATE FUNCTION yaparena.media_account_grant_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF TG_OP='DELETE' THEN
        RAISE EXCEPTION 'media grant history is immutable' USING ERRCODE='23514';
      END IF;
      IF TG_OP='INSERT' THEN
        IF NEW.state<>'active' OR NOT EXISTS(SELECT 1 FROM yaparena.sessions s JOIN yaparena.users u ON u.id=s.user_id
          WHERE s.id=NEW.session_id AND u.id=NEW.user_id AND u.account_status='active'
          AND s.auth_generation=u.auth_generation AND NEW.auth_generation=u.auth_generation
          AND s.expires_at>clock_timestamp()) THEN
          RAISE EXCEPTION 'media grant session is unavailable' USING ERRCODE='23514';
        END IF;
      ELSE
        IF (to_jsonb(NEW)-ARRAY['state','issued_at','expires_at','revoked_at']) IS DISTINCT FROM
          (to_jsonb(OLD)-ARRAY['state','issued_at','expires_at','revoked_at'])
          OR OLD.state='revoked' OR (OLD.state='revoking' AND NEW.state<>'revoked')
          OR (OLD.state='active' AND NEW.state NOT IN ('active','revoking'))
          OR NEW.issued_at<OLD.issued_at OR NEW.expires_at<OLD.expires_at
          OR (NEW.state<>OLD.state AND (NEW.issued_at<>OLD.issued_at OR NEW.expires_at<>OLD.expires_at)) THEN
          RAISE EXCEPTION 'media grant identity or retirement is immutable' USING ERRCODE='23514';
        END IF;
        IF NEW.state='active' AND NOT EXISTS(SELECT 1 FROM yaparena.sessions s JOIN yaparena.users u ON u.id=s.user_id
          WHERE s.id=NEW.session_id AND u.id=NEW.user_id AND u.account_status='active'
          AND s.auth_generation=u.auth_generation AND s.expires_at>clock_timestamp()) THEN
          RAISE EXCEPTION 'media grant session is unavailable' USING ERRCODE='23514';
        END IF;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER media_account_grant_guard BEFORE INSERT OR UPDATE OR DELETE ON yaparena.media_account_grants
      FOR EACH ROW EXECUTE FUNCTION yaparena.media_account_grant_guard();
    CREATE FUNCTION yaparena.media_account_enqueue_invalid() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    DECLARE account_id bigint;
    BEGIN
      IF TG_TABLE_NAME='users' THEN account_id:=NEW.id;
      ELSIF TG_OP='DELETE' THEN account_id:=OLD.user_id;
      ELSE account_id:=NEW.user_id; END IF;
      WITH retired AS (
        UPDATE yaparena.media_account_grants g SET state='revoking'
        WHERE g.user_id=account_id AND g.state='active' AND NOT EXISTS(
          SELECT 1 FROM yaparena.sessions s JOIN yaparena.users u ON u.id=s.user_id
          WHERE s.id=g.session_id AND u.id=g.user_id AND u.account_status='active'
            AND s.auth_generation=u.auth_generation AND s.expires_at>clock_timestamp())
        RETURNING id
      ) INSERT INTO yaparena.media_account_revocations(grant_id) SELECT id FROM retired ON CONFLICT DO NOTHING;
      RETURN NULL;
    END $$;
    -- Deferred checks see the final retained SID after logout-others advances
    -- its generation; generation-only triggers would kick the surviving device.
    CREATE CONSTRAINT TRIGGER media_account_generation_retirement AFTER UPDATE ON yaparena.users
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      WHEN(NEW.auth_generation IS DISTINCT FROM OLD.auth_generation OR NEW.account_status IS DISTINCT FROM OLD.account_status)
      EXECUTE FUNCTION yaparena.media_account_enqueue_invalid();
    CREATE CONSTRAINT TRIGGER media_account_session_retirement AFTER DELETE OR UPDATE ON yaparena.sessions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION yaparena.media_account_enqueue_invalid();
    CREATE TRIGGER media_account_revocation_history BEFORE DELETE ON yaparena.media_account_revocations
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_immutable();
    REVOKE ALL ON FUNCTION yaparena.media_account_grant_guard(),yaparena.media_account_enqueue_invalid() FROM PUBLIC;
    GRANT SELECT,INSERT ON yaparena.media_account_grants,yaparena.media_account_revocations TO yaparena_runtime;
    GRANT UPDATE(state,issued_at,expires_at,revoked_at) ON yaparena.media_account_grants TO yaparena_runtime;
    GRANT UPDATE(state,attempts,available_at,lease_until,claim_token,last_error,completed_at)
      ON yaparena.media_account_revocations TO yaparena_runtime;
  `);
  for (const table of ["media_account_grants", "media_account_revocations"])
    pgm.sql(`ALTER TABLE yaparena.${table} ENABLE ROW LEVEL SECURITY;
      CREATE POLICY backend_access ON yaparena.${table} TO yaparena_runtime USING(true) WITH CHECK(true)`);
};
export const down = () => {
  throw new Error(
    "Account media revocation history requires a reviewed forward fix",
  );
};
