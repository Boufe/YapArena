export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE yaparena.a4_sessions ADD COLUMN proposition text, ADD COLUMN topic_id uuid REFERENCES yaparena.topics(id) ON DELETE RESTRICT;
    UPDATE yaparena.a4_sessions s SET proposition=d.proposition,topic_id=d.topic_id FROM yaparena.debates d WHERE d.id=s.debate_id;
    ALTER TABLE yaparena.a4_sessions ALTER COLUMN proposition SET NOT NULL, ALTER COLUMN topic_id SET NOT NULL;
    ALTER TABLE yaparena.a4_journals ADD COLUMN writer_xid xid8 NOT NULL DEFAULT pg_current_xact_id();
    REVOKE INSERT ON yaparena.a4_journals FROM yaparena_runtime;
    GRANT INSERT(reference,scope,asset,kind,metadata) ON yaparena.a4_journals TO yaparena_runtime;
    CREATE FUNCTION yaparena.a4_current_journal() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
      SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM a4_journals WHERE reference=NEW.reference AND writer_xid=pg_current_xact_id()) THEN
        RAISE EXCEPTION 'A4 journal is sealed' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER a4_sealed_postings BEFORE INSERT ON yaparena.a4_postings FOR EACH ROW EXECUTE FUNCTION yaparena.a4_current_journal();
    REVOKE ALL ON FUNCTION yaparena.a4_current_journal() FROM PUBLIC,yaparena_runtime;
    DO $$ DECLARE role_name text; BEGIN
      FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION yaparena.a4_current_journal() FROM %I',role_name);
      END LOOP;
    END $$;
  `);
};
export const down = () => {
  throw new Error(
    "Preserve immutable A4 terms and journal sealing; use a forward fix",
  );
};
