export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE yaparena.users ADD COLUMN account_status text NOT NULL DEFAULT 'active'
      CHECK (account_status IN ('active','suspended'));
    CREATE TABLE yaparena.provider_identities (
      provider text NOT NULL CHECK (provider='privy'), subject text NOT NULL,
      user_id bigint UNIQUE REFERENCES yaparena.users(id) ON DELETE SET NULL,
      email text, methods jsonb NOT NULL DEFAULT '[]'::jsonb,
      credentials_digest char(64) NOT NULL,
      auth_generation bigint NOT NULL, minimum_issued_at bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(provider,subject)
    );
    -- No cascading tombstones: consumed provider sessions survive local logout/reset.
    CREATE TABLE yaparena.provider_session_exchanges (
      provider text NOT NULL, subject text NOT NULL, session_digest char(64) NOT NULL,
      user_id bigint REFERENCES yaparena.users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(provider,session_digest)
    );
    CREATE TABLE yaparena.auth_controls (
      singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
      signup_enabled boolean NOT NULL DEFAULT true
    );
    INSERT INTO yaparena.auth_controls DEFAULT VALUES;
    CREATE TABLE yaparena.provider_revocation_jobs (
      user_id bigint NOT NULL REFERENCES yaparena.users(id) ON DELETE CASCADE,
      subject text NOT NULL, generation bigint NOT NULL,
      attempts integer NOT NULL DEFAULT 0, state text NOT NULL DEFAULT 'pending'
        CHECK(state IN ('pending','running','complete','manual')),
      lease_until timestamptz NOT NULL DEFAULT '-infinity',
      PRIMARY KEY(user_id,generation)
    );
    CREATE FUNCTION yaparena.enqueue_provider_revocation() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      INSERT INTO yaparena.provider_revocation_jobs(user_id,subject,generation)
      SELECT NEW.id,subject,NEW.auth_generation FROM yaparena.provider_identities WHERE user_id=NEW.id
      ON CONFLICT DO NOTHING;
      RETURN NEW;
    END $$;
    REVOKE ALL ON FUNCTION yaparena.enqueue_provider_revocation() FROM PUBLIC;
    CREATE TRIGGER enqueue_provider_revocation AFTER UPDATE ON yaparena.users
      FOR EACH ROW WHEN(NEW.auth_generation IS DISTINCT FROM OLD.auth_generation)
      EXECUTE FUNCTION yaparena.enqueue_provider_revocation();
    CREATE FUNCTION yaparena.require_active_account() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      PERFORM 1 FROM yaparena.users WHERE id=NEW.user_id AND account_status='active' FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'account unavailable' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $$;
    REVOKE ALL ON FUNCTION yaparena.require_active_account() FROM PUBLIC;
    CREATE TRIGGER account_active_session BEFORE INSERT OR UPDATE ON yaparena.sessions
      FOR EACH ROW EXECUTE FUNCTION yaparena.require_active_account();
    CREATE FUNCTION yaparena.suspend_account_sessions() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF NEW.account_status IS DISTINCT FROM OLD.account_status THEN
        NEW.auth_generation := OLD.auth_generation + 1;
        DELETE FROM yaparena.sessions WHERE user_id=OLD.id;
      END IF;
      RETURN NEW;
    END $$;
    REVOKE ALL ON FUNCTION yaparena.suspend_account_sessions() FROM PUBLIC;
    CREATE TRIGGER account_status_revoke BEFORE UPDATE OF account_status ON yaparena.users
      FOR EACH ROW EXECUTE FUNCTION yaparena.suspend_account_sessions();
    GRANT SELECT,INSERT ON yaparena.provider_identities,yaparena.provider_session_exchanges TO yaparena_runtime;
    GRANT SELECT ON yaparena.auth_controls TO yaparena_runtime;
    GRANT UPDATE(auth_generation,minimum_issued_at,email,methods) ON yaparena.provider_identities TO yaparena_runtime;
    GRANT SELECT,INSERT,UPDATE ON yaparena.provider_revocation_jobs TO yaparena_runtime;
  `);
  for (const table of [
    "provider_identities",
    "provider_session_exchanges",
    "auth_controls",
    "provider_revocation_jobs",
  ]) {
    pgm.sql(`ALTER TABLE yaparena.${table} ENABLE ROW LEVEL SECURITY;
      CREATE POLICY backend_access ON yaparena.${table} TO yaparena_runtime USING(true) WITH CHECK(true)`);
  }
};
export const down = () => {
  throw new Error(
    "Provider identity history must not be rolled back; forward-fix",
  );
};
