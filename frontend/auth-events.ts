export type AuthRequest = {
  returnTo?: string;
  source?: HTMLElement;
};
export type AuthCompletion = { returnTo: string | null };
declare global {
  interface Window {
    yapSessionFetch?: (input: string, init?: RequestInit) => Promise<Response>;
    yapRememberSessionAccount?: (accountId: string | null) => void;
    yapCurrentSessionAccount?: () => string | null;
  }
  interface WindowEventMap {
    "yap:request-auth": CustomEvent<AuthRequest>;
    "yap:auth-complete": Event | CustomEvent<AuthCompletion>;
  }
}
