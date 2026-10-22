export const shorthands = undefined;
export const up = (pgm) => {
  pgm.sql(`
    -- Historical subject IDs are permanent, non-authenticating tombstones. They
    -- contain no credentials, email or keys and can never be reused by signup.
    CREATE TABLE yaparena.account_subjects(id bigint PRIMARY KEY);
    INSERT INTO yaparena.account_subjects SELECT id FROM yaparena.users;
    ALTER TABLE yaparena.users ADD CONSTRAINT users_subject FOREIGN KEY(id)
      REFERENCES yaparena.account_subjects(id) ON DELETE RESTRICT;
    CREATE FUNCTION yaparena.account_subject_insert() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN INSERT INTO yaparena.account_subjects VALUES(NEW.id); RETURN NEW; END $$;
    CREATE FUNCTION yaparena.account_id_immutable() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'account IDs are permanent' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
    REVOKE ALL ON FUNCTION yaparena.account_subject_insert(),yaparena.account_id_immutable() FROM PUBLIC;
    CREATE TRIGGER account_subject_insert BEFORE INSERT ON yaparena.users
      FOR EACH ROW EXECUTE FUNCTION yaparena.account_subject_insert();
    CREATE TRIGGER account_id_immutable BEFORE UPDATE OF id ON yaparena.users
      FOR EACH ROW EXECUTE FUNCTION yaparena.account_id_immutable();
    GRANT SELECT,INSERT ON yaparena.account_subjects TO yaparena_runtime;
    ALTER TABLE yaparena.account_subjects ENABLE ROW LEVEL SECURITY;
    CREATE POLICY backend_access ON yaparena.account_subjects TO yaparena_runtime USING(true) WITH CHECK(true);
    DO $$ DECLARE c record; column_name text; BEGIN
      FOR c IN SELECT pc.*,n.nspname,cl.relname FROM pg_constraint pc
        JOIN pg_class cl ON cl.oid=pc.conrelid JOIN pg_namespace n ON n.oid=cl.relnamespace
        WHERE pc.contype='f' AND pc.confrelid='yaparena.users'::regclass
          AND pc.confdeltype='r' AND n.nspname='yaparena'
          AND cl.relname IN ('a4_accounts','a4_audit','a4_requests','a4_sessions','a4_submissions',
            'community_audit_events','community_restrictions','event_chat_messages','event_like_changes',
            'event_participants','moderation_appeals','moderation_cases','coin_accounts') LOOP
        IF cardinality(c.conkey)<>1 OR cardinality(c.confkey)<>1 OR c.condeferrable THEN
          RAISE EXCEPTION 'unsupported historical ownership constraint';
        END IF;
        SELECT attname INTO STRICT column_name FROM pg_attribute WHERE attrelid=c.conrelid AND attnum=c.conkey[1];
        EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I',c.nspname,c.relname,c.conname);
        EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I FOREIGN KEY(%I) REFERENCES yaparena.account_subjects(id) ON DELETE RESTRICT',c.nspname,c.relname,c.conname,column_name);
      END LOOP;
    END $$;
  `);
};
export const down = () => {
  throw new Error(
    "Retired subject IDs must never become reusable; forward-fix",
  );
};
