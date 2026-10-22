export const shorthands = undefined;

// Decision 0008, step 9: requests no longer read Privy. A request whose last
// Privy read is older than the re-check interval schedules one asynchronous
// read. NULL means "never re-read since this release" and is due at once.
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE yaparena.provider_identities ADD COLUMN checked_at timestamptz;
    GRANT UPDATE(checked_at) ON yaparena.provider_identities TO yaparena_runtime;
  `);
};

export const down = () => {
  throw new Error("Provider identity checks require a forward fix");
};
