import assert from "node:assert/strict";
import { hashPassword } from "../dist/platform/auth/passwords.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import {
  createSessionToken,
  hashSessionToken,
} from "../dist/platform/auth/session-tokens.js";
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
const sessions = createSessionRepository(pool);
const password = "Synthetic identity trial password";
const suffix = randomUUID().slice(0, 8);
const email = `verify-${suffix}@example.test`;
const handle = `verify-person-${suffix}`;
const profileIds = [];
const userIds = [];
const challengeIds = [];

try {
  const created = await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, auth_generation AS "authGeneration"`,
    [email, await hashPassword(password)],
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
  const session = createSessionToken();
  await sessions.create(
    userId,
    session.tokenHash,
    new Date(Date.now() + 60000),
    { authGeneration: created.rows[0].authGeneration },
  );
  let sessionTokenHash = session.tokenHash;
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
  const walletTarget = {
    purpose: "link",
    address: account.address.toLowerCase(),
    chainId: 1,
  };
  const linked = await wallets.operations.create({
    ...walletTarget,
    credential: { type: "password" },
    userId,
    sessionTokenHash,
    origin,
  });
  const completed = await wallets.operations.complete({
    ...walletTarget,
    id: linked.id,
    password,
    proposedSignature: await account.signMessage({
      message: linked.proposedMessage,
    }),
    userId,
    sessionTokenHash,
    origin,
    rpcUrls: {},
    sessionDurationMs: 60000,
  });
  assert.equal(completed.wallet.address, walletTarget.address);
  sessionTokenHash = hashSessionToken(completed.token);
  assert.equal((await wallets.listWallets(userId)).length, 1);
  const login = await issue("login");
  assert.equal(
    (
      await wallets.completeLogin(login.id, {
        tokenHash: "b".repeat(64),
        expiresAt: new Date(Date.now() + 600000),
      })
    ).id,
    userId,
  );
  await assert.rejects(
    () =>
      wallets.completeLogin(login.id, {
        tokenHash: "b".repeat(64),
        expiresAt: new Date(Date.now() + 600000),
      }),
    ChallengeUnavailableError,
  );
  assert.equal(
    (await identity.listActivity(userId, 50, 0)).items.some(
      (item) => item.eventType === "wallet_identities.insert",
    ),
    true,
  );
  const wallet = (await wallets.listWallets(userId))[0];
  const unlinkTarget = {
    purpose: "unlink",
    address: wallet.address,
    chainId: Number(wallet.chainId),
    targetWalletId: wallet.id,
  };
  const unlink = await wallets.operations.create({
    ...unlinkTarget,
    credential: { type: "password" },
    userId,
    sessionTokenHash,
    origin,
  });
  await wallets.operations.complete({
    ...unlinkTarget,
    id: unlink.id,
    password,
    userId,
    sessionTokenHash,
    origin,
    rpcUrls: {},
    sessionDurationMs: 60000,
  });
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
