export type GrantProgress = {
  id: string;
  label: string;
  target: string;
  netProfit: string;
  remaining: string;
  qualified: boolean;
  percent: number;
};
export type AccountWalletSummary = {
  available: string;
  reserved: string;
  pending: string;
  promotional: string;
  withdrawable: string;
  grants: GrantProgress[];
};
