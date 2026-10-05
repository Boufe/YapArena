import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import request from "../scripts/test-http-request.js";

import { createApp } from "../dist/app.js";
import {
  createChallengeMessage,
  normalizeWalletAddress,
  validChainId,
  verifyChallengeSignature,
} from "../dist/platform/auth/siwe.js";
import {
  ChallengeUnavailableError,
  WalletAlreadyLinkedError,
} from "../dist/platform/auth/wallets.js";
import { createLogger } from "../dist/platform/logger.js";

const owner = privateKeyToAccount(`0x${"11".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"22".repeat(32)}`);
const id = "11111111-1111-4111-8111-111111111111";
const user = { id: "7", email: null, createdAt: new Date("2026-09-01") };

function challenge(purpose = "login") {
  const { message, expiresAt } = createChallengeMessage({
    address: owner.address,
    chainId: 1,
    origin: "http://localhost:3000",
    purpose,
  });
  return {
    id,
    address: owner.address.toLowerCase(),
    chainId: "1",
    purpose,
    message,
    userId: purpose === "link" ? user.id : null,
    sessionTokenHash: null,
    expiresAt,
  };
}

describe("SIWE proof", () => {
  it("verifies the exact server-issued message and rejects invalid proof", async () => {
    const issued = challenge();
    const signature = await owner.signMessage({ message: issued.message });
    assert.equal(
      await verifyChallengeSignature({
        challenge: issued,
        signature,
        origin: "http://localhost:3000",
        rpcUrls: {},
      }),
      true,
    );
    assert.equal(
      await verifyChallengeSignature({
        challenge: issued,
        signature: await stranger.signMessage({ message: issued.message }),
        origin: "http://localhost:3000",
        rpcUrls: {},
      }),
      false,
    );
    assert.equal(
      await verifyChallengeSignature({
        challenge: issued,
        signature,
        origin: "https://other.example",
        rpcUrls: {},
      }),
      false,
    );
    assert.equal(
      await verifyChallengeSignature({
        challenge: { ...issued, expiresAt: new Date(0) },
        signature,
        origin: "http://localhost:3000",
        rpcUrls: {},
      }),
      false,
    );
    assert.equal(
      await verifyChallengeSignature({
        challenge: issued,
        signature: "bad",
        origin: "http://localhost:3000",
        rpcUrls: {},
      }),
      false,
    );
  });

  it("validates wallet addresses and chain identifiers", () => {
    assert.equal(
      normalizeWalletAddress(owner.address),
      owner.address.toLowerCase(),
    );
    assert.equal(normalizeWalletAddress("not-an-address"), null);
    assert.equal(validChainId(1), true);
    assert.equal(validChainId(0), false);
    assert.equal(validChainId("1"), false);
  });
});

function walletApp({
  signedIn = false,
  conflict = false,
  challengeMissing = false,
  completeLoginError = false,
  unlinkOutcome = "last_credentials",
} = {}) {
  const records = new Map();
  let used = false;
  const wallets = {
    createChallenge: async (input) => {
      const record = {
        ...input,
        id,
        chainId: String(input.chainId),
        userId: input.userId ?? null,
        sessionTokenHash: input.sessionTokenHash ?? null,
      };
      records.set(id, record);
      return record;
    },
    getChallenge: async (key) =>
      used || challengeMissing ? null : (records.get(key) ?? null),
    completeLogin: async () => {
      if (used || completeLoginError) throw new ChallengeUnavailableError();
      used = true;
      return user;
    },
    completeLink: async () => {
      if (conflict) throw new WalletAlreadyLinkedError();
      used = true;
      return { id, address: owner.address.toLowerCase(), chainId: "1" };
    },
    listWallets: async () => [],
    unlinkWallet: async () => unlinkOutcome,
  };
  const sessions = {
    create: async () => ({}),
    findUserByTokenHash: async () => (signedIn ? user : null),
    deleteByTokenHash: async () => false,
  };
  const app = createApp({
    wallets,
    sessions,
    users: { create: async () => ({}), findByEmail: async () => null },
    messages: { isReady: async () => {} },
    logger: createLogger({ enabled: false }),
    applicationOrigin: "http://localhost:3000",
  });
  return { app, records };
}

describe("wallet authentication routes", () => {
  it("signs in with a one-use challenge and server session", async () => {
    const { app } = walletApp();
    const issued = await request(app)
      .post("/api/auth/wallet/login/challenge")
      .send({ address: owner.address, chainId: 1 });
    assert.equal(issued.status, 201);
    assert.match(issued.body.message, /does not authorize a transaction/);
    const signature = await owner.signMessage({ message: issued.body.message });
    const verified = await request(app)
      .post("/api/auth/wallet/login/verify")
      .send({ challengeId: issued.body.id, signature });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.user.id, "7");
    assert.match(verified.headers["set-cookie"][0], /session=/);
    assert.equal(
      (
        await request(app)
          .post("/api/auth/wallet/login/verify")
          .send({ challengeId: issued.body.id, signature })
      ).status,
      410,
    );
  });

  it("blocks account switching and bad signature attempts", async () => {
    const { app } = walletApp({ signedIn: true });
    assert.equal(
      (
        await request(app)
          .post("/api/auth/wallet/login/challenge")
          .set("Cookie", "session=active")
          .send({ address: owner.address, chainId: 1 })
      ).status,
      409,
    );
    const separate = walletApp();
    assert.equal(
      (
        await request(separate.app)
          .post("/api/auth/wallet/login/challenge")
          .send({ address: "bad", chainId: 1 })
      ).status,
      400,
    );
    const issued = await request(separate.app)
      .post("/api/auth/wallet/login/challenge")
      .send({ address: owner.address, chainId: 1 });
    const wrong = await stranger.signMessage({ message: issued.body.message });
    assert.equal(
      (
        await request(separate.app)
          .post("/api/auth/wallet/login/verify")
          .send({ challengeId: issued.body.id, signature: wrong })
      ).status,
      401,
    );
  });

  it("binds link challenges to an authenticated session", async () => {
    const { app, records } = walletApp({ signedIn: true });
    assert.equal(
      (
        await request(app)
          .post("/api/auth/wallet/link/challenge")
          .send({ address: owner.address, chainId: 1 })
      ).status,
      401,
    );
    const issued = await request(app)
      .post("/api/auth/wallet/link/challenge")
      .set("Cookie", "session=active")
      .send({ address: owner.address, chainId: 1 });
    assert.equal(issued.status, 201);
    const signature = await owner.signMessage({ message: issued.body.message });
    assert.equal(
      (
        await request(app)
          .post("/api/auth/wallet/link/verify")
          .set("Cookie", "session=different")
          .send({ challengeId: id, signature })
      ).status,
      410,
    );
    assert.ok(records.get(id).sessionTokenHash);
    assert.equal(
      (
        await request(app)
          .post("/api/auth/wallet/link/verify")
          .set("Cookie", "session=active")
          .send({ challengeId: id, signature })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(app)
          .delete(`/api/auth/wallets/${id}`)
          .set("Cookie", "session=active")
      ).status,
      409,
    );
  });

  it("rejects linking a wallet held by another account", async () => {
    const { app } = walletApp({ signedIn: true, conflict: true });
    const issued = await request(app)
      .post("/api/auth/wallet/link/challenge")
      .set("Cookie", "session=active")
      .send({ address: owner.address, chainId: 1 });
    const signature = await owner.signMessage({ message: issued.body.message });
    assert.equal(
      (
        await request(app)
          .post("/api/auth/wallet/link/verify")
          .set("Cookie", "session=active")
          .send({ challengeId: id, signature })
      ).status,
      409,
    );
  });

  it("validates challenge requests and refuses stale verification", async () => {
    const { app } = walletApp({ challengeMissing: true });
    assert.equal(
      (
        await request(app)
          .post("/api/auth/wallet/login/challenge")
          .send({ address: owner.address, chainId: 0 })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(app)
          .post("/api/auth/wallet/login/verify")
          .send({ challengeId: "bad", signature: "bad" })
      ).status,
      400,
    );
    const issued = await request(app)
      .post("/api/auth/wallet/login/challenge")
      .send({ address: owner.address, chainId: 1 });
    const signature = await owner.signMessage({ message: issued.body.message });
    assert.equal(
      (
        await request(app)
          .post("/api/auth/wallet/login/verify")
          .send({ challengeId: id, signature })
      ).status,
      410,
    );
    const replay = walletApp({ completeLoginError: true });
    const fresh = await request(replay.app)
      .post("/api/auth/wallet/login/challenge")
      .send({ address: owner.address, chainId: 1 });
    assert.equal(
      (
        await request(replay.app)
          .post("/api/auth/wallet/login/verify")
          .send({
            challengeId: id,
            signature: await owner.signMessage({ message: fresh.body.message }),
          })
      ).status,
      410,
    );
  });

  it("keeps wallet inventory scoped to the current account", async () => {
    const { app } = walletApp({ signedIn: true, unlinkOutcome: "missing" });
    assert.equal(
      (
        await request(app)
          .get("/api/auth/wallets")
          .set("Cookie", "session=active")
      ).status,
      200,
    );
    assert.equal(
      (
        await request(app)
          .delete(`/api/auth/wallets/${id}`)
          .set("Cookie", "session=active")
      ).status,
      404,
    );
    const removable = walletApp({ signedIn: true, unlinkOutcome: "removed" });
    assert.equal(
      (
        await request(removable.app)
          .delete(`/api/auth/wallets/${id}`)
          .set("Cookie", "session=active")
      ).status,
      204,
    );
    assert.equal(
      (
        await request(removable.app)
          .delete("/api/auth/wallets/bad")
          .set("Cookie", "session=active")
      ).status,
      404,
    );
  });

  it("rejects malformed wallet requests and enforces login and link session boundaries", async () => {
    const signedIn = walletApp({ signedIn: true });
    const issued = await request(signedIn.app)
      .post("/api/auth/wallet/login/challenge")
      .send({ address: owner.address, chainId: 1 });
    const signature = await owner.signMessage({ message: issued.body.message });
    assert.equal(
      (
        await request(signedIn.app)
          .post("/api/auth/wallet/login/verify")
          .set("Cookie", "session=active")
          .send({ challengeId: id, signature })
      ).status,
      409,
    );
    for (const body of [
      null,
      [],
      {},
      { address: owner.address, chainId: "1" },
    ]) {
      assert.equal(
        (
          await request(signedIn.app)
            .post("/api/auth/wallet/link/challenge")
            .set("Cookie", "session=active")
            .send(body)
        ).status,
        400,
      );
    }
    for (const body of [
      null,
      [],
      {},
      { challengeId: id, signature: "x".repeat(8195) },
    ]) {
      assert.equal(
        (
          await request(signedIn.app)
            .post("/api/auth/wallet/link/verify")
            .set("Cookie", "session=active")
            .send(body)
        ).status,
        400,
      );
    }
    assert.equal(
      (
        await request(signedIn.app)
          .post("/api/auth/wallet/link/verify")
          .set("Cookie", "session=active")
          .send({ challengeId: id, signature })
      ).status,
      410,
    );
  });

  it("rejects a link proof with the wrong signature or a consumed challenge", async () => {
    const { app } = walletApp({ signedIn: true });
    const issued = await request(app)
      .post("/api/auth/wallet/link/challenge")
      .set("Cookie", "session=active")
      .send({ address: owner.address, chainId: 1 });
    assert.equal(issued.status, 201);
    const wrong = await stranger.signMessage({ message: issued.body.message });
    assert.equal(
      (
        await request(app)
          .post("/api/auth/wallet/link/verify")
          .set("Cookie", "session=active")
          .send({ challengeId: id, signature: wrong })
      ).status,
      401,
    );
    const signature = await owner.signMessage({ message: issued.body.message });
    assert.equal(
      (
        await request(app)
          .post("/api/auth/wallet/link/verify")
          .set("Cookie", "session=active")
          .send({ challengeId: id, signature })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(app)
          .post("/api/auth/wallet/link/verify")
          .set("Cookie", "session=active")
          .send({ challengeId: id, signature })
      ).status,
      410,
    );
  });
});
