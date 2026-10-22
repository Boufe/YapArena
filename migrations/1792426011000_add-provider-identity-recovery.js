export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE yaparena.provider_revocation_jobs DROP CONSTRAINT provider_revocation_jobs_failure_reason_check;
    ALTER TABLE yaparena.provider_revocation_jobs ADD CONSTRAINT provider_revocation_jobs_failure_reason_check
      CHECK(failure_reason IN ('independent_provider_freeze','uncertain_provider_outcome','inherited_manual','retired_identity'));
    CREATE TABLE yaparena.provider_identity_recoveries (
      id uuid PRIMARY KEY,
      user_id bigint NOT NULL REFERENCES yaparena.account_subjects(id) ON DELETE RESTRICT,
      provider text NOT NULL DEFAULT 'privy' CHECK(provider='privy'),
      old_subject text NOT NULL UNIQUE,
      old_method text NOT NULL CHECK(old_method IN ('email','google_oauth')),
      new_subject text NOT NULL UNIQUE,
      old_credentials_digest char(64) NOT NULL,
      new_credentials_digest char(64) NOT NULL,
      new_session_digest char(64) NOT NULL,
      terms_digest char(64) NOT NULL,
      old_auth_generation bigint NOT NULL,
      new_auth_generation bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CHECK(old_subject<>new_subject AND new_auth_generation=old_auth_generation+1),
      FOREIGN KEY(provider,old_subject) REFERENCES yaparena.provider_identities(provider,subject) ON DELETE RESTRICT,
      FOREIGN KEY(provider,new_subject) REFERENCES yaparena.provider_identities(provider,subject) ON DELETE RESTRICT
    );
    CREATE FUNCTION yaparena.provider_identity_recovery_history_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      RAISE EXCEPTION 'provider recovery history is immutable' USING ERRCODE='23514';
    END $$;
    CREATE TRIGGER provider_identity_recovery_history_guard BEFORE UPDATE OR DELETE ON yaparena.provider_identity_recoveries
      FOR EACH ROW EXECUTE FUNCTION yaparena.provider_identity_recovery_history_guard();
    CREATE FUNCTION yaparena.provider_identity_owner_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF NEW.user_id IS NOT NULL AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
        RAISE EXCEPTION 'provider identity ownership cannot be reassigned' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER provider_identity_owner_guard BEFORE UPDATE OF user_id ON yaparena.provider_identities
      FOR EACH ROW EXECUTE FUNCTION yaparena.provider_identity_owner_guard();
    CREATE FUNCTION yaparena.require_consumed_provider_recovery() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    DECLARE proof yaparena.account_operations%ROWTYPE;
    BEGIN
      SELECT * INTO proof FROM yaparena.account_operations WHERE id=NEW.id;
      IF NOT FOUND OR proof.purpose<>'provider.identity.recover' OR proof.credential_type<>'passkey'
        OR proof.user_id<>NEW.user_id OR proof.auth_generation<>NEW.old_auth_generation
        OR proof.consumed_at IS NULL OR proof.consumed_at>=proof.expires_at
        OR proof.terms_digest<>NEW.terms_digest
        OR proof.terms->>'oldSubject'<>NEW.old_subject OR proof.terms->>'newSubject'<>NEW.new_subject
        OR proof.terms->>'oldMethod'<>NEW.old_method
        OR proof.terms->>'oldCredentialsDigest'<>NEW.old_credentials_digest
        OR proof.terms->>'newCredentialsDigest'<>NEW.new_credentials_digest
        OR proof.terms->>'newSessionDigest'<>NEW.new_session_digest THEN
        RAISE EXCEPTION 'provider recovery requires its consumed passkey proof' USING ERRCODE='23514';
      END IF;
      RETURN NULL;
    END $$;
    CREATE CONSTRAINT TRIGGER require_consumed_provider_recovery AFTER INSERT ON yaparena.provider_identity_recoveries
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION yaparena.require_consumed_provider_recovery();
    CREATE FUNCTION yaparena.apply_provider_identity_recovery(proof_id uuid) RETURNS bigint LANGUAGE plpgsql
      SECURITY DEFINER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    DECLARE proof yaparena.account_operations%ROWTYPE; identity text; next_generation bigint;
    BEGIN
      SELECT * INTO proof FROM yaparena.account_operations WHERE id=proof_id;
      IF NOT FOUND OR proof.purpose<>'provider.identity.recover' OR proof.credential_type<>'passkey' THEN
        RAISE EXCEPTION 'provider recovery unavailable' USING ERRCODE='23514';
      END IF;
      FOR identity IN SELECT value FROM (VALUES(proof.terms->>'oldSubject'),(proof.terms->>'newSubject')) x(value)
        ORDER BY value COLLATE "C" LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended('privy:'||identity,0));
      END LOOP;
      PERFORM 1 FROM yaparena.users WHERE id=proof.user_id AND account_status='active'
        AND auth_generation=proof.auth_generation FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'provider recovery unavailable' USING ERRCODE='23514'; END IF;
      PERFORM 1 FROM yaparena.sessions WHERE user_id=proof.user_id AND token_hash=proof.session_token_hash
        AND auth_generation=proof.auth_generation AND expires_at>clock_timestamp() FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'provider recovery unavailable' USING ERRCODE='23514'; END IF;
      SELECT * INTO proof FROM yaparena.account_operations WHERE id=proof_id FOR UPDATE;
      IF proof.consumed_at IS NOT NULL OR proof.expires_at<=clock_timestamp()
        OR proof.terms->>'provider'<>'privy' OR proof.terms->>'accountId'<>proof.user_id::text
        OR proof.terms->>'oldSubject'=proof.terms->>'newSubject'
        OR (SELECT count(*) FROM jsonb_object_keys(proof.terms))<>10
        OR EXISTS(SELECT 1 FROM jsonb_each(proof.terms) WHERE jsonb_typeof(value)<>'string')
        OR NOT (proof.terms ?& ARRAY['provider','accountId','oldSubject','newSubject','oldCredentialsDigest','newCredentialsDigest','newSessionDigest','oldMethod','oldIdentifier','newEmail'])
        OR proof.terms->>'newSessionDigest' !~ '^[0-9a-f]{64}$'
        OR proof.terms->>'newCredentialsDigest' !~ '^[0-9a-f]{64}$'
        OR length(proof.terms->>'newEmail') NOT BETWEEN 3 AND 320
        OR proof.terms->>'oldMethod' NOT IN ('email','google_oauth')
        OR (proof.terms->>'oldMethod'='email' AND lower(proof.terms->>'newEmail')=lower(proof.terms->>'oldIdentifier')) THEN
        RAISE EXCEPTION 'provider recovery unavailable' USING ERRCODE='23514';
      END IF;
      PERFORM 1 FROM yaparena.account_security_keys WHERE id=proof.authorizing_passkey_id
        AND user_id=proof.user_id AND revoked_at IS NULL FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'provider recovery unavailable' USING ERRCODE='23514'; END IF;
      PERFORM 1 FROM yaparena.provider_identities WHERE provider='privy' AND subject=proof.terms->>'oldSubject'
        AND user_id=proof.user_id AND credentials_digest=proof.terms->>'oldCredentialsDigest'
        AND methods=jsonb_build_array(proof.terms->>'oldMethod')
        AND (credentials_snapshot=jsonb_build_array(jsonb_build_object('type',proof.terms->>'oldMethod','id',proof.terms->>'oldIdentifier'))
          OR (credentials_snapshot IS NULL AND proof.terms->>'oldMethod'='email' AND email=proof.terms->>'oldIdentifier'));
      IF NOT FOUND OR EXISTS(SELECT 1 FROM yaparena.provider_identities WHERE provider='privy' AND subject=proof.terms->>'newSubject') THEN
        RAISE EXCEPTION 'provider recovery unavailable' USING ERRCODE='23514';
      END IF;
      -- This definer has one narrow privilege the runtime does not: retiring an
      -- active mapping. A NULL owner can never be rebound, even by owner UPDATE.
      UPDATE yaparena.provider_identities SET user_id=NULL,email=NULL,methods='[]'::jsonb,credentials_snapshot=NULL
        WHERE provider='privy' AND subject=proof.terms->>'oldSubject' AND user_id=proof.user_id;
      -- With no mapping attached, this generation change does not enqueue old
      -- provider control for the replacement identity. Session/media triggers run.
      UPDATE yaparena.users SET auth_generation=auth_generation+1 WHERE id=proof.user_id
        RETURNING auth_generation INTO next_generation;
      DELETE FROM yaparena.sessions WHERE user_id=proof.user_id;
      UPDATE yaparena.provider_revocation_jobs SET state='complete',failure_reason='retired_identity',lease_until='-infinity'
        WHERE user_id=proof.user_id AND subject=proof.terms->>'oldSubject';
      INSERT INTO yaparena.provider_identities(provider,subject,user_id,email,methods,auth_generation,minimum_issued_at,credentials_digest,credentials_snapshot)
        VALUES('privy',proof.terms->>'newSubject',proof.user_id,proof.terms->>'newEmail','["email"]'::jsonb,next_generation,0,
          proof.terms->>'newCredentialsDigest',jsonb_build_array(jsonb_build_object('type','email','id',proof.terms->>'newEmail')));
      INSERT INTO yaparena.provider_session_exchanges(provider,subject,session_digest,user_id)
        VALUES('privy',proof.terms->>'newSubject',proof.terms->>'newSessionDigest',proof.user_id);
      INSERT INTO yaparena.provider_identity_recoveries(id,user_id,old_subject,old_method,new_subject,old_credentials_digest,new_credentials_digest,
        new_session_digest,terms_digest,old_auth_generation,new_auth_generation)
        VALUES(proof.id,proof.user_id,proof.terms->>'oldSubject',proof.terms->>'oldMethod',proof.terms->>'newSubject',proof.terms->>'oldCredentialsDigest',
          proof.terms->>'newCredentialsDigest',proof.terms->>'newSessionDigest',proof.terms_digest,proof.auth_generation,next_generation);
      RETURN next_generation;
    END $$;
    REVOKE ALL ON FUNCTION yaparena.provider_identity_recovery_history_guard(),yaparena.provider_identity_owner_guard(),
      yaparena.require_consumed_provider_recovery(),yaparena.apply_provider_identity_recovery(uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION yaparena.apply_provider_identity_recovery(uuid) TO yaparena_runtime;
    GRANT SELECT ON yaparena.provider_identity_recoveries TO yaparena_runtime;
    ALTER TABLE yaparena.provider_identity_recoveries ENABLE ROW LEVEL SECURITY;
    CREATE POLICY backend_read ON yaparena.provider_identity_recoveries FOR SELECT TO yaparena_runtime USING(true);
  `);
};

export const down = () => {
  throw new Error(
    "Retired provider identities cannot be restored; forward-fix",
  );
};
