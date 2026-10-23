import {
  lockAccount,
  revokeAccountSessions,
  SessionUnavailableError,
} from "../../dist/platform/auth/sessions.js";

// Ends every session of an account through the security-incident path, the
// only remaining application path that advances auth_generation for sessions.
// Tests use it where they need a generation change that queues a provider
// reset, which ordinary sign-out no longer does.
export async function endAllAccountSessions(pool, userId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (!(await lockAccount(client, userId)))
      throw new SessionUnavailableError("account is unavailable");
    const generation = await revokeAccountSessions(client, userId, {
      action: "sessions.incident",
    });
    await client.query("COMMIT");
    return generation;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
