import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hash,
  type Hex,
  type HttpTransportConfig,
  type TransactionSerializedEIP1559,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  baseSepoliaAsset,
  createBaseSepoliaAdapter,
  type PreparedTestTransfer,
  type TestTransferObservation,
} from "../src/features/account-wallet/base-sepolia.ts";

// Explicit operator command, never runtime/startup/migration behavior. The only
// chain/token are pinned in the adapter; no .env/operator file is loaded here.
assert.equal(process.env.COIN_TESTNET_ENVIRONMENT, "sandbox");
const mode = process.argv[2] ?? "--status";
assert.ok(["--status", "--prepare", "--execute"].includes(mode));
assert.equal(process.argv.length <= 3, true);
const directory = resolve(
  process.env.COIN_TESTNET_DIRECTORY ?? "/private/tmp/yaparena-coin-testnet",
);
assert.ok(
  directory.startsWith("/private/tmp/"),
  "test keys require private temp storage",
);
await mkdir(directory, { recursive: true, mode: 0o700 });
assert.equal(
  await realpath(directory),
  directory,
  "no symlinked key directory",
);
assert.equal(
  (await lstat(directory)).mode & 0o077,
  0,
  "private key directory must be mode 700",
);
const artifactDirectory = resolve("docs/evidence/coin-testnet");
await mkdir(artifactDirectory, { recursive: true });
const lockPath = resolve(directory, "operator.lock");
const lock = await open(lockPath, "wx", 0o600).catch(() => {
  throw new Error(
    "testnet verifier is already running; inspect the private operator lock",
  );
});
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function privateKey(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}
function hash(value: unknown): value is Hash {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}
function serialized(value: unknown): value is TransactionSerializedEIP1559 {
  return typeof value === "string" && /^0x02(?:[0-9a-fA-F]{2})+$/.test(value);
}
async function loadPrivate(path: string): Promise<unknown> {
  const stat = await lstat(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(
    stat.mode & 0o077,
    0,
    "test operation/key files must be mode 600",
  );
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  return value;
}
async function persistPrivate(path: string, value: unknown) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(
      JSON.stringify(value, (_key, entry: unknown) =>
        typeof entry === "bigint" ? String(entry) : entry,
      ),
    );
    await file.sync();
  } finally {
    await file.close();
  }
  const parent = await open(directory, "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (record(error) && error.code === "ENOENT") return false;
    throw error;
  }
}
function parsePrepared(value: unknown): PreparedTestTransfer {
  assert.ok(record(value));
  assert.equal(value.environment, "sandbox");
  assert.equal(value.chainId, baseSepoliaAsset.chainId);
  assert.equal(value.token, baseSepoliaAsset.token);
  assert.ok(typeof value.from === "string");
  assert.ok(typeof value.to === "string");
  assert.ok(typeof value.amount === "string");
  assert.match(value.amount, /^[1-9][0-9]{0,35}$/);
  assert.ok(typeof value.nonce === "number");
  assert.ok(Number.isSafeInteger(value.nonce) && value.nonce >= 0);
  assert.ok(typeof value.operationId === "string");
  assert.ok(hash(value.hash) && serialized(value.serializedTransaction));
  return {
    environment: "sandbox",
    chainId: 84532,
    token: baseSepoliaAsset.token,
    from: getAddress(value.from),
    to: getAddress(value.to),
    amount: BigInt(value.amount),
    nonce: value.nonce,
    operationId: value.operationId,
    hash: value.hash,
    serializedTransaction: value.serializedTransaction,
  };
}
type Sample = { usdc: bigint; gas: bigint };
type PublicOperation = {
  operation: "funding" | "payout";
  from: Address;
  to: Address;
  amount: string;
  nonce: number;
  hash: Hash;
  observation: TestTransferObservation;
};
const operations: PublicOperation[] = [];
let phase = "private setup";
// The public RPC returned HTTP 429 during bursty reconciliation. Pace requests
// across every client; retain zero automatic retries and the same signed bytes.
let priorRpc = Promise.resolve();
const pacedFetch: NonNullable<HttpTransportConfig["fetchFn"]> = async (
  input,
  init,
) => {
  const previous = priorRpc;
  let release = () => {};
  priorRpc = new Promise<void>((done) => {
    release = done;
  });
  await previous;
  try {
    return await fetch(input, init);
  } finally {
    await delay(350);
    release();
  }
};
function testTransport() {
  return http("https://sepolia.base.org", {
    retryCount: 0,
    timeout: 10_000,
    fetchFn: pacedFetch,
  });
}
try {
  const keysPath = resolve(directory, "keys.json");
  if (!(await exists(keysPath))) {
    assert.equal(
      mode,
      "--prepare",
      "run --prepare to generate disposable test keys",
    );
    await persistPrivate(keysPath, {
      funder: generatePrivateKey(),
      custody: generatePrivateKey(),
      recipient: generatePrivateKey(),
    });
  }
  const keys = await loadPrivate(keysPath);
  assert.ok(record(keys));
  assert.ok(
    privateKey(keys.funder) &&
      privateKey(keys.custody) &&
      privateKey(keys.recipient),
  );
  const accounts = {
    funder: privateKeyToAccount(keys.funder),
    custody: privateKeyToAccount(keys.custody),
    recipient: privateKeyToAccount(keys.recipient),
  };
  const adapter = createBaseSepoliaAdapter({
    ...baseSepoliaAsset,
    transport: testTransport(),
  });
  const reader = createPublicClient({
    chain: baseSepolia,
    transport: testTransport(),
  });
  const addresses = Object.fromEntries(
    Object.entries(accounts).map(([name, account]) => [name, account.address]),
  );
  const before: Record<string, Sample> = {};
  phase = "read initial external balances";
  for (const [name, account] of Object.entries(accounts))
    before[name] = await adapter.balances(account.address);
  let blocked: string | null = null;
  let gasSupply: {
    hash: Hash;
    nonce: number;
    amount: string;
    destination: Address;
  } | null = null;
  let gasObservation: {
    status: "pending" | "completed" | "uncertain";
    blockNumber: string | null;
    blockHash: Hash | null;
    finalizedBlockNumber: string | null;
  } | null = null;
  if (mode === "--execute") {
    phase = "validate persisted gas identity";
    // Test ETH is setup gas only, never user backing. Use the already approved
    // valueless faucet funds to seed the second disposable signer, avoiding a
    // second CAPTCHA. This fixed transfer has its own durable nonce/identity.
    const gasPath = resolve(directory, "gas-supply-signed.json");
    const gasAmount = 200_000_000_000_000n;
    let gasBytes: TransactionSerializedEIP1559 | undefined;
    if (await exists(gasPath)) {
      const prior = await loadPrivate(gasPath);
      assert.ok(
        record(prior) &&
          serialized(prior.serializedTransaction) &&
          hash(prior.hash),
      );
      assert.ok(typeof prior.nonce === "number");
      gasBytes = prior.serializedTransaction;
      const parsed = parseTransaction(gasBytes);
      assert.equal(parsed.chainId, 84532);
      assert.equal(getAddress(parsed.to!), accounts.custody.address);
      assert.equal(parsed.value, gasAmount);
      assert.ok(!parsed.data || parsed.data === "0x");
      assert.equal(parsed.nonce, prior.nonce);
      assert.equal(keccak256(gasBytes), prior.hash);
      assert.equal(
        await recoverTransactionAddress({ serializedTransaction: gasBytes }),
        accounts.funder.address,
      );
      gasSupply = {
        hash: prior.hash,
        nonce: prior.nonce,
        amount: String(gasAmount),
        destination: accounts.custody.address,
      };
    } else if (
      before.custody?.gas === 0n &&
      (before.funder?.gas ?? 0n) > gasAmount
    ) {
      assert.equal(await reader.getChainId(), 84532);
      const [latest, pending] = await Promise.all([
        reader.getTransactionCount({
          address: accounts.funder.address,
          blockTag: "latest",
        }),
        reader.getTransactionCount({
          address: accounts.funder.address,
          blockTag: "pending",
        }),
      ]);
      assert.equal(
        latest,
        pending,
        "reconcile outstanding sender nonce before gas setup",
      );
      const reservation = resolve(directory, "gas-supply-reservation.json");
      if (!(await exists(reservation)))
        await persistPrivate(reservation, {
          sender: accounts.funder.address,
          nonce: latest,
          environment: "sandbox",
          network: baseSepoliaAsset.network,
        });
      const reserved = await loadPrivate(reservation);
      assert.ok(record(reserved));
      assert.equal(reserved.nonce, latest);
      assert.equal(reserved.sender, accounts.funder.address);
      const wallet = createWalletClient({
        account: accounts.funder,
        chain: baseSepolia,
        transport: testTransport(),
      });
      const request = await wallet.prepareTransactionRequest({
        to: accounts.custody.address,
        value: gasAmount,
        nonce: latest,
        type: "eip1559",
      });
      assert.ok(
        (before.funder?.gas ?? 0n) >
          gasAmount + request.gas * request.maxFeePerGas + 10_000_000_000_000n,
      );
      const signed = await wallet.signTransaction(request);
      assert.ok(serialized(signed));
      gasBytes = signed;
      gasSupply = {
        hash: keccak256(signed),
        nonce: latest,
        amount: String(gasAmount),
        destination: accounts.custody.address,
      };
      await persistPrivate(gasPath, {
        ...gasSupply,
        serializedTransaction: signed,
      });
    }
    if (gasBytes && gasSupply) {
      assert.equal(await reader.getChainId(), 84532);
      const latest = await reader.getTransactionCount({
        address: accounts.funder.address,
        blockTag: "latest",
      });
      if (latest === gasSupply.nonce) {
        try {
          const wallet = createWalletClient({
            chain: baseSepolia,
            transport: testTransport(),
          });
          assert.equal(
            await wallet.sendRawTransaction({
              serializedTransaction: gasBytes,
            }),
            gasSupply.hash,
          );
        } catch {
          // Retain the same bytes/hash on a timeout; never generate another gas
          // payment. The subsequent public balances/receipt reconcile it.
        }
      }
    }
    for (const [operation, sender, destination, amount] of [
      ["funding", accounts.funder, accounts.custody.address, 5_000_000n],
      ["payout", accounts.custody, accounts.recipient.address, 1_000_000n],
    ] as const) {
      phase = `${operation} preparation and reconciliation`;
      const path = resolve(directory, `${operation}-signed.json`);
      let prepared: PreparedTestTransfer;
      if (await exists(path)) {
        prepared = parsePrepared(await loadPrivate(path));
        assert.equal(prepared.operationId, operation);
        assert.equal(prepared.from, sender.address);
        assert.equal(prepared.to, destination);
        assert.equal(prepared.amount, amount);
      } else {
        const balance = await adapter.balances(sender.address);
        if (balance.usdc < amount || balance.gas === 0n) {
          blocked = `fund disposable ${operation} sender with test USDC/test ETH only`;
          break;
        }
        const nonce = await reader.getTransactionCount({
          address: sender.address,
          blockTag: "latest",
        });
        // Exclusive operator lock plus this durable per-sender reservation is
        // adequate only for these three disposable keys. Application workers
        // require the lead-owned unique PostgreSQL nonce/operation mapping.
        const reservationPath = resolve(
          directory,
          `${operation}-reservation.json`,
        );
        if (await exists(reservationPath)) {
          const prior = await loadPrivate(reservationPath);
          assert.ok(record(prior));
          assert.equal(prior.operationId, operation);
          assert.equal(prior.sender, sender.address);
          assert.equal(prior.nonce, nonce);
        } else {
          await persistPrivate(reservationPath, {
            environment: "sandbox",
            network: baseSepoliaAsset.network,
            sender: sender.address,
            operationId: operation,
            nonce,
          });
        }
        prepared = await adapter.prepareTransfer(
          {
            environment: "sandbox",
            chainId: 84532,
            token: baseSepoliaAsset.token,
            from: sender.address,
            to: destination,
            amount,
          },
          sender,
          { nonce, operationId: operation },
        );
        await persistPrivate(path, prepared);
      }
      await adapter.broadcastPrepared(prepared);
      const observation = await adapter.inspectTransfer(
        prepared,
        prepared.hash,
        prepared.nonce,
      );
      operations.push({
        operation,
        from: prepared.from,
        to: prepared.to,
        amount: String(prepared.amount),
        nonce: prepared.nonce,
        hash: prepared.hash,
        observation,
      });
      if (observation.status !== "completed") {
        blocked =
          observation.status === "failed"
            ? `${operation} finalized with a reverted receipt; review before another operation`
            : `${operation} awaits reconciliation; rerun --execute to inspect the SAME signed identity`;
        break;
      }
    }
  }
  const after: Record<string, Sample> = {};
  phase = "read final external balances";
  for (const [name, account] of Object.entries(accounts))
    after[name] = await adapter.balances(account.address);
  if (gasSupply) {
    phase = "reconcile gas receipt";
    gasObservation = {
      status: "uncertain",
      blockNumber: null,
      blockHash: null,
      finalizedBlockNumber: null,
    };
    try {
      assert.equal(await reader.getChainId(), 84532);
      const receipt = await reader.getTransactionReceipt({
        hash: gasSupply.hash,
      });
      const [canonical, finalized, transaction] = await Promise.all([
        reader.getBlock({ blockNumber: receipt.blockNumber }),
        reader.getBlock({ blockTag: "finalized" }),
        reader.getTransaction({ hash: gasSupply.hash }),
      ]);
      assert.equal(receipt.status, "success");
      assert.equal(receipt.transactionHash, gasSupply.hash);
      assert.equal(transaction.hash, gasSupply.hash);
      assert.equal(canonical.hash, receipt.blockHash);
      assert.ok("chainId" in transaction && transaction.chainId === 84532);
      assert.equal(getAddress(transaction.from), accounts.funder.address);
      assert.equal(getAddress(transaction.to!), accounts.custody.address);
      assert.equal(transaction.value, 200_000_000_000_000n);
      assert.equal(transaction.input, "0x");
      assert.equal(transaction.nonce, gasSupply.nonce);
      gasObservation = {
        status:
          finalized.number !== null && finalized.number >= receipt.blockNumber
            ? "completed"
            : "pending",
        blockNumber: String(receipt.blockNumber),
        blockHash: receipt.blockHash,
        finalizedBlockNumber: String(finalized.number),
      };
    } catch {
      // A missing/failed lookup retains the original gas identity for review.
    }
  }
  const completed =
    operations.length === 2 &&
    operations.every(
      (operation) => operation.observation.status === "completed",
    );
  const externalBalancesReconciled =
    after.funder?.usdc === 15_000_000n &&
    after.custody?.usdc === 4_000_000n &&
    after.recipient?.usdc === 1_000_000n;
  if (completed) {
    assert.equal(after.funder?.usdc, 15_000_000n);
    assert.equal(after.custody?.usdc, 4_000_000n);
    assert.equal(after.recipient?.usdc, 1_000_000n);
  }
  const evidence = {
    at: new Date().toISOString(),
    revision: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    sourceSha256: createHash("sha256")
      .update(await readFile("src/features/account-wallet/base-sepolia.ts"))
      .digest("hex"),
    verifierSourceSha256: createHash("sha256")
      .update(await readFile("scripts/verify-coin-testnet.ts"))
      .digest("hex"),
    scope:
      "Actual Base Sepolia chain RPC; valueless Circle test USDC; no live funds, custody-provider acceptance, conversion route or application-ledger acceptance claimed.",
    asset: baseSepoliaAsset,
    mode,
    completed,
    externalBalancesReconciled,
    blocked,
    addresses,
    gasSupply,
    gasObservation,
    before,
    after,
    operations,
    outstanding: completed
      ? []
      : [
          ...(["funding", "payout"] as const)
            .filter(
              (name) =>
                operations.find((entry) => entry.operation === name)
                  ?.observation.status !== "completed",
            )
            .map((name) => `${name}: finalized exact-transfer receipt`),
          ...(externalBalancesReconciled
            ? []
            : ["external test-USDC balance reconciliation"]),
        ],
  };
  const artifactName = mode === "--execute" ? "acceptance.json" : "setup.json";
  await writeFile(
    resolve(artifactDirectory, artifactName),
    JSON.stringify(
      evidence,
      (_key, value: unknown) =>
        typeof value === "bigint" ? String(value) : value,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({
      completed,
      blocked,
      addresses,
      balances: Object.fromEntries(
        Object.entries(after).map(([name, sample]) => [
          name,
          {
            testUsdcAtomic: String(sample.usdc),
            testEthWei: String(sample.gas),
          },
        ]),
      ),
      operations: operations.map(({ operation, hash, observation }) => ({
        operation,
        hash,
        status: observation.status,
      })),
      evidence: `docs/evidence/coin-testnet/${artifactName}`,
    }),
  );
  if (mode === "--execute" && !completed) process.exitCode = 2;
} catch (error) {
  const category =
    error instanceof Error && /^[a-zA-Z]{1,80}$/.test(error.name)
      ? error.name
      : "unclassified";
  const causes: { category: string; httpStatus?: number }[] = [];
  let cause: unknown = error;
  for (let depth = 0; depth < 5 && record(cause); depth++) {
    causes.push({
      category:
        typeof cause.name === "string" && /^[a-zA-Z]{1,80}$/.test(cause.name)
          ? cause.name
          : "unclassified",
      ...(typeof cause.status === "number" &&
      Number.isInteger(cause.status) &&
      cause.status >= 100 &&
      cause.status <= 599
        ? { httpStatus: cause.status }
        : {}),
    });
    cause = cause.cause;
  }
  console.error(
    JSON.stringify({
      result: "FAIL",
      phase,
      category,
      causes,
      action:
        "preserve private operation files for reconciliation; signing inputs and RPC error details omitted",
    }),
  );
  process.exitCode = 1;
} finally {
  await lock.close();
  await unlink(lockPath);
}
