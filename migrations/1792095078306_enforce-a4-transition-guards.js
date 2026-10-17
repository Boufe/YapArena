export const up = (pgm) => {
  pgm.sql(`
    -- Column UPDATE permits row locking without permitting control changes.
    GRANT UPDATE(id) ON yaparena.a4_controls TO yaparena_runtime;
    CREATE FUNCTION yaparena.a4_immutable_transition() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
      SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF TG_TABLE_NAME='a4_submissions' THEN
        IF OLD.outcome IS NOT NULL AND NEW.outcome IS DISTINCT FROM OLD.outcome THEN
          RAISE EXCEPTION 'A4 execution is immutable' USING ERRCODE='23514';
        END IF;
      ELSE
        IF (OLD.snapshot IS NOT NULL AND (NEW.snapshot IS DISTINCT FROM OLD.snapshot OR NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash))
          OR (OLD.pricing IS NOT NULL AND NEW.pricing IS DISTINCT FROM OLD.pricing)
          OR (NEW.state<>OLD.state AND NOT (
            (OLD.state='scheduled' AND NEW.state IN ('open','void')) OR
            (OLD.state='open' AND NEW.state IN ('locked','void')) OR
            (OLD.state='locked' AND NEW.state='priced') OR
            (OLD.state='priced' AND NEW.state='pending') OR
            (OLD.state='pending' AND NEW.state='settled'))) THEN
          RAISE EXCEPTION 'A4 transition or snapshot is immutable' USING ERRCODE='23514';
        END IF;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER a4_round_transition BEFORE UPDATE ON yaparena.a4_rounds FOR EACH ROW EXECUTE FUNCTION yaparena.a4_immutable_transition();
    CREATE TRIGGER a4_execution_transition BEFORE UPDATE ON yaparena.a4_submissions FOR EACH ROW EXECUTE FUNCTION yaparena.a4_immutable_transition();
    REVOKE ALL ON FUNCTION yaparena.a4_immutable_transition() FROM PUBLIC,yaparena_runtime;
    DO $$ DECLARE role_name text; BEGIN
      FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION yaparena.a4_immutable_transition() FROM %I',role_name);
      END LOOP;
    END $$;
  `);
};
export const down = () => {
  throw new Error("Keep A4 transition guards; use a forward fix");
};
