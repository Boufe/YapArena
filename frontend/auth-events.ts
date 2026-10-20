export type AuthMode = "login" | "signup";
export type AuthRequest = { returnTo?: string; mode?: AuthMode };
declare global {
  interface WindowEventMap {
    "yap:request-auth": CustomEvent<AuthRequest>;
    "yap:auth-mode": CustomEvent<AuthMode | null>;
    "yap:auth-dismissed": Event;
    "yap:auth-complete": Event;
  }
}
