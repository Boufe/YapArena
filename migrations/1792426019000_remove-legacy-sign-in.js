export const shorthands = undefined;

// Decision 0009, PR B: remove the legacy sign-in schema after the staging
// reset. PR A stopped every read and write of these objects. The reset deleted
// every account holding a password, wallet or native passkey, so this
// migration refuses while one remains and names the accounts instead of
// deleting credentials. Privy passkey rows and their tables stay until
// prompt 12 deletes the Privy code.
export const up = (pgm) => {
  pgm.sql(`
    -- Take the strongest locks first, in one order, so no runtime write can
    -- slip between the check and the drops.
    LOCK TABLE yaparena.users, yaparena.wallet_identities,
      yaparena.account_security_keys IN ACCESS EXCLUSIVE MODE;

    DO $$
    DECLARE passwords text; wallets text; passkeys text;
    BEGIN
      SELECT string_agg(id::text, ',' ORDER BY id) INTO passwords
        FROM yaparena.users WHERE password_hash IS NOT NULL;
      SELECT string_agg(DISTINCT user_id::text, ',' ORDER BY user_id::text) INTO wallets
        FROM yaparena.wallet_identities;
      SELECT string_agg(DISTINCT user_id::text, ',' ORDER BY user_id::text) INTO passkeys
        FROM yaparena.account_security_keys WHERE provenance = 'yaparena';
      IF passwords IS NOT NULL OR wallets IS NOT NULL OR passkeys IS NOT NULL THEN
        RAISE EXCEPTION 'legacy sign-in credentials remain; reset these accounts first'
          USING ERRCODE = '55000',
            DETAIL = format('account IDs with a password: %s; with a wallet: %s; with a native passkey: %s',
              coalesce(passwords, 'none'), coalesce(wallets, 'none'), coalesce(passkeys, 'none'));
      END IF;
    END $$;

    -- Passwords. The trigger that revoked sessions on a password or email
    -- change also kept the account generation from decreasing; that guard
    -- moves to its own trigger.
    DROP TRIGGER users_revoke_changed_password ON yaparena.users;
    DROP FUNCTION yaparena.revoke_changed_password();
    CREATE FUNCTION yaparena.account_generation_monotonic() RETURNS trigger
      LANGUAGE plpgsql SET search_path TO pg_catalog, yaparena, pg_temp AS $$
    BEGIN
      IF NEW.auth_generation < OLD.auth_generation THEN
        RAISE EXCEPTION 'authentication generation cannot decrease';
      END IF;
      RETURN NEW;
    END $$;
    REVOKE ALL ON FUNCTION yaparena.account_generation_monotonic() FROM PUBLIC;
    CREATE TRIGGER users_generation_monotonic BEFORE UPDATE ON yaparena.users
      FOR EACH ROW EXECUTE FUNCTION yaparena.account_generation_monotonic();
    ALTER TABLE yaparena.users DROP CONSTRAINT users_email_password_pair;
    ALTER TABLE yaparena.users DROP COLUMN password_hash;

    -- Wallet sign-in and wallet credential operations.
    DROP TABLE yaparena.wallet_operations;
    DROP TABLE yaparena.wallet_challenges;
    DROP TABLE yaparena.wallet_identities;
    DROP FUNCTION yaparena.revoke_removed_wallet();

    -- Native passkeys: no key remains (checked above); their challenges and
    -- the legacy access challenges were issued only by removed flows.
    DELETE FROM yaparena.account_security_challenges;
    DELETE FROM yaparena.account_access_challenges;
    ALTER TABLE yaparena.account_security_keys
      ADD CONSTRAINT security_key_privy_only CHECK (provenance = 'privy');

    -- Provider identity recovery. Its history rows reference retained
    -- subjects, so the reset keeps them; they go with the table.
    DO $$
    DECLARE dropped bigint;
    BEGIN
      SELECT count(*) INTO dropped FROM yaparena.provider_identity_recoveries;
      RAISE NOTICE 'dropping % provider identity recovery history rows', dropped;
    END $$;
    DROP FUNCTION yaparena.apply_provider_identity_recovery(uuid);
    DROP TABLE yaparena.provider_identity_recoveries;
    DROP FUNCTION yaparena.provider_identity_recovery_history_guard();
    DROP FUNCTION yaparena.require_consumed_provider_recovery();
  `);
};

export const down = () => {
  throw new Error("Removed legacy sign-in data cannot be restored by rollback");
};
