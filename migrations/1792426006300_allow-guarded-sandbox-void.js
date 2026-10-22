export const shorthands = undefined;
export const up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION yaparena.coin_debate_round_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF OLD.state<>'open' OR NEW.state NOT IN ('settled','void')
        OR (to_jsonb(NEW)-ARRAY['state','result','revealed_at']) IS DISTINCT FROM
           (to_jsonb(OLD)-ARRAY['state','result','revealed_at'])
        OR (NEW.state='settled' AND clock_timestamp()<OLD.closes_at)
        OR (NEW.state='void' AND current_user<>'yaparena_owner')
        OR NEW.revealed_at>clock_timestamp() THEN
        RAISE EXCEPTION 'immutable sandbox debate terms or unauthorized outcome' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
  `);
};
export const down = () => {
  throw new Error("Keep guarded financial history; forward-fix");
};
