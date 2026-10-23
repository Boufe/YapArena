import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { SignInMethod, VerifiedIdentity } from "./auth0.ts";
import { insertSession, lockAccount } from "./sessions.ts";
import type { AuthenticationUser } from "./users.ts";

// Decision 0009, points 3 and 4. Each (auth0, sub) maps to exactly one
// account; an account may hold one subject per sign-in method. Accounts are
// never merged on email alone: a Google subject joins an existing account only
// after a verified email code for the same address.
export type SignInFailure =
  "signup_paused" | "account_unavailable" | "email_ambiguous" | "link_failed";

export class SignInError extends Error {
  constructor(
    readonly code: SignInFailure,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const support = "Contact YapArena support for help.";
const failures = {
  signup_paused: () =>
    new SignInError(
      "signup_paused",
      503,
      "New accounts are paused for maintenance. Existing accounts can still sign in.",
    ),
  account_unavailable: () =>
    new SignInError(
      "account_unavailable",
      403,
      `This account can't sign in right now. ${support}`,
    ),
  email_ambiguous: () =>
    new SignInError(
      "email_ambiguous",
      409,
      `This email address belongs to more than one account. ${support}`,
    ),
  link_failed: () =>
    new SignInError(
      "link_failed",
      409,
      `We couldn't link this sign-in to your account, so nothing was changed. Start again, or ${support.toLowerCase()}`,
    ),
};

export type SignInContext =
  { purpose: "sign_in" } | { purpose: "link"; pendingLinkId: string };

export type SessionGrant = { tokenHash: string; expiresAt: Date };

export type SignInResult =
  | Readonly<{
      kind: "session";
      user: AuthenticationUser;
      created: boolean;
      linked: readonly SignInMethod[];
    }>
  | Readonly<{ kind: "link_required"; pendingLinkId: string; email: string }>;

const methodNames: Readonly<Record<SignInMethod, string>> = {
  email: "Email code",
  google: "Google",
};

// A refusal inside a link step still spends the pending link: the commit
// keeps it consumed even though nothing else was written.
class SpentRefusal extends Error {
  constructor(readonly refusal: SignInError) {
    super(refusal.message);
  }
}

async function lockKey(client: PoolClient, key: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    key,
  ]);
}

async function mappedAccount(client: PoolClient, subject: string) {
  const row = (
    await client.query<{ userId: string | null }>(
      `SELECT user_id::text AS "userId" FROM provider_identities
       WHERE provider='auth0' AND subject=$1`,
      [subject],
    )
  ).rows[0];
  return row ? { userId: row.userId } : null;
}

async function accountsWithEmail(client: PoolClient, email: string) {
  return (
    await client.query<{ userId: string; active: boolean }>(
      `SELECT DISTINCT p.user_id::text AS "userId",u.account_status='active' AS active
       FROM provider_identities p JOIN users u ON u.id=p.user_id
       WHERE p.provider='auth0' AND p.email=$1 AND p.user_id IS NOT NULL`,
      [email],
    )
  ).rows;
}

async function attach(
  client: PoolClient,
  userId: string,
  identity: Pick<VerifiedIdentity, "subject" | "email" | "method">,
  via: "sign_in" | "email_code",
) {
  await client.query(
    `INSERT INTO provider_identities(provider,subject,user_id,email,methods,checked_at)
     VALUES('auth0',$1,$2,$3,$4::jsonb,clock_timestamp())`,
    [
      identity.subject,
      userId,
      identity.email,
      JSON.stringify([identity.method]),
    ],
  );
  await client.query(
    `INSERT INTO identity_audit_events(user_id,event_type,subject_id,metadata)
     VALUES($1,'sign_in.method_linked',$2,$3::jsonb)`,
    [
      userId,
      identity.method,
      JSON.stringify({
        provider: "auth0",
        subject: identity.subject,
        verifiedBy: via,
        outcome: "success",
      }),
    ],
  );
  await client.query(
    `INSERT INTO account_notifications(user_id,event_type,message)
     VALUES($1,'sign_in.method_linked',$2)`,
    [
      userId,
      `${methodNames[identity.method]} sign-in was linked to your account. If this wasn't you, contact YapArena support.`,
    ],
  );
}

export function createAuth0Accounts(database: Pool) {
  async function transaction<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if (error instanceof SpentRefusal) {
        await client.query("COMMIT");
        throw error.refusal;
      }
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function activeAccount(client: PoolClient, userId: string | null) {
    const account = userId ? await lockAccount(client, userId) : null;
    if (!account) throw failures.account_unavailable();
    return {
      id: account.id,
      email: account.email,
      createdAt: account.createdAt,
      authGeneration: account.authGeneration,
    } satisfies AuthenticationUser;
  }

  async function startSession(
    client: PoolClient,
    user: AuthenticationUser,
    grant: SessionGrant,
  ) {
    await insertSession(
      client,
      user.id,
      grant.tokenHash,
      grant.expiresAt,
      user.authGeneration,
    );
  }

  // The post-callback sign-in function. The Auth0 callback and the local test
  // identity entry both call it with an identity they have already verified.
  async function signIn(
    identity: VerifiedIdentity,
    context: SignInContext,
    grant: SessionGrant,
  ): Promise<SignInResult> {
    return transaction(async (client) => {
      // The email lock serializes every flow that could create, link or
      // match an account for this address; subject locks follow it.
      await lockKey(client, `auth0-email:${identity.email}`);
      if (context.purpose === "link")
        return completeLink(client, identity, context.pendingLinkId, grant);
      await lockKey(client, `auth0-subject:${identity.subject}`);
      const mapped = await mappedAccount(client, identity.subject);
      if (mapped) {
        const user = await activeAccount(client, mapped.userId);
        await client.query(
          `UPDATE provider_identities SET email=$2,checked_at=clock_timestamp()
           WHERE provider='auth0' AND subject=$1`,
          [identity.subject, identity.email],
        );
        await startSession(client, user, grant);
        return { kind: "session", user, created: false, linked: [] };
      }
      const matches = await accountsWithEmail(client, identity.email);
      if (matches.length > 1) throw failures.email_ambiguous();
      const match = matches[0];
      if (!match) {
        const enabled = (
          await client.query<{ enabled: boolean }>(
            "SELECT signup_enabled AS enabled FROM auth_controls WHERE singleton",
          )
        ).rows[0]?.enabled;
        if (!enabled) throw failures.signup_paused();
        const user = (
          await client.query<AuthenticationUser>(
            `INSERT INTO users DEFAULT VALUES
             RETURNING id,email,created_at AS "createdAt",auth_generation AS "authGeneration"`,
          )
        ).rows[0]!;
        await client.query(
          `INSERT INTO provider_identities(provider,subject,user_id,email,methods,checked_at)
           VALUES('auth0',$1,$2,$3,$4::jsonb,clock_timestamp())`,
          [
            identity.subject,
            user.id,
            identity.email,
            JSON.stringify([identity.method]),
          ],
        );
        await startSession(client, user, grant);
        return { kind: "session", user, created: true, linked: [] };
      }
      if (!match.active) throw failures.account_unavailable();
      if (identity.method === "google") {
        // No account and no session yet: prove the mailbox with a code first.
        const pendingLinkId = randomUUID();
        await client.query(
          `WITH now AS (SELECT clock_timestamp() AS at)
           INSERT INTO auth_pending_links(id,user_id,google_subject,email,created_at,expires_at)
           SELECT $1,$2,$3,$4,at,at+interval '10 minutes' FROM now`,
          [pendingLinkId, match.userId, identity.subject, identity.email],
        );
        return {
          kind: "link_required",
          pendingLinkId,
          email: identity.email,
        };
      }
      // An email code proves the mailbox, so the new email subject joins the
      // one account with this address.
      const user = await activeAccount(client, match.userId);
      await attach(client, user.id, identity, "sign_in");
      await startSession(client, user, grant);
      return { kind: "session", user, created: false, linked: ["email"] };
    });
  }

  async function completeLink(
    client: PoolClient,
    identity: VerifiedIdentity,
    pendingLinkId: string,
    grant: SessionGrant,
  ): Promise<SignInResult> {
    const pending = (
      await client.query<{
        userId: string;
        googleSubject: string;
        email: string;
      }>(
        `UPDATE auth_pending_links SET consumed_at=clock_timestamp()
         WHERE id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp()
         RETURNING user_id::text AS "userId",google_subject AS "googleSubject",email`,
        [pendingLinkId],
      )
    ).rows[0];
    // Abandoned, expired or reused links attach nothing.
    if (!pending) throw failures.link_failed();
    const refuse = (error: SignInError): never => {
      throw new SpentRefusal(error);
    };
    if (identity.method !== "email" || identity.email !== pending.email)
      refuse(failures.link_failed());
    for (const subject of [identity.subject, pending.googleSubject].sort())
      await lockKey(client, `auth0-subject:${subject}`);
    const account = await lockAccount(client, pending.userId);
    if (!account) return refuse(failures.account_unavailable());
    const emailOwner = await mappedAccount(client, identity.subject);
    if (emailOwner && emailOwner.userId !== account.id)
      refuse(failures.link_failed());
    if (!emailOwner) {
      // "Or is then attached": the code's address must still belong to this
      // one account before its email subject joins it.
      const matches = await accountsWithEmail(client, identity.email);
      if (matches.length !== 1 || matches[0]!.userId !== account.id)
        refuse(failures.link_failed());
    }
    const googleOwner = await mappedAccount(client, pending.googleSubject);
    if (googleOwner && googleOwner.userId !== account.id)
      refuse(failures.link_failed());
    const user: AuthenticationUser = {
      id: account.id,
      email: account.email,
      createdAt: account.createdAt,
      authGeneration: account.authGeneration,
    };
    const linked: SignInMethod[] = [];
    if (!emailOwner) {
      await attach(client, user.id, identity, "email_code");
      linked.push("email");
    }
    // A concurrent completion may already have attached the Google subject:
    // it is linked at most once.
    if (!googleOwner) {
      await attach(
        client,
        user.id,
        {
          subject: pending.googleSubject,
          email: pending.email,
          method: "google",
        },
        "email_code",
      );
      linked.push("google");
    }
    await startSession(client, user, grant);
    return { kind: "session", user, created: false, linked };
  }

  return Object.freeze({
    signIn,

    // The sign-in methods attached to an account, for the account page.
    async methods(userId: string) {
      const result = await database.query<{
        method: SignInMethod;
        email: string;
        linkedAt: Date;
      }>(
        `SELECT methods->>0 AS method,email,created_at AS "linkedAt"
         FROM provider_identities WHERE provider='auth0' AND user_id=$1
         ORDER BY created_at,subject`,
        [userId],
      );
      return result.rows;
    },
  });
}

export type Auth0Accounts = ReturnType<typeof createAuth0Accounts>;
