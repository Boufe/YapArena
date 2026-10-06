export const shorthands = undefined;

export const up = (pgm) => {
  // Nullable keys preserve existing records and already-open legacy clients.
  pgm.sql(`ALTER TABLE yaparena.event_chat_messages
    ADD COLUMN client_message_id uuid,
    ADD COLUMN revision bigint NOT NULL DEFAULT 0;
    CREATE UNIQUE INDEX event_chat_submission_key
      ON yaparena.event_chat_messages (author_user_id, debate_id, client_message_id)
      WHERE client_message_id IS NOT NULL;

    CREATE FUNCTION yaparena.advance_chat_revision() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER
      SET search_path = pg_catalog, yaparena, pg_temp AS $$
      BEGIN
        IF NEW.state IS DISTINCT FROM OLD.state THEN
          NEW.revision := OLD.revision + 1;
        END IF;
        RETURN NEW;
      END $$;
    REVOKE ALL ON FUNCTION yaparena.advance_chat_revision() FROM PUBLIC;
    CREATE TRIGGER chat_state_revision BEFORE UPDATE OF state
      ON yaparena.event_chat_messages FOR EACH ROW
      EXECUTE FUNCTION yaparena.advance_chat_revision();`);
  // Existing query-specific runtime table grants and backend RLS policy apply
  // to these columns; the trigger needs no callable runtime EXECUTE grant.
};

export const down = () => {
  throw new Error("Retain chat submission keys on rollback; use a forward fix");
};
