export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`CREATE OR REPLACE FUNCTION product_measurement_record_completion() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.live_ended_at IS NOT NULL AND OLD.live_ended_at IS NULL
        AND NEW.is_demo = false AND NEW.publication_state = 'published' THEN
        INSERT INTO product_measurement_events (event_type, debate_id, topic_id)
        VALUES ('debate_completed', NEW.id, NEW.topic_id)
        ON CONFLICT DO NOTHING;
      END IF;
      RETURN NEW;
    END;
    $$`);
};

export const down = (pgm) => {
  pgm.sql(`CREATE OR REPLACE FUNCTION product_measurement_record_completion() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.live_ended_at IS NOT NULL AND OLD.live_ended_at IS NULL
        AND NEW.is_demo = false THEN
        INSERT INTO product_measurement_events (event_type, debate_id, topic_id)
        VALUES ('debate_completed', NEW.id, NEW.topic_id)
        ON CONFLICT DO NOTHING;
      END IF;
      RETURN NEW;
    END;
    $$`);
};
