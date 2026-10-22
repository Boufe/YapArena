export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE yaparena.account_security_keys
      ADD COLUMN provenance text NOT NULL DEFAULT 'yaparena' CHECK(provenance IN ('yaparena','privy')),
      ADD COLUMN provider_subject text,
      ADD COLUMN provider_public_key_digest char(64),
      ADD COLUMN rp_id text,
      ADD CONSTRAINT security_key_provider_provenance CHECK(
        (provenance='yaparena' AND provider_subject IS NULL AND provider_public_key_digest IS NULL AND rp_id IS NULL)
        OR (provenance='privy' AND provider_subject IS NOT NULL AND length(provider_subject)>0
          AND provider_public_key_digest IS NOT NULL AND provider_public_key_digest ~ '^[0-9a-f]{64}$'
          AND rp_id IS NOT NULL AND length(rp_id) BETWEEN 1 AND 253));
    CREATE TABLE yaparena.provider_passkey_intents (
      id uuid PRIMARY KEY,
      user_id bigint NOT NULL REFERENCES yaparena.users(id) ON DELETE CASCADE,
      session_token_hash text NOT NULL CHECK(session_token_hash ~ '^[0-9a-f]{64}$'),
      auth_generation bigint NOT NULL,
      provider_subject text NOT NULL,
      origin text NOT NULL,
      rp_id text NOT NULL CHECK(length(rp_id) BETWEEN 1 AND 253),
      intent_mode text NOT NULL CHECK(intent_mode IN ('addition','existing')),
      selected_credential_id text,
      CHECK((intent_mode='addition' AND selected_credential_id IS NULL)
        OR (intent_mode='existing' AND selected_credential_id IS NOT NULL AND length(selected_credential_id) BETWEEN 1 AND 2048)),
      before_digest char(64) NOT NULL CHECK(before_digest ~ '^[0-9a-f]{64}$'),
      before_credentials jsonb NOT NULL CHECK(jsonb_typeof(before_credentials)='array'),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      candidate_digest char(64),
      candidate_credential_id text,
      candidate_public_key bytea,
      candidate_key_digest char(64),
      candidate_session_digest char(64),
      challenge text,
      CHECK(expires_at>created_at AND expires_at<=created_at+interval '5 minutes'),
      CHECK(consumed_at IS NULL OR consumed_at<expires_at),
      CHECK((candidate_digest IS NULL AND candidate_credential_id IS NULL AND candidate_public_key IS NULL
          AND candidate_key_digest IS NULL AND candidate_session_digest IS NULL AND challenge IS NULL)
        OR (candidate_digest IS NOT NULL AND candidate_digest ~ '^[0-9a-f]{64}$'
          AND candidate_credential_id IS NOT NULL AND length(candidate_credential_id) BETWEEN 1 AND 2048
          AND candidate_public_key IS NOT NULL AND octet_length(candidate_public_key) BETWEEN 16 AND 4096
          AND candidate_key_digest IS NOT NULL AND candidate_key_digest ~ '^[0-9a-f]{64}$'
          AND candidate_session_digest IS NOT NULL AND candidate_session_digest ~ '^[0-9a-f]{64}$'
          AND challenge IS NOT NULL AND challenge ~ '^[A-Za-z0-9_-]{43}$'))
    );
    CREATE INDEX provider_passkey_intents_account ON yaparena.provider_passkey_intents(user_id,expires_at)
      WHERE consumed_at IS NULL;
    CREATE FUNCTION yaparena.provider_passkey_intent_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF OLD.consumed_at IS NOT NULL
        OR (to_jsonb(NEW)-ARRAY['candidate_digest','candidate_credential_id','candidate_public_key','candidate_key_digest','candidate_session_digest','challenge','consumed_at'])
          IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['candidate_digest','candidate_credential_id','candidate_public_key','candidate_key_digest','candidate_session_digest','challenge','consumed_at'])
        OR (OLD.candidate_digest IS NOT NULL AND
          (to_jsonb(NEW)-'consumed_at') IS DISTINCT FROM (to_jsonb(OLD)-'consumed_at')) THEN
        RAISE EXCEPTION 'provider passkey intent is immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER provider_passkey_intent_guard BEFORE UPDATE ON yaparena.provider_passkey_intents
      FOR EACH ROW EXECUTE FUNCTION yaparena.provider_passkey_intent_guard();
    REVOKE ALL ON FUNCTION yaparena.provider_passkey_intent_guard() FROM PUBLIC;
    GRANT SELECT,INSERT ON yaparena.provider_passkey_intents TO yaparena_runtime;
    GRANT UPDATE(candidate_digest,candidate_credential_id,candidate_public_key,candidate_key_digest,candidate_session_digest,challenge,consumed_at)
      ON yaparena.provider_passkey_intents TO yaparena_runtime;
    ALTER TABLE yaparena.provider_passkey_intents ENABLE ROW LEVEL SECURITY;
    CREATE POLICY backend_all ON yaparena.provider_passkey_intents TO yaparena_runtime USING(true) WITH CHECK(true);
    CREATE OR REPLACE FUNCTION yaparena.apply_provider_identity_recovery(proof_id uuid) RETURNS bigint LANGUAGE plpgsql
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
        AND user_id=proof.user_id AND provenance='yaparena' AND revoked_at IS NULL FOR UPDATE;
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
  `);
};

export const down = () => {
  throw new Error("Provider passkey provenance requires a forward fix");
};
