import assert from "node:assert/strict";
import { createSessionToken } from "../dist/platform/auth/session-tokens.js";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { createIdentityRepository } from "../dist/features/identity/repository.js";
import { createAuth0Accounts } from "../dist/platform/auth/auth0-accounts.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const identity = createIdentityRepository(pool);
const accounts = createAuth0Accounts(pool);
const suffix = randomUUID().slice(0, 8);
const email = `verify-${suffix}@example.test`;
const handle = `verify-person-${suffix}`;
const emailSubject = `email|verify-${suffix}`;
const googleSubject = `google-oauth2|verify-${suffix}`;
const profileIds: string[] = [];
const userIds: string[] = [];
const grant = () => ({
  tokenHash: createSessionToken().tokenHash,
  expiresAt: new Date(Date.now() + 60000),
});

try {
  // The post-callback sign-in function, as Auth0's callback calls it.
  const created = await accounts.signIn(
    { subject: emailSubject, email, method: "email", authTime: null },
    { purpose: "sign_in" },
    grant(),
  );
  assert.equal(created.kind, "session");
  if (created.kind !== "session") throw new Error("sign-in did not finish");
  assert.equal(created.created, true);
  const userId = created.user.id;
  userIds.push(userId);
  assert.deepEqual(await identity.getRoles(userId), ["participant"]);
  const profile = await identity.createProfile(
    userId,
    handle,
    "Verification person",
    null,
  );
  profileIds.push(profile.id);
  assert.equal(profile.publicationState, "draft");
  assert.equal(
    (await identity.updateProfile(userId, { publicationState: "published" }))!
      .publicationState,
    "published",
  );

  const target = await pool.query<{ slug: string }>(
    "SELECT slug FROM topics WHERE publication_state = 'published' ORDER BY created_at LIMIT 1",
  );
  assert.ok(target.rows[0], "seeded public topic is required");
  const topicSlug = target.rows[0]!.slug;
  assert.equal(await identity.follow(userId, "topic", topicSlug), "created");
  assert.equal(await identity.follow(userId, "topic", topicSlug), "exists");
  assert.equal(await identity.follow(userId, "profile", handle), "self");
  assert.equal(await identity.isFollowing(userId, "topic", topicSlug), true);
  assert.equal((await identity.listFollows(userId, 20, 0)).items.length, 1);

  // Google for the same address: no account or session until the email code
  // proves the mailbox, then the Google subject joins this account once.
  const google = await accounts.signIn(
    { subject: googleSubject, email, method: "google", authTime: null },
    { purpose: "sign_in" },
    grant(),
  );
  assert.equal(google.kind, "link_required");
  if (google.kind !== "link_required") throw new Error("link was not required");
  const linked = await accounts.signIn(
    { subject: emailSubject, email, method: "email", authTime: null },
    { purpose: "link", pendingLinkId: google.pendingLinkId },
    grant(),
  );
  assert.equal(linked.kind === "session" && linked.user.id, userId);
  assert.deepEqual(linked.kind === "session" && linked.linked, ["google"]);
  assert.deepEqual(
    (await accounts.methods(userId)).map(({ method }) => method).sort(),
    ["email", "google"],
  );
  const direct = await accounts.signIn(
    { subject: googleSubject, email, method: "google", authTime: null },
    { purpose: "sign_in" },
    grant(),
  );
  assert.equal(direct.kind === "session" && direct.user.id, userId);
  assert.equal(
    (await identity.listActivity(userId, 50, 0)).items.some(
      (item) => item.eventType === "sign_in.method_linked",
    ),
    true,
  );
  await identity.unfollow(userId, "topic", topicSlug);
  assert.equal(await identity.isFollowing(userId, "topic", topicSlug), false);
  console.log(
    "PostgreSQL identity, follow, audit and Auth0 sign-in linkage verified.",
  );
} finally {
  if (profileIds.length)
    await pool.query("DELETE FROM public_profiles WHERE id = ANY($1::uuid[])", [
      profileIds,
    ]);
  if (userIds.length)
    await pool.query("DELETE FROM users WHERE id = ANY($1::bigint[])", [
      userIds,
    ]);
  if (userIds.length)
    await pool.query(
      "DELETE FROM identity_audit_events WHERE user_id = ANY($1::bigint[])",
      [userIds],
    );
  await pool.query(
    "DELETE FROM provider_identities WHERE provider='auth0' AND subject = ANY($1::text[])",
    [[emailSubject, googleSubject]],
  );
  await pool.end();
}
