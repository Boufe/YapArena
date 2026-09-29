export const shorthands = undefined;

export const up = (pgm) => {
  pgm.alterColumn("users", "email", { notNull: false });
  pgm.alterColumn("users", "password_hash", { notNull: false });
  pgm.addConstraint("users", "users_email_password_pair", {
    check: "(email IS NULL) = (password_hash IS NULL)",
  });

  pgm.addColumns("public_profiles", {
    updated_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });
  pgm.addColumns("follows", {
    id: { type: "uuid", notNull: true, default: pgm.func("gen_random_uuid()") },
  });
  pgm.addConstraint("follows", "follows_pkey", { primaryKey: "id" });
  pgm.createIndex("follows", ["user_id", "created_at", "id"]);

  pgm.createTable("account_roles", {
    user_id: {
      type: "bigint",
      notNull: true,
      references: "users",
      onDelete: "CASCADE",
    },
    role: { type: "varchar(20)", notNull: true },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });
  pgm.addConstraint("account_roles", "account_roles_pkey", {
    primaryKey: ["user_id", "role"],
  });
  pgm.addConstraint("account_roles", "account_roles_allowed_role", {
    check: "role IN ('participant', 'moderator', 'operator', 'sponsor')",
  });

  pgm.createTable("identity_audit_events", {
    id: { type: "bigserial", primaryKey: true },
    user_id: { type: "bigint", notNull: true },
    event_type: { type: "varchar(40)", notNull: true },
    subject_id: { type: "text", notNull: true },
    occurred_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });
  pgm.createIndex("identity_audit_events", ["user_id", "occurred_at", "id"]);
  pgm.createIndex("identity_audit_events", "occurred_at");

  pgm.createTable("wallet_identities", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    user_id: {
      type: "bigint",
      notNull: true,
      references: "users",
      onDelete: "CASCADE",
    },
    chain_id: { type: "bigint", notNull: true },
    address: { type: "char(42)", notNull: true },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });
  pgm.addConstraint("wallet_identities", "wallet_identities_chain_positive", {
    check: "chain_id > 0",
  });
  pgm.addConstraint("wallet_identities", "wallet_identities_address_format", {
    check: "address ~ '^0x[0-9a-f]{40}$'",
  });
  pgm.addConstraint(
    "wallet_identities",
    "wallet_identities_chain_address_unique",
    {
      unique: ["chain_id", "address"],
    },
  );
  pgm.createIndex("wallet_identities", "user_id");

  pgm.createTable("wallet_challenges", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    address: { type: "char(42)", notNull: true },
    chain_id: { type: "bigint", notNull: true },
    purpose: { type: "varchar(12)", notNull: true },
    message: { type: "text", notNull: true },
    user_id: { type: "bigint", references: "users", onDelete: "CASCADE" },
    session_token_hash: { type: "char(64)" },
    expires_at: { type: "timestamptz", notNull: true },
    consumed_at: { type: "timestamptz" },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("current_timestamp"),
    },
  });
  pgm.addConstraint("wallet_challenges", "wallet_challenges_purpose", {
    check:
      "(purpose = 'login' AND user_id IS NULL AND session_token_hash IS NULL) OR (purpose = 'link' AND user_id IS NOT NULL AND session_token_hash IS NOT NULL)",
  });
  pgm.createIndex("wallet_challenges", "expires_at");

  pgm.sql(`CREATE FUNCTION identity_audit_row() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE owner_id bigint;
    DECLARE subject text;
    BEGIN
      IF TG_TABLE_NAME = 'sessions' THEN
        owner_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
        subject := CASE WHEN TG_OP = 'DELETE' THEN OLD.id::text ELSE NEW.id::text END;
      ELSIF TG_TABLE_NAME = 'public_profiles' THEN
        owner_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
        subject := CASE WHEN TG_OP = 'DELETE' THEN OLD.id::text ELSE NEW.id::text END;
      ELSIF TG_TABLE_NAME = 'follows' THEN
        owner_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
        subject := CASE WHEN TG_OP = 'DELETE' THEN OLD.id::text ELSE NEW.id::text END;
      ELSIF TG_TABLE_NAME = 'wallet_identities' THEN
        owner_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
        subject := CASE WHEN TG_OP = 'DELETE' THEN OLD.id::text ELSE NEW.id::text END;
      ELSE
        owner_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
        subject := CASE WHEN TG_OP = 'DELETE' THEN OLD.role ELSE NEW.role END;
      END IF;
      IF owner_id IS NOT NULL THEN
        INSERT INTO identity_audit_events (user_id, event_type, subject_id)
        VALUES (owner_id, TG_TABLE_NAME || '.' || lower(TG_OP), subject);
      END IF;
      RETURN COALESCE(NEW, OLD);
    END
  $$`);
  for (const table of [
    "sessions",
    "public_profiles",
    "follows",
    "account_roles",
    "wallet_identities",
  ]) {
    const operations =
      table === "public_profiles"
        ? "INSERT OR UPDATE OR DELETE"
        : "INSERT OR DELETE";
    pgm.sql(`CREATE TRIGGER ${table}_identity_audit AFTER ${operations} ON ${table}
      FOR EACH ROW EXECUTE FUNCTION identity_audit_row()`);
  }
  pgm.sql(`CREATE FUNCTION assign_participant_role() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO account_roles (user_id, role) VALUES (NEW.id, 'participant');
      RETURN NEW;
    END
  $$`);
  pgm.sql(`CREATE TRIGGER users_assign_participant AFTER INSERT ON users
    FOR EACH ROW EXECUTE FUNCTION assign_participant_role()`);
  pgm.sql(
    "INSERT INTO account_roles (user_id, role) SELECT id, 'participant' FROM users ON CONFLICT DO NOTHING",
  );
};

export const down = (pgm) => {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM users WHERE email IS NULL OR password_hash IS NULL) THEN
      RAISE EXCEPTION 'Cannot roll back wallet identity migration while wallet-only accounts exist; migrate those accounts first';
    END IF;
  END $$`);
  pgm.sql("DROP TRIGGER users_assign_participant ON users");
  pgm.sql("DROP FUNCTION assign_participant_role()");
  for (const table of [
    "sessions",
    "public_profiles",
    "follows",
    "account_roles",
    "wallet_identities",
  ]) {
    pgm.sql(`DROP TRIGGER ${table}_identity_audit ON ${table}`);
  }
  pgm.sql("DROP FUNCTION identity_audit_row()");
  pgm.dropTable("wallet_challenges");
  pgm.dropTable("wallet_identities");
  pgm.dropTable("identity_audit_events");
  pgm.dropTable("account_roles");
  pgm.dropConstraint("follows", "follows_pkey");
  pgm.dropColumn("follows", "id");
  pgm.dropColumn("public_profiles", "updated_at");
  pgm.dropConstraint("users", "users_email_password_pair");
  pgm.alterColumn("users", "email", { notNull: true });
  pgm.alterColumn("users", "password_hash", { notNull: true });
};
