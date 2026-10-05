export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE wallet_operations (
      id uuid PRIMARY KEY,
      user_id bigint NOT NULL REFERENCES users ON DELETE CASCADE,
      session_token_hash char(64) NOT NULL,
      auth_generation bigint NOT NULL,
      purpose text NOT NULL CHECK (purpose IN ('link', 'unlink')),
      address char(42) NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
      chain_id bigint NOT NULL CHECK (chain_id > 0),
      target_wallet_id uuid,
      credential_type text NOT NULL CHECK (credential_type IN ('password', 'wallet')),
      authorizing_wallet_id uuid,
      authorizing_address char(42),
      authorizing_chain_id bigint,
      authorization_message text,
      proposed_message text,
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CHECK ((purpose = 'link' AND target_wallet_id IS NULL AND proposed_message IS NOT NULL)
          OR (purpose = 'unlink' AND target_wallet_id IS NOT NULL AND proposed_message IS NULL)),
      CHECK ((credential_type = 'password'
              AND authorizing_wallet_id IS NULL AND authorizing_address IS NULL
              AND authorizing_chain_id IS NULL AND authorization_message IS NULL)
          OR (credential_type = 'wallet'
              AND authorizing_wallet_id IS NOT NULL AND authorizing_address IS NOT NULL
              AND authorizing_chain_id IS NOT NULL AND authorizing_chain_id > 0
              AND authorization_message IS NOT NULL))
    );
    CREATE INDEX wallet_operations_expires_idx ON wallet_operations (expires_at);
    ALTER TABLE wallet_operations ENABLE ROW LEVEL SECURITY;
    CREATE POLICY wallet_operations_backend ON wallet_operations
      TO yaparena_runtime USING (true) WITH CHECK (true);
    GRANT SELECT, INSERT, DELETE ON wallet_operations TO yaparena_runtime;
    GRANT UPDATE (consumed_at) ON wallet_operations TO yaparena_runtime;
  `);
};

export const down = (pgm) => {
  pgm.dropTable("wallet_operations");
};
