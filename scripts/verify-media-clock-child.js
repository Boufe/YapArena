import pg from "pg";
import { runExclusiveDatabaseJob } from "../dist/platform/database-jobs.js";
import { verifyRuntimeIdentity } from "../dist/platform/database.js";

// Only the disposable parent harness supplies this synthetic runtime connection.
const connectionString = process.env.MEDIA_TRIAL_RUNTIME_URL;
const address = new URL(connectionString);
if (address.hostname !== "127.0.0.1" || address.username !== "yaparena_runtime")
  throw Error("Disposable runtime URL required");
const pool = new pg.Pool({
  connectionString,
  options: "-c search_path=pg_catalog,yaparena,pg_temp",
  max: 1,
});
let release;
const gate = new Promise((resolve) => {
  release = resolve;
});
process.on("message", (message) => {
  if (message?.type === "release") release();
});
const timeout = setTimeout(() => process.exit(1), 10000);
try {
  await verifyRuntimeIdentity(pool);
  await runExclusiveDatabaseJob(pool, "media-clock", async (client) => {
    const result = await client.query(
      "SELECT pg_backend_pid() AS pid,current_user AS identity",
    );
    process.send({ type: "ready", ...result.rows[0] });
    await gate;
  });
} finally {
  clearTimeout(timeout);
  await pool.end();
  process.disconnect();
}
