import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { privateKeyToAccount } from "viem/accounts";

import { createIdentityRepository } from "../dist/features/identity/repository.js";
import {
  createChallengeMessage,
  verifyChallengeSignature,
} from "../dist/platform/auth/siwe.js";
import {
  createWalletRepository,
  ChallengeUnavailableError,
} from "../dist/platform/auth/wallets.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const identity = createIdentityRepository(pool);
const wallets = createWalletRepository(pool);
const suffix = randomUUID().slice(0, 8);
const email = `verify-${suffix}@example.test`;
const handle = `verify-person-${suffix}`;
const profileIds = [];
const userIds = [];
const challengeIds = [];

try {
  const created = await pool.query(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'verification-only') RETURNING id",
    [email],
  );
  const userId = created.rows[0].id;
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
    (await identity.updateProfile(userId, { publicationState: "published" }))
      .publicationState,
    "published",
  );

  const target = await pool.query(
    "SELECT slug FROM topics WHERE publication_state = 'published' ORDER BY created_at LIMIT 1",
  );
  assert.ok(target.rows[0], "seeded public topic is required");
  const topicSlug = target.rows[0].slug;
  assert.equal(await identity.follow(userId, "topic", topicSlug), "created");
  assert.equal(await identity.follow(userId, "topic", topicSlug), "exists");
  assert.equal(await identity.follow(userId, "profile", handle), "self");
  assert.equal(await identity.isFollowing(userId, "topic", topicSlug), true);
  assert.equal((await identity.listFollows(userId, 20, 0)).items.length, 1);

  const account = privateKeyToAccount(`0x${"31".repeat(32)}`);
  const origin = "http://localhost:3000";
  const sessionTokenHash = "a".repeat(64);
  const issue = async (purpose) => {
    const { message, expiresAt } = createChallengeMessage({
      address: account.address,
      chainId: 1,
      origin,
      purpose,
    });
    const issued = await wallets.createChallenge({
      address: account.address.toLowerCase(),
      chainId: 1,
      purpose,
      message,
      expiresAt,
      ...(purpose === "link" ? { userId, sessionTokenHash } : {}),
    });
    challengeIds.push(issued.id);
    const signature = await account.signMessage({ message });
    assert.equal(
      await verifyChallengeSignature({
        challenge: issued,
        signature,
        origin,
        rpcUrls: {},
      }),
      true,
    );
    return issued;
  };
  const linked = await issue("link");
  assert.equal(
    (await wallets.completeLink(linked.id, userId, sessionTokenHash)).address,
    account.address.toLowerCase(),
  );
  assert.equal((await wallets.listWallets(userId)).length, 1);
  const login = await issue("login");
  assert.equal((await wallets.completeLogin(login.id)).id, userId);
  await assert.rejects(
    () => wallets.completeLogin(login.id),
    ChallengeUnavailableError,
  );
  assert.equal(
    (await identity.listActivity(userId, 50, 0)).items.some(
      (item) => item.eventType === "wallet_identities.insert",
    ),
    true,
  );
  assert.equal(
    await wallets.unlinkWallet(
      userId,
      (await wallets.listWallets(userId))[0].id,
    ),
    "removed",
  );
  await identity.unfollow(userId, "topic", topicSlug);
  assert.equal(await identity.isFollowing(userId, "topic", topicSlug), false);
  console.log("PostgreSQL identity, follow, audit, and SIWE linkage verified.");
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
  if (challengeIds.length)
    await pool.query(
      "DELETE FROM wallet_challenges WHERE id = ANY($1::uuid[])",
      [challengeIds],
    );
  await pool.end();
}
