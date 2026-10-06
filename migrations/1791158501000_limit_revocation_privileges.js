export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`DO $$ BEGIN
    IF current_schema() = 'yaparena' AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yaparena_runtime') THEN
      REVOKE UPDATE (email, password_hash) ON users FROM yaparena_runtime;
      REVOKE EXECUTE ON FUNCTION enforce_session_generation(), revoke_changed_password(), revoke_removed_wallet() FROM yaparena_runtime;
    END IF;
  END $$`);
};

export const down = () => {
  throw new Error(
    "Do not restore unnecessary credential-write privileges; use a compatible forward fix",
  );
};
