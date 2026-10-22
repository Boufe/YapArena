export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE yaparena.users ADD COLUMN auth_changed_at timestamptz NOT NULL DEFAULT clock_timestamp();
    CREATE FUNCTION yaparena.account_generation_clock() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF NEW.auth_generation IS DISTINCT FROM OLD.auth_generation THEN
        NEW.auth_changed_at := clock_timestamp();
      ELSIF NEW.auth_changed_at IS DISTINCT FROM OLD.auth_changed_at THEN
        RAISE EXCEPTION 'account generation clock is database controlled' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    -- Run after existing BEFORE triggers which can advance the generation.
    CREATE TRIGGER zz_account_generation_clock BEFORE UPDATE ON yaparena.users
      FOR EACH ROW EXECUTE FUNCTION yaparena.account_generation_clock();
    REVOKE ALL ON FUNCTION yaparena.account_generation_clock() FROM PUBLIC;
    ALTER TABLE yaparena.provider_identities ADD COLUMN credentials_snapshot jsonb
      CHECK(credentials_snapshot IS NULL OR jsonb_typeof(credentials_snapshot)='array');
    GRANT UPDATE(credentials_digest,credentials_snapshot) ON yaparena.provider_identities TO yaparena_runtime;
    CREATE TABLE yaparena.account_access_challenges (
      id uuid PRIMARY KEY,
      user_id bigint REFERENCES yaparena.users(id) ON DELETE CASCADE,
      auth_generation bigint CHECK(auth_generation>=0),
      purpose text NOT NULL CHECK(purpose IN ('security.login','provider.credentials.reconcile')),
      nonce char(64) NOT NULL CHECK(nonce ~ '^[0-9a-f]{64}$'),
      provider_subject text,
      provider_session_digest char(64) CHECK(provider_session_digest ~ '^[0-9a-f]{64}$'),
      old_credentials_digest char(64) CHECK(old_credentials_digest ~ '^[0-9a-f]{64}$'),
      new_credentials_digest char(64) CHECK(new_credentials_digest ~ '^[0-9a-f]{64}$'),
      new_credentials_snapshot jsonb CHECK(jsonb_typeof(new_credentials_snapshot)='array'),
      credential_type text NOT NULL CHECK(credential_type IN ('passkey','wallet','password')),
      authorizing_passkey_ids uuid[] NOT NULL DEFAULT '{}',
      authorizing_wallet_id uuid,
      authorizing_address text,
      authorizing_chain_id bigint,
      authorization_message text,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      CHECK(expires_at>created_at AND expires_at<=created_at+interval '5 minutes'),
      CHECK((purpose='security.login' AND user_id IS NULL AND auth_generation IS NULL
        AND provider_subject IS NULL AND provider_session_digest IS NULL
        AND old_credentials_digest IS NULL AND new_credentials_digest IS NULL
        AND new_credentials_snapshot IS NULL AND credential_type='passkey'
        AND cardinality(authorizing_passkey_ids)=0 AND authorizing_wallet_id IS NULL
        AND authorizing_address IS NULL AND authorizing_chain_id IS NULL AND authorization_message IS NULL)
        OR (purpose='provider.credentials.reconcile' AND user_id IS NOT NULL AND auth_generation IS NOT NULL
          AND provider_subject IS NOT NULL AND provider_session_digest IS NOT NULL
          AND old_credentials_digest IS NOT NULL AND new_credentials_digest IS NOT NULL
          AND new_credentials_snapshot IS NOT NULL AND
          ((credential_type='passkey' AND cardinality(authorizing_passkey_ids)>0
            AND authorizing_wallet_id IS NULL AND authorizing_address IS NULL
            AND authorizing_chain_id IS NULL AND authorization_message IS NULL)
          OR (credential_type='password' AND cardinality(authorizing_passkey_ids)=0
            AND authorizing_wallet_id IS NULL AND authorizing_address IS NULL
            AND authorizing_chain_id IS NULL AND authorization_message IS NULL)
          OR (credential_type='wallet' AND cardinality(authorizing_passkey_ids)=0
            AND authorizing_wallet_id IS NOT NULL AND authorizing_address ~ '^0x[0-9a-f]{40}$'
            AND authorizing_chain_id>0 AND authorization_message IS NOT NULL))))
    );
    CREATE TRIGGER account_access_challenge_guard BEFORE INSERT OR UPDATE ON yaparena.account_access_challenges
      FOR EACH ROW EXECUTE FUNCTION yaparena.account_operation_guard();
    GRANT SELECT,INSERT,DELETE ON yaparena.account_access_challenges TO yaparena_runtime;
    GRANT UPDATE(consumed_at) ON yaparena.account_access_challenges TO yaparena_runtime;
    ALTER TABLE yaparena.account_access_challenges ENABLE ROW LEVEL SECURITY;
    CREATE POLICY backend_access ON yaparena.account_access_challenges TO yaparena_runtime USING(true) WITH CHECK(true);
  `);
};

export const down = () => {
  throw new Error("Account recovery history requires a reviewed forward fix");
};
