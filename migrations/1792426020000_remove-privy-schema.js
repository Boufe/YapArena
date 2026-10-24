export const shorthands = undefined;

// Decision 0009, prompt 12 schema change: drop the Privy, passkey and
// embedded-wallet schema after the code that used it was deleted. The
// previous release no longer reads or writes any of it. Kept: sessions,
// auth_generation, account_status, auth_controls, account_operations and all
// coin_* history.
export const up = (pgm) => {
  pgm.sql(`
    -- Take the strongest locks first, in one order, so no runtime write can
    -- slip between the checks and the drops.
    LOCK TABLE yaparena.users, yaparena.provider_identities,
      yaparena.provider_revocation_jobs, yaparena.account_operations,
      yaparena.account_security_keys IN ACCESS EXCLUSIVE MODE;

    -- An unfinished provider freeze/unfreeze job is an unresolved incident.
    -- Refuse instead of dropping its record.
    DO $$
    DECLARE unfinished text;
    BEGIN
      SELECT string_agg(format('account %s: %s/%s', user_id, state, control_phase),
          '; ' ORDER BY user_id, generation) INTO unfinished
        FROM yaparena.provider_revocation_jobs WHERE state <> 'complete';
      IF unfinished IS NOT NULL THEN
        RAISE EXCEPTION 'unfinished provider revocation jobs remain; resolve them first'
          USING ERRCODE = '55000', DETAIL = unfinished;
      END IF;
    END $$;

    -- Functions that name dropped objects go first, with their triggers.
    -- PostgreSQL does not track names inside function bodies.
    DROP TRIGGER enqueue_provider_revocation ON yaparena.users;
    DROP FUNCTION yaparena.enqueue_provider_revocation();
    DROP TRIGGER zz_account_generation_clock ON yaparena.users;
    DROP FUNCTION yaparena.account_generation_clock();

    -- Provider freeze/unfreeze jobs, including their control-phase columns.
    DROP TABLE yaparena.provider_revocation_jobs;

    -- Passkeys. Operations approved by a passkey, wallet or password came only
    -- from removed flows and can no longer be confirmed or consumed.
    DO $$
    DECLARE removed bigint;
    BEGIN
      DELETE FROM yaparena.account_operations WHERE credential_type <> 'sign_in';
      GET DIAGNOSTICS removed = ROW_COUNT;
      RAISE NOTICE 'deleted % account operations from removed approval flows', removed;
    END $$;
    ALTER TABLE yaparena.account_operations DROP CONSTRAINT account_operation_credential;
    ALTER TABLE yaparena.account_operations DROP COLUMN authorizing_passkey_id;
    ALTER TABLE yaparena.account_operations ADD CONSTRAINT account_operation_credential CHECK (
      (credential_type = 'password' AND authorizing_wallet_id IS NULL
        AND authorizing_address IS NULL AND authorizing_chain_id IS NULL
        AND authorization_message IS NULL)
      OR (credential_type = 'wallet' AND authorizing_wallet_id IS NOT NULL
        AND authorizing_address ~ '^0x[0-9a-f]{40}$' AND authorizing_chain_id > 0
        AND authorization_message IS NOT NULL)
      OR (credential_type = 'sign_in' AND authorizing_wallet_id IS NULL
        AND authorizing_address IS NULL AND authorizing_chain_id IS NULL
        AND authorization_message IS NULL));
    DROP TABLE yaparena.provider_passkey_bootstraps;
    DROP TABLE yaparena.provider_passkey_intents;
    DROP TABLE yaparena.account_security_challenges;
    DROP TABLE yaparena.account_access_challenges;
    DROP TABLE yaparena.account_security_keys;
    DROP TABLE yaparena.account_security_users;
    DROP FUNCTION yaparena.provider_passkey_bootstrap_guard();
    DROP FUNCTION yaparena.provider_passkey_intent_guard();
    DROP FUNCTION yaparena.security_key_guard();
    DROP FUNCTION yaparena.security_key_revoke_sessions();
    DROP FUNCTION yaparena.account_operation_guard();

    -- Privy session exchanges and embedded-wallet provisioning.
    DROP TABLE yaparena.provider_session_exchanges;
    DROP TABLE yaparena.embedded_wallet_provisioning;
    DROP FUNCTION yaparena.guard_embedded_wallet_provisioning();

    -- The generation clock existed only for app-passkey login.
    ALTER TABLE yaparena.users DROP COLUMN auth_changed_at;

    -- Provider identities: Auth0 only.
    DO $$
    DECLARE linked bigint; unlinked bigint;
    BEGIN
      SELECT count(*) FILTER (WHERE user_id IS NOT NULL),
          count(*) FILTER (WHERE user_id IS NULL)
        INTO linked, unlinked
        FROM yaparena.provider_identities WHERE provider = 'privy';
      DELETE FROM yaparena.provider_identities WHERE provider = 'privy';
      RAISE NOTICE 'deleted % linked and % unlinked Privy identities', linked, unlinked;
    END $$;
    ALTER TABLE yaparena.provider_identities DROP CONSTRAINT provider_identities_privy_state;
    ALTER TABLE yaparena.provider_identities DROP CONSTRAINT provider_identities_provider;
    ALTER TABLE yaparena.provider_identities
      ADD CONSTRAINT provider_identities_provider CHECK (provider = 'auth0');
    ALTER TABLE yaparena.provider_identities
      DROP COLUMN auth_generation,
      DROP COLUMN minimum_issued_at,
      DROP COLUMN credentials_digest,
      DROP COLUMN credentials_snapshot,
      DROP COLUMN checked_at;

    -- No remaining function may name a dropped object or column.
    DO $$
    DECLARE offenders text;
    BEGIN
      SELECT string_agg(n.nspname || '.' || p.proname, ', ' ORDER BY n.nspname, p.proname)
        INTO offenders
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND n.nspname NOT LIKE 'pg\\_%'
         AND (p.prosrc ~* '\\m(provider_revocation_jobs|provider_passkey_bootstraps|provider_passkey_intents|provider_session_exchanges|account_security_keys|account_security_users|account_security_challenges|account_access_challenges|embedded_wallet_provisioning|auth_changed_at|minimum_issued_at|credentials_digest|credentials_snapshot|authorizing_passkey_id|privy)\\M'
           OR (p.prosrc ~* '\\mprovider_identities\\M'
             AND p.prosrc ~* '\\m(auth_generation|checked_at)\\M'));
      IF offenders IS NOT NULL THEN
        RAISE EXCEPTION 'functions still name dropped Privy objects: %', offenders
          USING ERRCODE = '55000';
      END IF;
    END $$;
  `);
};

export const down = () => {
  throw new Error(
    "Removed Privy and wallet data cannot be restored by rollback",
  );
};
