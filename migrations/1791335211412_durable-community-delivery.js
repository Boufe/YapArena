export const shorthands = undefined;
export const deliveryTables = ["community_rooms", "community_room_events"];

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE yaparena.community_rooms (
      room_id uuid PRIMARY KEY,
      cursor bigint NOT NULL DEFAULT 0 CHECK (cursor >= 0),
      retained_after bigint NOT NULL DEFAULT 0 CHECK (retained_after >= 0)
    );
    CREATE TABLE yaparena.community_room_events (
      room_id uuid NOT NULL,
      cursor bigint NOT NULL,
      kind text NOT NULL CHECK (kind IN ('message','summary','reset')),
      message_id bigint,
      message_revision bigint,
      occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (room_id, cursor)
    );
    CREATE INDEX community_events_retention ON yaparena.community_room_events (occurred_at, room_id, cursor);
    ALTER TABLE yaparena.event_chat_messages ADD COLUMN stream_revision bigint NOT NULL DEFAULT 0;
    INSERT INTO yaparena.community_rooms (room_id) SELECT id FROM yaparena.debates;
    -- FOR UPDATE SKIP LOCKED requires an UPDATE column grant; these IDs are
    -- used only for bounded cleanup locks, matching the existing users(id) pattern.
    GRANT UPDATE (id) ON yaparena.event_like_changes TO yaparena_runtime;
    GRANT UPDATE (user_id) ON yaparena.event_likes TO yaparena_runtime;

    CREATE FUNCTION yaparena.capture_community_change() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER
      SET search_path = pg_catalog, yaparena, pg_temp AS $$
    DECLARE room uuid; rooms uuid[]; next_cursor bigint; message bigint;
      message_revision bigint; kind text := 'summary';
    BEGIN
      IF TG_TABLE_NAME = 'event_chat_messages' THEN
        IF TG_OP = 'UPDATE' AND NEW.state IS NOT DISTINCT FROM OLD.state
          AND NEW.body IS NOT DISTINCT FROM OLD.body THEN RETURN NEW; END IF;
        room := CASE WHEN TG_OP = 'DELETE' THEN OLD.debate_id ELSE NEW.debate_id END;
        message := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
        message_revision := CASE WHEN TG_OP = 'DELETE' THEN OLD.revision + 1 ELSE NEW.revision END;
        kind := 'message';
      ELSIF TG_TABLE_NAME IN ('event_likes', 'event_chat_controls') THEN
        IF TG_TABLE_NAME = 'event_chat_controls' THEN
          IF TG_OP = 'INSERT' AND NEW.state = 'open' THEN RETURN NEW; END IF;
          IF TG_OP = 'UPDATE' AND NEW.state IS NOT DISTINCT FROM OLD.state THEN RETURN NEW; END IF;
        END IF;
        room := CASE WHEN TG_OP = 'DELETE' THEN OLD.debate_id ELSE NEW.debate_id END;
      ELSIF TG_TABLE_NAME = 'debates' THEN
        IF TG_OP = 'UPDATE' AND (NEW.status,NEW.publication_state,NEW.is_demo,NEW.topic_id)
          IS NOT DISTINCT FROM (OLD.status,OLD.publication_state,OLD.is_demo,OLD.topic_id) THEN RETURN NEW; END IF;
        room := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
      ELSIF TG_TABLE_NAME = 'topics' THEN
        IF NEW.publication_state IS NOT DISTINCT FROM OLD.publication_state THEN RETURN NEW; END IF;
        SELECT array_agg(id ORDER BY id) INTO rooms FROM debates WHERE topic_id = NEW.id;
      ELSIF TG_TABLE_NAME = 'public_profiles' THEN
        IF (NEW.display_name,NEW.publication_state) IS NOT DISTINCT FROM
          (OLD.display_name,OLD.publication_state) THEN RETURN NEW; END IF;
        SELECT array_agg(DISTINCT debate_id ORDER BY debate_id) INTO rooms
          FROM event_chat_messages WHERE author_user_id = NEW.user_id;
        kind := 'reset';
      END IF;
      IF room IS NOT NULL THEN rooms := ARRAY[room]; END IF;
      FOREACH room IN ARRAY COALESCE(rooms, ARRAY[]::uuid[]) LOOP
        -- Row update held to COMMIT: the next allocator waits for commit/rollback.
        INSERT INTO community_rooms (room_id,cursor) VALUES (room,1)
          ON CONFLICT (room_id) DO UPDATE SET cursor = community_rooms.cursor + 1
          RETURNING cursor INTO next_cursor;
        IF TG_TABLE_NAME = 'event_chat_messages' AND TG_OP <> 'DELETE' THEN
          NEW.stream_revision := next_cursor;
        END IF;
        INSERT INTO community_room_events (room_id,cursor,kind,message_id,message_revision)
          VALUES (room,next_cursor,kind,message,message_revision);
        PERFORM pg_notify('yaparena_community_v1',room::text);
      END LOOP;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $$;
    REVOKE ALL ON FUNCTION yaparena.capture_community_change() FROM PUBLIC;
    CREATE TRIGGER community_capture_chat BEFORE INSERT OR UPDATE OF state,body OR DELETE
      ON yaparena.event_chat_messages FOR EACH ROW EXECUTE FUNCTION yaparena.capture_community_change();
    CREATE TRIGGER community_capture_likes BEFORE INSERT OR DELETE ON yaparena.event_likes
      FOR EACH ROW EXECUTE FUNCTION yaparena.capture_community_change();
    CREATE TRIGGER community_capture_controls BEFORE INSERT OR UPDATE OF state OR DELETE
      ON yaparena.event_chat_controls FOR EACH ROW EXECUTE FUNCTION yaparena.capture_community_change();
    CREATE TRIGGER community_capture_lifecycle BEFORE INSERT OR UPDATE OF status,publication_state,is_demo,topic_id OR DELETE
      ON yaparena.debates FOR EACH ROW EXECUTE FUNCTION yaparena.capture_community_change();
    CREATE TRIGGER community_capture_topic AFTER UPDATE OF publication_state ON yaparena.topics
      FOR EACH ROW EXECUTE FUNCTION yaparena.capture_community_change();
    CREATE TRIGGER community_capture_profile AFTER UPDATE OF display_name,publication_state ON yaparena.public_profiles
      FOR EACH ROW EXECUTE FUNCTION yaparena.capture_community_change();
  `);
  for (const table of deliveryTables) {
    pgm.sql(`ALTER TABLE yaparena.${table} ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON yaparena.${table} FROM PUBLIC;
      GRANT SELECT, INSERT, UPDATE, DELETE ON yaparena.${table} TO yaparena_runtime;
      CREATE POLICY backend_runtime ON yaparena.${table} TO yaparena_runtime
        USING (true) WITH CHECK (true);`);
  }
};
export const down = () => {
  throw new Error("Retain the durable log on rollback; use a forward fix");
};
