export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE yaparena.provider_revocation_jobs
      ADD COLUMN control_phase text NOT NULL DEFAULT 'legacy'
        CHECK(control_phase IN ('legacy','preflight','freeze_intent','freeze_confirm','unfreeze_intent','unfreeze_confirm','done')),
      ADD COLUMN control_id uuid,
      ADD COLUMN control_credentials_digest text CHECK(control_credentials_digest ~ '^[0-9a-f]{64}$'),
      ADD COLUMN control_attempt integer CHECK(control_attempt>0),
      ADD COLUMN control_lease_id uuid,
      ADD COLUMN control_deadline_at timestamptz,
      ADD COLUMN control_reads integer NOT NULL DEFAULT 0 CHECK(control_reads BETWEEN 0 AND 8),
      ADD COLUMN control_lease_until timestamptz NOT NULL DEFAULT '-infinity',
      ADD COLUMN control_next_check_at timestamptz NOT NULL DEFAULT '-infinity',
      ADD COLUMN freeze_requested_at timestamptz,
      ADD COLUMN freeze_acknowledged_at timestamptz,
      ADD COLUMN unfreeze_requested_at timestamptz,
      ADD COLUMN unfreeze_acknowledged_at timestamptz;
    -- Existing pending/running jobs retain the conservative legacy boundary;
    -- in particular, no old manual/unknown mutation is admitted for polling.
    ALTER TABLE yaparena.provider_revocation_jobs ALTER COLUMN control_phase SET DEFAULT 'preflight';
    CREATE INDEX provider_control_due ON yaparena.provider_revocation_jobs(control_next_check_at,control_lease_until)
      WHERE state IN ('pending','running') AND control_phase<>'legacy';
  `);
};

export const down = () => {
  throw new Error("Provider control phases require a forward fix");
};
