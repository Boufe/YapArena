export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE yaparena.provider_passkey_bootstraps (
      id uuid PRIMARY KEY,
      user_id bigint NOT NULL REFERENCES yaparena.users(id) ON DELETE CASCADE,
      original_intent_id uuid NOT NULL REFERENCES yaparena.provider_passkey_intents(id) ON DELETE CASCADE,
      auth_generation bigint NOT NULL CHECK(auth_generation>=0),
      provider_subject text NOT NULL,
      provider_session_digest char(64) NOT NULL CHECK(provider_session_digest ~ '^[0-9a-f]{64}$'),
      before_digest char(64) NOT NULL CHECK(before_digest ~ '^[0-9a-f]{64}$'),
      after_digest char(64) NOT NULL CHECK(after_digest ~ '^[0-9a-f]{64}$'),
      credential_id text NOT NULL CHECK(length(credential_id) BETWEEN 1 AND 2048 AND credential_id ~ '^[A-Za-z0-9_-]+$'),
      public_key bytea NOT NULL CHECK(octet_length(public_key) BETWEEN 16 AND 4096),
      public_key_digest char(64) NOT NULL CHECK(public_key_digest ~ '^[0-9a-f]{64}$'),
      origin text NOT NULL,
      rp_id text NOT NULL CHECK(length(rp_id) BETWEEN 1 AND 253),
      challenge text NOT NULL CHECK(challenge ~ '^[A-Za-z0-9_-]{43}$'),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      CHECK(expires_at>created_at AND expires_at<=created_at+interval '5 minutes'),
      CHECK(consumed_at IS NULL OR (consumed_at>=created_at AND consumed_at<expires_at))
    );
    CREATE UNIQUE INDEX provider_passkey_bootstrap_once ON yaparena.provider_passkey_bootstraps(user_id)
      WHERE consumed_at IS NOT NULL;
    CREATE INDEX provider_passkey_bootstrap_expiry ON yaparena.provider_passkey_bootstraps(expires_at);
    CREATE FUNCTION yaparena.provider_passkey_bootstrap_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF TG_OP='INSERT' THEN
        IF NEW.consumed_at IS NOT NULL THEN
          RAISE EXCEPTION 'bootstrap cannot be preconsumed' USING ERRCODE='23514';
        END IF;
      ELSIF OLD.consumed_at IS NOT NULL OR (to_jsonb(NEW)-'consumed_at') IS DISTINCT FROM (to_jsonb(OLD)-'consumed_at') THEN
        RAISE EXCEPTION 'bootstrap authorization is immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER provider_passkey_bootstrap_guard BEFORE INSERT OR UPDATE ON yaparena.provider_passkey_bootstraps
      FOR EACH ROW EXECUTE FUNCTION yaparena.provider_passkey_bootstrap_guard();
    REVOKE ALL ON FUNCTION yaparena.provider_passkey_bootstrap_guard() FROM PUBLIC;
    GRANT SELECT,INSERT ON yaparena.provider_passkey_bootstraps TO yaparena_runtime;
    GRANT UPDATE(consumed_at) ON yaparena.provider_passkey_bootstraps TO yaparena_runtime;
    ALTER TABLE yaparena.provider_passkey_bootstraps ENABLE ROW LEVEL SECURITY;
    CREATE POLICY backend_all ON yaparena.provider_passkey_bootstraps TO yaparena_runtime USING(true) WITH CHECK(true);
  `);
};

export const down = () => {
  throw new Error("Provider passkey bootstrap requires a forward fix");
};
