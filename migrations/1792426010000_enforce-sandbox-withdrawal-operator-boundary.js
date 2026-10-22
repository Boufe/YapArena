export const shorthands = undefined;
export const up = (pgm) => {
  pgm.sql(`
    -- Runtime owns quoting and fresh-proof reservation. Review, submission and
    -- external outcome transitions belong to the separate owner process.
    CREATE FUNCTION yaparena.coin_withdrawal_operator_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF current_user='yaparena_runtime' AND NEW.kind='withdrawal' THEN
        IF TG_OP='INSERT' THEN
          IF NEW.status<>'quoted' THEN
            RAISE EXCEPTION 'withdrawal entry requires an unapproved quote' USING ERRCODE='42501';
          END IF;
        ELSIF NEW.status IS DISTINCT FROM OLD.status
          AND NOT (OLD.status='quoted' AND NEW.status='review') THEN
          RAISE EXCEPTION 'withdrawal transition requires the separate owner process' USING ERRCODE='42501';
        END IF;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER coin_withdrawal_operator_guard BEFORE INSERT OR UPDATE ON yaparena.coin_sandbox_requests
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_withdrawal_operator_guard();

    CREATE FUNCTION yaparena.coin_withdrawal_operator_event_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    BEGIN
      IF (NEW.kind IN ('withdrawal.approved','withdrawal.rejected','withdrawal.signed')
          OR NEW.kind LIKE 'withdrawal.external.%') AND current_user<>'yaparena_owner' THEN
        RAISE EXCEPTION 'withdrawal operator evidence requires the separate owner process' USING ERRCODE='42501';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER coin_withdrawal_operator_event_guard BEFORE INSERT ON yaparena.coin_sandbox_events
      FOR EACH ROW EXECUTE FUNCTION yaparena.coin_withdrawal_operator_event_guard();

    -- All legitimate inserts are in owner-only reserveSignedPayout. The web
    -- runtime cannot reserve a signed identity or manufacture approval evidence.
    REVOKE INSERT ON yaparena.coin_nonce_reservations FROM yaparena_runtime;
    REVOKE ALL ON FUNCTION yaparena.coin_withdrawal_operator_guard(),
      yaparena.coin_withdrawal_operator_event_guard() FROM PUBLIC;
  `);
};
export const down = () => {
  throw new Error(
    "Withdrawal operator separation requires a reviewed forward fix",
  );
};
