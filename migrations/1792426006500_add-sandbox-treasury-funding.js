export const shorthands = undefined;
export const up = (pgm) => {
  pgm.sql(`ALTER TABLE yaparena.coin_sandbox_requests DROP CONSTRAINT coin_sandbox_requests_kind_check;
    ALTER TABLE yaparena.coin_sandbox_requests ADD CONSTRAINT coin_sandbox_requests_kind_check
      CHECK(kind IN ('funding','stake','withdrawal','correction','treasury'));
    -- Requests settle one exact transfer, not an undisclosed partial-payment
    -- aggregator. Do not consume another incoming payment on a completed retry.
    CREATE UNIQUE INDEX coin_external_receipt_request ON yaparena.coin_external_receipts(request_id);`);
};
export const down = () => {
  throw new Error("Treasury funding history requires a reviewed forward fix");
};
