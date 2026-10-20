export type AuthMode = "login" | "signup";
export type AuthRequest = {
  returnTo?: string;
  mode?: AuthMode;
  source?: HTMLElement;
};
export type AuthCompletion = { returnTo: string | null };
export type ProviderChange = {
  action: "link" | "remove" | "update";
  method: "email" | "google_oauth" | "passkey";
  target: string;
};
declare global {
  interface Window {
    yapSessionFetch?: (input: string, init?: RequestInit) => Promise<Response>;
    yapRememberSessionAccount?: (accountId: string | null) => void;
    yapCurrentSessionAccount?: () => string | null;
    yapLinkProviderIdentity?: (token: string) => Promise<void>;
    yapRecoverProviderIdentity?: (token: string) => Promise<void>;
    yapApproveProviderChange?: (change: ProviderChange) => Promise<void>;
  }
  interface WindowEventMap {
    "yap:request-auth": CustomEvent<AuthRequest>;
    "yap:auth-mode": CustomEvent<AuthMode | null>;
    "yap:auth-dismissed": Event;
    "yap:auth-complete": Event | CustomEvent<AuthCompletion>;
    "yap:recover-provider": Event;
    "yap:link-provider": Event;
  }
}
