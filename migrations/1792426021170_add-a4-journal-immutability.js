export const shorthands = undefined;

// Prompt 17, step 1: make A4 journals and postings append-only in the
// database, as coin_immutable does for coin_* history. Until now only grants
// stopped the runtime role from changing them; the owner could still update
// or delete posted history.
export const up = (pgm) => {
  pgm.sql(`
    CREATE FUNCTION yaparena.a4_immutable() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN RAISE EXCEPTION 'A4 journal history is append-only' USING ERRCODE='23514'; END $$;
    REVOKE ALL ON FUNCTION yaparena.a4_immutable() FROM PUBLIC,yaparena_runtime;
    DO $$ DECLARE role_name text; BEGIN
      FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION yaparena.a4_immutable() FROM %I',role_name);
      END LOOP;
    END $$;
    CREATE TRIGGER immutable_a4_journal BEFORE UPDATE OR DELETE ON yaparena.a4_journals
      FOR EACH ROW EXECUTE FUNCTION yaparena.a4_immutable();
    CREATE TRIGGER immutable_a4_posting BEFORE UPDATE OR DELETE ON yaparena.a4_postings
      FOR EACH ROW EXECUTE FUNCTION yaparena.a4_immutable();
  `);
};
export const down = () => {
  throw new Error("Retain A4 financial audit history; use a forward fix");
};
