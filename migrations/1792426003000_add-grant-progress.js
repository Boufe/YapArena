export const shorthands = undefined;
export const up = (pgm) => {
  pgm.sql(`
    -- Read-model foundation only. Runtime cannot issue grants or record profit.
    -- A financial worker and funded grant policy are separate release gates.
    CREATE TABLE yaparena.coin_grant_lots (
      id uuid PRIMARY KEY,
      user_id bigint NOT NULL REFERENCES yaparena.account_subjects(id) ON DELETE RESTRICT,
      environment text NOT NULL CHECK(environment IN ('sandbox','live')),
      asset text NOT NULL CHECK(asset='USDC'),
      kind text NOT NULL CHECK(kind IN ('welcome','daily')),
      reference text NOT NULL,
      target numeric(36,0) NOT NULL CHECK(target>0),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(user_id,environment,reference), UNIQUE(id,environment,asset)
    );
    CREATE INDEX coin_grant_owner ON yaparena.coin_grant_lots(user_id,environment,created_at,id);
    CREATE TABLE yaparena.coin_grant_profit_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      lot_id uuid NOT NULL, journal_id uuid NOT NULL,
      environment text NOT NULL, asset text NOT NULL,
      net_profit numeric(36,0) NOT NULL CHECK(net_profit<>0),
      UNIQUE(lot_id,journal_id),
      FOREIGN KEY(lot_id,environment,asset) REFERENCES yaparena.coin_grant_lots(id,environment,asset) ON DELETE RESTRICT,
      FOREIGN KEY(journal_id,environment,asset) REFERENCES yaparena.coin_journals(id,environment,asset) ON DELETE RESTRICT
    );
    CREATE INDEX coin_grant_profit_order ON yaparena.coin_grant_profit_events(lot_id,id);
    CREATE TRIGGER immutable_coin_grant BEFORE UPDATE OR DELETE ON yaparena.coin_grant_lots
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_immutable();
    CREATE TRIGGER immutable_coin_grant_profit BEFORE UPDATE OR DELETE ON yaparena.coin_grant_profit_events
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_immutable();
    GRANT SELECT ON yaparena.coin_grant_lots,yaparena.coin_grant_profit_events TO yaparena_runtime;
  `);
  for (const table of ["coin_grant_lots", "coin_grant_profit_events"]) {
    pgm.sql(`ALTER TABLE yaparena.${table} ENABLE ROW LEVEL SECURITY;
      CREATE POLICY backend_read ON yaparena.${table} FOR SELECT TO yaparena_runtime USING(true)`);
  }
};
export const down = () => {
  throw new Error("Grant history must be retained; forward-fix");
};
