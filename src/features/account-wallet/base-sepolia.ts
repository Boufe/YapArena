import { createHash } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  isAddressEqual,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Hash,
  type PublicClient,
  type Transport,
  type TransactionSerializedEIP1559,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

// These are deliberately not runtime configuration. This adapter cannot select
// a live network, a different token, or a redeemable asset.
export const baseSepoliaAsset = Object.freeze({
  environment: "sandbox" as const,
  network: "eip155:84532" as const,
  chainId: 84532 as const,
  token: getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
  precision: 6 as const,
  id: "circle-test-usdc:base-sepolia" as const,
});

export type BaseSepoliaTransfer = {
  environment: "sandbox";
  chainId: 84532;
  token: Address;
  from: Address;
  to: Address;
  amount: bigint;
};
export type PreparedTestTransfer = BaseSepoliaTransfer & {
  operationId: string;
  nonce: number;
  hash: Hash;
  // Bearer material for this valueless transfer. Persist privately before
  // broadcasting; never put raw transactions or keys in public evidence/logs.
  serializedTransaction: TransactionSerializedEIP1559;
};
export type TestTransferObservation = {
  status: "pending" | "completed" | "failed" | "uncertain";
  finalNoTransfer: boolean;
  transactionId: Hash;
  blockNumber: string | null;
  blockHash: Hash | null;
  finalizedBlockNumber: string | null;
  eventLogIndex: number | null;
  reason: string;
};
export const baseSepoliaReceiptNetwork = "base-sepolia:84532" as const;

// One stable receipt encoding for owner commands and actual-chain acceptance.
// The moving finalized height proves coverage but is deliberately not hashed.
// Its namespace is the ledger rail identifier; asset.network remains EIP-155.
export function createBaseSepoliaReceipt(
  transfer: BaseSepoliaTransfer & { hash: Hash },
  observation: TestTransferObservation,
) {
  validateTerms(transfer);
  validHash(transfer.hash);
  if (
    observation.status !== "completed" ||
    observation.finalNoTransfer ||
    observation.transactionId.toLowerCase() !== transfer.hash.toLowerCase() ||
    !observation.blockHash ||
    !observation.blockNumber ||
    !/^[1-9][0-9]*$/.test(observation.blockNumber) ||
    !observation.finalizedBlockNumber ||
    !/^[1-9][0-9]*$/.test(observation.finalizedBlockNumber) ||
    BigInt(observation.finalizedBlockNumber) <
      BigInt(observation.blockNumber) ||
    observation.eventLogIndex === null ||
    !Number.isSafeInteger(observation.eventLogIndex) ||
    observation.eventLogIndex < 0
  )
    throw new Error("a matching finalized test transfer is required");
  validHash(observation.blockHash);
  const transactionId = transfer.hash.toLowerCase();
  const blockHash = observation.blockHash.toLowerCase();
  const from = getAddress(transfer.from);
  const to = getAddress(transfer.to);
  return {
    network: baseSepoliaReceiptNetwork,
    transactionId,
    locator: `log:${observation.eventLogIndex}`,
    amount: String(transfer.amount),
    evidenceDigest: createHash("sha256")
      .update(
        JSON.stringify([
          baseSepoliaReceiptNetwork,
          transactionId,
          observation.blockNumber,
          blockHash,
          observation.eventLogIndex,
          from,
          to,
          String(transfer.amount),
        ]),
      )
      .digest("hex"),
  };
}
type Reader = Pick<
  PublicClient<Transport, typeof baseSepolia>,
  | "getChainId"
  | "getTransactionReceipt"
  | "getTransaction"
  | "getBlock"
  | "getTransactionCount"
  | "readContract"
  | "getBalance"
>;
function createReader(
  transport: Transport,
): PublicClient<Transport, typeof baseSepolia> {
  return createPublicClient({
    chain: baseSepolia,
    transport,
  });
}

function validateTerms(terms: BaseSepoliaTransfer) {
  if (
    terms.environment !== "sandbox" ||
    terms.chainId !== baseSepoliaAsset.chainId ||
    !isAddressEqual(getAddress(terms.token), baseSepoliaAsset.token) ||
    typeof terms.amount !== "bigint" ||
    terms.amount <= 0n ||
    terms.amount >= 2n ** 256n ||
    isAddressEqual(getAddress(terms.to), getAddress(terms.from)) ||
    /^0x0{40}$/i.test(terms.to) ||
    /^0x0{40}$/i.test(terms.from)
  )
    throw new Error("invalid Base Sepolia sandbox transfer terms");
}
function transferData(terms: BaseSepoliaTransfer) {
  validateTerms(terms);
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [terms.to, terms.amount],
  });
}
function validHash(hash: Hash) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash))
    throw new Error("invalid transaction hash");
}
function isEip1559(value: string): value is TransactionSerializedEIP1559 {
  return /^0x02(?:[0-9a-fA-F]{2})+$/.test(value);
}

// Pure verification: safe for the owner repository before acquiring DB locks.
// It neither reads an RPC nor signs/broadcasts a transaction.
export async function validatePreparedTestTransfer(
  prepared: PreparedTestTransfer,
): Promise<void> {
  const data = transferData(prepared);
  validHash(prepared.hash);
  if (
    !/^[a-zA-Z0-9_-]{1,100}$/.test(prepared.operationId) ||
    !Number.isSafeInteger(prepared.nonce) ||
    prepared.nonce < 0 ||
    !isEip1559(prepared.serializedTransaction)
  )
    throw new Error("invalid persisted test operation identifier or nonce");
  const transaction = parseTransaction(prepared.serializedTransaction);
  if (
    transaction.chainId !== baseSepoliaAsset.chainId ||
    !transaction.to ||
    !isAddressEqual(transaction.to, baseSepoliaAsset.token) ||
    transaction.data !== data ||
    (transaction.value ?? 0n) !== 0n ||
    transaction.nonce !== prepared.nonce ||
    keccak256(prepared.serializedTransaction) !== prepared.hash ||
    !isAddressEqual(
      await recoverTransactionAddress({
        serializedTransaction: prepared.serializedTransaction,
      }),
      prepared.from,
    )
  )
    throw new Error("signed test transfer does not match the persisted terms");
}

export function createBaseSepoliaAdapter(input: {
  environment: "sandbox";
  chainId: 84532;
  token: Address;
  // Injection supports RPC contract tests and approved testnet-verifier pacing.
  // Configuration has no live-chain path; every operation checks the chain.
  reader?: Reader;
  transport?: Transport;
}) {
  if (
    input.environment !== "sandbox" ||
    input.chainId !== baseSepoliaAsset.chainId ||
    !isAddressEqual(getAddress(input.token), baseSepoliaAsset.token)
  )
    throw new Error("only Circle test USDC on Base Sepolia is supported");
  const transport =
    input.transport ??
    http("https://sepolia.base.org", {
      timeout: 10_000,
      retryCount: 0,
    });
  const reader: Reader = input.reader ?? createReader(transport);
  async function assertChain() {
    if ((await reader.getChainId()) !== baseSepoliaAsset.chainId)
      throw new Error("RPC is not Base Sepolia");
  }
  async function balances(address: Address) {
    getAddress(address);
    await assertChain();
    const [usdc, gas] = await Promise.all([
      reader.readContract({
        address: baseSepoliaAsset.token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      }),
      reader.getBalance({ address }),
    ]);
    return { usdc, gas };
  }
  async function prepareTransfer(
    terms: BaseSepoliaTransfer,
    account: PrivateKeyAccount,
    reservation: { nonce: number; operationId: string },
  ): Promise<PreparedTestTransfer> {
    const data = transferData(terms);
    if (
      !isAddressEqual(account.address, terms.from) ||
      !Number.isSafeInteger(reservation.nonce) ||
      reservation.nonce < 0 ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(reservation.operationId)
    )
      throw new Error("test signer or caller-reserved nonce is invalid");
    await assertChain();
    const [latestNonce, pendingNonce, decimals] = await Promise.all([
      reader.getTransactionCount({ address: terms.from, blockTag: "latest" }),
      reader.getTransactionCount({ address: terms.from, blockTag: "pending" }),
      reader.readContract({
        address: baseSepoliaAsset.token,
        abi: erc20Abi,
        functionName: "decimals",
      }),
    ]);
    if (
      decimals !== 6 ||
      latestNonce !== pendingNonce ||
      latestNonce !== reservation.nonce
    )
      throw new Error(
        "token precision or outstanding test nonce requires review",
      );
    const wallet = createWalletClient({
      account,
      chain: baseSepolia,
      transport,
    });
    const request = await wallet.prepareTransactionRequest({
      to: baseSepoliaAsset.token,
      data,
      value: 0n,
      nonce: reservation.nonce,
      type: "eip1559",
    });
    // The caller supplies a candidate nonce; this function does not allocate it.
    // BEFORE broadcasting, persist the signed identity under a unique DB
    // environment/network/sender/nonce + request reservation. An insertion loser
    // must discard its candidate bytes and never broadcast them. On a retry,
    // load the original DB identity before preparing any new candidate.
    const serializedTransaction = await wallet.signTransaction(request);
    if (!isEip1559(serializedTransaction))
      throw new Error("test signing did not produce an EIP-1559 transaction");
    return {
      ...terms,
      operationId: reservation.operationId,
      nonce: latestNonce,
      serializedTransaction,
      hash: keccak256(serializedTransaction),
    };
  }
  async function inspectTransfer(
    terms: BaseSepoliaTransfer,
    hash: Hash,
    nonce?: number,
  ): Promise<TestTransferObservation> {
    const data = transferData(terms);
    validHash(hash);
    const observation: TestTransferObservation = {
      status: "uncertain",
      finalNoTransfer: false,
      transactionId: hash,
      blockNumber: null,
      blockHash: null,
      finalizedBlockNumber: null,
      eventLogIndex: null,
      reason: "external evidence unavailable; retain reservation",
    };
    try {
      await assertChain();
      const receipt = await reader.getTransactionReceipt({ hash });
      observation.blockNumber = String(receipt.blockNumber);
      observation.blockHash = receipt.blockHash;
      const [canonical, finalized, transaction] = await Promise.all([
        reader.getBlock({ blockNumber: receipt.blockNumber }),
        reader.getBlock({ blockTag: "finalized" }),
        reader.getTransaction({ hash }),
      ]);
      observation.finalizedBlockNumber = String(finalized.number);
      if (
        canonical.hash !== receipt.blockHash ||
        receipt.transactionHash !== hash ||
        transaction.hash !== hash ||
        !("chainId" in transaction) ||
        transaction.chainId !== baseSepoliaAsset.chainId ||
        !transaction.to ||
        !isAddressEqual(transaction.to, baseSepoliaAsset.token) ||
        !isAddressEqual(transaction.from, terms.from) ||
        transaction.input !== data ||
        transaction.value !== 0n ||
        (nonce !== undefined && transaction.nonce !== nonce)
      )
        return {
          ...observation,
          reason: "receipt or transaction terms conflict",
        };
      if (finalized.number === null || finalized.number < receipt.blockNumber)
        return {
          ...observation,
          status: "pending",
          reason: "canonical receipt is awaiting finalized chain state",
        };
      if (receipt.status === "reverted")
        return {
          ...observation,
          status: "failed",
          finalNoTransfer: true,
          reason: "original transfer reverted in finalized canonical state",
        };
      let tokenTransferCount = 0;
      const transfers = receipt.logs.filter((log) => {
        if (!isAddressEqual(log.address, baseSepoliaAsset.token)) return false;
        try {
          const decoded = decodeEventLog({
            abi: erc20Abi,
            eventName: "Transfer",
            data: log.data,
            topics: log.topics,
          });
          tokenTransferCount++;
          return (
            isAddressEqual(decoded.args.from, terms.from) &&
            isAddressEqual(decoded.args.to, terms.to) &&
            decoded.args.value === terms.amount &&
            log.transactionHash === hash &&
            log.blockHash === receipt.blockHash &&
            log.blockNumber === receipt.blockNumber &&
            Number.isSafeInteger(log.logIndex) &&
            log.logIndex !== null &&
            log.logIndex >= 0 &&
            !log.removed
          );
        } catch {
          return false;
        }
      });
      if (
        receipt.status !== "success" ||
        transfers.length !== 1 ||
        tokenTransferCount !== 1
      )
        return {
          ...observation,
          reason: "exact test-USDC transfer log missing",
        };
      return {
        ...observation,
        status: "completed",
        eventLogIndex: transfers[0]!.logIndex,
        reason:
          "exact test-USDC transfer reconciled in finalized canonical state",
      };
    } catch (error) {
      if (
        error instanceof TransactionNotFoundError ||
        error instanceof TransactionReceiptNotFoundError
      )
        return {
          ...observation,
          reason:
            "original transfer not observed; absence does not prove failure",
        };
      // RPC URLs/errors can contain credentials. Return a bounded vocabulary,
      // never provider error objects or signing inputs.
      return observation;
    }
  }
  async function broadcastPrepared(prepared: PreparedTestTransfer) {
    await validatePreparedTestTransfer(prepared);
    await assertChain();
    const prior = await inspectTransfer(
      prepared,
      prepared.hash,
      prepared.nonce,
    );
    if (prior.status !== "uncertain") return prior;
    const [latestNonce, pendingNonce] = await Promise.all([
      reader.getTransactionCount({
        address: prepared.from,
        blockTag: "latest",
      }),
      reader.getTransactionCount({
        address: prepared.from,
        blockTag: "pending",
      }),
    ]);
    if (latestNonce !== prepared.nonce || pendingNonce !== prepared.nonce)
      return {
        ...prior,
        status: "uncertain" as const,
        reason:
          "sender nonce advanced; reconcile original identity before retry",
      };
    try {
      const wallet = createWalletClient({ chain: baseSepolia, transport });
      const returned = await wallet.sendRawTransaction({
        serializedTransaction: prepared.serializedTransaction,
      });
      if (returned !== prepared.hash)
        return {
          ...prior,
          reason: "RPC returned a conflicting transaction hash",
        };
      return {
        ...prior,
        status: "pending" as const,
        reason:
          "original signed test transfer submitted; awaiting reconciliation",
      };
    } catch {
      return {
        ...prior,
        reason: "submission uncertain; retain original identity",
      };
    }
  }
  return { balances, prepareTransfer, broadcastPrepared, inspectTransfer };
}
