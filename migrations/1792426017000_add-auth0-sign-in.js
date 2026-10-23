export const shorthands = undefined;

// Decision 0009: Auth0 sign-in. Expand only; the previous release keeps
// working. Each (auth0, sub) maps to one account and an account may hold
// several subjects (one per sign-in method), so the one-mapping-per-account
// constraint becomes an ordinary index. Sign-in state and pending Google links
// live here for at most 10 minutes and are consumed once.
export const up = (pgm) => {
  pgm.sql(`
    DO $$ DECLARE item record; BEGIN
      FOR item IN SELECT conname FROM pg_constraint
        WHERE conrelid='yaparena.provider_identities'::regclass AND contype='c'
          AND pg_get_constraintdef(oid) LIKE '%provider%privy%'
      LOOP EXECUTE format('ALTER TABLE yaparena.provider_identities DROP CONSTRAINT %I',item.conname); END LOOP;
      FOR item IN SELECT conname FROM pg_constraint
        WHERE conrelid='yaparena.provider_identities'::regclass AND contype='u'
          AND conkey=ARRAY[(SELECT attnum FROM pg_attribute
            WHERE attrelid='yaparena.provider_identities'::regclass AND attname='user_id')]
      LOOP EXECUTE format('ALTER TABLE yaparena.provider_identities DROP CONSTRAINT %I',item.conname); END LOOP;
    END $$;
    ALTER TABLE yaparena.provider_identities
      ADD CONSTRAINT provider_identities_provider CHECK(provider IN ('privy','auth0')),
      ALTER COLUMN credentials_digest DROP NOT NULL,
      ALTER COLUMN auth_generation DROP NOT NULL,
      ADD CONSTRAINT provider_identities_privy_state CHECK(provider<>'privy'
        OR (credentials_digest IS NOT NULL AND auth_generation IS NOT NULL)),
      ADD CONSTRAINT provider_identities_auth0_shape CHECK(provider<>'auth0' OR (
        length(subject) BETWEEN 3 AND 256
        AND ((subject LIKE 'email|%' AND methods='["email"]'::jsonb)
          OR (subject LIKE 'google-oauth2|%' AND methods='["google"]'::jsonb))
        AND email IS NOT NULL AND email=lower(email) AND length(email) BETWEEN 3 AND 320));
    CREATE INDEX provider_identities_user ON yaparena.provider_identities(user_id);
    CREATE INDEX provider_identities_auth0_email ON yaparena.provider_identities(email)
      WHERE provider='auth0' AND user_id IS NOT NULL;

    -- Privy session control is unmounted. Auth0 sign-in has no provider
    -- sessions to freeze, so only Privy mappings still queue a reset job.
    CREATE OR REPLACE FUNCTION yaparena.enqueue_provider_revocation() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      INSERT INTO yaparena.provider_revocation_jobs(user_id,subject,generation)
      SELECT NEW.id,subject,NEW.auth_generation FROM yaparena.provider_identities
      WHERE user_id=NEW.id AND provider='privy'
      ON CONFLICT DO NOTHING;
      RETURN NEW;
    END $$;
    REVOKE ALL ON FUNCTION yaparena.enqueue_provider_revocation() FROM PUBLIC;

    CREATE TABLE yaparena.auth_pending_links (
      id uuid PRIMARY KEY,
      user_id bigint NOT NULL REFERENCES yaparena.users(id) ON DELETE CASCADE,
      google_subject text NOT NULL CHECK(google_subject LIKE 'google-oauth2|%' AND length(google_subject)<=256),
      email text NOT NULL CHECK(email=lower(email) AND length(email) BETWEEN 3 AND 320),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      CHECK(expires_at>created_at AND expires_at<=created_at+interval '10 minutes')
    );
    CREATE INDEX auth_pending_links_expiry ON yaparena.auth_pending_links(expires_at);
    CREATE TABLE yaparena.auth_login_transactions (
      state_digest char(64) PRIMARY KEY CHECK(state_digest ~ '^[0-9a-f]{64}$'),
      binding_digest char(64) NOT NULL CHECK(binding_digest ~ '^[0-9a-f]{64}$'),
      nonce text NOT NULL CHECK(nonce ~ '^[A-Za-z0-9_-]{32,128}$'),
      code_verifier text NOT NULL CHECK(code_verifier ~ '^[A-Za-z0-9._~-]{43,128}$'),
      purpose text NOT NULL CHECK(purpose IN ('sign_in','link','confirm')),
      return_path text NOT NULL CHECK(return_path LIKE '/%' AND length(return_path)<=2048),
      user_id bigint REFERENCES yaparena.users(id) ON DELETE CASCADE,
      operation_id uuid REFERENCES yaparena.account_operations(id) ON DELETE CASCADE,
      pending_link_id uuid REFERENCES yaparena.auth_pending_links(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      CHECK(expires_at>created_at AND expires_at<=created_at+interval '10 minutes'),
      CHECK((purpose='sign_in' AND user_id IS NULL AND operation_id IS NULL AND pending_link_id IS NULL)
        OR (purpose='link' AND pending_link_id IS NOT NULL AND user_id IS NULL AND operation_id IS NULL)
        OR (purpose='confirm' AND user_id IS NOT NULL AND operation_id IS NOT NULL AND pending_link_id IS NULL))
    );
    CREATE INDEX auth_login_transactions_expiry ON yaparena.auth_login_transactions(expires_at);
    -- Both tables are one-use: rows start unconsumed and only consumed_at may
    -- change, once, before expiry.
    CREATE FUNCTION yaparena.auth_one_use_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF TG_OP='INSERT' THEN
        IF NEW.consumed_at IS NOT NULL THEN
          RAISE EXCEPTION 'sign-in state starts unconsumed' USING ERRCODE='23514';
        END IF;
      ELSIF (to_jsonb(NEW)-'consumed_at') IS DISTINCT FROM (to_jsonb(OLD)-'consumed_at')
        OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
        OR NEW.expires_at<=clock_timestamp() THEN
        RAISE EXCEPTION 'sign-in state is immutable, consumed or expired' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    REVOKE ALL ON FUNCTION yaparena.auth_one_use_guard() FROM PUBLIC;
    CREATE TRIGGER auth_pending_link_guard BEFORE INSERT OR UPDATE ON yaparena.auth_pending_links
      FOR EACH ROW EXECUTE FUNCTION yaparena.auth_one_use_guard();
    CREATE TRIGGER auth_login_transaction_guard BEFORE INSERT OR UPDATE ON yaparena.auth_login_transactions
      FOR EACH ROW EXECUTE FUNCTION yaparena.auth_one_use_guard();
    GRANT SELECT,INSERT,DELETE ON yaparena.auth_pending_links,yaparena.auth_login_transactions TO yaparena_runtime;
    GRANT UPDATE(consumed_at) ON yaparena.auth_pending_links,yaparena.auth_login_transactions TO yaparena_runtime;
  `);
  for (const table of ["auth_pending_links", "auth_login_transactions"])
    pgm.sql(`ALTER TABLE yaparena.${table} ENABLE ROW LEVEL SECURITY;
      CREATE POLICY backend_access ON yaparena.${table} TO yaparena_runtime USING(true) WITH CHECK(true)`);
};

export const down = () => {
  throw new Error(
    "Auth0 sign-in mappings must not be rolled back; forward-fix",
  );
};
