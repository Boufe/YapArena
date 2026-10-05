import { randomBytes } from "node:crypto";
import { createPublicClient, getAddress, http, verifyMessage } from "viem";
import { createSiweMessage, parseSiweMessage } from "viem/siwe";

export class WalletVerificationUnavailableError extends Error {}

export function normalizeWalletAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return getAddress(value).toLowerCase();
  } catch {
    return null;
  }
}

export function validChainId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function createChallengeMessage({
  address,
  chainId,
  origin,
  purpose,
  now = new Date(),
  operationId,
  target,
}: {
  address: string;
  chainId: number;
  origin: string;
  purpose: "login" | "link" | "approve-link" | "approve-unlink";
  operationId?: string;
  target?: { address: string; chainId: number };
  now?: Date;
}) {
  const site = new URL(origin);
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1_000);
  const action = purpose === "approve-unlink" ? "unlink" : "link";
  const statement = purpose.startsWith("approve-")
    ? `Authorize ${action} of wallet ${target!.address} on chain ${target!.chainId} for your YAP Arena account. This does not authorize a transaction.`
    : purpose === "link"
      ? "Prove control of this new wallet for linking to your YAP Arena account. This does not authorize a transaction."
      : "Sign in to YAP Arena. This does not authorize a transaction.";
  const message = createSiweMessage({
    address: getAddress(address),
    chainId,
    domain: site.host,
    uri: site.origin,
    version: "1",
    nonce: randomBytes(16).toString("hex"),
    issuedAt: now,
    expirationTime: expiresAt,
    scheme: site.protocol.slice(0, -1),
    statement,
    ...(operationId ? { requestId: operationId } : {}),
  });
  return { message, expiresAt };
}

export async function verifyChallengeSignature({
  challenge,
  signature,
  origin,
  rpcUrls,
}: {
  challenge: {
    address: string;
    chainId: string;
    message: string;
    expiresAt: Date;
  };
  signature: string;
  origin: string;
  rpcUrls: Readonly<Record<string, string>>;
}): Promise<boolean> {
  if (!/^0x[0-9a-fA-F]{2,8192}$/.test(signature)) return false;
  const parsed = parseSiweMessage(challenge.message);
  const site = new URL(origin);
  if (
    parsed.domain !== site.host ||
    parsed.uri !== site.origin ||
    parsed.chainId !== Number(challenge.chainId) ||
    parsed.address?.toLowerCase() !== challenge.address ||
    parsed.version !== "1" ||
    !parsed.nonce ||
    parsed.scheme !== site.protocol.slice(0, -1) ||
    !parsed.issuedAt ||
    parsed.issuedAt.getTime() > Date.now() ||
    parsed.expirationTime?.getTime() !==
      new Date(challenge.expiresAt).getTime() ||
    new Date(challenge.expiresAt).getTime() <= Date.now()
  )
    return false;

  try {
    if (
      await verifyMessage({
        address: getAddress(challenge.address),
        message: challenge.message,
        signature: signature as `0x${string}`,
      })
    )
      return true;
  } catch {
    // A contract signature may not be recoverable as an EOA signature.
  }

  const rpcUrl = rpcUrls[challenge.chainId];
  if (!rpcUrl) return false;
  try {
    const client = createPublicClient({
      transport: http(rpcUrl, { timeout: 3_000 }),
    });
    return await client.verifySiweMessage({
      message: challenge.message,
      signature: signature as `0x${string}`,
      domain: site.host,
      nonce: parsed.nonce,
      time: new Date(),
    });
  } catch {
    throw new WalletVerificationUnavailableError(
      "wallet verification is unavailable",
    );
  }
}
