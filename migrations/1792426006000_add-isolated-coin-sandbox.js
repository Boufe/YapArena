export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`
    -- YC_PROMO is a spend-only entitlement, NOT USDC. At 100 YC/USDC,
    -- a YC_PROMO atom (precision 4) has the same numerical quoted value as
    -- one USDC atom (precision 6). Cross-asset journal transfers stay forbidden.
    DO $$ DECLARE item record; BEGIN
      FOR item IN SELECT conname FROM pg_constraint
        WHERE conrelid='yaparena.coin_accounts'::regclass AND contype='c'
          AND (pg_get_constraintdef(oid) LIKE '%asset%' OR pg_get_constraintdef(oid) LIKE '%precision%')
      LOOP EXECUTE format('ALTER TABLE yaparena.coin_accounts DROP CONSTRAINT %I',item.conname); END LOOP;
      FOR item IN SELECT conname FROM pg_constraint
        WHERE conrelid='yaparena.coin_journals'::regclass AND contype='c'
          AND pg_get_constraintdef(oid) LIKE '%asset%'
      LOOP EXECUTE format('ALTER TABLE yaparena.coin_journals DROP CONSTRAINT %I',item.conname); END LOOP;
    END $$;
    ALTER TABLE yaparena.coin_accounts ADD CONSTRAINT coin_asset_precision CHECK(
      (asset='USDC' AND precision=6) OR (asset='YC_PROMO' AND precision=4 AND environment='sandbox'));
    ALTER TABLE yaparena.coin_journals ADD CONSTRAINT coin_journal_asset CHECK(
      asset='USDC' OR (asset='YC_PROMO' AND environment='sandbox'));

    CREATE TABLE yaparena.coin_sandbox_books (
      user_id bigint PRIMARY KEY REFERENCES yaparena.account_subjects(id) ON DELETE RESTRICT,
      book jsonb NOT NULL,
      version bigint NOT NULL DEFAULT 0 CHECK(version>=0)
    );
    CREATE TABLE yaparena.coin_sandbox_controls (
      singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
      rail text NOT NULL CHECK(rail IN ('simulation','base-sepolia'))
    );
    INSERT INTO yaparena.coin_sandbox_controls(singleton,rail) VALUES(true,'simulation');
    CREATE FUNCTION yaparena.coin_sandbox_book_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF TG_OP='INSERT' THEN
        IF NEW.version<>0 OR NEW.book<>jsonb_build_object('scope',jsonb_build_object(
          'accountId',NEW.user_id::text,'environment','sandbox','asset','USDC','precision',6),
          'grants','[]'::jsonb,'purchased','[]'::jsonb) THEN
          RAISE EXCEPTION 'sandbox book starts empty' USING ERRCODE='23514';
        END IF;
      ELSIF pg_trigger_depth()<2 OR NEW.user_id<>OLD.user_id OR NEW.version<>OLD.version+1 THEN
        RAISE EXCEPTION 'sandbox book requires append-only event' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER sandbox_book_guard BEFORE INSERT OR UPDATE ON yaparena.coin_sandbox_books
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_sandbox_book_guard();

    CREATE TABLE yaparena.coin_sandbox_requests (
      id uuid PRIMARY KEY,
      user_id bigint NOT NULL REFERENCES yaparena.account_subjects(id) ON DELETE RESTRICT,
      environment text NOT NULL DEFAULT 'sandbox' CHECK(environment='sandbox'),
      kind text NOT NULL CHECK(kind IN ('funding','stake','withdrawal','correction')),
      reference char(64) NOT NULL CHECK(reference ~ '^[0-9a-f]{64}$'),
      terms_digest char(64) NOT NULL CHECK(terms_digest ~ '^[0-9a-f]{64}$'),
      terms jsonb NOT NULL CHECK(jsonb_typeof(terms)='object'),
      status text NOT NULL CHECK(status IN ('quoted','review','reserved','approved','pending','executed','completed','settled','failed','uncertain','void')),
      expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(user_id,kind,reference),UNIQUE(id,user_id)
    );
    CREATE FUNCTION yaparena.coin_sandbox_request_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') THEN
        RAISE EXCEPTION 'sandbox request terms are immutable' USING ERRCODE='23514';
      END IF;
      IF OLD.status IN ('completed','settled','failed','void') AND NEW.status<>OLD.status THEN
        RAISE EXCEPTION 'sandbox terminal outcome requires an auditable correction' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER sandbox_request_guard BEFORE UPDATE ON yaparena.coin_sandbox_requests
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_sandbox_request_guard();
    CREATE TRIGGER sandbox_request_history BEFORE DELETE ON yaparena.coin_sandbox_requests
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_immutable();

    CREATE TABLE yaparena.coin_sandbox_events (
      sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id uuid NOT NULL UNIQUE,
      user_id bigint NOT NULL REFERENCES yaparena.coin_sandbox_books(user_id) ON DELETE RESTRICT,
      environment text NOT NULL DEFAULT 'sandbox' CHECK(environment='sandbox'),
      kind text NOT NULL CHECK(length(kind) BETWEEN 1 AND 80),
      reference char(64) NOT NULL CHECK(reference ~ '^[0-9a-f]{64}$'),
      terms_digest char(64) NOT NULL CHECK(terms_digest ~ '^[0-9a-f]{64}$'),
      before_version bigint NOT NULL CHECK(before_version>=0),
      book_after jsonb NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(metadata)='object'),
      request_id uuid,
      cash_journal_id uuid,
      cash_asset text NOT NULL DEFAULT 'USDC' CHECK(cash_asset='USDC'),
      promo_journal_id uuid,
      promo_asset text NOT NULL DEFAULT 'YC_PROMO' CHECK(promo_asset='YC_PROMO'),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(user_id,reference),
      FOREIGN KEY(request_id,user_id) REFERENCES yaparena.coin_sandbox_requests(id,user_id),
      FOREIGN KEY(cash_journal_id,environment,cash_asset) REFERENCES yaparena.coin_journals(id,environment,asset),
      FOREIGN KEY(promo_journal_id,environment,promo_asset) REFERENCES yaparena.coin_journals(id,environment,asset),
      CHECK(COALESCE(book_after#>>'{scope,accountId}','')=user_id::text
        AND COALESCE(book_after#>>'{scope,environment}','')='sandbox'
        AND COALESCE(book_after#>>'{scope,asset}','')='USDC'
        AND COALESCE(book_after#>>'{scope,precision}','')='6')
    );
    CREATE INDEX sandbox_events_owner ON yaparena.coin_sandbox_events(user_id,sequence DESC);
    CREATE INDEX sandbox_events_request ON yaparena.coin_sandbox_events(request_id,sequence DESC);
    CREATE FUNCTION yaparena.coin_sandbox_project_event() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      UPDATE yaparena.coin_sandbox_books SET book=NEW.book_after,version=version+1
        WHERE user_id=NEW.user_id AND version=NEW.before_version;
      IF NOT FOUND THEN RAISE EXCEPTION 'sandbox event version conflict' USING ERRCODE='40001'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER sandbox_event_projection AFTER INSERT ON yaparena.coin_sandbox_events
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_sandbox_project_event();
    CREATE TRIGGER sandbox_event_history BEFORE UPDATE OR DELETE ON yaparena.coin_sandbox_events
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_immutable();

    CREATE TABLE yaparena.coin_sandbox_system_accounts (
      purpose text NOT NULL CHECK(purpose IN ('purchased_external','promotional_external','promotional_available',
        'promotional_reserved','center_external','center_available','center_reserved','fees','correction_available','grant_issuer')),
      environment text NOT NULL DEFAULT 'sandbox' CHECK(environment='sandbox'),
      asset text NOT NULL CHECK(asset IN ('USDC','YC_PROMO')),
      account_id uuid NOT NULL UNIQUE,
      PRIMARY KEY(purpose,asset),
      FOREIGN KEY(account_id,environment,asset) REFERENCES yaparena.coin_accounts(id,environment,asset),
      CHECK((purpose='grant_issuer')=(asset='YC_PROMO'))
    );
    CREATE TRIGGER sandbox_system_history BEFORE UPDATE OR DELETE ON yaparena.coin_sandbox_system_accounts
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_immutable();
    CREATE TABLE yaparena.coin_external_receipts (
      id uuid PRIMARY KEY,
      request_id uuid NOT NULL REFERENCES yaparena.coin_sandbox_requests(id),
      environment text NOT NULL DEFAULT 'sandbox' CHECK(environment='sandbox'),
      network text NOT NULL,asset text NOT NULL CHECK(asset='USDC'),
      transaction_id text NOT NULL CHECK(length(transaction_id) BETWEEN 1 AND 200),
      locator text NOT NULL CHECK(length(locator) BETWEEN 1 AND 200),
      amount numeric(36,0) NOT NULL CHECK(amount>0),
      evidence_digest char(64) NOT NULL CHECK(evidence_digest ~ '^[0-9a-f]{64}$'),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(environment,network,asset,transaction_id,locator)
    );
    CREATE TRIGGER sandbox_receipt_history BEFORE UPDATE OR DELETE ON yaparena.coin_external_receipts
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_immutable();
    CREATE TABLE yaparena.coin_nonce_reservations (
      request_id uuid PRIMARY KEY REFERENCES yaparena.coin_sandbox_requests(id),
      environment text NOT NULL DEFAULT 'sandbox' CHECK(environment='sandbox'),
      network text NOT NULL CHECK(network='base-sepolia:84532'),
      sender char(42) NOT NULL CHECK(sender ~ '^0x[0-9a-f]{40}$'),
      nonce numeric(20,0) NOT NULL CHECK(nonce>=0),
      transaction_id char(66) NOT NULL CHECK(transaction_id ~ '^0x[0-9a-f]{64}$'),
      signed_bytes text NOT NULL CHECK(length(signed_bytes) BETWEEN 2 AND 32768),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(environment,network,sender,nonce),UNIQUE(environment,network,transaction_id)
    );
    CREATE TRIGGER sandbox_nonce_history BEFORE UPDATE OR DELETE ON yaparena.coin_nonce_reservations
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_immutable();

    CREATE FUNCTION yaparena.coin_sandbox_rail_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('coin-sandbox-rail',0));
      IF EXISTS(SELECT 1 FROM yaparena.coin_sandbox_books)
        OR EXISTS(SELECT 1 FROM yaparena.coin_sandbox_requests)
        OR EXISTS(SELECT 1 FROM yaparena.coin_accounts WHERE environment='sandbox')
        OR EXISTS(SELECT 1 FROM yaparena.coin_journals WHERE environment='sandbox') THEN
        RAISE EXCEPTION 'sandbox rail is immutable after initialization; use an isolated database' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER sandbox_rail_guard BEFORE UPDATE ON yaparena.coin_sandbox_controls
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_sandbox_rail_guard();
    CREATE TRIGGER sandbox_controls_history BEFORE DELETE ON yaparena.coin_sandbox_controls
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_immutable();

    REVOKE ALL ON FUNCTION yaparena.coin_sandbox_book_guard(),yaparena.coin_sandbox_request_guard(),
      yaparena.coin_sandbox_project_event(),yaparena.coin_sandbox_rail_guard() FROM PUBLIC;
    GRANT SELECT ON yaparena.coin_sandbox_controls TO yaparena_runtime;
    ALTER TABLE yaparena.coin_sandbox_controls ENABLE ROW LEVEL SECURITY;
    CREATE POLICY sandbox_controls_read ON yaparena.coin_sandbox_controls FOR SELECT TO yaparena_runtime USING(true);
    -- The existing web role gets SANDBOX-only write policies. Live USDC remains
    -- read-only. No owner/admin credential is added to any runtime process.
    GRANT INSERT ON yaparena.coin_accounts,yaparena.coin_journals,yaparena.coin_postings,
      yaparena.coin_grant_lots,yaparena.coin_grant_profit_events TO yaparena_runtime;
    GRANT UPDATE(balance) ON yaparena.coin_accounts TO yaparena_runtime;
    GRANT USAGE ON SEQUENCE yaparena.coin_grant_profit_events_id_seq TO yaparena_runtime;
    CREATE POLICY coin_sandbox_balance ON yaparena.coin_accounts FOR UPDATE TO yaparena_runtime
      USING(environment='sandbox') WITH CHECK(environment='sandbox');
    GRANT SELECT,INSERT ON yaparena.coin_sandbox_books,yaparena.coin_sandbox_requests,
      yaparena.coin_sandbox_events,yaparena.coin_sandbox_system_accounts,yaparena.coin_external_receipts,
      yaparena.coin_nonce_reservations TO yaparena_runtime;
    GRANT UPDATE(book,version) ON yaparena.coin_sandbox_books TO yaparena_runtime;
    GRANT UPDATE(status) ON yaparena.coin_sandbox_requests TO yaparena_runtime;
    GRANT USAGE ON SEQUENCE yaparena.coin_sandbox_events_sequence_seq TO yaparena_runtime;
  `);
  for (const table of [
    "coin_accounts",
    "coin_journals",
    "coin_postings",
    "coin_grant_lots",
    "coin_grant_profit_events",
  ])
    pgm.sql(
      `CREATE POLICY sandbox_insert ON yaparena.${table} FOR INSERT TO yaparena_runtime WITH CHECK(environment='sandbox')`,
    );
  for (const table of [
    "coin_sandbox_books",
    "coin_sandbox_requests",
    "coin_sandbox_events",
    "coin_sandbox_system_accounts",
    "coin_external_receipts",
    "coin_nonce_reservations",
  ]) {
    pgm.sql(`ALTER TABLE yaparena.${table} ENABLE ROW LEVEL SECURITY;
      CREATE POLICY sandbox_access ON yaparena.${table} TO yaparena_runtime USING(true) WITH CHECK(true)`);
  }
};

export const down = () => {
  throw new Error("Financial sandbox history must be retained; forward-fix");
};
