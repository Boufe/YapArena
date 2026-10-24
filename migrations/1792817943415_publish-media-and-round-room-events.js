export const shorthands = undefined;

// Media and A4 changes join each debate's community room log as reference-only
// signals: the row names which public projection changed, never its contents.
// A signal is a 'summary' row whose refresh column names the projection, so a
// server image from before this migration still sends clients a change they
// accept. Constraint triggers run at COMMIT, so the room counter is always the
// last lock a writer takes, after every business row lock
// (docs/community-delivery.md).

export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE yaparena.community_room_events ADD COLUMN refresh text
      CONSTRAINT community_room_events_refresh
      CHECK (refresh IS NULL OR (kind = 'summary' AND message_id IS NULL
        AND refresh IN ('media', 'round', 'activity')));

    CREATE FUNCTION yaparena.capture_room_signal() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER
      SET search_path = pg_catalog, yaparena, pg_temp AS $$
    DECLARE room uuid; rooms uuid[]; projection text; next_cursor bigint;
      run_owner record; signalled text; entry text;
    BEGIN
      IF TG_TABLE_NAME = 'debate_media' THEN
        -- Only columns in the public media snapshot produce a signal.
        IF TG_OP = 'UPDATE' AND (NEW.state, NEW.active_side, NEW.turn_number,
            NEW.turn_deadline_at, NEW.remaining_ms, NEW.active_ms, NEW.last_resumed_at,
            NEW.revision, NEW.recording_status, NEW.captions_vtt IS NULL)
          IS NOT DISTINCT FROM (OLD.state, OLD.active_side, OLD.turn_number,
            OLD.turn_deadline_at, OLD.remaining_ms, OLD.active_ms, OLD.last_resumed_at,
            OLD.revision, OLD.recording_status, OLD.captions_vtt IS NULL) THEN
          RETURN NULL;
        END IF;
        projection := 'media';
        room := CASE WHEN TG_OP = 'DELETE' THEN OLD.debate_id ELSE NEW.debate_id END;
      ELSIF TG_TABLE_NAME = 'a4_rounds' THEN
        IF NEW.state IS NOT DISTINCT FROM OLD.state THEN RETURN NULL; END IF;
        SELECT s.debate_id, s.mode, s.creator_id INTO run_owner
          FROM a4_sessions s WHERE s.id = NEW.session_id;
        IF run_owner.mode = 'human' THEN
          -- Human-only rounds are shared with every signed-in viewer of the debate.
          projection := 'round';
        ELSIF NEW.state = 'settled' AND EXISTS (
            SELECT 1 FROM a4_public_publishers p WHERE p.user_id = run_owner.creator_id) THEN
          -- A private sandbox is silent until a consenting creator's result is public.
          projection := 'activity';
        ELSE
          RETURN NULL;
        END IF;
        room := run_owner.debate_id;
      ELSIF TG_TABLE_NAME = 'a4_sessions' THEN
        IF NEW.mode <> 'human' OR (TG_OP = 'UPDATE'
            AND NEW.state IS NOT DISTINCT FROM OLD.state) THEN
          RETURN NULL;
        END IF;
        projection := 'round';
        room := NEW.debate_id;
      ELSIF TG_TABLE_NAME = 'a4_public_publishers' THEN
        -- Consent adds or removes settled sandbox results in each affected room.
        projection := 'activity';
        SELECT array_agg(DISTINCT s.debate_id ORDER BY s.debate_id) INTO rooms
          FROM a4_sessions s
          WHERE s.creator_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END
            AND s.mode IN ('mixed', 'observer')
            AND EXISTS (SELECT 1 FROM a4_rounds r WHERE r.session_id = s.id AND r.state = 'settled');
      ELSIF TG_TABLE_NAME = 'a4_synthetic_rounds' THEN
        projection := 'activity';
        room := NEW.debate_id;
      END IF;
      IF room IS NOT NULL THEN rooms := ARRAY[room]; END IF;
      -- Clients re-read the current projection, so one signal per room and
      -- projection covers a whole transaction. The list is transaction-local.
      signalled := COALESCE(current_setting('yaparena.room_signals', true), '');
      FOREACH room IN ARRAY COALESCE(rooms, ARRAY[]::uuid[]) LOOP
        entry := projection || ':' || room::text || ';';
        CONTINUE WHEN position(entry IN signalled) > 0;
        signalled := signalled || entry;
        -- Row update held to COMMIT: the next allocator waits for commit/rollback.
        INSERT INTO community_rooms (room_id, cursor) VALUES (room, 1)
          ON CONFLICT (room_id) DO UPDATE SET cursor = community_rooms.cursor + 1
          RETURNING cursor INTO next_cursor;
        INSERT INTO community_room_events (room_id, cursor, kind, refresh)
          VALUES (room, next_cursor, 'summary', projection);
        PERFORM pg_notify('yaparena_community_v1', room::text);
      END LOOP;
      PERFORM set_config('yaparena.room_signals', signalled, true);
      RETURN NULL;
    END $$;
    REVOKE ALL ON FUNCTION yaparena.capture_room_signal() FROM PUBLIC;

    CREATE CONSTRAINT TRIGGER room_signal_media
      AFTER INSERT OR UPDATE OR DELETE ON yaparena.debate_media
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION yaparena.capture_room_signal();
    CREATE CONSTRAINT TRIGGER room_signal_round
      AFTER UPDATE OF state ON yaparena.a4_rounds
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION yaparena.capture_room_signal();
    CREATE CONSTRAINT TRIGGER room_signal_session
      AFTER INSERT OR UPDATE OF state ON yaparena.a4_sessions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION yaparena.capture_room_signal();
    CREATE CONSTRAINT TRIGGER room_signal_publisher
      AFTER INSERT OR DELETE ON yaparena.a4_public_publishers
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION yaparena.capture_room_signal();
    CREATE CONSTRAINT TRIGGER room_signal_synthetic
      AFTER INSERT ON yaparena.a4_synthetic_rounds
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION yaparena.capture_room_signal();

    DO $$ DECLARE role_name text; BEGIN
      FOR role_name IN SELECT rolname FROM pg_roles
          WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION yaparena.capture_room_signal() FROM %I', role_name);
      END LOOP;
    END $$;
  `);
};

export const down = () => {
  throw new Error("Retain the durable log on rollback; use a forward fix");
};
