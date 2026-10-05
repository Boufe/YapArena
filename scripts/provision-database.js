import pg from "pg";
import { pathToFileURL } from "node:url";
import {
  runtimeGrants,
  applicationRoutines,
} from "../migrations/1791158400000_isolate_server_database.js";

const identifier = (value) => `"${value.replaceAll('"', '""')}"`;

// Administrative operator step, separate from ordinary node-pg-migrate migrations.
// No passwords in SQL artifacts, command arguments, output, or migration history.
export async function provisionDatabase(client, passwords = {}) {
  await client.query("BEGIN");
  try {
    if (
      passwords.yaparena_owner &&
      passwords.yaparena_owner === passwords.yaparena_runtime
    )
      throw new Error("Owner and runtime passwords must be distinct");
    if (
      passwords.yaparena_runtime &&
      passwords.yaparena_runtime === client.connectionParameters.password
    )
      throw new Error("Administrator and runtime passwords must be distinct");
    for (const role of ["yaparena_owner", "yaparena_runtime"]) {
      const existing = await client.query(
        "SELECT * FROM pg_roles WHERE rolname = $1",
        [role],
      );
      if (!existing.rowCount) {
        if (!passwords[role])
          throw new Error("New identities require secret-managed passwords");
        const command = await client.query(
          "SELECT format('CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', $1::text, $2::text) AS sql",
          [role, passwords[role]],
        );
        await client.query(command.rows[0].sql);
      }
    }
    const unsafe = await client.query(`SELECT rolname FROM pg_roles
      WHERE rolname IN ('yaparena_owner', 'yaparena_runtime')
        AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication OR NOT rolcanlogin)
      UNION ALL SELECT 'membership' FROM pg_auth_members
        WHERE member IN ('yaparena_runtime'::regrole, 'yaparena_owner'::regrole)
          OR roleid = 'yaparena_runtime'::regrole`);
    if (unsafe.rowCount)
      throw new Error(
        "Unsafe pre-existing database identities; inspect inventory first",
      );
    const administrator = (
      await client.query(
        "SELECT current_user AS name, current_database() AS database",
      )
    ).rows[0];
    // An administrative operator may assume owner; runtime/browser roles may never do so.
    await client.query(
      `GRANT yaparena_owner TO ${identifier(administrator.name)}`,
    );
    const browserEscalation =
      await client.query(`SELECT b.rolname FROM pg_roles b
      WHERE b.rolname IN ('anon','authenticated','authenticator') AND (
        b.rolsuper OR b.rolbypassrls OR b.rolcreaterole OR
        EXISTS (SELECT 1 FROM pg_roles privileged WHERE
          (privileged.rolname IN ('yaparena_owner','yaparena_runtime') OR
            privileged.rolsuper OR privileged.rolbypassrls OR privileged.rolcreaterole)
          AND b.oid <> privileged.oid AND pg_has_role(b.oid,privileged.oid,'MEMBER')))
    `);
    if (browserEscalation.rowCount)
      throw new Error(
        "Browser/API role has an unsafe administrative membership",
      );
    for (const schema of ["yaparena", "yaparena_migrations"]) {
      await client.query(
        `CREATE SCHEMA IF NOT EXISTS ${schema} AUTHORIZATION yaparena_owner`,
      );
      const owner = await client.query(
        "SELECT nspowner = 'yaparena_owner'::regrole AS safe FROM pg_namespace WHERE nspname = $1",
        [schema],
      );
      if (!owner.rows[0].safe)
        throw new Error("Existing private schema has an unexpected owner");
    }
    // Adopt only explicitly named application tables. ALTER TABLE SET SCHEMA moves owned
    // sequences/indexes too. Never transfer every object owned by postgres on Supabase.
    for (const table of [...Object.keys(runtimeGrants), "pgmigrations"]) {
      const target =
        table === "pgmigrations" ? "yaparena_migrations" : "yaparena";
      const found = await client.query(
        `SELECT n.nspname, c.relkind FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = $1 AND n.nspname IN ('public', $2)`,
        [table, target],
      );
      if (found.rowCount > 1)
        throw new Error(
          "Ambiguous application object; manual inventory required",
        );
      if (!found.rowCount) continue; // fresh installation
      if (found.rows[0].relkind !== "r")
        throw new Error("Unexpected application object kind");
      const source = identifier(found.rows[0].nspname);
      await client.query(
        `ALTER TABLE ${source}.${table} OWNER TO yaparena_owner`,
      );
      if (found.rows[0].nspname !== target)
        await client.query(
          `ALTER TABLE ${source}.${table} SET SCHEMA ${target}`,
        );
    }
    for (const routine of applicationRoutines) {
      const found = await client.query(
        `SELECT n.nspname FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname = $1 AND p.pronargs = 0 AND n.nspname IN ('public','yaparena')`,
        [routine],
      );
      if (found.rowCount > 1) throw new Error("Ambiguous application routine");
      if (!found.rowCount) continue;
      const source = identifier(found.rows[0].nspname);
      await client.query(
        `ALTER FUNCTION ${source}.${routine}() OWNER TO yaparena_owner`,
      );
      if (found.rows[0].nspname !== "yaparena")
        await client.query(
          `ALTER FUNCTION ${source}.${routine}() SET SCHEMA yaparena`,
        );
      await client.query(
        `ALTER FUNCTION yaparena.${routine}() SET search_path = pg_catalog, yaparena, pg_temp`,
      );
    }
    // Known cross-schema view dependencies remain valid after a move and can leak data.
    // Fail rather than modify an object outside our ownership scope.
    const dependencies =
      await client.query(`SELECT DISTINCT v.oid FROM pg_depend d
      JOIN pg_rewrite rw ON rw.oid = d.objid AND d.classid = 'pg_rewrite'::regclass
      JOIN pg_class v ON v.oid = rw.ev_class JOIN pg_namespace vn ON vn.oid = v.relnamespace
      JOIN pg_class t ON t.oid = d.refobjid AND d.refclassid = 'pg_class'::regclass
      JOIN pg_namespace tn ON tn.oid = t.relnamespace
      WHERE tn.nspname IN ('yaparena','yaparena_migrations')
        AND vn.nspname NOT IN ('yaparena','yaparena_migrations')`);
    if (dependencies.rowCount)
      throw new Error(
        "External views reference application data; operator review required",
      );
    const routineDependencies =
      await client.query(`SELECT DISTINCT p.oid FROM pg_depend d
      JOIN pg_proc p ON p.oid=d.objid AND d.classid='pg_proc'::regclass
      JOIN pg_namespace pn ON pn.oid=p.pronamespace
      JOIN pg_class t ON t.oid=d.refobjid AND d.refclassid='pg_class'::regclass
      JOIN pg_namespace tn ON tn.oid=t.relnamespace
      WHERE tn.nspname IN ('yaparena','yaparena_migrations')
        AND pn.nspname NOT IN ('yaparena','yaparena_migrations')`);
    if (routineDependencies.rowCount)
      throw new Error(
        "External routines reference application data; operator review required",
      );
    for (const role of ["yaparena_owner", "yaparena_runtime"]) {
      await client.query(
        `GRANT CONNECT ON DATABASE ${identifier(administrator.database)} TO ${role}`,
      );
      await client.query(
        `ALTER ROLE ${role} IN DATABASE ${identifier(administrator.database)} SET search_path = pg_catalog, yaparena, pg_temp`,
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_ADMIN_URL,
  });
  try {
    if (!process.env.DATABASE_ADMIN_URL)
      throw new Error("DATABASE_ADMIN_URL is required");
    await client.connect();
    await provisionDatabase(client, {
      yaparena_owner: process.env.DATABASE_OWNER_PASSWORD,
      yaparena_runtime: process.env.DATABASE_RUNTIME_PASSWORD,
    });
    console.log(
      "Application identities and ownership provisioned; run the separate migration job next.",
    );
  } catch (error) {
    // pg errors can contain statements/credentials. Print only a SQLSTATE or fixed failure.
    console.error(
      `Database provisioning failed (${error.code ?? "operator review required"}).`,
    );
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
