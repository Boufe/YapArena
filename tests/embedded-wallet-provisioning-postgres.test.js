import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createProviderAccounts } from "../dist/platform/auth/provider-accounts.js";
import { providerCredentialsDigest } from "../dist/platform/auth/provider-credentials.js";
import { firstProviderPasskeyBootstrapAllowed } from "../dist/platform/auth/provider-passkey-policy.js";
import { createSessionToken } from "../dist/platform/auth/session-tokens.js";
import {
  createEmbeddedWalletProvisioning,
  enqueueEmbeddedWalletProvisioning,
} from "../dist/platform/auth/embedded-wallet-provisioning.js";
import { EmbeddedWalletProviderError } from "../dist/platform/auth/embedded-wallet-provider.js";

const runtimeUrl = process.env.WALLET_TEST_DATABASE_URL;
const ownerUrl = process.env.WALLET_TEST_OWNER_DATABASE_URL;
const address = "0x1234567890123456789012345678901234567890";
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe(
  "durable user-owned embedded wallets in disposable PostgreSQL",
  { skip: !runtimeUrl || !ownerUrl },
  () => {
    let a, b, owner;
    const accounts = [];
    before(() => {
      for (const input of [runtimeUrl, ownerUrl]) {
        const url = new URL(input);
        assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
        assert.match(
          url.pathname,
          /^\/(?:yaparena_f02|revocation_test)[a-z0-9_]*$/,
        );
      }
      a = new pg.Pool({ connectionString: runtimeUrl, max: 1 });
      b = new pg.Pool({ connectionString: runtimeUrl, max: 1 });
      owner = new pg.Pool({ connectionString: ownerUrl });
    });
    after(async () => {
      if (accounts.length)
        await owner.query("DELETE FROM users WHERE id=ANY($1::bigint[])", [
          accounts,
        ]);
      await Promise.all([a?.end(), b?.end(), owner?.end()]);
    });
    async function fixture() {
      const subject = `did:privy:${randomUUID()}`;
      const credentials = [
        { type: "email", id: `${randomUUID()}@example.invalid` },
      ];
      const identity = {
        subject,
        sessionId: randomUUID(),
        email: credentials[0].id,
        methods: ["email"],
        credentials,
        credentialsDigest: providerCredentialsDigest(credentials),
        issuedAt: Math.floor(Date.now() / 1000),
      };
      const token = createSessionToken();
      const { user } = await createProviderAccounts(a).exchange(
        identity,
        token.tokenHash,
        new Date(Date.now() + 600000),
      );
      accounts.push(user.id);
      let wallet = null;
      const calls = [];
      const adapter = {
        async inspect(input) {
          calls.push({ action: "inspect", ...input });
          assert.equal(input.subject, subject);
          return { credentialsDigest: identity.credentialsDigest, wallet };
        },
        async create(input) {
          calls.push({ action: "create", ...input });
          assert.equal(input.subject, subject);
          wallet = { id: `wallet-${randomUUID()}`, address };
        },
      };
      return {
        userId: user.id,
        subject,
        identity,
        token,
        adapter,
        calls,
        repo: createEmbeddedWalletProvisioning(a, adapter),
        other: createEmbeddedWalletProvisioning(b, adapter),
        get wallet() {
          return wallet;
        },
        set wallet(value) {
          wallet = value;
        },
      };
    }
    async function row(userId) {
      return (
        await owner.query(
          "SELECT * FROM embedded_wallet_provisioning WHERE user_id=$1",
          [userId],
        )
      ).rows[0];
    }
    async function due(userId) {
      await owner.query(
        "UPDATE embedded_wallet_provisioning SET next_attempt_at=clock_timestamp()-INTERVAL '1 second' WHERE user_id=$1",
        [userId],
      );
    }

    it("transactionally enqueues exactly one job with provisioning and rolls back an interrupted signup", async () => {
      const f = await fixture();
      const initial = await row(f.userId);
      assert.equal(initial.subject, f.subject);
      assert.equal(initial.state, "pending");
      assert.match(initial.external_id, /^yap-evm-[0-9a-f-]+$/);
      const client = await a.connect();
      try {
        await client.query("BEGIN");
        await enqueueEmbeddedWalletProvisioning(client, f.userId, f.subject);
        await enqueueEmbeddedWalletProvisioning(client, f.userId, f.subject);
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      assert.equal((await row(f.userId)).external_id, initial.external_id);
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int AS count FROM embedded_wallet_provisioning WHERE user_id=$1",
            [f.userId],
          )
        ).rows[0].count,
        1,
      );
      const rollback = await owner.connect();
      try {
        await rollback.query("BEGIN");
        const user = (
          await rollback.query("INSERT INTO users DEFAULT VALUES RETURNING id")
        ).rows[0];
        await rollback.query(
          "INSERT INTO provider_identities(provider,subject,user_id,methods,auth_generation,credentials_digest,credentials_snapshot) VALUES('privy',$1,$2,'[\"email\"]',0,$3,$4::jsonb)",
          [
            `did:privy:${randomUUID()}`,
            user.id,
            f.identity.credentialsDigest,
            JSON.stringify(f.identity.credentials),
          ],
        );
        const mapping = (
          await rollback.query(
            "SELECT subject FROM provider_identities WHERE user_id=$1",
            [user.id],
          )
        ).rows[0];
        await enqueueEmbeddedWalletProvisioning(
          rollback,
          user.id,
          mapping.subject,
        );
        await rollback.query("ROLLBACK");
        assert.equal(
          (
            await owner.query(
              "SELECT count(*)::int AS count FROM embedded_wallet_provisioning WHERE user_id=$1",
              [user.id],
            )
          ).rows[0].count,
          0,
        );
      } finally {
        rollback.release();
      }
    });
    it("creates one empty wallet after authoritative checks and projects owned status without internal references", async () => {
      const f = await fixture();
      assert.equal((await f.repo.get(f.userId)).state, "pending");
      assert.deepEqual(await f.repo.process(1, f.userId), {
        processed: 1,
        ready: 1,
        retry: 0,
        review: 0,
      });
      assert.deepEqual(await f.repo.get(f.userId), {
        accountId: f.userId,
        subject: f.subject,
        state: "ready",
        chain: "ethereum",
        address,
        canRetry: false,
        retryAt: null,
      });
      assert.equal(
        f.calls.filter((call) => call.action === "create").length,
        1,
      );
      assert.equal((await f.other.process(1, f.userId)).processed, 0);
      await f.repo.requestRetry(f.userId);
      assert.equal((await f.repo.process(1, f.userId)).processed, 0);
      assert.equal(
        f.calls.filter((call) => call.action === "create").length,
        1,
      );
      await assert.rejects(
        owner.query(
          "UPDATE embedded_wallet_provisioning SET wallet_id='replacement' WHERE user_id=$1",
          [f.userId],
        ),
        /cannot be replaced/,
      );
      await assert.rejects(
        owner.query(
          "UPDATE embedded_wallet_provisioning SET subject='did:privy:replacement' WHERE user_id=$1",
          [f.userId],
        ),
        /immutable/,
      );
      await assert.rejects(
        a.query(
          "UPDATE embedded_wallet_provisioning SET external_id='new-reference' WHERE user_id=$1",
          [f.userId],
        ),
        /permission denied/,
      );
    });
    it("keeps first security-passkey bootstrap available after empty asset wallet provisioning", async () => {
      const f = await fixture();
      assert.equal(
        await firstProviderPasskeyBootstrapAllowed(a, f.userId),
        true,
      );
      await f.repo.process(1, f.userId);
      assert.equal(
        await firstProviderPasskeyBootstrapAllowed(a, f.userId),
        true,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int AS count FROM identity_audit_events WHERE user_id=$1 AND event_type='embedded_wallet.provisioned'",
            [f.userId],
          )
        ).rows[0].count,
        1,
      );
      await owner.query(
        "INSERT INTO wallet_identities(user_id,address,chain_id) VALUES($1,$2,7654321)",
        [f.userId, `0x${randomUUID().replaceAll("-", "").padEnd(40, "0")}`],
      );
      assert.equal(
        await firstProviderPasskeyBootstrapAllowed(a, f.userId),
        false,
      );
    });
    it("reuses a verified existing wallet without invoking create", async () => {
      const f = await fixture();
      f.wallet = { id: "pre-existing-user-wallet", address };
      assert.equal((await f.repo.process(1, f.userId)).ready, 1);
      assert.equal(
        f.calls.some((call) => call.action === "create"),
        false,
      );
    });
    it("leases work across instances and releases database connections during provider calls", async () => {
      const f = await fixture();
      const entered = deferred(),
        release = deferred();
      const original = f.adapter.create;
      f.adapter.create = async (input) => {
        await original(input);
        entered.resolve();
        await release.promise;
      };
      const first = f.repo.process(1, f.userId);
      await entered.promise;
      assert.equal((await a.query("SELECT 1 AS value")).rows[0].value, 1);
      assert.equal((await f.other.process(1, f.userId)).processed, 0);
      release.resolve();
      assert.equal((await first).ready, 1);
      assert.equal(
        f.calls.filter((call) => call.action === "create").length,
        1,
      );
    });
    it("reconciles an uncertain completed creation before any further mutation", async () => {
      const f = await fixture();
      const original = f.adapter.create;
      f.adapter.create = async (input) => {
        await original(input);
        throw new EmbeddedWalletProviderError("unavailable");
      };
      assert.equal((await f.repo.process(1, f.userId)).retry, 1);
      const waiting = await f.repo.get(f.userId);
      assert.equal(waiting.state, "retry_wait");
      assert.equal(waiting.canRetry, false);
      await f.repo.requestRetry(f.userId);
      assert.equal((await f.repo.process(1, f.userId)).processed, 0);
      await due(f.userId);
      assert.equal((await f.other.process(1, f.userId)).ready, 1);
      assert.equal(
        f.calls.filter((call) => call.action === "create").length,
        1,
      );
      assert.equal((await f.repo.get(f.userId)).address, address);
    });
    it("uses a new attempt key only after confirmed absence while preserving the permanent unique external reference", async () => {
      const f = await fixture();
      const original = f.adapter.create;
      let failed = false;
      f.adapter.create = async (input) => {
        if (!failed) {
          failed = true;
          f.calls.push({ action: "create", ...input });
          throw new EmbeddedWalletProviderError("unavailable");
        }
        await original(input);
      };
      await f.repo.process(1, f.userId);
      await due(f.userId);
      await f.other.process(1, f.userId);
      const creates = f.calls.filter((call) => call.action === "create");
      assert.equal(creates.length, 2);
      assert.equal(creates[0].externalId, creates[1].externalId);
      assert.notEqual(creates[0].idempotencyKey, creates[1].idempotencyKey);
      assert.equal((await f.repo.get(f.userId)).state, "ready");
    });
    it("fences generation, suspension and unaccepted provider credentials before creation", async () => {
      const generation = await fixture();
      await owner.query(
        "UPDATE users SET auth_generation=auth_generation+1 WHERE id=$1",
        [generation.userId],
      );
      await generation.repo.process(1, generation.userId);
      assert.equal(generation.calls.length, 0);
      assert.equal(
        (await generation.repo.get(generation.userId)).state,
        "unavailable",
      );
      const suspended = await fixture();
      await owner.query(
        "UPDATE users SET account_status='suspended' WHERE id=$1",
        [suspended.userId],
      );
      await suspended.repo.process(1, suspended.userId);
      assert.equal(suspended.calls.length, 0);
      const changed = await fixture();
      changed.adapter.inspect = async () => ({
        credentialsDigest: "f".repeat(64),
        wallet: null,
      });
      await changed.repo.process(1, changed.userId);
      assert.equal(
        changed.calls.some((call) => call.action === "create"),
        false,
      );
      assert.equal(
        (await changed.repo.get(changed.userId)).state,
        "retry_wait",
      );
    });
    it("does not provision a replacement after the account's provider DID is replaced", async () => {
      const f = await fixture();
      await owner.query(
        "UPDATE provider_identities SET user_id=NULL WHERE user_id=$1",
        [f.userId],
      );
      const replacement = `did:privy:${randomUUID()}`;
      await owner.query(
        "INSERT INTO provider_identities(provider,subject,user_id,email,methods,auth_generation,credentials_digest,credentials_snapshot) SELECT 'privy',$2,id,$3,'[\"email\"]',auth_generation,$4,$5::jsonb FROM users WHERE id=$1",
        [
          f.userId,
          replacement,
          f.identity.email,
          f.identity.credentialsDigest,
          JSON.stringify(f.identity.credentials),
        ],
      );
      await f.repo.requestRetry(f.userId);
      assert.equal((await f.repo.get(f.userId)).state, "review_required");
      const outcome = await f.repo.process(1, f.userId);
      assert.equal(outcome.review, 1);
      assert.equal(outcome.retry, 0);
      assert.equal(f.calls.length, 0);
      assert.equal((await row(f.userId)).subject, f.subject);
    });
    it("requires review for unsafe ownership and bounded exhausted retries, including a crashed final lease", async () => {
      const unsafe = await fixture();
      unsafe.adapter.inspect = async () => {
        throw new EmbeddedWalletProviderError("review_required");
      };
      assert.equal((await unsafe.repo.process(1, unsafe.userId)).review, 1);
      assert.equal(
        (await unsafe.repo.get(unsafe.userId)).state,
        "review_required",
      );
      const crashed = await fixture();
      await owner.query(
        "UPDATE embedded_wallet_provisioning SET state='running',attempts=8,lease_id=$2,lease_until=clock_timestamp()-INTERVAL '1 second' WHERE user_id=$1",
        [crashed.userId, randomUUID()],
      );
      assert.deepEqual(await crashed.repo.process(1, crashed.userId), {
        processed: 0,
        ready: 0,
        retry: 0,
        review: 1,
      });
      assert.equal(
        (await crashed.repo.get(crashed.userId)).state,
        "review_required",
      );
      assert.equal(crashed.calls.length, 0);
      assert.equal(
        (await crashed.repo.requestRetry(crashed.userId)).canRetry,
        false,
      );
      assert.equal((await crashed.repo.process(1, crashed.userId)).review, 0);
      const verification = await fixture();
      await owner.query(
        "UPDATE embedded_wallet_provisioning SET attempts=7 WHERE user_id=$1",
        [verification.userId],
      );
      await owner.query(
        "UPDATE users SET auth_generation=auth_generation+1 WHERE id=$1",
        [verification.userId],
      );
      assert.deepEqual(
        await verification.repo.process(1, verification.userId),
        {
          processed: 1,
          ready: 0,
          retry: 0,
          review: 1,
        },
      );
      assert.equal(verification.calls.length, 0);
    });
    it("does not let an expired lease's late result overwrite another instance's confirmed wallet", async () => {
      const f = await fixture();
      const entered = deferred(),
        release = deferred();
      const original = f.adapter.create;
      f.adapter.create = async (input) => {
        await original(input);
        entered.resolve();
        await release.promise;
      };
      const first = f.repo.process(1, f.userId);
      await entered.promise;
      await owner.query(
        "UPDATE embedded_wallet_provisioning SET lease_until=clock_timestamp()-INTERVAL '1 second' WHERE user_id=$1",
        [f.userId],
      );
      assert.equal((await f.other.process(1, f.userId)).ready, 1);
      release.resolve();
      assert.equal((await first).ready, 0);
      assert.equal((await f.repo.get(f.userId)).state, "ready");
      assert.equal(
        f.calls.filter((call) => call.action === "create").length,
        1,
      );
    });
    it("validates worker bounds and never creates a wallet for an unmapped account", async () => {
      const f = await fixture();
      for (const limit of [0, -1, 4, 1.5])
        await assert.rejects(
          f.repo.process(limit, f.userId),
          /between one and three/,
        );
      const account = (
        await owner.query("INSERT INTO users DEFAULT VALUES RETURNING id")
      ).rows[0];
      accounts.push(account.id);
      assert.equal(
        (await f.repo.requestRetry(account.id)).state,
        "unavailable",
      );
      assert.equal(await row(account.id), undefined);
    });
  },
);
