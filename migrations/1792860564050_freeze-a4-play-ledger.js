export const shorthands = undefined;

// Decision 0010, contract step. Ordinary YAP play is retired: its part of the
// A4 ledger (scope 'global', every human run and the account-wide balance)
// becomes read-only for every role once its balances are recorded. Bot runs
// keep their own scopes and stay writable until a ledger-free simulator
// replaces them. Requires the expand migration before it.
export const up = (pgm) => {
  pgm.sql(`
    -- Block concurrent ledger writes (reads continue) while checking and freezing.
    LOCK TABLE yaparena.a4_accounts, yaparena.a4_journals, yaparena.a4_postings
      IN SHARE ROW EXCLUSIVE MODE;
    DO $$ DECLARE total integer; listed text; BEGIN
      SELECT count(*), string_agg(format('%s: %s', problem, item), '; ')
        INTO total, listed
        FROM (SELECT * FROM yaparena.a4_ledger_closing_blockers('global')
          ORDER BY problem, item LIMIT 20) b;
      IF total>0 THEN
        RAISE EXCEPTION 'YAP play is still in progress; let the A4 worker settle it before this release'
          USING ERRCODE='55000',
            DETAIL=format('%s blocker(s), first ones: %s', total, listed);
      END IF;
    END $$;

    INSERT INTO yaparena.a4_play_closing_balances(account_id,kind,amount,posted)
      SELECT a.id, a.kind, a.amount, COALESCE(sum(p.amount),0)
        FROM yaparena.a4_accounts a LEFT JOIN yaparena.a4_postings p ON p.account_id=a.id
        WHERE a.scope='global' GROUP BY a.id, a.kind, a.amount;

    CREATE FUNCTION yaparena.a4_play_ledger_retired() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN RAISE EXCEPTION 'YAP play is retired; its ledger is read-only' USING ERRCODE='23514'; END $$;
    REVOKE ALL ON FUNCTION yaparena.a4_play_ledger_retired() FROM PUBLIC,yaparena_runtime;
    DO $$ DECLARE role_name text; BEGIN
      FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION yaparena.a4_play_ledger_retired() FROM %I',role_name);
      END LOOP;
    END $$;

    -- Accounts: no new, changed or removed 'global' account, and no account
    -- moved into it. Journals: no new 'global' journal; existing journals are
    -- already immutable and sealed, so no posting can join one. A posting to a
    -- 'global' account from another scope fails the deferred balance check.
    CREATE TRIGGER a4_play_account_insert BEFORE INSERT ON yaparena.a4_accounts
      FOR EACH ROW WHEN (NEW.scope='global') EXECUTE FUNCTION yaparena.a4_play_ledger_retired();
    CREATE TRIGGER a4_play_account_update BEFORE UPDATE ON yaparena.a4_accounts
      FOR EACH ROW WHEN (OLD.scope='global' OR NEW.scope='global')
      EXECUTE FUNCTION yaparena.a4_play_ledger_retired();
    CREATE TRIGGER a4_play_account_delete BEFORE DELETE ON yaparena.a4_accounts
      FOR EACH ROW WHEN (OLD.scope='global') EXECUTE FUNCTION yaparena.a4_play_ledger_retired();
    CREATE TRIGGER a4_play_journal_insert BEFORE INSERT ON yaparena.a4_journals
      FOR EACH ROW WHEN (NEW.scope='global') EXECUTE FUNCTION yaparena.a4_play_ledger_retired();
    -- Truncating any ledger table would erase the frozen history.
    CREATE TRIGGER a4_accounts_truncate BEFORE TRUNCATE ON yaparena.a4_accounts
      FOR EACH STATEMENT EXECUTE FUNCTION yaparena.a4_play_ledger_retired();
    CREATE TRIGGER a4_journals_truncate BEFORE TRUNCATE ON yaparena.a4_journals
      FOR EACH STATEMENT EXECUTE FUNCTION yaparena.a4_play_ledger_retired();
    CREATE TRIGGER a4_postings_truncate BEFORE TRUNCATE ON yaparena.a4_postings
      FOR EACH STATEMENT EXECUTE FUNCTION yaparena.a4_play_ledger_retired();
  `);
};

export const down = () => {
  throw new Error("Retain the frozen YAP play ledger; use a forward fix");
};
