export const shorthands = undefined;

export const up = (pgm) => {
  pgm.addColumns("users", {
    auth_generation: { type: "bigint", notNull: true, default: 0 },
  });
  // Unknown legacy provenance is retired. Do not let old binaries create rows
  // without a checked generation: there is intentionally no session default.
  pgm.sql("DELETE FROM sessions");
  pgm.addColumns("sessions", {
    auth_generation: { type: "bigint", notNull: true },
  });
  pgm.addColumns("wallet_challenges", {
    account_id: { type: "bigint" },
    wallet_id: { type: "uuid" },
    auth_generation: { type: "bigint" },
  });
  pgm.sql(
    "UPDATE wallet_challenges SET consumed_at = CURRENT_TIMESTAMP WHERE consumed_at IS NULL",
  );
  pgm.addColumns("identity_audit_events", {
    metadata: { type: "jsonb", notNull: true, default: "{}" },
  });
  pgm.sql(`
    CREATE FUNCTION enforce_session_generation() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE generation bigint;
    BEGIN
      SELECT auth_generation INTO generation FROM users WHERE id = NEW.user_id FOR UPDATE;
      IF generation IS NULL OR NEW.auth_generation IS DISTINCT FROM generation THEN
        RAISE EXCEPTION 'obsolete session generation' USING ERRCODE = '40001';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER sessions_enforce_generation BEFORE INSERT OR UPDATE ON sessions
      FOR EACH ROW EXECUTE FUNCTION enforce_session_generation();

    CREATE FUNCTION revoke_changed_password() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.auth_generation < OLD.auth_generation THEN
        RAISE EXCEPTION 'authentication generation cannot decrease';
      END IF;
      IF NEW.password_hash IS DISTINCT FROM OLD.password_hash OR NEW.email IS DISTINCT FROM OLD.email THEN
        NEW.auth_generation := OLD.auth_generation + 1;
        DELETE FROM sessions WHERE user_id = OLD.id;
        INSERT INTO identity_audit_events (user_id, event_type, subject_id, metadata)
          VALUES (OLD.id, 'credentials.password_changed', OLD.id::text,
            jsonb_build_object('actorDatabaseRole', current_user, 'outcome', 'success',
              'authGeneration', NEW.auth_generation,
              'requestId', current_setting('yaparena.request_id', true)));
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER users_revoke_changed_password BEFORE UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION revoke_changed_password();

    CREATE FUNCTION revoke_removed_wallet() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE generation bigint;
    BEGIN
      UPDATE users SET auth_generation = auth_generation + 1 WHERE id = OLD.user_id
        RETURNING auth_generation INTO generation;
      DELETE FROM sessions WHERE user_id = OLD.user_id;
      INSERT INTO identity_audit_events (user_id, event_type, subject_id, metadata)
        VALUES (OLD.user_id, 'credentials.wallet_removed', OLD.id::text,
          jsonb_build_object('actorDatabaseRole', current_user, 'outcome', 'success',
            'authGeneration', generation,
            'requestId', current_setting('yaparena.request_id', true)));
      RETURN OLD;
    END $$;
    CREATE TRIGGER wallets_revoke_removed BEFORE DELETE ON wallet_identities
      FOR EACH ROW EXECUTE FUNCTION revoke_removed_wallet();

    DO $$ DECLARE schema_name text := current_schema(); function_name text;
    BEGIN
      FOREACH function_name IN ARRAY ARRAY['enforce_session_generation', 'revoke_changed_password', 'revoke_removed_wallet'] LOOP
        EXECUTE format('ALTER FUNCTION %I.%I() SET search_path TO pg_catalog, %I, pg_temp', schema_name, function_name, schema_name);
        EXECUTE format('REVOKE ALL ON FUNCTION %I.%I() FROM PUBLIC', schema_name, function_name);
      END LOOP;
      IF schema_name = 'yaparena' AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yaparena_runtime') THEN
        GRANT UPDATE (auth_generation, email, password_hash) ON users TO yaparena_runtime;
        GRANT UPDATE (auth_generation) ON sessions TO yaparena_runtime;
        GRANT EXECUTE ON FUNCTION enforce_session_generation(), revoke_changed_password(), revoke_removed_wallet() TO yaparena_runtime;
      END IF;
    END $$;
  `);
};

// Removing these guards would let an old binary resurrect revoked access.
// Roll back application code only to a version which understands this schema.
export const down = () => {
  throw new Error(
    "Session revocation is irreversible; retain the schema and deploy a compatible forward fix",
  );
};
