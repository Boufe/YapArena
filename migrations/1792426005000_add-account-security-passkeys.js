export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE yaparena.provider_revocation_jobs ADD COLUMN confirmed_frozen_at bigint
      CHECK(confirmed_frozen_at>0);
    ALTER TABLE yaparena.provider_revocation_jobs ADD COLUMN failure_reason text
      CHECK(failure_reason IN ('independent_provider_freeze','uncertain_provider_outcome','inherited_manual'));
    CREATE TABLE yaparena.account_security_users (
      user_id bigint PRIMARY KEY REFERENCES yaparena.users(id) ON DELETE CASCADE,
      user_handle text NOT NULL UNIQUE CHECK(user_handle ~ '^[A-Za-z0-9_-]{43}$')
    );
    CREATE TABLE yaparena.account_security_keys (
      id uuid PRIMARY KEY,
      user_id bigint NOT NULL REFERENCES yaparena.users(id) ON DELETE CASCADE,
      credential_id text NOT NULL UNIQUE CHECK(length(credential_id) BETWEEN 1 AND 2048),
      public_key bytea NOT NULL CHECK(octet_length(public_key) BETWEEN 16 AND 4096),
      counter bigint NOT NULL CHECK(counter>=0 AND counter<=9007199254740991),
      device_type text NOT NULL CHECK(device_type IN ('singleDevice','multiDevice')),
      backed_up boolean NOT NULL,
      transports text[] NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      revoked_at timestamptz,
      CHECK(device_type='multiDevice' OR NOT backed_up)
    );
    CREATE FUNCTION yaparena.security_key_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF TG_OP='INSERT' THEN
        IF NEW.revoked_at IS NOT NULL THEN
          RAISE EXCEPTION 'security key starts active' USING ERRCODE='23514';
        END IF;
      ELSIF (to_jsonb(NEW)-ARRAY['counter','backed_up','revoked_at']) IS DISTINCT FROM
          (to_jsonb(OLD)-ARRAY['counter','backed_up','revoked_at'])
        OR OLD.revoked_at IS NOT NULL OR NEW.counter<OLD.counter THEN
        RAISE EXCEPTION 'security key identity is immutable or revoked' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER security_key_guard BEFORE INSERT OR UPDATE ON yaparena.account_security_keys
      FOR EACH ROW EXECUTE FUNCTION yaparena.security_key_guard();
    CREATE FUNCTION yaparena.security_key_revoke_sessions() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF TG_OP='INSERT' OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
        UPDATE yaparena.users SET auth_generation=auth_generation+1 WHERE id=NEW.user_id;
        DELETE FROM yaparena.sessions WHERE user_id=NEW.user_id;
        INSERT INTO yaparena.identity_audit_events(user_id,event_type,subject_id,metadata)
        VALUES(NEW.user_id,CASE WHEN TG_OP='INSERT' THEN 'security.passkey.enrolled'
          ELSE 'security.passkey.revoked' END,NEW.id::text,jsonb_build_object('outcome','success'));
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER security_key_revoke_sessions AFTER INSERT OR UPDATE ON yaparena.account_security_keys
      FOR EACH ROW EXECUTE FUNCTION yaparena.security_key_revoke_sessions();
    CREATE TABLE yaparena.account_security_challenges (
      id uuid PRIMARY KEY,
      user_id bigint NOT NULL REFERENCES yaparena.users(id) ON DELETE CASCADE,
      session_token_hash char(64) NOT NULL CHECK(session_token_hash ~ '^[0-9a-f]{64}$'),
      auth_generation bigint NOT NULL CHECK(auth_generation>=0),
      challenge text NOT NULL CHECK(length(challenge) BETWEEN 32 AND 256),
      user_handle text NOT NULL,
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CHECK(expires_at>created_at AND expires_at<=created_at+interval '5 minutes')
    );
    CREATE TRIGGER security_challenge_guard BEFORE INSERT OR UPDATE ON yaparena.account_security_challenges
      FOR EACH ROW EXECUTE FUNCTION yaparena.account_operation_guard();
    ALTER TABLE yaparena.account_operations ADD COLUMN authorizing_passkey_id uuid
      REFERENCES yaparena.account_security_keys(id);
    DO $$ DECLARE item record; BEGIN
      FOR item IN SELECT conname FROM pg_constraint
        WHERE conrelid='yaparena.account_operations'::regclass AND contype='c'
          AND pg_get_constraintdef(oid) LIKE '%credential_type%'
      LOOP EXECUTE format('ALTER TABLE yaparena.account_operations DROP CONSTRAINT %I',item.conname); END LOOP;
    END $$;
    ALTER TABLE yaparena.account_operations ADD CONSTRAINT account_operation_credential CHECK(
      (credential_type='password' AND authorizing_wallet_id IS NULL AND authorizing_address IS NULL
        AND authorizing_chain_id IS NULL AND authorization_message IS NULL AND authorizing_passkey_id IS NULL)
      OR (credential_type='wallet' AND authorizing_wallet_id IS NOT NULL
        AND authorizing_address ~ '^0x[0-9a-f]{40}$' AND authorizing_chain_id>0
        AND authorization_message IS NOT NULL AND authorizing_passkey_id IS NULL)
      OR (credential_type='passkey' AND authorizing_passkey_id IS NOT NULL
        AND authorizing_wallet_id IS NULL AND authorizing_address IS NULL
        AND authorizing_chain_id IS NULL AND authorization_message IS NULL));
    REVOKE ALL ON FUNCTION yaparena.security_key_guard(),yaparena.security_key_revoke_sessions() FROM PUBLIC;
    GRANT SELECT,INSERT ON yaparena.account_security_users,yaparena.account_security_keys TO yaparena_runtime;
    GRANT UPDATE(counter,backed_up,revoked_at) ON yaparena.account_security_keys TO yaparena_runtime;
    GRANT SELECT,INSERT,DELETE ON yaparena.account_security_challenges TO yaparena_runtime;
    GRANT UPDATE(consumed_at) ON yaparena.account_security_challenges TO yaparena_runtime;
  `);
  for (const table of [
    "account_security_users",
    "account_security_keys",
    "account_security_challenges",
  ])
    pgm.sql(`ALTER TABLE yaparena.${table} ENABLE ROW LEVEL SECURITY;
      CREATE POLICY backend_access ON yaparena.${table} TO yaparena_runtime USING(true) WITH CHECK(true)`);
};

export const down = () => {
  throw new Error(
    "Security credential history requires a reviewed forward fix",
  );
};
