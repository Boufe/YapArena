export const shorthands = undefined;

// Decision 0010, expand step. Read-only checks for the A4 ledger and the table
// that records the retired YAP play balances when the freeze migration runs.
// Nothing here changes how A4 writes.

export const up = (pgm) => {
  pgm.sql(`
    -- Every way the stored ledger can disagree with itself. No rows means the
    -- account balances equal their postings, every journal balances and every
    -- scope sums to zero. NULL checks all scopes.
    CREATE FUNCTION yaparena.a4_ledger_discrepancies(target_scope text DEFAULT NULL)
      RETURNS TABLE(problem text, scope text, item text, projected numeric, posted numeric)
      LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
      WITH posted AS (
        SELECT p.account_id, sum(p.amount) AS amount FROM a4_postings p
          JOIN a4_accounts a ON a.id=p.account_id
          WHERE target_scope IS NULL OR a.scope=target_scope
          GROUP BY p.account_id)
      SELECT 'balance differs from its postings', a.scope, a.id, a.amount::numeric,
          COALESCE(p.amount,0)::numeric
        FROM a4_accounts a LEFT JOIN posted p ON p.account_id=a.id
        WHERE (target_scope IS NULL OR a.scope=target_scope) AND a.amount<>COALESCE(p.amount,0)
      UNION ALL
      SELECT 'journal is empty or unbalanced', j.scope, j.reference, NULL::numeric,
          COALESCE(sum(p.amount),0)::numeric
        FROM a4_journals j LEFT JOIN a4_postings p ON p.reference=j.reference
        WHERE target_scope IS NULL OR j.scope=target_scope
        GROUP BY j.scope, j.reference HAVING count(p.reference)=0 OR sum(p.amount)<>0
      UNION ALL
      SELECT 'scope does not sum to zero', a.scope, a.asset, sum(a.amount)::numeric, NULL::numeric
        FROM a4_accounts a WHERE target_scope IS NULL OR a.scope=target_scope
        GROUP BY a.scope, a.asset HAVING sum(a.amount)<>0
    $$;

    -- What stops a scope from being closed: an unfinished round, value still
    -- reserved for a round, or a discrepancy. Run scopes follow scopeOf in
    -- src/features/a4/repository.ts: human runs post to 'global', bot runs to
    -- their run ID.
    CREATE FUNCTION yaparena.a4_ledger_closing_blockers(target_scope text)
      RETURNS TABLE(problem text, item text)
      LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
      SELECT 'round is not settled or void',
          format('round %s of run %s is %s', r.id, r.session_id, r.state)
        FROM a4_rounds r JOIN a4_sessions s ON s.id=r.session_id
        WHERE r.state NOT IN ('settled','void')
          AND CASE WHEN s.mode='human' THEN 'global' ELSE s.id::text END=target_scope
      UNION ALL
      SELECT 'value is still committed', format('account %s holds %s', a.id, a.amount)
        FROM a4_accounts a
        WHERE a.scope=target_scope AND a.kind IN ('reserved','collateral','fees_pending')
          AND a.amount<>0
      UNION ALL
      SELECT d.problem, format('%s %s', d.scope, d.item)
        FROM a4_ledger_discrepancies(target_scope) d
    $$;

    -- Retired YAP play balances as recorded at the freeze. Append-only.
    CREATE TABLE yaparena.a4_play_closing_balances (
      account_id text PRIMARY KEY REFERENCES yaparena.a4_accounts(id) ON DELETE RESTRICT,
      kind text NOT NULL,
      amount numeric(40,0) NOT NULL,
      posted numeric(40,0) NOT NULL,
      closed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CHECK (amount=posted)
    );
    ALTER TABLE yaparena.a4_play_closing_balances ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON yaparena.a4_play_closing_balances FROM PUBLIC;
    CREATE TRIGGER immutable_a4_play_closing BEFORE UPDATE OR DELETE
      ON yaparena.a4_play_closing_balances FOR EACH ROW EXECUTE FUNCTION yaparena.a4_immutable();
    CREATE TRIGGER a4_play_closing_truncate BEFORE TRUNCATE
      ON yaparena.a4_play_closing_balances FOR EACH STATEMENT EXECUTE FUNCTION yaparena.a4_immutable();

    REVOKE ALL ON FUNCTION yaparena.a4_ledger_discrepancies(text),
      yaparena.a4_ledger_closing_blockers(text) FROM PUBLIC,yaparena_runtime;
    DO $$ DECLARE role_name text; BEGIN
      FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION yaparena.a4_ledger_discrepancies(text),yaparena.a4_ledger_closing_blockers(text) FROM %I',role_name);
        EXECUTE format('REVOKE ALL ON yaparena.a4_play_closing_balances FROM %I',role_name);
      END LOOP;
    END $$;
  `);
};

export const down = () => {
  throw new Error("Retain A4 financial audit history; use a forward fix");
};
