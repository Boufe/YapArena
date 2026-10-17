export interface Profile {
  handle: string;
  displayName: string;
  bio: string | null;
  publicationState: "draft" | "published" | "hidden";
}
export interface LinkedWallet {
  id: string;
  address: string;
  chainId: string;
}
export interface WalletChangeTarget {
  purpose: "link" | "unlink";
  address: string;
  chainId: number;
  targetWalletId?: string;
}
export interface WalletOperation {
  id: string;
  authorizationMessage: string | null;
  authorizingAddress: string | null;
  authorizingChainId: string | null;
  proposedMessage: string | null;
  expiresAt: string;
}
export interface PendingWalletChange {
  target: WalletChangeTarget;
  operation?: WalletOperation;
  password?: string;
  authorizationSignature?: string;
}
export interface WalletChallenge {
  id: string;
  message: string;
}
export interface AccountUser {
  id: string;
  email: string | null;
}
export interface FollowEntry {
  targetType: string;
  title: string;
  slug: string;
}
export interface ActivityEntry {
  eventType: string;
  occurredAt: string;
}
export interface CollectionPage<T> {
  items: T[];
  pagination: { hasMore: boolean };
}
export interface AccountError extends Error {
  status?: number;
}
export interface EthereumProvider {
  request(request: { method: "eth_requestAccounts" }): Promise<string[]>;
  request(request: { method: "eth_chainId" }): Promise<string>;
  request(request: {
    method: "personal_sign";
    params: [string, string];
  }): Promise<string>;
}
declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}
