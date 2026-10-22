export const shorthands = undefined;
export const up = (pgm) => {
  pgm.sql(`
    -- Money is counted in USDC atomic units (six decimals).
    -- At 100 YC/USDC, 10,000 atomic USDC units equal one Yap Coin.
    -- Network selection and external funding remain disabled.
    CREATE TABLE yaparena.coin_accounts (
      id uuid PRIMARY KEY, environment text NOT NULL CHECK(environment IN ('sandbox','live')),
      asset text NOT NULL DEFAULT 'USDC' CHECK(asset='USDC'), precision integer NOT NULL DEFAULT 6 CHECK(precision=6),
      user_id bigint REFERENCES yaparena.users(id) ON DELETE RESTRICT,
      kind text NOT NULL CHECK(kind IN ('available','reserved','pending','promotional','backing','fees','operating')),
      balance numeric(36,0) NOT NULL DEFAULT 0,
      CHECK (kind IN ('backing','fees','operating') OR user_id IS NOT NULL),
      CHECK (kind='backing' OR balance>=0), UNIQUE(id,environment,asset)
    );
    CREATE UNIQUE INDEX coin_user_bucket ON yaparena.coin_accounts(environment,asset,user_id,kind) WHERE user_id IS NOT NULL;
    CREATE TABLE yaparena.coin_journals (
      id uuid PRIMARY KEY, environment text NOT NULL CHECK(environment IN ('sandbox','live')),
      asset text NOT NULL CHECK(asset='USDC'), reference text NOT NULL,
      operation text NOT NULL CHECK(operation IN ('funding','reserve','payout','release','reversal')),
      reversal_of uuid UNIQUE,
      transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(environment,reference), UNIQUE(id,environment,asset),
      CHECK((operation='reversal')=(reversal_of IS NOT NULL)),
      FOREIGN KEY(reversal_of,environment,asset) REFERENCES yaparena.coin_journals(id,environment,asset) ON DELETE RESTRICT
    );
    CREATE TABLE yaparena.coin_postings (
      journal_id uuid NOT NULL, account_id uuid NOT NULL, environment text NOT NULL, asset text NOT NULL,
      amount numeric(36,0) NOT NULL CHECK(amount<>0), PRIMARY KEY(journal_id,account_id),
      FOREIGN KEY(journal_id,environment,asset) REFERENCES yaparena.coin_journals(id,environment,asset) ON DELETE RESTRICT,
      FOREIGN KEY(account_id,environment,asset) REFERENCES yaparena.coin_accounts(id,environment,asset) ON DELETE RESTRICT
    );
    CREATE FUNCTION yaparena.coin_immutable() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN RAISE EXCEPTION 'coin history is append-only' USING ERRCODE='23514'; END $$;
    CREATE FUNCTION yaparena.coin_balanced() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    DECLARE j uuid; original uuid; BEGIN
      IF TG_TABLE_NAME='coin_journals' THEN j:=NEW.id; ELSE j:=NEW.journal_id; END IF;
      IF (SELECT count(*)<2 OR COALESCE(sum(amount),0)<>0 FROM yaparena.coin_postings WHERE journal_id=j)
      THEN RAISE EXCEPTION 'unbalanced coin journal' USING ERRCODE='23514'; END IF;
      SELECT reversal_of INTO original FROM yaparena.coin_journals WHERE id=j;
      IF original IS NOT NULL AND EXISTS(
        SELECT account_id FROM yaparena.coin_postings WHERE journal_id IN (j,original)
        GROUP BY account_id HAVING sum(amount)<>0
      ) THEN RAISE EXCEPTION 'reversal must exactly negate original postings' USING ERRCODE='23514'; END IF;
      RETURN NULL;
    END $$;
    CREATE FUNCTION yaparena.coin_account_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF TG_OP='INSERT' THEN
        IF NEW.balance<>0 THEN RAISE EXCEPTION 'account starts empty' USING ERRCODE='23514'; END IF;
      ELSIF pg_trigger_depth()<2 OR
        ROW(NEW.id,NEW.environment,NEW.asset,NEW.precision,NEW.user_id,NEW.kind) IS DISTINCT FROM
        ROW(OLD.id,OLD.environment,OLD.asset,OLD.precision,OLD.user_id,OLD.kind)
      THEN RAISE EXCEPTION 'coin balance requires journal postings' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $$;
    CREATE FUNCTION yaparena.coin_project_posting() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM yaparena.coin_journals WHERE id=NEW.journal_id AND transaction_id=pg_current_xact_id())
      THEN RAISE EXCEPTION 'journal is sealed after its creation transaction' USING ERRCODE='23514'; END IF;
      UPDATE yaparena.coin_accounts SET balance=balance+NEW.amount WHERE id=NEW.account_id;
      RETURN NEW;
    END $$;
    REVOKE ALL ON FUNCTION yaparena.coin_immutable(),yaparena.coin_balanced(),yaparena.coin_account_guard(),yaparena.coin_project_posting() FROM PUBLIC;
    CREATE TRIGGER coin_account_guard BEFORE INSERT OR UPDATE ON yaparena.coin_accounts FOR EACH ROW EXECUTE FUNCTION yaparena.coin_account_guard();
    CREATE TRIGGER coin_projection AFTER INSERT ON yaparena.coin_postings FOR EACH ROW EXECUTE FUNCTION yaparena.coin_project_posting();
    CREATE TRIGGER immutable_coin_journal BEFORE UPDATE OR DELETE ON yaparena.coin_journals FOR EACH ROW EXECUTE FUNCTION yaparena.coin_immutable();
    CREATE TRIGGER immutable_coin_posting BEFORE UPDATE OR DELETE ON yaparena.coin_postings FOR EACH ROW EXECUTE FUNCTION yaparena.coin_immutable();
    CREATE CONSTRAINT TRIGGER balanced_coin_journal AFTER INSERT ON yaparena.coin_journals
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION yaparena.coin_balanced();
    CREATE CONSTRAINT TRIGGER balanced_coin_posting AFTER INSERT ON yaparena.coin_postings
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION yaparena.coin_balanced();
    GRANT SELECT ON yaparena.coin_accounts,yaparena.coin_journals,yaparena.coin_postings TO yaparena_runtime;
  `);
  for (const table of ["coin_accounts", "coin_journals", "coin_postings"]) {
    pgm.sql(`ALTER TABLE yaparena.${table} ENABLE ROW LEVEL SECURITY;
      CREATE POLICY backend_read ON yaparena.${table} FOR SELECT TO yaparena_runtime USING(true)`);
  }
};
export const down = () => {
  throw new Error("Financial history must be retained; forward-fix");
};
