export const shorthands = undefined;
export const receiptTables = ["community_submission_receipts"];

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE yaparena.community_submission_receipts (
      author_user_id bigint NOT NULL REFERENCES yaparena.users(id) ON DELETE CASCADE,
      debate_id uuid NOT NULL REFERENCES yaparena.debates(id) ON DELETE CASCADE,
      client_message_id uuid NOT NULL,
      message_id bigint NOT NULL UNIQUE,
      body_hash bytea NOT NULL CHECK (octet_length(body_hash) = 32),
      created_at timestamptz NOT NULL,
      revision bigint NOT NULL CHECK (revision >= 0),
      stream_revision bigint NOT NULL CHECK (stream_revision >= 0),
      PRIMARY KEY (author_user_id, debate_id, client_message_id)
    );
    CREATE INDEX community_receipts_room ON yaparena.community_submission_receipts (debate_id);
    ALTER TABLE yaparena.community_submission_receipts ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON yaparena.community_submission_receipts FROM PUBLIC, anon, authenticated;
    GRANT SELECT, INSERT ON yaparena.community_submission_receipts TO yaparena_runtime;
    GRANT UPDATE (revision, stream_revision) ON yaparena.community_submission_receipts TO yaparena_runtime;
    CREATE POLICY backend_runtime ON yaparena.community_submission_receipts TO yaparena_runtime
      USING (true) WITH CHECK (true);

    -- No text or moderation evidence is retained here. The immutable binding
    -- survives body retention and remains private for the room/account lifetime.
    INSERT INTO yaparena.community_submission_receipts
      SELECT author_user_id,debate_id,client_message_id,id,sha256(convert_to(body,'UTF8')),
        created_at,revision,stream_revision FROM yaparena.event_chat_messages
      WHERE client_message_id IS NOT NULL;
    CREATE FUNCTION yaparena.capture_submission_receipt() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER
      SET search_path = pg_catalog, yaparena, pg_temp AS $$
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        IF (NEW.author_user_id,NEW.debate_id,NEW.client_message_id)
          IS DISTINCT FROM (OLD.author_user_id,OLD.debate_id,OLD.client_message_id) THEN
          RAISE EXCEPTION 'accepted message identity is immutable' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.client_message_id IS NOT NULL THEN
          INSERT INTO community_submission_receipts
            (author_user_id,debate_id,client_message_id,message_id,body_hash,created_at,revision,stream_revision)
            VALUES (NEW.author_user_id,NEW.debate_id,NEW.client_message_id,NEW.id,
              sha256(convert_to(NEW.body,'UTF8')),NEW.created_at,NEW.revision,NEW.stream_revision);
        END IF;
        RETURN NEW;
      END IF;
      -- BEFORE community_capture_chat has already acquired and advanced the
      -- room counter. Receipt locks come last, in that same transaction.
      UPDATE community_submission_receipts SET revision = OLD.revision + 1,
        stream_revision = (SELECT cursor FROM community_rooms WHERE room_id=OLD.debate_id)
        WHERE message_id=OLD.id;
      RETURN OLD;
    END $$;
    REVOKE ALL ON FUNCTION yaparena.capture_submission_receipt() FROM PUBLIC, anon, authenticated, yaparena_runtime;
    CREATE TRIGGER chat_submission_receipt AFTER INSERT OR DELETE OR UPDATE OF author_user_id,debate_id,client_message_id
      ON yaparena.event_chat_messages FOR EACH ROW EXECUTE FUNCTION yaparena.capture_submission_receipt();
  `);
};

export const down = () => {
  throw new Error(
    "Retain accepted submission bindings on rollback; use a forward fix",
  );
};
