export const shorthands = undefined;
export const up = (pgm) => {
  pgm.sql(`
    -- Notifications are untrusted external claims after transport authentication.
    -- Only a separate owner process reconciles them into financial history.
    CREATE TABLE yaparena.coin_sandbox_webhook_inbox (
      id uuid PRIMARY KEY,
      rail text NOT NULL CHECK(rail IN ('simulation','base-sepolia')),
      provider text NOT NULL CHECK(provider IN ('deterministic-simulation','base-sepolia-notifier')),
      delivery_id text NOT NULL CHECK(length(delivery_id) BETWEEN 1 AND 200),
      request_id uuid NOT NULL REFERENCES yaparena.coin_sandbox_requests(id),
      payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
      payload_digest char(64) NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
      received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CHECK((rail='simulation' AND provider='deterministic-simulation') OR
        (rail='base-sepolia' AND provider='base-sepolia-notifier')),
      UNIQUE(rail,provider,delivery_id)
    );
    CREATE FUNCTION yaparena.coin_sandbox_inbox_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock_shared(hashtextextended('coin-sandbox-rail',0));
      IF NOT EXISTS(SELECT 1 FROM yaparena.coin_sandbox_controls WHERE singleton AND rail=NEW.rail)
        OR NOT EXISTS(SELECT 1 FROM yaparena.coin_sandbox_requests WHERE id=NEW.request_id
          AND kind IN ('funding','withdrawal') AND terms->>'rail'=NEW.rail) THEN
        RAISE EXCEPTION 'sandbox notification rail or request mismatch' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER sandbox_inbox_guard BEFORE INSERT ON yaparena.coin_sandbox_webhook_inbox
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_sandbox_inbox_guard();
    CREATE TRIGGER sandbox_inbox_history BEFORE UPDATE OR DELETE ON yaparena.coin_sandbox_webhook_inbox
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_immutable();
    CREATE TABLE yaparena.coin_sandbox_webhook_outcomes (
      inbox_id uuid PRIMARY KEY REFERENCES yaparena.coin_sandbox_webhook_inbox(id),
      disposition text NOT NULL CHECK(disposition IN ('processed','rejected')),
      event_digest char(64) NOT NULL CHECK(event_digest ~ '^[a-f0-9]{64}$'),
      reason_code text NOT NULL CHECK(reason_code IN
        ('applied','invalid-notification','missing-external-identity','request-conflict')),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TRIGGER sandbox_inbox_outcome_history BEFORE UPDATE OR DELETE ON yaparena.coin_sandbox_webhook_outcomes
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_immutable();
    REVOKE ALL ON FUNCTION yaparena.coin_sandbox_inbox_guard() FROM PUBLIC;
    ALTER TABLE yaparena.coin_sandbox_webhook_inbox ENABLE ROW LEVEL SECURITY;
    CREATE POLICY sandbox_inbox_backend ON yaparena.coin_sandbox_webhook_inbox TO yaparena_runtime USING(true) WITH CHECK(true);
    GRANT SELECT,INSERT ON yaparena.coin_sandbox_webhook_inbox TO yaparena_runtime;
    -- No runtime grants on outcomes: acknowledging a notification is operator work.
    ALTER TABLE yaparena.coin_sandbox_webhook_outcomes ENABLE ROW LEVEL SECURITY;
  `);
};
export const down = () => {
  throw new Error("Sandbox notification history must be retained; forward-fix");
};
