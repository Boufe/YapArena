export const shorthands = undefined;

// Exact repository-owned objects; provider schemas/objects are outside this migration.
// Provisioning imports this manifest to adopt an existing installation.
export const runtimeGrants = Object.freeze({
  users: "SELECT, INSERT, UPDATE (id)", // pg requires UPDATE for wallet row locks
  sessions: "SELECT, INSERT, DELETE",
  messages: "SELECT, INSERT",
  public_profiles: "SELECT, INSERT, UPDATE",
  topics: "SELECT, INSERT, UPDATE",
  sponsors: "", // no backend query currently uses this table
  debates: "SELECT, INSERT, UPDATE",
  follows: "SELECT, INSERT, DELETE",
  account_roles: "SELECT, INSERT", // participant assignment trigger, no role administration API
  identity_audit_events: "SELECT, INSERT, DELETE",
  wallet_identities: "SELECT, INSERT, DELETE",
  wallet_challenges: "SELECT, INSERT, UPDATE, DELETE",
  event_rule_versions: "SELECT",
  match_requests: "SELECT, INSERT, UPDATE",
  event_participants: "SELECT, INSERT, UPDATE",
  event_history: "SELECT, INSERT",
  account_notifications: "SELECT, INSERT, UPDATE",
  debate_media: "SELECT, INSERT, UPDATE, DELETE",
  media_device_checks: "SELECT, INSERT, UPDATE",
  event_chat_controls: "SELECT, INSERT, UPDATE",
  event_chat_messages: "SELECT, INSERT, UPDATE, DELETE",
  event_likes: "SELECT, INSERT, DELETE",
  moderation_cases: "SELECT, INSERT, UPDATE, DELETE",
  community_restrictions: "SELECT, INSERT, UPDATE",
  moderation_appeals: "SELECT, INSERT, UPDATE",
  community_audit_events: "SELECT, INSERT",
  event_like_changes: "SELECT, INSERT, DELETE",
  product_measurement_consents: "SELECT, INSERT, UPDATE, DELETE",
  product_measurement_affiliations: "SELECT, INSERT, UPDATE, DELETE",
  product_measurement_affiliation_audit: "SELECT, INSERT, DELETE",
  product_measurement_events: "SELECT, INSERT, DELETE",
  product_measurement_watch_sessions: "SELECT, INSERT, UPDATE, DELETE",
});

export const applicationRoutines = [
  "identity_audit_row",
  "assign_participant_role",
  "product_measurement_record_completion",
];

export const up = (pgm) => {
  pgm.sql(`DO $$ BEGIN
    IF current_user <> 'yaparena_owner' THEN
      RAISE EXCEPTION 'Use the separately provisioned migration identity';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yaparena_runtime'
      AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication))
      OR EXISTS (SELECT 1 FROM pg_auth_members WHERE
        member = 'yaparena_runtime'::regrole OR roleid = 'yaparena_runtime'::regrole) THEN
      RAISE EXCEPTION 'Runtime role attributes or memberships are unsafe';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles b WHERE b.rolname IN ('anon','authenticated','authenticator')
      AND (b.rolsuper OR b.rolbypassrls OR b.rolcreaterole OR
        pg_has_role(b.oid, 'yaparena_owner', 'MEMBER') OR
        pg_has_role(b.oid, 'yaparena_runtime', 'MEMBER'))) THEN
      RAISE EXCEPTION 'Browser/API role attributes or owner/runtime memberships are unsafe';
    END IF;
  END $$`);

  // Reset ACLs on our private schemas and objects, including inherited/indirect grantees.
  // Never use ALL ... IN SCHEMA public or REASSIGN OWNED on a provider database.
  pgm.sql(`DO $$ DECLARE object record; grantee text; column_acl record; BEGIN
    FOR object IN SELECT nspname, nspacl, nspowner FROM pg_namespace
      WHERE nspname IN ('yaparena', 'yaparena_migrations') LOOP
      FOR grantee IN SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC'
        ELSE quote_ident(pg_get_userbyid(a.grantee)) END
        FROM aclexplode(COALESCE(object.nspacl, acldefault('n', object.nspowner))) a
        WHERE a.grantee <> 'yaparena_owner'::regrole LOOP
        EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %s CASCADE', object.nspname, grantee);
      END LOOP;
      EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', object.nspname);
    END LOOP;
    FOR object IN SELECT c.oid, n.nspname, c.relname, c.relkind, c.relacl, c.relowner
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('yaparena', 'yaparena_migrations') AND c.relkind IN ('r','p','v','m','S','f') LOOP
      IF (SELECT relowner FROM pg_class WHERE oid = object.oid) <> 'yaparena_owner'::regrole THEN
        RAISE EXCEPTION 'Unexpected owner in application schemas';
      END IF;
      FOR grantee IN SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC'
        ELSE quote_ident(pg_get_userbyid(a.grantee)) END
        FROM aclexplode(COALESCE(object.relacl, acldefault(
          CASE WHEN object.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, object.relowner))) a
        WHERE a.grantee <> 'yaparena_owner'::regrole LOOP
        EXECUTE format('REVOKE ALL ON %s %I.%I FROM %s CASCADE',
          CASE WHEN object.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
          object.nspname, object.relname, grantee);
      END LOOP;
      EXECUTE format('REVOKE ALL ON %s %I.%I FROM PUBLIC',
        CASE WHEN object.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, object.nspname, object.relname);
      FOR column_acl IN SELECT a.attname, x.grantee FROM pg_attribute a,
        LATERAL aclexplode(a.attacl) x WHERE a.attrelid = object.oid
        AND x.grantee <> 'yaparena_owner'::regrole LOOP
        EXECUTE format('REVOKE ALL (%I) ON TABLE %I.%I FROM %s CASCADE',
          column_acl.attname, object.nspname, object.relname,
          CASE WHEN column_acl.grantee = 0 THEN 'PUBLIC'
            ELSE quote_ident(pg_get_userbyid(column_acl.grantee)) END);
      END LOOP;
    END LOOP;
    FOR object IN SELECT p.oid::regprocedure AS signature, p.proacl, p.proowner
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('yaparena', 'yaparena_migrations') LOOP
      IF object.proowner <> 'yaparena_owner'::regrole THEN
        RAISE EXCEPTION 'Unexpected routine owner in application schemas';
      END IF;
      FOR grantee IN SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC'
        ELSE quote_ident(pg_get_userbyid(a.grantee)) END
        FROM aclexplode(COALESCE(object.proacl, acldefault('f', object.proowner))) a
        WHERE a.grantee <> 'yaparena_owner'::regrole LOOP
        EXECUTE format('REVOKE ALL ON ROUTINE %s FROM %s CASCADE', object.signature, grantee);
      END LOOP;
    END LOOP;
  END $$`);

  pgm.sql(
    "GRANT USAGE ON SCHEMA yaparena, yaparena_migrations TO yaparena_runtime",
  );
  pgm.sql(
    "GRANT SELECT ON yaparena_migrations.pgmigrations TO yaparena_runtime",
  );
  for (const [table, grants] of Object.entries(runtimeGrants)) {
    if (grants)
      pgm.sql(`GRANT ${grants} ON yaparena.${table} TO yaparena_runtime`);
    // Private schema plus RLS defense in depth. Express remains the user authorizer.
    pgm.sql(`ALTER TABLE yaparena.${table} ENABLE ROW LEVEL SECURITY`);
    // Policies combine with OR. Remove pre-existing application policies so a
    // PUBLIC/inherited policy cannot broaden the explicitly scoped backend policy.
    pgm.sql(`DO $$ DECLARE p record; BEGIN
      FOR p IN SELECT polname FROM pg_policy WHERE polrelid = 'yaparena.${table}'::regclass LOOP
        EXECUTE format('DROP POLICY %I ON yaparena.${table}', p.polname);
      END LOOP;
    END $$`);
    if (table === "account_roles") {
      pgm.sql(
        `CREATE POLICY backend_read ON yaparena.account_roles FOR SELECT TO yaparena_runtime USING (true)`,
      );
      pgm.sql(`CREATE POLICY backend_assign_participant ON yaparena.account_roles FOR INSERT
        TO yaparena_runtime WITH CHECK (role = 'participant')`);
    } else {
      pgm.sql(`CREATE POLICY backend_access ON yaparena.${table}
        TO yaparena_runtime USING (true) WITH CHECK (true)`);
    }
  }
  // USAGE permits nextval/currval, never setval. Metadata sequence gets no runtime grant.
  pgm.sql(
    "GRANT USAGE ON ALL SEQUENCES IN SCHEMA yaparena TO yaparena_runtime",
  );
  for (const routine of applicationRoutines) {
    pgm.sql(`ALTER FUNCTION yaparena.${routine}() SECURITY INVOKER`);
    pgm.sql(
      `ALTER FUNCTION yaparena.${routine}() SET search_path = pg_catalog, yaparena, pg_temp`,
    );
    // Runtime never calls these directly. Trigger execution uses invoker data privileges.
  }

  // Global revocation is necessary: schema defaults cannot subtract global PUBLIC EXECUTE.
  // This is safe because this identity only creates application objects, never provider objects.
  pgm.sql(`DO $$ DECLARE d record; a record; BEGIN
    FOR d IN SELECT * FROM pg_default_acl WHERE defaclrole = 'yaparena_owner'::regrole
      AND (defaclnamespace = 0 OR defaclnamespace IN
        (SELECT oid FROM pg_namespace WHERE nspname IN ('yaparena','yaparena_migrations')))
      AND defaclobjtype IN ('r','s','f') LOOP
      FOR a IN SELECT DISTINCT grantee FROM aclexplode(d.defaclacl)
        WHERE grantee <> 'yaparena_owner'::regrole LOOP
        EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE yaparena_owner%s REVOKE ALL ON %s FROM %s',
          CASE WHEN d.defaclnamespace = 0 THEN '' ELSE
            ' IN SCHEMA ' || quote_ident((SELECT nspname FROM pg_namespace WHERE oid = d.defaclnamespace)) END,
          CASE d.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 's' THEN 'SEQUENCES' ELSE 'ROUTINES' END,
          CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END);
      END LOOP;
    END LOOP;
  END $$`);
  for (const scope of [
    "",
    " IN SCHEMA yaparena",
    " IN SCHEMA yaparena_migrations",
  ]) {
    for (const kind of ["TABLES", "SEQUENCES", "ROUTINES"]) {
      pgm.sql(
        `ALTER DEFAULT PRIVILEGES FOR ROLE yaparena_owner${scope} REVOKE ALL ON ${kind} FROM PUBLIC`,
      );
      for (const role of ["anon", "authenticated", "service_role"]) {
        pgm.sql(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
          ALTER DEFAULT PRIVILEGES FOR ROLE yaparena_owner${scope} REVOKE ALL ON ${kind} FROM ${role};
        END IF; END $$`);
      }
    }
  }
  // Future objects fail closed. Each new migration grants its query-specific runtime privileges
  // and creates backend_access if it enables RLS; no blanket DML or EXECUTE defaults.
};

export const down = () => {
  throw new Error(
    "Database isolation is irreversible here; use a reviewed forward fix",
  );
};
