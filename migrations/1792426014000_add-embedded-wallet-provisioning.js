export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE yaparena.embedded_wallet_provisioning (
      user_id bigint PRIMARY KEY REFERENCES yaparena.users(id) ON DELETE CASCADE,
      subject text NOT NULL CHECK(subject LIKE 'did:privy:%' AND length(subject)<=256),
      external_id text NOT NULL UNIQUE DEFAULT ('yap-evm-' || gen_random_uuid()::text)
        CHECK(length(external_id)<=64 AND external_id ~ '^[A-Za-z0-9_-]+$'),
      chain_type text NOT NULL DEFAULT 'ethereum' CHECK(chain_type='ethereum'),
      state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','ready','retry_wait','review_required')),
      attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),
      attempt_key uuid NOT NULL DEFAULT gen_random_uuid(),
      lease_id uuid,
      lease_until timestamptz NOT NULL DEFAULT '-infinity',
      next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      wallet_id text,
      address text CHECK(address ~ '^0x[0-9a-fA-F]{40}$'),
      last_failure text CHECK(last_failure IN ('provider_unavailable','account_verification','ownership_review','attempts_exhausted')),
      creation_started_at timestamptz,
      completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CHECK((wallet_id IS NULL)=(address IS NULL)),
      CHECK(state<>'ready' OR (wallet_id IS NOT NULL AND completed_at IS NOT NULL)),
      CHECK(state<>'running' OR lease_id IS NOT NULL)
    );
    CREATE INDEX embedded_wallet_provisioning_pending_idx
      ON yaparena.embedded_wallet_provisioning(next_attempt_at,created_at)
      WHERE state IN ('pending','retry_wait','running');
    ALTER TABLE yaparena.embedded_wallet_provisioning ENABLE ROW LEVEL SECURITY;
    CREATE POLICY embedded_wallet_provisioning_runtime
      ON yaparena.embedded_wallet_provisioning TO yaparena_runtime USING(true) WITH CHECK(true);
    GRANT SELECT,INSERT ON yaparena.embedded_wallet_provisioning TO yaparena_runtime;
    GRANT UPDATE(state,attempts,attempt_key,lease_id,lease_until,next_attempt_at,wallet_id,address,last_failure,creation_started_at,completed_at,updated_at)
      ON yaparena.embedded_wallet_provisioning TO yaparena_runtime;
    CREATE FUNCTION yaparena.guard_embedded_wallet_provisioning() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.subject IS DISTINCT FROM OLD.subject
        OR NEW.external_id IS DISTINCT FROM OLD.external_id OR NEW.chain_type IS DISTINCT FROM OLD.chain_type
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'embedded wallet owner and external reference are immutable';
      END IF;
      IF OLD.wallet_id IS NOT NULL AND (NEW.wallet_id IS DISTINCT FROM OLD.wallet_id OR NEW.address IS DISTINCT FROM OLD.address) THEN
        RAISE EXCEPTION 'confirmed embedded wallet cannot be replaced';
      END IF;
      IF OLD.state='ready' AND NEW.state NOT IN ('ready','review_required') THEN
        RAISE EXCEPTION 'confirmed embedded wallet cannot be provisioned again';
      END IF;
      RETURN NEW;
    END $$;
    REVOKE ALL ON FUNCTION yaparena.guard_embedded_wallet_provisioning() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION yaparena.guard_embedded_wallet_provisioning() TO yaparena_runtime;
    CREATE TRIGGER embedded_wallet_provisioning_immutable BEFORE UPDATE ON yaparena.embedded_wallet_provisioning
      FOR EACH ROW EXECUTE FUNCTION yaparena.guard_embedded_wallet_provisioning();
    -- Existing verified provider accounts receive the same durable job as new
    -- signup. Retained accounts without a Privy mapping are not changed. The
    -- worker rechecks accepted credentials and generation before provider IO.
    INSERT INTO yaparena.embedded_wallet_provisioning(user_id,subject)
      SELECT u.id,p.subject FROM yaparena.users u JOIN yaparena.provider_identities p ON p.user_id=u.id
      WHERE p.provider='privy' AND u.account_status='active' AND p.auth_generation=u.auth_generation;
  `);
};

// Keep the durable external-operation references when rolling back app code.
export const down = () => {
  throw new Error(
    "Embedded wallet references are retained; use a compatible forward migration",
  );
};
