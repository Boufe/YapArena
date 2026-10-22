export const shorthands = undefined;
export const up = (pgm) => {
  pgm.sql(`
    -- New sandbox currency, separate from every historical A4 YAP table.
    CREATE TABLE yaparena.coin_debate_rounds (
      id uuid PRIMARY KEY,
      debate_id uuid NOT NULL REFERENCES yaparena.debates(id),
      creator_id bigint NOT NULL REFERENCES yaparena.account_subjects(id),
      proposition text NOT NULL,
      environment text NOT NULL DEFAULT 'sandbox' CHECK(environment='sandbox'),
      rail text NOT NULL CHECK(rail IN ('simulation','base-sepolia')),
      reference char(64) NOT NULL UNIQUE,
      terms jsonb NOT NULL,
      seed char(64) NOT NULL CHECK(seed ~ '^[a-f0-9]{64}$'),
      seed_commitment char(64) NOT NULL CHECK(seed_commitment ~ '^[a-f0-9]{64}$'),
      opens_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      closes_at timestamptz NOT NULL,
      state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','settled','void')),
      result jsonb,
      revealed_at timestamptz,
      CHECK(closes_at>opens_at),
      CHECK((state='open' AND result IS NULL AND revealed_at IS NULL)
        OR (state IN ('settled','void') AND result IS NOT NULL AND revealed_at IS NOT NULL))
    );
    CREATE UNIQUE INDEX coin_debate_open ON yaparena.coin_debate_rounds(debate_id) WHERE state='open';
    CREATE TABLE yaparena.coin_debate_orders (
      round_id uuid NOT NULL REFERENCES yaparena.coin_debate_rounds(id),
      user_id bigint NOT NULL REFERENCES yaparena.account_subjects(id),
      request_id uuid NOT NULL UNIQUE,
      side text NOT NULL CHECK(side IN ('YES','NO')),
      limit_value text NOT NULL,
      quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 100),
      funding jsonb NOT NULL,
      center_reservation numeric(36,0) NOT NULL CHECK(center_reservation>0),
      promotional_reservation numeric(36,0) NOT NULL CHECK(promotional_reservation>=0),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(round_id,user_id),
      FOREIGN KEY(request_id,user_id) REFERENCES yaparena.coin_sandbox_requests(id,user_id)
    );
    CREATE FUNCTION yaparena.coin_debate_order_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM yaparena.coin_debate_rounds WHERE id=NEW.round_id
        AND state='open' AND clock_timestamp()>=opens_at AND clock_timestamp()<closes_at) THEN
        RAISE EXCEPTION 'sandbox debate is past cutoff' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER coin_debate_admission BEFORE INSERT ON yaparena.coin_debate_orders
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_debate_order_guard();
    CREATE FUNCTION yaparena.coin_debate_round_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF OLD.state<>'open' OR NEW.state NOT IN ('settled','void')
        OR (to_jsonb(NEW)-ARRAY['state','result','revealed_at']) IS DISTINCT FROM
           (to_jsonb(OLD)-ARRAY['state','result','revealed_at'])
        OR clock_timestamp()<OLD.closes_at OR NEW.revealed_at>clock_timestamp() THEN
        RAISE EXCEPTION 'immutable sandbox debate terms or premature result' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER coin_debate_round_guard BEFORE UPDATE ON yaparena.coin_debate_rounds
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_debate_round_guard();
    CREATE TRIGGER coin_debate_round_history BEFORE DELETE ON yaparena.coin_debate_rounds
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_immutable();
    CREATE TRIGGER coin_debate_order_history BEFORE UPDATE OR DELETE ON yaparena.coin_debate_orders
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_immutable();
    REVOKE ALL ON FUNCTION yaparena.coin_debate_round_guard(),yaparena.coin_debate_order_guard() FROM PUBLIC;
    GRANT SELECT,INSERT ON yaparena.coin_debate_rounds,yaparena.coin_debate_orders TO yaparena_runtime;
    GRANT UPDATE(state,result,revealed_at) ON yaparena.coin_debate_rounds TO yaparena_runtime;
  `);
  for (const table of ["coin_debate_rounds", "coin_debate_orders"])
    pgm.sql(`ALTER TABLE yaparena.${table} ENABLE ROW LEVEL SECURITY;
      CREATE POLICY sandbox_access ON yaparena.${table} TO yaparena_runtime USING(true) WITH CHECK(true)`);
};
export const down = () => {
  throw new Error(
    "Sandbox participation history must be retained; forward-fix",
  );
};
