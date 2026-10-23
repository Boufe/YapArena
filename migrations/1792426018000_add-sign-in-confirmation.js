export const shorthands = undefined;

// Decision 0009, point 8: a sensitive operation is confirmed by a fresh
// sign-in. The account operation is the one-use, five-minute challenge; the
// callback records which subject of the same account signed in and when.
// Expand only: rows of the previous release keep their credential types.
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE yaparena.account_operations
      ADD COLUMN confirmed_at timestamptz,
      ADD COLUMN confirmed_subject text,
      ADD COLUMN confirmed_auth_time timestamptz;
    ALTER TABLE yaparena.account_operations DROP CONSTRAINT account_operation_credential;
    ALTER TABLE yaparena.account_operations ADD CONSTRAINT account_operation_credential CHECK(
      (credential_type='password' AND authorizing_wallet_id IS NULL AND authorizing_address IS NULL
        AND authorizing_chain_id IS NULL AND authorization_message IS NULL AND authorizing_passkey_id IS NULL)
      OR (credential_type='wallet' AND authorizing_wallet_id IS NOT NULL
        AND authorizing_address ~ '^0x[0-9a-f]{40}$' AND authorizing_chain_id>0
        AND authorization_message IS NOT NULL AND authorizing_passkey_id IS NULL)
      OR (credential_type='passkey' AND authorizing_passkey_id IS NOT NULL
        AND authorizing_wallet_id IS NULL AND authorizing_address IS NULL
        AND authorizing_chain_id IS NULL AND authorization_message IS NULL)
      OR (credential_type='sign_in' AND authorizing_passkey_id IS NULL
        AND authorizing_wallet_id IS NULL AND authorizing_address IS NULL
        AND authorizing_chain_id IS NULL AND authorization_message IS NULL));
    ALTER TABLE yaparena.account_operations ADD CONSTRAINT account_operation_confirmation CHECK(
      (confirmed_at IS NULL AND confirmed_subject IS NULL AND confirmed_auth_time IS NULL)
      OR (credential_type='sign_in' AND confirmed_at IS NOT NULL
        AND confirmed_subject IS NOT NULL AND length(confirmed_subject) BETWEEN 3 AND 256
        AND confirmed_auth_time IS NOT NULL
        AND confirmed_auth_time>=date_trunc('second',created_at)
        AND confirmed_at<expires_at));
    -- Rows start unconfirmed and unconsumed. A sign-in confirmation is set
    -- once before expiry; consumption follows it once, before expiry.
    CREATE FUNCTION yaparena.account_operation_state_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    DECLARE confirmation text[] := ARRAY['confirmed_at','confirmed_subject','confirmed_auth_time'];
    BEGIN
      IF TG_OP='INSERT' THEN
        IF NEW.consumed_at IS NOT NULL OR NEW.confirmed_at IS NOT NULL THEN
          RAISE EXCEPTION 'operation starts unconfirmed and unconsumed' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END IF;
      IF OLD.consumed_at IS NOT NULL OR NEW.expires_at<=clock_timestamp() THEN
        RAISE EXCEPTION 'operation is consumed or expired' USING ERRCODE='23514';
      END IF;
      IF NEW.consumed_at IS NOT NULL THEN
        IF (to_jsonb(NEW)-'consumed_at') IS DISTINCT FROM (to_jsonb(OLD)-'consumed_at')
          OR (OLD.credential_type='sign_in' AND OLD.confirmed_at IS NULL) THEN
          RAISE EXCEPTION 'operation is immutable or unconfirmed' USING ERRCODE='23514';
        END IF;
      ELSIF OLD.credential_type<>'sign_in' OR OLD.confirmed_at IS NOT NULL
        OR NEW.confirmed_at IS NULL
        OR (to_jsonb(NEW)-confirmation) IS DISTINCT FROM (to_jsonb(OLD)-confirmation) THEN
        RAISE EXCEPTION 'operation is immutable or already confirmed' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    REVOKE ALL ON FUNCTION yaparena.account_operation_state_guard() FROM PUBLIC;
    DROP TRIGGER account_operation_guard ON yaparena.account_operations;
    CREATE TRIGGER account_operation_guard BEFORE INSERT OR UPDATE ON yaparena.account_operations
      FOR EACH ROW EXECUTE FUNCTION yaparena.account_operation_state_guard();
    GRANT UPDATE(confirmed_at,confirmed_subject,confirmed_auth_time) ON yaparena.account_operations TO yaparena_runtime;

    -- Opening the coin sandbox is confirmed once by a fresh sign-in; it
    -- replaces the standing "strong method" requirement (founder, 2026-10-23).
    CREATE TABLE yaparena.coin_sandbox_openings (
      user_id bigint PRIMARY KEY REFERENCES yaparena.users(id) ON DELETE CASCADE,
      operation_id uuid NOT NULL UNIQUE,
      opened_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    ALTER TABLE yaparena.coin_sandbox_openings ENABLE ROW LEVEL SECURITY;
    CREATE POLICY backend_access ON yaparena.coin_sandbox_openings TO yaparena_runtime
      USING(true) WITH CHECK(true);
    GRANT SELECT,INSERT ON yaparena.coin_sandbox_openings TO yaparena_runtime;
  `);
};

export const down = () => {
  throw new Error("Sign-in confirmations require a reviewed forward fix");
};
