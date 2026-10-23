import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createAuth0Accounts,
  SignInError,
} from "../dist/platform/auth/auth0-accounts.js";
import { createApp } from "../dist/app.js";
import { createLogger } from "../dist/platform/logger.js";
import request from "../scripts/test-http-request.ts";

// The signup pause is a global switch, so PostgreSQL suites running in
// parallel must not toggle it. A scripted client exercises the same SQL path.
function scriptedDatabase({ mapped = null, signupEnabled }) {
  const statements = [];
  const client = {
    async query(sql, values = []) {
      statements.push(sql.replace(/\s+/g, " ").trim());
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (
        sql.includes("FROM provider_identities") &&
        sql.includes("subject=$1")
      )
        return { rows: mapped ? [{ userId: mapped }] : [] };
      if (sql.includes("JOIN users u ON u.id=p.user_id")) return { rows: [] };
      if (sql.includes("FROM auth_controls"))
        return { rows: [{ enabled: signupEnabled }] };
      if (sql.includes("FROM users WHERE id = $1"))
        return {
          rows: [
            {
              id: values[0],
              email: null,
              createdAt: new Date(0),
              authGeneration: "4",
            },
          ],
        };
      if (sql.startsWith("UPDATE provider_identities")) return { rows: [] };
      if (sql.includes("INSERT INTO sessions"))
        return {
          rows: [
            {
              id: "1",
              userId: values[0],
              expiresAt: values[2],
              createdAt: new Date(0),
            },
          ],
        };
      throw new Error(`unexpected statement: ${sql}`);
    },
    release() {},
  };
  return { database: { connect: async () => client }, statements };
}
const identity = {
  subject: "email|paused",
  email: "paused@example.test",
  method: "email",
  authTime: null,
};
const grant = { tokenHash: "a".repeat(64), expiresAt: new Date(Date.now()) };

describe("signup pause", () => {
  it("refuses to create an account while signups are paused", async () => {
    const { database, statements } = scriptedDatabase({ signupEnabled: false });
    await assert.rejects(
      createAuth0Accounts(database).signIn(
        identity,
        { purpose: "sign_in" },
        grant,
      ),
      (error) =>
        error instanceof SignInError &&
        error.code === "signup_paused" &&
        error.status === 503,
    );
    assert.equal(statements.at(-1), "ROLLBACK");
    assert.equal(
      statements.some((sql) => sql.startsWith("INSERT INTO users")),
      false,
    );
  });

  it("lets an existing account sign in while signups are paused", async () => {
    const { database, statements } = scriptedDatabase({
      mapped: "17",
      signupEnabled: false,
    });
    const result = await createAuth0Accounts(database).signIn(
      identity,
      { purpose: "sign_in" },
      grant,
    );
    assert.equal(result.kind, "session");
    assert.equal(result.user.id, "17");
    assert.equal(result.created, false);
    assert.equal(
      statements.some((sql) => sql.includes("auth_controls")),
      false,
      "the pause is read only before creating an account",
    );
    assert.equal(statements.at(-1), "COMMIT");
  });

  it("explains a paused signup on the callback page and offers a retry", async () => {
    const app = createApp({
      messages: {},
      sessions: { findUserByTokenHash: async () => null },
      logger: createLogger({ enabled: false }),
      environment: "test",
      applicationOrigin: "http://localhost:3000",
      auth0: {
        client: {
          verifyCallback: async () => identity,
          logoutUrl: () => new URL("https://tenant.example.test/v2/logout"),
        },
        accounts: {
          signIn: async () => {
            throw new SignInError(
              "signup_paused",
              503,
              "New accounts are paused.",
            );
          },
        },
        state: {
          consume: async () => ({
            purpose: "sign_in",
            returnPath: "/live",
            userId: null,
            operationId: null,
            pendingLinkId: null,
            secrets: { state: "s", nonce: "n", codeVerifier: "v" },
          }),
        },
      },
    });
    const response = await request(app)
      .get("/api/auth/callback?code=c&state=s")
      .set("Cookie", `sign-in=${"b".repeat(43)}`);
    assert.equal(response.status, 503);
    assert.match(response.text, /New accounts are paused/);
    assert.match(response.text, /href="\/api\/auth\/login\?return=%2Flive"/);
    assert.equal(response.headers["set-cookie"], undefined);
  });
});
