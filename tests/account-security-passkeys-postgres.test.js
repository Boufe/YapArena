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
import { createAccountAccessRepository } from "../dist/platform/auth/account-access.js";
import { providerCredentialsDigest } from "../dist/platform/auth/provider-credentials.js";
import { createProviderIdentityRecovery } from "../dist/platform/auth/provider-identity-recovery.js";
import { createCoinSandboxRepository } from "../dist/features/account-wallet/sandbox-repository.js";
import { ProviderUnavailableError } from "../dist/platform/auth/privy.js";

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
    authentication(
      options,
      { counter = 1, flags = 0x05, userHandle, ...overrides } = {},
    ) {
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
          ...(userHandle ? { userHandle } : {}),
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
      assert.equal(
        challenge.options.authenticatorSelection.residentKey,
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
    async function accessFixture() {
      const enrolled = await enroll(await fixture());
      const credentials = [
        { type: "email", id: `${randomUUID()}@example.test` },
      ];
      const identity = {
        subject: `did:privy:${randomUUID()}`,
        sessionId: randomUUID(),
        email: credentials[0].id,
        methods: ["email"],
        issuedAt: Math.floor(Date.now() / 1000),
        credentialsDigest: providerCredentialsDigest(credentials),
        credentials,
      };
      await owner.query(
        `INSERT INTO provider_identities(provider,subject,user_id,email,methods,credentials_digest,credentials_snapshot,auth_generation)
        SELECT 'privy',$1,id,$2,'["email"]'::jsonb,$3,$4::jsonb,auth_generation FROM users WHERE id=$5`,
        [
          identity.subject,
          identity.email,
          identity.credentialsDigest,
          JSON.stringify(credentials),
          enrolled.f.userId,
        ],
      );
      return {
        ...enrolled,
        identity,
        userHandle: enrolled.challenge.options.user.id,
      };
    }
    async function recoveryFixture(oldMethod = "email") {
      const f = await accessFixture();
      if (oldMethod === "google_oauth") {
        const credentials = [
          { type: "google_oauth", id: `google-${randomUUID()}` },
        ];
        Object.assign(f.identity, {
          email: null,
          methods: [oldMethod],
          credentials,
          credentialsDigest: providerCredentialsDigest(credentials),
        });
        await owner.query(
          "UPDATE provider_identities SET email=NULL,methods=$2::jsonb,credentials_snapshot=$3::jsonb,credentials_digest=$4 WHERE subject=$1",
          [
            f.identity.subject,
            JSON.stringify(f.identity.methods),
            JSON.stringify(credentials),
            f.identity.credentialsDigest,
          ],
        );
      }
      const credentials = [
        { type: "email", id: `${randomUUID()}@example.test` },
      ];
      const next = {
        subject: `did:privy:${randomUUID()}`,
        sessionId: randomUUID(),
        email: credentials[0].id,
        methods: ["email"],
        credentials,
        credentialsDigest: providerCredentialsDigest(credentials),
        issuedAt: Math.floor(Date.now() / 1000),
      };
      const verifier = {
        async verify() {
          return next;
        },
        async inspect(subject) {
          assert.equal(subject, f.identity.subject);
          return f.identity;
        },
      };
      const service = createProviderIdentityRecovery(a, verifier);
      return { ...f, next, verifier, service };
    }
    async function recoveryOperation(f, overrides = {}) {
      return f.service.create({
        ...f.f,
        token: "synthetic-provider-token",
        credential: { type: "passkey", keyId: f.result.keyId },
        ...overrides,
      });
    }
    async function finishRecovery(f, operation, overrides = {}) {
      return f.service.complete({
        ...f.f,
        token: "synthetic-provider-token",
        id: operation.id,
        authentication: f.authenticatorDevice.authentication(
          operation.authenticationOptions,
        ),
        rpcUrls: {},
        sessionDurationMs: 600000,
        ...overrides,
      });
    }
    for (const oldMethod of ["email", "google_oauth"])
      it(`replaces a lost sole ${oldMethod} sign-in with a verified email using its retained key, preserving account/profile/funds and permanently retiring the old identity`, async () => {
        const f = await recoveryFixture(oldMethod),
          coins = createCoinSandboxRepository(a, {
            rail: "simulation",
            withdrawalFee: "100000",
          });
        const quote = await coins.quoteFunding(f.f, {
          amount: "10000000",
          idempotencyKey: randomUUID(),
        });
        await coins.confirmSimulatedFunding(f.f, { requestId: quote.id });
        const before = await coins.summary(f.f);
        const profile = (
          await owner.query(
            "INSERT INTO public_profiles(user_id,handle,display_name,bio) VALUES($1,$2,'Synthetic recovery profile','Preserve exactly') RETURNING *",
            [f.f.userId, `recovery-${randomUUID().slice(0, 20)}`],
          )
        ).rows[0];
        const extra = createSessionToken();
        await createSessionRepository(a).create(
          f.f.userId,
          extra.tokenHash,
          new Date(Date.now() + 600000),
          (
            await owner.query(
              'SELECT auth_generation AS "authGeneration" FROM users WHERE id=$1',
              [f.f.userId],
            )
          ).rows[0],
        );
        const operation = await recoveryOperation(f);
        assert.equal(operation.terms.oldMethod, oldMethod);
        assert.equal(operation.terms.newEmail, f.next.email);
        const result = await finishRecovery(f, operation),
          context = {
            ...f.f,
            sessionTokenHash: hashSessionToken(result.token),
          };
        const after = await coins.summary(context);
        assert.deepEqual(after.balances, before.balances);
        assert.deepEqual(after.book, before.book);
        assert.deepEqual(after.requests, before.requests);
        assert.deepEqual(after.projection, before.projection);
        assert.deepEqual(
          (
            await owner.query("SELECT * FROM public_profiles WHERE id=$1", [
              profile.id,
            ])
          ).rows[0],
          profile,
        );
        assert.equal(
          (
            await createSessionRepository(b).findUserByTokenHash(
              context.sessionTokenHash,
            )
          ).id,
          f.f.userId,
        );
        assert.equal(
          await createSessionRepository(b).findUserByTokenHash(
            f.f.sessionTokenHash,
          ),
          null,
        );
        assert.equal(
          await createSessionRepository(b).findUserByTokenHash(extra.tokenHash),
          null,
        );
        const mappings = (
          await owner.query(
            "SELECT subject,user_id,email,methods,credentials_snapshot FROM provider_identities WHERE subject=ANY($1::text[]) ORDER BY subject",
            [[f.identity.subject, f.next.subject]],
          )
        ).rows;
        assert.equal(
          mappings.find((p) => p.subject === f.identity.subject).user_id,
          null,
        );
        assert.deepEqual(
          mappings.find((p) => p.subject === f.identity.subject).methods,
          [],
        );
        assert.equal(
          mappings.find((p) => p.subject === f.next.subject).user_id,
          f.f.userId,
        );
        assert.equal(
          (
            await owner.query(
              "SELECT count(*)::int AS count FROM provider_identities WHERE user_id=$1",
              [f.f.userId],
            )
          ).rows[0].count,
          1,
        );
        const exchange = createProviderAccounts(b),
          token = createSessionToken();
        await assert.rejects(
          exchange.exchange(
            {
              ...f.identity,
              sessionId: randomUUID(),
              issuedAt: Math.floor(Date.now() / 1000),
            },
            token.tokenHash,
            new Date(Date.now() + 600000),
          ),
          { status: 403 },
        );
        await assert.rejects(
          exchange.exchange(
            f.next,
            token.tokenHash,
            new Date(Date.now() + 600000),
          ),
          { status: 401 },
        );
        await assert.rejects(
          finishRecovery(f, operation),
          /review|invalid|changed/,
        );
        assert.equal(
          (
            await owner.query(
              "SELECT count(*)::int AS count FROM provider_identity_recoveries WHERE id=$1",
              [operation.id],
            )
          ).rows[0].count,
          1,
        );
        // Operation cleanup must never remove permanent retired-identity history.
        await owner.query("DELETE FROM account_operations WHERE id=$1", [
          operation.id,
        ]);
        assert.equal(
          (
            await owner.query(
              "SELECT old_subject FROM provider_identity_recoveries WHERE id=$1",
              [operation.id],
            )
          ).rows[0].old_subject,
          f.identity.subject,
        );
        await assert.rejects(
          owner.query(
            "UPDATE provider_identities SET user_id=$2 WHERE subject=$1",
            [f.identity.subject, f.f.userId],
          ),
          { code: "23514" },
        );
        await assert.rejects(
          owner.query("DELETE FROM provider_identities WHERE subject=$1", [
            f.identity.subject,
          ]),
          { code: "23503" },
        );
        await assert.rejects(
          owner.query("DELETE FROM provider_identity_recoveries WHERE id=$1", [
            operation.id,
          ]),
          { code: "23514" },
        );
      });
    it("requires the retained security key and exact new server-verified email/SID, without consuming a changed or cross-account proof", async () => {
      const f = await recoveryFixture(),
        intruder = await enroll(await fixture());
      await assert.rejects(
        recoveryOperation(f, { credential: { type: "password" } }),
        { status: 403 },
      );
      await assert.rejects(
        recoveryOperation(f, {
          credential: { type: "passkey", keyId: intruder.result.keyId },
        }),
        { status: 403, message: "security passkey required" },
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int AS count FROM account_operations WHERE user_id=$1 AND purpose='provider.identity.recover'",
            [f.f.userId],
          )
        ).rows[0].count,
        0,
      );
      const operation = await recoveryOperation(f),
        savedSid = f.next.sessionId;
      f.next.sessionId = randomUUID();
      await assert.rejects(
        finishRecovery(f, operation),
        /invalid|expired|changed/,
      );
      f.next.sessionId = savedSid;
      const savedIdentity = { ...f.next },
        changedCredentials = [
          { type: "email", id: `${randomUUID()}@example.test` },
        ];
      Object.assign(f.next, {
        email: changedCredentials[0].id,
        credentials: changedCredentials,
        credentialsDigest: providerCredentialsDigest(changedCredentials),
      });
      await assert.rejects(finishRecovery(f, operation), { status: 410 });
      Object.assign(f.next, savedIdentity);
      await assert.rejects(
        finishRecovery(f, operation, { authentication: undefined, password }),
        { status: 403 },
      );
      await assert.rejects(
        finishRecovery(f, operation, {
          userId: intruder.f.userId,
          sessionTokenHash: intruder.f.sessionTokenHash,
        }),
        /review|changed|invalid/,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT counter FROM account_security_keys WHERE id=$1",
            [f.result.keyId],
          )
        ).rows[0].counter,
        "0",
      );
      assert.equal(
        (
          await owner.query(
            "SELECT consumed_at FROM account_operations WHERE id=$1",
            [operation.id],
          )
        ).rows[0].consumed_at,
        null,
      );
      await finishRecovery(f, operation);
    });
    it("refuses already bound or tombstoned new identities and unsupported multi-method old/new provider states without moving either account", async () => {
      const f = await recoveryFixture(),
        other = await accessFixture(),
        original = { ...f.next };
      Object.assign(f.next, other.identity);
      await assert.rejects(recoveryOperation(f), { status: 409 });
      await owner.query("DELETE FROM users WHERE id=$1", [other.f.userId]);
      await assert.rejects(recoveryOperation(f), { status: 409 });
      Object.assign(f.next, original);
      f.next.methods = ["email", "google_oauth"];
      await assert.rejects(recoveryOperation(f), { status: 409 });
      f.next.methods = ["email"];
      f.identity.methods = ["email", "passkey"];
      await assert.rejects(recoveryOperation(f), { status: 409 });
      assert.equal(
        (
          await owner.query(
            "SELECT user_id FROM provider_identities WHERE subject=$1",
            [f.identity.subject],
          )
        ).rows[0].user_id,
        f.f.userId,
      );
    });
    it("rolls a fresh-key counter and replacement back when a competing provider claim wins, and permits only one concurrent recovery", async () => {
      const f = await recoveryFixture(),
        operation = await recoveryOperation(f);
      const result = await Promise.allSettled([
        finishRecovery(f, operation),
        finishRecovery(f, operation),
      ]);
      assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int AS count FROM provider_identity_recoveries WHERE user_id=$1",
            [f.f.userId],
          )
        ).rows[0].count,
        1,
      );
      const g = await recoveryFixture(),
        pending = await recoveryOperation(g),
        claimed = createSessionToken();
      const other = await createProviderAccounts(b).exchange(
        g.next,
        claimed.tokenHash,
        new Date(Date.now() + 600000),
      );
      accounts.push(other.user.id);
      await assert.rejects(finishRecovery(g, pending), { status: 409 });
      assert.equal(
        (
          await owner.query(
            "SELECT counter FROM account_security_keys WHERE id=$1",
            [g.result.keyId],
          )
        ).rows[0].counter,
        "0",
      );
      assert.equal(
        (
          await owner.query(
            "SELECT user_id FROM provider_identities WHERE subject=$1",
            [g.next.subject],
          )
        ).rows[0].user_id,
        other.user.id,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT user_id FROM provider_identities WHERE subject=$1",
            [g.identity.subject],
          )
        ).rows[0].user_id,
        g.f.userId,
      );
    });
    it("does not hold a pool connection or account lock while inspecting providers; local revocation wins the held recovery", async () => {
      const f = await recoveryFixture(),
        operation = await recoveryOperation(f);
      let release, entered;
      const seen = new Promise((resolve) => {
          entered = resolve;
        }),
        wait = new Promise((resolve) => {
          release = resolve;
        });
      const pool = new pg.Pool({ connectionString: runtimeUrl, max: 1 });
      const service = createProviderIdentityRecovery(pool, {
        ...f.verifier,
        async inspect() {
          entered();
          await wait;
          return f.identity;
        },
      });
      const held = service.complete({
        ...f.f,
        token: "synthetic-provider-token",
        id: operation.id,
        authentication: f.authenticatorDevice.authentication(
          operation.authenticationOptions,
        ),
        rpcUrls: {},
        sessionDurationMs: 600000,
      });
      try {
        await seen;
        await pool.query("SELECT 1");
        await createSessionRepository(b).revoke(
          f.f.userId,
          f.f.sessionTokenHash,
          false,
        );
        release();
        await assert.rejects(held, /session|invalid|expired|changed/);
        assert.equal(
          (
            await owner.query(
              "SELECT counter FROM account_security_keys WHERE id=$1",
              [f.result.keyId],
            )
          ).rows[0].counter,
          "0",
        );
        assert.equal(
          (
            await owner.query(
              "SELECT user_id FROM provider_identities WHERE subject=$1",
              [f.identity.subject],
            )
          ).rows[0].user_id,
          f.f.userId,
        );
      } finally {
        release();
        await pool.end();
      }
    });
    it("restricts SQL ownership/history privileges and rolls back a direct unconsumed-proof recovery at commit", async () => {
      const f = await recoveryFixture(),
        operation = await recoveryOperation(f);
      await assert.rejects(
        a.query(
          "UPDATE provider_identities SET user_id=NULL WHERE subject=$1",
          [f.identity.subject],
        ),
        { code: "42501" },
      );
      await assert.rejects(
        a.query("INSERT INTO provider_identity_recoveries(id) VALUES($1)", [
          randomUUID(),
        ]),
        { code: "42501" },
      );
      const client = await a.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT apply_provider_identity_recovery($1)", [
          operation.id,
        ]);
        await assert.rejects(client.query("COMMIT"), { code: "23514" });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      assert.equal(
        (
          await owner.query(
            "SELECT user_id FROM provider_identities WHERE subject=$1",
            [f.identity.subject],
          )
        ).rows[0].user_id,
        f.f.userId,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int AS count FROM provider_identity_recoveries WHERE id=$1",
            [operation.id],
          )
        ).rows[0].count,
        0,
      );
      await finishRecovery(f, operation);
    });
    it("signs in with a discoverable retained security key, checks provider state every time, and rejects wrong user handles and replay", async () => {
      const f = await accessFixture();
      let inspections = 0;
      const service = createAccountAccessRepository(a, {
        async verify() {
          throw new Error("key login must not require provider token");
        },
        async inspect() {
          inspections++;
          return f.identity;
        },
      });
      const challenge = await service.loginOptions({ origin });
      assert.equal(challenge.authenticationOptions.allowCredentials, undefined);
      await assert.rejects(
        service.login({
          id: challenge.id,
          origin,
          sessionDurationMs: 600000,
          authentication: f.authenticatorDevice.authentication(
            challenge.authenticationOptions,
            { userHandle: randomBytes(32).toString("base64url") },
          ),
        }),
        /verification failed/,
      );
      const logged = await service.login({
        id: challenge.id,
        origin,
        sessionDurationMs: 600000,
        authentication: f.authenticatorDevice.authentication(
          challenge.authenticationOptions,
          { userHandle: f.userHandle },
        ),
      });
      assert.equal(
        (
          await createSessionRepository(b).findUserByTokenHash(
            hashSessionToken(logged.token),
          )
        ).id,
        f.f.userId,
      );
      await assert.rejects(
        service.login({
          id: challenge.id,
          origin,
          sessionDurationMs: 600000,
          authentication: f.authenticatorDevice.authentication(
            challenge.authenticationOptions,
            { counter: 2, userHandle: f.userHandle },
          ),
        }),
        /expired/,
      );
      const second = await service.loginOptions({ origin });
      await service.login({
        id: second.id,
        origin,
        sessionDurationMs: 600000,
        authentication: f.authenticatorDevice.authentication(
          second.authenticationOptions,
          { counter: 2, userHandle: f.userHandle },
        ),
      });
      assert.equal(inspections, 2);
    });
    it("rejects discoverable login challenges issued before any later account revocation", async () => {
      const f = await accessFixture(),
        service = createAccountAccessRepository(a, {
          async verify() {
            return f.identity;
          },
          async inspect() {
            return f.identity;
          },
        }),
        challenge = await service.loginOptions({ origin });
      await createSessionRepository(b).revoke(
        f.f.userId,
        f.f.sessionTokenHash,
        false,
      );
      await assert.rejects(
        service.login({
          id: challenge.id,
          origin,
          sessionDurationMs: 600000,
          authentication: f.authenticatorDevice.authentication(
            challenge.authenticationOptions,
            { userHandle: f.userHandle },
          ),
        }),
        /expired or account access changed/,
      );
    });
    it("accepts a newer same-millisecond challenge without weakening the database generation fence", async () => {
      const f = await accessFixture(),
        service = createAccountAccessRepository(a, {
          async verify() {
            return f.identity;
          },
          async inspect() {
            return f.identity;
          },
        }),
        original = await service.loginOptions({ origin });
      let newerId;
      for (let attempt = 0; attempt < 5 && !newerId; attempt++) {
        const id = randomUUID(),
          created = (
            await owner.query(
              `WITH changed AS(
          UPDATE users SET auth_generation=auth_generation+1 WHERE id=$1 RETURNING auth_changed_at
        ), copied AS(
          INSERT INTO account_access_challenges(id,purpose,nonce,credential_type,created_at,expires_at)
          SELECT $2,purpose,nonce,credential_type,changed.auth_changed_at+interval '1 microsecond',changed.auth_changed_at+interval '5 minutes'
          FROM account_access_challenges CROSS JOIN changed WHERE id=$3 RETURNING created_at
        ) SELECT date_trunc('milliseconds',changed.auth_changed_at)=date_trunc('milliseconds',copied.created_at) AS same_ms FROM changed,copied`,
              [f.f.userId, id, original.id],
            )
          ).rows[0];
        if (created.same_ms) newerId = id;
      }
      assert.ok(
        newerId,
        "fixture must exercise distinct DB timestamps in one JS millisecond",
      );
      const result = await service.login({
        id: newerId,
        origin,
        sessionDurationMs: 600000,
        authentication: f.authenticatorDevice.authentication(
          original.authenticationOptions,
          { userHandle: f.userHandle },
        ),
      });
      assert.equal(
        (
          await createSessionRepository(b).findUserByTokenHash(
            hashSessionToken(result.token),
          )
        ).id,
        f.f.userId,
      );
    });
    it("requires an exact displayed provider delta and bound SID before atomically restoring one session with a retained key", async () => {
      const f = await accessFixture();
      const credentials = [
        { type: "email", id: `${randomUUID()}@example.test` },
        { type: "google_oauth", id: randomUUID() },
      ];
      let current = {
        ...f.identity,
        sessionId: randomUUID(),
        email: credentials[0].id,
        methods: ["email", "google_oauth"],
        credentialsDigest: providerCredentialsDigest(credentials),
        credentials,
      };
      const verifier = {
          async verify() {
            return current;
          },
          async inspect() {
            return current;
          },
        },
        service = createAccountAccessRepository(a, verifier);
      const login = await service.loginOptions({ origin });
      await assert.rejects(
        service.login({
          id: login.id,
          origin,
          sessionDurationMs: 600000,
          authentication: f.authenticatorDevice.authentication(
            login.authenticationOptions,
            { userHandle: f.userHandle },
          ),
        }),
        /Sign-in methods changed/,
      );
      assert.equal(
        await createSessionRepository(b).findUserByTokenHash(
          f.f.sessionTokenHash,
        ),
        null,
      );
      const candidate = await service.reconciliationCandidate(
        "synthetic-provider-token",
      );
      assert.deepEqual(candidate.before, f.identity.credentials);
      assert.deepEqual(candidate.after, credentials);
      const operation = await service.reconciliationOptions({
        token: "synthetic-provider-token",
        origin,
        credential: { type: "passkey", keyId: f.result.keyId },
      });
      assert.deepEqual(operation.after, credentials);
      const proof = {
        id: operation.id,
        token: "synthetic-provider-token",
        origin,
        rpcUrls: {},
        sessionDurationMs: 600000,
        authentication: f.authenticatorDevice.authentication(
          operation.authenticationOptions,
          { counter: 2, userHandle: f.userHandle },
        ),
      };
      const real = current;
      current = { ...current, sessionId: randomUUID() };
      await assert.rejects(service.reconcile(proof), /expired/);
      current = real;
      const results = await Promise.allSettled([
        service.reconcile(proof),
        createAccountAccessRepository(b, verifier).reconcile(proof),
      ]);
      assert.equal(
        results.filter((value) => value.status === "fulfilled").length,
        1,
      );
      assert.equal(
        results.filter((value) => value.status === "rejected").length,
        1,
      );
      const updated = (
        await owner.query(
          "SELECT user_id,credentials_digest,credentials_snapshot FROM provider_identities WHERE subject=$1",
          [f.identity.subject],
        )
      ).rows[0];
      assert.equal(updated.user_id, f.f.userId);
      assert.equal(updated.credentials_digest, current.credentialsDigest);
      assert.deepEqual(updated.credentials_snapshot, credentials);
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM sessions WHERE user_id=$1",
            [f.f.userId],
          )
        ).rows[0].n,
        1,
      );
      await assert.rejects(service.reconcile(proof), /expired/);
    });
    it("permits a retained password reconciliation without treating a provider token as fresh proof", async () => {
      const f = await accessFixture(),
        credentials = [{ type: "email", id: `${randomUUID()}@example.test` }],
        identity = {
          ...f.identity,
          credentials,
          email: credentials[0].id,
          credentialsDigest: providerCredentialsDigest(credentials),
        };
      const service = createAccountAccessRepository(a, {
          async verify() {
            return identity;
          },
          async inspect() {
            return identity;
          },
        }),
        operation = await service.reconciliationOptions({
          token: "synthetic-provider-token",
          origin,
          credential: { type: "password" },
        });
      const input = {
        id: operation.id,
        token: "synthetic-provider-token",
        origin,
        rpcUrls: {},
        sessionDurationMs: 600000,
      };
      await assert.rejects(
        service.reconcile({ ...input, password: "incorrect" }),
        /password is incorrect/,
      );
      const result = await service.reconcile({ ...input, password });
      assert.equal(
        (
          await createSessionRepository(b).findUserByTokenHash(
            hashSessionToken(result.token),
          )
        ).id,
        f.f.userId,
      );
    });
    it("requires a retained wallet signature for the exact displayed method changes and rejects another wallet", async () => {
      const f = await accessFixture(),
        wallet = privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`),
        other = privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`),
        walletId = randomUUID();
      await owner.query(
        "INSERT INTO wallet_identities(id,user_id,address,chain_id) VALUES($1,$2,$3,1)",
        [walletId, f.f.userId, wallet.address.toLowerCase()],
      );
      const credentials = [
          { type: "email", id: `${randomUUID()}@example.test` },
        ],
        identity = {
          ...f.identity,
          credentials,
          email: credentials[0].id,
          credentialsDigest: providerCredentialsDigest(credentials),
        },
        service = createAccountAccessRepository(a, {
          async verify() {
            return identity;
          },
          async inspect() {
            return identity;
          },
        });
      const operation = await service.reconciliationOptions({
          token: "synthetic-provider-token",
          origin,
          credential: { type: "wallet", walletId },
        }),
        input = {
          id: operation.id,
          token: "synthetic-provider-token",
          origin,
          rpcUrls: {},
          sessionDurationMs: 600000,
        };
      assert.ok(operation.authorizationMessage.includes(f.identity.email));
      assert.ok(operation.authorizationMessage.includes(identity.email));
      await assert.rejects(
        service.reconcile({
          ...input,
          signature: await other.signMessage({
            message: operation.authorizationMessage,
          }),
        }),
        /wallet verification failed/,
      );
      const result = await service.reconcile({
        ...input,
        signature: await wallet.signMessage({
          message: operation.authorizationMessage,
        }),
      });
      assert.equal(
        (
          await createSessionRepository(b).findUserByTokenHash(
            hashSessionToken(result.token),
          )
        ).id,
        f.f.userId,
      );
    });
    it("checks challenge expiry after provider inspection and rolls back key use and provisional session creation", async () => {
      let inspections = 0;
      const f = await accessFixture(),
        service = createAccountAccessRepository(a, {
          async verify() {
            return f.identity;
          },
          async inspect() {
            inspections++;
            await new Promise((resolve) => setTimeout(resolve, 500));
            return f.identity;
          },
        }),
        challenge = await service.loginOptions({ origin }),
        shortId = randomUUID();
      await owner.query(
        `INSERT INTO account_access_challenges(id,purpose,nonce,credential_type,created_at,expires_at)
        SELECT $1,purpose,nonce,credential_type,date_trunc('milliseconds',clock_timestamp()),date_trunc('milliseconds',clock_timestamp())+interval '400 milliseconds'
        FROM account_access_challenges WHERE id=$2`,
        [shortId, challenge.id],
      );
      await assert.rejects(
        service.login({
          id: shortId,
          origin,
          sessionDurationMs: 600000,
          authentication: f.authenticatorDevice.authentication(
            challenge.authenticationOptions,
            { userHandle: f.userHandle },
          ),
        }),
        /expired/,
      );
      assert.equal(inspections, 1);
      assert.equal(
        (
          await owner.query(
            "SELECT counter FROM account_security_keys WHERE id=$1",
            [f.result.keyId],
          )
        ).rows[0].counter,
        "0",
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM sessions WHERE user_id=$1",
            [f.f.userId],
          )
        ).rows[0].n,
        1,
      );
    });
    it("applies account and operation abuse limits after server-side identity resolution and before checking proof", async () => {
      const f = await accessFixture(),
        attempts = [],
        service = createAccountAccessRepository(
          a,
          {
            async verify() {
              return f.identity;
            },
            async inspect() {
              return f.identity;
            },
          },
          {
            async authorizeAttempt(userId, purpose) {
              attempts.push({ userId, purpose });
              throw new Error("synthetic account limit");
            },
          },
        ),
        challenge = await service.loginOptions({ origin });
      await assert.rejects(
        service.login({
          id: challenge.id,
          origin,
          sessionDurationMs: 600000,
          authentication: f.authenticatorDevice.authentication(
            challenge.authenticationOptions,
            { userHandle: f.userHandle },
          ),
        }),
        /account limit/,
      );
      const reconcile = await service.reconciliationOptions({
        token: "synthetic-provider-token",
        origin,
        credential: { type: "password" },
      });
      await assert.rejects(
        service.reconcile({
          id: reconcile.id,
          token: "synthetic-provider-token",
          origin,
          rpcUrls: {},
          sessionDurationMs: 600000,
          password,
        }),
        /account limit/,
      );
      assert.deepEqual(attempts, [
        { userId: f.f.userId, purpose: "security.login" },
        { userId: f.f.userId, purpose: "provider.credentials.reconcile" },
      ]);
      assert.equal(
        (
          await owner.query(
            "SELECT counter FROM account_security_keys WHERE id=$1",
            [f.result.keyId],
          )
        ).rows[0].counter,
        "0",
      );
    });
    it("does not guess an unknown old provider snapshot or cross a later revocation while reconciling", async () => {
      const f = await accessFixture(),
        service = createAccountAccessRepository(a, {
          async verify() {
            return f.identity;
          },
          async inspect() {
            return f.identity;
          },
        });
      const operation = await service.reconciliationOptions({
        token: "synthetic-provider-token",
        origin,
        credential: { type: "password" },
      });
      await createSessionRepository(b).revoke(
        f.f.userId,
        f.f.sessionTokenHash,
        false,
      );
      await assert.rejects(
        service.reconcile({
          id: operation.id,
          token: "synthetic-provider-token",
          origin,
          rpcUrls: {},
          sessionDurationMs: 600000,
          password,
        }),
        /expired/,
      );
      await owner.query(
        "UPDATE provider_identities SET credentials_snapshot=NULL,methods='[\"google_oauth\"]'::jsonb WHERE user_id=$1",
        [f.f.userId],
      );
      await assert.rejects(
        service.reconciliationCandidate("synthetic-provider-token"),
        /earlier sign-in methods need ownership review/,
      );
    });
    it("fails closed on provider outage and rolls back a verified key counter with no new cookie", async () => {
      const f = await accessFixture(),
        service = createAccountAccessRepository(a, {
          async verify() {
            throw new ProviderUnavailableError("provider unavailable");
          },
          async inspect() {
            throw new ProviderUnavailableError("provider unavailable");
          },
        }),
        challenge = await service.loginOptions({ origin });
      await assert.rejects(
        service.login({
          id: challenge.id,
          origin,
          sessionDurationMs: 600000,
          authentication: f.authenticatorDevice.authentication(
            challenge.authenticationOptions,
            { userHandle: f.userHandle },
          ),
        }),
        ProviderUnavailableError,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT counter FROM account_security_keys WHERE id=$1",
            [f.result.keyId],
          )
        ).rows[0].counter,
        "0",
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM sessions WHERE user_id=$1",
            [f.f.userId],
          )
        ).rows[0].n,
        1,
      );
    });
    it("allows a verified Google-only first security key at the same before-funds bootstrap boundary", async () => {
      const credentials = [{ type: "google_oauth", id: randomUUID() }],
        identity = {
          subject: `did:privy:${randomUUID()}`,
          sessionId: randomUUID(),
          email: null,
          methods: ["google_oauth"],
          issuedAt: Math.floor(Date.now() / 1000),
          credentials,
          credentialsDigest: providerCredentialsDigest(credentials),
        },
        token = createSessionToken();
      const { user } = await createProviderAccounts(a).exchange(
        identity,
        token.tokenHash,
        new Date(Date.now() + 600000),
      );
      accounts.push(user.id);
      const context = {
          userId: user.id,
          sessionTokenHash: token.tokenHash,
          origin,
        },
        repository = createSecurityPasskeyRepository(a),
        challenge = await repository.enrollmentOptions(context),
        device = authenticator();
      assert.equal(challenge.bootstrapAllowed, true);
      await repository.completeEnrollment({
        ...context,
        id: challenge.id,
        response: device.registration(challenge.options),
        sessionDurationMs: 600000,
      });
      assert.equal((await repository.list(user.id)).length, 1);
    });
  },
);
