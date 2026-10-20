export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE yaparena.account_operations (
      id uuid PRIMARY KEY,
      user_id bigint NOT NULL REFERENCES yaparena.users(id) ON DELETE CASCADE,
      session_token_hash char(64) NOT NULL CHECK(session_token_hash ~ '^[0-9a-f]{64}$'),
      auth_generation bigint NOT NULL CHECK(auth_generation>=0),
      purpose text NOT NULL CHECK(purpose ~ '^[a-z][a-z0-9_.]{0,79}$'),
      terms jsonb NOT NULL CHECK(jsonb_typeof(terms)='object'),
      terms_digest char(64) NOT NULL CHECK(terms_digest ~ '^[0-9a-f]{64}$'),
      nonce char(64) NOT NULL CHECK(nonce ~ '^[0-9a-f]{64}$'),
      credential_type text NOT NULL CHECK(credential_type IN ('password','wallet')),
      authorizing_wallet_id uuid,
      authorizing_address char(42),
      authorizing_chain_id bigint,
      authorization_message text,
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CHECK(expires_at>created_at AND expires_at<=created_at+interval '5 minutes'),
      CHECK((credential_type='password' AND authorizing_wallet_id IS NULL
        AND authorizing_address IS NULL AND authorizing_chain_id IS NULL AND authorization_message IS NULL)
        OR (credential_type='wallet' AND authorizing_wallet_id IS NOT NULL
          AND authorizing_address ~ '^0x[0-9a-f]{40}$' AND authorizing_chain_id>0
          AND authorization_message IS NOT NULL))
    );
    CREATE INDEX account_operations_expiry ON yaparena.account_operations(expires_at);
    CREATE FUNCTION yaparena.account_operation_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF TG_OP='INSERT' THEN
        IF NEW.consumed_at IS NOT NULL THEN
          RAISE EXCEPTION 'operation starts unconsumed' USING ERRCODE='23514';
        END IF;
      ELSIF (to_jsonb(NEW)-'consumed_at') IS DISTINCT FROM (to_jsonb(OLD)-'consumed_at')
        OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
        OR NEW.expires_at<=clock_timestamp() THEN
        RAISE EXCEPTION 'operation is immutable, consumed or expired' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    REVOKE ALL ON FUNCTION yaparena.account_operation_guard() FROM PUBLIC;
    CREATE TRIGGER account_operation_guard BEFORE INSERT OR UPDATE ON yaparena.account_operations
      FOR EACH ROW EXECUTE FUNCTION yaparena.account_operation_guard();
    ALTER TABLE yaparena.account_operations ENABLE ROW LEVEL SECURITY;
    CREATE POLICY account_operations_backend ON yaparena.account_operations TO yaparena_runtime
      USING(true) WITH CHECK(true);
    GRANT SELECT,INSERT,DELETE ON yaparena.account_operations TO yaparena_runtime;
    GRANT UPDATE(consumed_at) ON yaparena.account_operations TO yaparena_runtime;
  `);
};

export const down = () => {
  throw new Error("Operation authorization requires a reviewed forward fix");
};
