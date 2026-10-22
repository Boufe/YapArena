import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  baseSepoliaAsset,
  createBaseSepoliaAdapter,
  createBaseSepoliaReceipt,
} from "../dist/features/account-wallet/base-sepolia.js";

// Public, synthetic signing fixture. It never holds funds or contacts a chain.
const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const destination = `0x${"22".repeat(20)}`;
const txHash = `0x${"33".repeat(32)}`;
const blockHash = `0x${"44".repeat(32)}`;
const terms = {
  environment: "sandbox",
  chainId: 84532,
  token: baseSepoliaAsset.token,
  from: account.address,
  to: destination,
  amount: 5_000_000n,
};
describe("Base Sepolia canonical ledger receipts", () => {
  const observation = {
    status: "completed",
    finalNoTransfer: false,
    transactionId: txHash,
    blockNumber: "100",
    blockHash,
    finalizedBlockNumber: "101",
    eventLogIndex: 7,
    reason: "verified finalized transfer",
  };
  it("shares the ledger namespace and stable digest across finality progress", () => {
    const first = createBaseSepoliaReceipt(
      { ...terms, hash: txHash },
      observation,
    );
    const later = createBaseSepoliaReceipt(
      { ...terms, hash: txHash },
      { ...observation, finalizedBlockNumber: "200", reason: "later check" },
    );
    assert.deepEqual(first, later);
    assert.deepEqual(
      first,
      createBaseSepoliaReceipt(
        { ...terms, from: terms.from.toLowerCase(), hash: txHash },
        observation,
      ),
    );
    assert.equal(first.network, "base-sepolia:84532");
    assert.equal(first.locator, "log:7");
    assert.equal(first.amount, "5000000");
    assert.match(first.evidenceDigest, /^[a-f0-9]{64}$/);
    assert.notEqual(
      createBaseSepoliaReceipt(
        { ...terms, hash: txHash },
        { ...observation, eventLogIndex: 8 },
      ).evidenceDigest,
      first.evidenceDigest,
    );
  });
  it("rejects incomplete, mismatched or malformed finalized observations", () => {
    for (const patch of [
      { status: "pending" },
      { finalNoTransfer: true },
      { transactionId: blockHash },
      { blockHash: null },
      { blockHash: "invalid" },
      { blockNumber: null },
      { blockNumber: "-1" },
      { finalizedBlockNumber: null },
      { finalizedBlockNumber: "invalid" },
      { finalizedBlockNumber: "99" },
      { eventLogIndex: null },
      { eventLogIndex: -1 },
      { eventLogIndex: Number.MAX_SAFE_INTEGER + 1 },
    ])
      assert.throws(() =>
        createBaseSepoliaReceipt(
          { ...terms, hash: txHash },
          { ...observation, ...patch },
        ),
      );
  });
});
function fixture() {
  const log = {
    address: baseSepoliaAsset.token,
    topics: encodeEventTopics({
      abi: erc20Abi,
      eventName: "Transfer",
      args: { from: account.address, to: destination },
    }),
    data: encodeAbiParameters([{ type: "uint256" }], [terms.amount]),
    transactionHash: txHash,
    blockHash,
    blockNumber: 100n,
    logIndex: 7,
    removed: false,
  };
  const state = {
    chain: 84532,
    latestNonce: 0,
    pendingNonce: 0,
    decimals: 6,
    receiptError: null,
    transactionError: null,
    rpcError: null,
    sendError: false,
    conflictingHash: false,
    sends: 0,
    receipt: {
      status: "success",
      transactionHash: txHash,
      blockHash,
      blockNumber: 100n,
      logs: [log],
    },
    transaction: {
      hash: txHash,
      chainId: 84532,
      from: account.address,
      to: baseSepoliaAsset.token,
      input: encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [destination, terms.amount],
      }),
      value: 0n,
      nonce: 0,
    },
    canonical: { hash: blockHash, number: 100n },
    finalized: { hash: blockHash, number: 100n },
  };
  const reader = {
    async getChainId() {
      if (state.rpcError) throw state.rpcError;
      return state.chain;
    },
    async getTransactionReceipt() {
      if (state.receiptError) throw state.receiptError;
      return state.receipt;
    },
    async getTransaction() {
      if (state.transactionError) throw state.transactionError;
      return state.transaction;
    },
    async getBlock(input) {
      return input.blockTag ? state.finalized : state.canonical;
    },
    async getTransactionCount(input) {
      return input.blockTag === "pending"
        ? state.pendingNonce
        : state.latestNonce;
    },
    async readContract(input) {
      return input.functionName === "decimals" ? state.decimals : 10_000_000n;
    },
    async getBalance() {
      return 1_000_000_000_000_000n;
    },
  };
  const transport = custom(
    {
      async request({ method, params }) {
        if (method === "eth_chainId") return "0x14a34";
        if (method === "eth_estimateGas") return "0x10000";
        if (method === "eth_maxPriorityFeePerGas") return "0x1";
        if (method === "eth_gasPrice") return "0x2";
        if (method === "eth_getBlockByNumber")
          return {
            number: "0x64",
            hash: blockHash,
            baseFeePerGas: "0x1",
            gasLimit: "0x1000000",
            gasUsed: "0x1",
            timestamp: "0x1",
            transactions: [],
          };
        if (method === "eth_sendRawTransaction") {
          state.sends++;
          if (state.sendError) throw new Error("synthetic submission timeout");
          return state.conflictingHash ? txHash : keccak256(params[0]);
        }
        throw new Error(`unexpected test RPC method ${method}`);
      },
    },
    { retryCount: 0 },
  );
  const adapter = createBaseSepoliaAdapter({
    ...baseSepoliaAsset,
    reader,
    transport,
  });
  return { state, adapter, reader, transport };
}
const reservation = { nonce: 0, operationId: "withdrawal-1" };

describe("Base Sepolia test-only USDC adapter", () => {
  it("pins environment, network and Circle token before any network call", () => {
    for (const change of [
      { environment: "live" },
      { chainId: 8453 },
      { token: destination },
    ])
      assert.throws(() =>
        createBaseSepoliaAdapter({ ...baseSepoliaAsset, ...change }),
      );
  });
  it("reads external balances only after checking the chain", async () => {
    const { adapter, state } = fixture();
    assert.deepEqual(await adapter.balances(account.address), {
      usdc: 10_000_000n,
      gas: 1_000_000_000_000_000n,
    });
    state.chain = 8453;
    await assert.rejects(adapter.balances(account.address), /not Base Sepolia/);
  });
  it("rejects invalid transfer terms and identifiers", async () => {
    const { adapter } = fixture();
    for (const change of [
      { environment: "live" },
      { chainId: 1 },
      { token: destination },
      { amount: 0n },
      { amount: -1n },
      { amount: 2n ** 256n },
      { to: account.address },
      { from: `0x${"00".repeat(20)}` },
      { to: `0x${"00".repeat(20)}` },
    ])
      await assert.rejects(
        adapter.inspectTransfer({ ...terms, ...change }, txHash),
      );
    await assert.rejects(adapter.inspectTransfer(terms, "bad-hash"));
  });
  it("requires the owning signer and an explicit uniquely reserved nonce", async () => {
    const { adapter } = fixture();
    await assert.rejects(
      adapter.prepareTransfer(
        terms,
        privateKeyToAccount(`0x${"12".repeat(32)}`),
        reservation,
      ),
    );
    for (const change of [
      { nonce: -1 },
      { nonce: 1.1 },
      { operationId: "" },
      { operationId: "bad operation" },
    ])
      await assert.rejects(
        adapter.prepareTransfer(terms, account, { ...reservation, ...change }),
      );
  });
  it("refuses precision mismatch, outstanding transactions and a stale reservation", async () => {
    for (const change of [
      { decimals: 18 },
      { pendingNonce: 1 },
      { latestNonce: 1, pendingNonce: 1 },
    ]) {
      const { adapter, state } = fixture();
      Object.assign(state, change);
      await assert.rejects(
        adapter.prepareTransfer(terms, account, reservation),
        /precision or outstanding/,
      );
    }
  });
  it("prepares signed identity without sending and validates it before broadcast", async () => {
    const { adapter, state } = fixture();
    const prepared = await adapter.prepareTransfer(terms, account, reservation);
    assert.equal(state.sends, 0);
    assert.equal(prepared.hash, keccak256(prepared.serializedTransaction));
    assert.equal(prepared.nonce, 0);
    for (const change of [
      { amount: 1n },
      { hash: txHash },
      { nonce: 1 },
      { operationId: "" },
      { from: destination },
    ])
      await assert.rejects(
        adapter.broadcastPrepared({ ...prepared, ...change }),
      );
    assert.equal(state.sends, 0);
  });
  it("completes only an exact canonical finalized successful transfer", async () => {
    const { adapter } = fixture();
    const result = await adapter.inspectTransfer(terms, txHash, 0);
    assert.equal(result.status, "completed");
    assert.equal(result.finalNoTransfer, false);
    assert.equal(result.blockNumber, "100");
    assert.equal(result.finalizedBlockNumber, "100");
    assert.equal(result.eventLogIndex, 7);
  });
  it("keeps canonical but unfinalized receipts pending", async () => {
    for (const number of [99n, null]) {
      const { adapter, state } = fixture();
      state.finalized.number = number;
      assert.equal(
        (await adapter.inspectTransfer(terms, txHash)).status,
        "pending",
      );
    }
  });
  it("does not accept receipt, transaction, nonce or canonicality conflicts", async () => {
    for (const change of [
      { transaction: { chainId: 8453 } },
      { transaction: { hash: blockHash } },
      { transaction: { from: destination } },
      { transaction: { to: destination } },
      { transaction: { to: null } },
      { transaction: { input: "0x" } },
      { transaction: { value: 1n } },
      { transaction: { nonce: 1 } },
      { receipt: { transactionHash: blockHash } },
      { canonical: { hash: txHash } },
    ]) {
      const { adapter, state } = fixture();
      for (const [part, value] of Object.entries(change))
        Object.assign(state[part], value);
      const result = await adapter.inspectTransfer(terms, txHash, 0);
      assert.equal(result.status, "uncertain");
      assert.equal(result.finalNoTransfer, false);
    }
    const { adapter, state } = fixture();
    delete state.transaction.chainId;
    assert.equal(
      (await adapter.inspectTransfer(terms, txHash)).status,
      "uncertain",
    );
  });
  it("never accepts missing, duplicate, wrong-asset or removed transfer logs", async () => {
    for (const change of [
      { address: destination },
      { topics: [] },
      { data: "0x" },
      { data: encodeAbiParameters([{ type: "uint256" }], [1n]) },
      {
        topics: encodeEventTopics({
          abi: erc20Abi,
          eventName: "Transfer",
          args: { from: destination, to: account.address },
        }),
      },
      { transactionHash: blockHash },
      { blockHash: txHash },
      { blockNumber: 99n },
      { logIndex: null },
      { logIndex: -1 },
      { logIndex: 0.5 },
      { removed: true },
    ]) {
      const { adapter, state } = fixture();
      Object.assign(state.receipt.logs[0], change);
      assert.equal(
        (await adapter.inspectTransfer(terms, txHash)).status,
        "uncertain",
      );
    }
    for (const count of [0, 2]) {
      const { adapter, state } = fixture();
      state.receipt.logs = Array(count).fill(state.receipt.logs[0]);
      assert.equal(
        (await adapter.inspectTransfer(terms, txHash)).status,
        "uncertain",
      );
    }
    const { adapter, state } = fixture();
    state.receipt.logs.push({
      ...state.receipt.logs[0],
      data: encodeAbiParameters([{ type: "uint256" }], [1n]),
    });
    assert.equal(
      (await adapter.inspectTransfer(terms, txHash)).status,
      "uncertain",
    );
  });
  it("rejects a signed mainnet/native-value/wrong-token transaction despite matching metadata", async () => {
    const { adapter, state } = fixture();
    const prepared = await adapter.prepareTransfer(terms, account, reservation);
    for (const change of [
      { chainId: 8453 },
      { value: 1n },
      { to: destination },
      { data: "0x" },
    ]) {
      const serializedTransaction = await account.signTransaction({
        chainId: 84532,
        type: "eip1559",
        to: terms.token,
        data: state.transaction.input,
        value: 0n,
        nonce: 0,
        gas: 65536n,
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n,
        ...change,
      });
      await assert.rejects(
        adapter.broadcastPrepared({
          ...prepared,
          hash: keccak256(serializedTransaction),
          serializedTransaction,
        }),
      );
    }
    assert.equal(state.sends, 0);
  });
  it("proves no USDC transfer only for the original finalized reverted transaction", async () => {
    const { adapter, state } = fixture();
    state.receipt.status = "reverted";
    let result = await adapter.inspectTransfer(terms, txHash);
    assert.equal(result.status, "failed");
    assert.equal(result.finalNoTransfer, true);
    state.finalized.number = 99n;
    result = await adapter.inspectTransfer(terms, txHash);
    assert.equal(result.status, "pending");
    assert.equal(result.finalNoTransfer, false);
  });
  it("treats missing transactions, outages and wrong networks as uncertain without leaking errors", async () => {
    for (const error of [
      new TransactionReceiptNotFoundError({ hash: txHash }),
      new TransactionNotFoundError({ hash: txHash }),
      new Error("sensitive RPC failure"),
    ]) {
      const { adapter, state } = fixture();
      state.receiptError = error;
      const result = await adapter.inspectTransfer(terms, txHash);
      assert.equal(result.status, "uncertain");
      assert.equal(result.finalNoTransfer, false);
      assert.equal(JSON.stringify(result).includes("sensitive"), false);
    }
    const { adapter, state } = fixture();
    state.chain = 1;
    assert.equal(
      (await adapter.inspectTransfer(terms, txHash)).status,
      "uncertain",
    );
  });
  it("broadcasts the exact persisted identity and never creates another after a timeout", async () => {
    const { adapter, state } = fixture();
    const prepared = await adapter.prepareTransfer(terms, account, reservation);
    state.receiptError = new TransactionReceiptNotFoundError({
      hash: prepared.hash,
    });
    assert.equal((await adapter.broadcastPrepared(prepared)).status, "pending");
    assert.equal(state.sends, 1);
    state.sendError = true;
    assert.equal(
      (await adapter.broadcastPrepared(prepared)).status,
      "uncertain",
    );
    assert.equal(state.sends, 2);
    assert.equal(prepared.hash, keccak256(prepared.serializedTransaction));
    state.latestNonce = 1;
    state.pendingNonce = 1;
    assert.equal(
      (await adapter.broadcastPrepared(prepared)).status,
      "uncertain",
    );
    assert.equal(state.sends, 2);
  });
  it("rejects conflicting submission hashes and skips retransmission after chain inclusion", async () => {
    const { adapter, state } = fixture();
    const prepared = await adapter.prepareTransfer(terms, account, reservation);
    state.receiptError = new TransactionReceiptNotFoundError({
      hash: prepared.hash,
    });
    state.conflictingHash = true;
    assert.equal(
      (await adapter.broadcastPrepared(prepared)).status,
      "uncertain",
    );
    state.receiptError = null;
    state.receipt.transactionHash = prepared.hash;
    state.transaction.hash = prepared.hash;
    state.receipt.logs[0].transactionHash = prepared.hash;
    state.finalized.number = 99n;
    assert.equal((await adapter.broadcastPrepared(prepared)).status, "pending");
    state.finalized.number = 100n;
    assert.equal(
      (await adapter.broadcastPrepared(prepared)).status,
      "completed",
    );
    assert.equal(state.sends, 1);
  });
});
