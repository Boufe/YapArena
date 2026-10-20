import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { createSecurityPasskeyRepository } from "../dist/platform/auth/security-passkeys.js";
import { createAccountOperationRepository } from "../dist/platform/auth/account-operations.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import {
  createSessionToken,
  hashSessionToken,
} from "../dist/platform/auth/session-tokens.js";
import { hashPassword } from "../dist/platform/auth/passwords.js";
import { createProviderAccounts } from "../dist/platform/auth/provider-accounts.js";
import { createProviderWalletOperations } from "../dist/platform/auth/provider-wallet-operations.js";
import { privateKeyToAccount } from "viem/accounts";

const ownerUrl = process.env.WALLET_TEST_OWNER_DATABASE_URL;
const runtimeUrl = process.env.WALLET_TEST_DATABASE_URL;
const origin = "http://localhost:53024";
const password = "synthetic security enrollment passphrase";
const hash = (input) => createHash("sha256").update(input).digest();

// Synthetic WebAuthn protocol responses use real P-256 keys and signatures.
// They are deterministic protocol acceptance, not browser/physical-device evidence.
function authenticator() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = publicKey.export({ format: "jwk" });
  const publicCose = isoCBOR.encode(
    new Map([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, new Uint8Array(Buffer.from(jwk.x, "base64url"))],
      [-3, new Uint8Array(Buffer.from(jwk.y, "base64url"))],
    ]),
  );
  const credentialRaw = randomBytes(32),
    credentialId = credentialRaw.toString("base64url");
  function data(flags, counter) {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter);
    return Buffer.concat([
      hash(new URL(origin).hostname),
      Buffer.from([flags]),
      count,
    ]);
  }
  return {
    registration(options, overrides = {}) {
      const clientDataJSON = Buffer.from(
        JSON.stringify({
          type: "webauthn.create",
          challenge: options.challenge,
          origin,
          ...overrides,
        }),
      ).toString("base64url");
      const length = Buffer.alloc(2);
      length.writeUInt16BE(credentialRaw.length);
      const authData = Buffer.concat([
        data(0x45, 0),
        Buffer.alloc(16),
        length,
        credentialRaw,
        publicCose,
      ]);
      return {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON,
          attestationObject: Buffer.from(
            isoCBOR.encode(
              new Map([
                ["fmt", "none"],
                ["attStmt", new Map()],
                ["authData", new Uint8Array(authData)],
              ]),
            ),
          ).toString("base64url"),
          transports: ["internal"],
        },
      };
    },
    authentication(options, { counter = 1, flags = 0x05, ...overrides } = {}) {
      const clientData = Buffer.from(
        JSON.stringify({
          type: "webauthn.get",
          challenge: options.challenge,
          origin,
          ...overrides,
        }),
      );
      const authData = data(flags, counter);
      return {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: clientData.toString("base64url"),
          authenticatorData: authData.toString("base64url"),
          signature: sign(
            "sha256",
            Buffer.concat([authData, hash(clientData)]),
            privateKey,
          ).toString("base64url"),
        },
      };
    },
  };
}

describe(
  "separate YapArena security passkeys in disposable PostgreSQL",
  { skip: !runtimeUrl || !ownerUrl },
  () => {
    let owner, a, b, passwordHash;
    const accounts = [];
    before(async () => {
      for (const value of [ownerUrl, runtimeUrl]) {
        const url = new URL(value);
        assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
        assert.match(
          url.pathname,
          /^\/(?:yaparena_f02|revocation_test)[a-z0-9_]*$/,
        );
      }
      owner = new pg.Pool({ connectionString: ownerUrl });
      a = new pg.Pool({ connectionString: runtimeUrl });
      b = new pg.Pool({ connectionString: runtimeUrl });
      passwordHash = await hashPassword(password);
    });
    after(async () => {
      if (accounts.length)
        await owner.query("DELETE FROM users WHERE id=ANY($1::bigint[])", [
          accounts,
        ]);
      await Promise.all([owner?.end(), a?.end(), b?.end()]);
    });
    async function fixture() {
      const user = (
        await owner.query(
          `INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id,auth_generation AS "authGeneration"`,
          [`${randomUUID()}@example.test`, passwordHash],
        )
      ).rows[0];
      accounts.push(user.id);
      const token = createSessionToken();
      await createSessionRepository(a).create(
        user.id,
        token.tokenHash,
        new Date(Date.now() + 600000),
        user,
      );
      return { userId: user.id, sessionTokenHash: token.tokenHash, origin };
    }
    async function emailFixture() {
      const token = createSessionToken();
      const { user } = await createProviderAccounts(a).exchange(
        {
          subject: `did:privy:${randomUUID()}`,
          sessionId: randomUUID(),
          email: `${randomUUID()}@example.test`,
          methods: ["email"],
          issuedAt: Math.floor(Date.now() / 1000),
          credentialsDigest: "a".repeat(64),
        },
        token.tokenHash,
        new Date(Date.now() + 600000),
      );
      accounts.push(user.id);
      return { userId: user.id, sessionTokenHash: token.tokenHash, origin };
    }
    async function approve(
      f,
      purpose,
      terms,
      credential = { type: "password" },
      extra = {},
    ) {
      const ops = createAccountOperationRepository(a),
        operation = await ops.create({ ...f, purpose, terms, credential });
      return ops.prepare({
        ...f,
        id: operation.id,
        purpose,
        terms,
        password,
        rpcUrls: {},
        ...extra,
      });
    }
    async function enroll(f, authenticatorDevice = authenticator()) {
      const repository = createSecurityPasskeyRepository(a),
        challenge = await repository.enrollmentOptions(f);
      assert.equal(
        challenge.options.authenticatorSelection.userVerification,
        "required",
      );
      const approval = await approve(f, "security.passkey.enroll", {
        challengeId: challenge.id,
      });
      const result = await repository.completeEnrollment({
        ...f,
        id: challenge.id,
        response: authenticatorDevice.registration(challenge.options),
        sessionDurationMs: 600000,
        approval,
      });
      return {
        f: { ...f, sessionTokenHash: hashSessionToken(result.token) },
        result,
        authenticatorDevice,
        challenge,
        approval,
      };
    }
    async function consume(proof, database = a) {
      const c = await database.connect();
      try {
        await c.query("BEGIN");
        const result = await proof.consume(c, async () => "authorized");
        await c.query("COMMIT");
        return result;
      } catch (error) {
        await c.query("ROLLBACK");
        throw error;
      } finally {
        c.release();
      }
    }
    it("enrolls an independently verified key, revokes old app cookies and preserves retained account ownership", async () => {
      const original = await fixture(),
        { f, result, authenticatorDevice, challenge, approval } =
          await enroll(original);
      const sessions = createSessionRepository(b);
      assert.equal(
        await sessions.findUserByTokenHash(original.sessionTokenHash),
        null,
      );
      assert.equal(
        (await sessions.findUserByTokenHash(f.sessionTokenHash)).id,
        f.userId,
      );
      const keys = await createSecurityPasskeyRepository(b).list(f.userId);
      assert.equal(keys.length, 1);
      assert.equal(keys[0].id, result.keyId);
      assert.equal(keys[0].deviceType, "singleDevice");
      assert.doesNotMatch(
        JSON.stringify(keys),
        /credentialId|publicKey|userHandle|counter/,
      );
      await assert.rejects(
        createSecurityPasskeyRepository(a).completeEnrollment({
          ...original,
          id: challenge.id,
          response: authenticatorDevice.registration(challenge.options),
          sessionDurationMs: 600000,
          approval,
        }),
        /expired or invalid/,
      );
    });
    it("permits first setup only before financial history and never permits bootstrap over a previous key or retained credential", async () => {
      const f = await emailFixture(),
        repo = createSecurityPasskeyRepository(a),
        challenge = await repo.enrollmentOptions(f),
        device = authenticator();
      assert.equal(challenge.bootstrapAllowed, true);
      const result = await repo.completeEnrollment({
        ...f,
        id: challenge.id,
        response: device.registration(challenge.options),
        sessionDurationMs: 600000,
      });
      const current = {
        ...f,
        sessionTokenHash: hashSessionToken(result.token),
      };
      assert.equal(
        (await repo.enrollmentOptions(current)).bootstrapAllowed,
        false,
      );
      assert.equal(
        (await repo.enrollmentOptions(await fixture())).bootstrapAllowed,
        false,
      );
      const funded = await emailFixture(),
        pending = await repo.enrollmentOptions(funded);
      assert.equal(pending.bootstrapAllowed, true);
      await owner.query(
        "INSERT INTO coin_grant_lots(id,user_id,environment,asset,kind,reference,target) VALUES($1::uuid,$2,'sandbox','USDC','welcome',$1::text,25000000)",
        [randomUUID(), funded.userId],
      );
      assert.equal(
        (await repo.enrollmentOptions(funded)).bootstrapAllowed,
        false,
      );
      await assert.rejects(
        repo.completeEnrollment({
          ...funded,
          id: pending.id,
          response: authenticator().registration(pending.options),
          sessionDurationMs: 600000,
        }),
        /existing trusted credential/,
      );
      await owner.query(
        "UPDATE account_security_keys SET revoked_at=clock_timestamp() WHERE id=$1",
        [result.keyId],
      );
      const user = (
          await owner.query(
            `SELECT auth_generation AS "authGeneration" FROM users WHERE id=$1`,
            [f.userId],
          )
        ).rows[0],
        fresh = createSessionToken();
      await createSessionRepository(a).create(
        f.userId,
        fresh.tokenHash,
        new Date(Date.now() + 600000),
        user,
      );
      assert.equal(
        (
          await repo.enrollmentOptions({
            ...f,
            sessionTokenHash: fresh.tokenHash,
          })
        ).bootstrapAllowed,
        false,
      );
    });
    it("rolls back authenticator counters when the authorized mutation fails", async () => {
      const { f, result, authenticatorDevice } = await enroll(await fixture());
      const ops = createAccountOperationRepository(a),
        terms = { purpose: "synthetic rollback" };
      const operation = await ops.create({
        ...f,
        purpose: "withdrawal.request",
        terms,
        credential: { type: "passkey", keyId: result.keyId },
      });
      const prepared = await ops.prepare({
        ...f,
        id: operation.id,
        purpose: operation.purpose,
        terms,
        rpcUrls: {},
        authentication: authenticatorDevice.authentication(
          operation.authenticationOptions,
        ),
      });
      const c = await a.connect();
      try {
        await c.query("BEGIN");
        await assert.rejects(
          prepared.consume(c, async () => {
            throw Error("synthetic mutation failure");
          }),
          /synthetic mutation failure/,
        );
        await c.query("ROLLBACK");
      } finally {
        c.release();
      }
      assert.equal(
        (
          await owner.query(
            "SELECT counter::text FROM account_security_keys WHERE id=$1",
            [result.keyId],
          )
        ).rows[0].counter,
        "0",
      );
      assert.equal(await consume(prepared), "authorized");
    });
    it("links the first wallet to an email-only account with its security passkey and permits deliberate unlink while email remains", async () => {
      const initial = await emailFixture(),
        repo = createSecurityPasskeyRepository(a),
        challenge = await repo.enrollmentOptions(initial),
        device = authenticator();
      const enrolled = await repo.completeEnrollment({
        ...initial,
        id: challenge.id,
        response: device.registration(challenge.options),
        sessionDurationMs: 600000,
      });
      let f = {
        ...initial,
        sessionTokenHash: hashSessionToken(enrolled.token),
      };
      const wallet = privateKeyToAccount(
          `0x${randomBytes(32).toString("hex")}`,
        ),
        target = {
          purpose: "link",
          address: wallet.address.toLowerCase(),
          chainId: 875421,
        };
      const operations = createProviderWalletOperations(a);
      const operation = await operations.create({
        ...f,
        ...target,
        credential: { type: "passkey", keyId: enrolled.keyId },
      });
      const proof = {
        ...f,
        ...target,
        id: operation.id,
        rpcUrls: {},
        sessionDurationMs: 600000,
        authentication: device.authentication(operation.authenticationOptions),
        proposedSignature: await wallet.signMessage({
          message: operation.proposedMessage,
        }),
      };
      await assert.rejects(
        operations.complete({ ...proof, proposedSignature: "0x1234" }),
        /new wallet signature is invalid/,
      );
      const linked = await operations.complete(proof);
      assert.equal(linked.wallet.address, target.address);
      assert.equal(
        await createSessionRepository(b).findUserByTokenHash(
          f.sessionTokenHash,
        ),
        null,
      );
      await assert.rejects(operations.complete(proof), /expired or invalid/);
      f = { ...f, sessionTokenHash: hashSessionToken(linked.token) };
      const unlink = {
        purpose: "unlink",
        address: target.address,
        chainId: target.chainId,
        targetWalletId: linked.wallet.id,
      };
      await assert.rejects(
        operations.create({
          ...f,
          ...unlink,
          credential: { type: "wallet", walletId: linked.wallet.id },
        }),
        /will remain linked/,
      );
      const removal = await operations.create({
        ...f,
        ...unlink,
        credential: { type: "passkey", keyId: enrolled.keyId },
      });
      const removed = await createProviderWalletOperations(b).complete({
        ...f,
        ...unlink,
        id: removal.id,
        rpcUrls: {},
        sessionDurationMs: 600000,
        authentication: device.authentication(removal.authenticationOptions, {
          counter: 2,
        }),
      });
      assert.equal(removed.wallet.id, linked.wallet.id);
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM wallet_identities WHERE user_id=$1",
            [f.userId],
          )
        ).rows[0].n,
        0,
      );
      assert.ok(
        await createSessionRepository(a).findUserByTokenHash(
          hashSessionToken(removed.token),
        ),
      );
    });
    it("requires an exact fresh passkey assertion for every operation and consumes it atomically across pools", async () => {
      const { f, result, authenticatorDevice } = await enroll(await fixture());
      const terms = {
        environment: "sandbox",
        asset: "USDC",
        amount: "5000000",
        destination: "synthetic-wallet",
        fee: "1000",
      };
      const ops = createAccountOperationRepository(a),
        operation = await ops.create({
          ...f,
          purpose: "withdrawal.request",
          terms,
          credential: { type: "passkey", keyId: result.keyId },
        });
      assert.equal(
        operation.authenticationOptions.userVerification,
        "required",
      );
      const authentication = authenticatorDevice.authentication(
        operation.authenticationOptions,
      );
      const input = {
        ...f,
        id: operation.id,
        purpose: operation.purpose,
        terms,
        authentication,
        rpcUrls: {},
      };
      const one = await ops.prepare(input),
        two = await createAccountOperationRepository(b).prepare(input);
      const outcomes = await Promise.allSettled([
        consume(one, a),
        consume(two, b),
      ]);
      assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        (
          await owner.query(
            "SELECT counter::text FROM account_security_keys WHERE id=$1",
            [result.keyId],
          )
        ).rows[0].counter,
        "1",
      );
      const next = await ops.create({
        ...f,
        purpose: "withdrawal.request",
        terms,
        credential: { type: "passkey", keyId: result.keyId },
      });
      await assert.rejects(
        consume(await ops.prepare({ ...input, id: next.id })),
        /passkey approval is invalid/,
      );
      for (const overrides of [
        { flags: 1 },
        { origin: "https://attacker.example" },
        { challenge: randomBytes(32).toString("base64url") },
        { counter: 1 },
      ]) {
        const authentication = authenticatorDevice.authentication(
          next.authenticationOptions,
          overrides,
        );
        await assert.rejects(
          consume(await ops.prepare({ ...input, id: next.id, authentication })),
          /passkey approval is invalid/,
        );
      }
      assert.equal(
        await consume(
          await ops.prepare({
            ...input,
            id: next.id,
            authentication: authenticatorDevice.authentication(
              next.authenticationOptions,
              { counter: 2 },
            ),
          }),
        ),
        "authorized",
      );
    });
    it("requires retained proof for enrollment/removal and preserves immutable revoked key history", async () => {
      const { f, result } = await enroll(await fixture()),
        other = await fixture(),
        repository = createSecurityPasskeyRepository(a);
      const challenge = await repository.enrollmentOptions(f),
        device = authenticator();
      const wrong = await approve(f, "withdrawal.request", {
        challengeId: challenge.id,
      });
      await assert.rejects(
        repository.completeEnrollment({
          ...f,
          id: challenge.id,
          response: device.registration(challenge.options),
          sessionDurationMs: 600000,
          approval: wrong,
        }),
        /does not authorize/,
      );
      const foreign = await approve(other, "security.passkey.enroll", {
        challengeId: challenge.id,
      });
      await assert.rejects(
        repository.completeEnrollment({
          ...f,
          id: challenge.id,
          response: device.registration(challenge.options),
          sessionDurationMs: 600000,
          approval: foreign,
        }),
        /another session/,
      );
      await assert.rejects(
        createAccountOperationRepository(a).create({
          ...f,
          purpose: "security.passkey.remove",
          terms: { keyId: result.keyId },
          credential: { type: "passkey", keyId: result.keyId },
        }),
        /retained credential/,
      );
      const approval = await approve(f, "security.passkey.remove", {
        keyId: result.keyId,
      });
      const removed = await repository.remove({
        ...f,
        keyId: result.keyId,
        sessionDurationMs: 600000,
        approval,
      });
      assert.deepEqual(await repository.list(f.userId), []);
      assert.equal(
        await createSessionRepository(b).findUserByTokenHash(
          f.sessionTokenHash,
        ),
        null,
      );
      assert.ok(
        await createSessionRepository(b).findUserByTokenHash(
          hashSessionToken(removed.token),
        ),
      );
      await assert.rejects(
        owner.query(
          "UPDATE account_security_keys SET revoked_at=NULL WHERE id=$1",
          [result.keyId],
        ),
        { code: "23514" },
      );
      await assert.rejects(
        a.query("DELETE FROM account_security_keys WHERE id=$1", [
          result.keyId,
        ]),
        { code: "42501" },
      );
    });
    it("rejects enrollment responses for a different origin/challenge before adding any key", async () => {
      const f = await fixture(),
        repository = createSecurityPasskeyRepository(a),
        challenge = await repository.enrollmentOptions(f),
        device = authenticator();
      const approval = await approve(f, "security.passkey.enroll", {
        challengeId: challenge.id,
      });
      for (const overrides of [
        { origin: "https://attacker.example" },
        { challenge: randomBytes(32).toString("base64url") },
      ])
        await assert.rejects(
          repository.completeEnrollment({
            ...f,
            id: challenge.id,
            response: device.registration(challenge.options, overrides),
            sessionDurationMs: 600000,
            approval,
          }),
          /enrollment is invalid/,
        );
      assert.deepEqual(await repository.list(f.userId), []);
    });
  },
);
