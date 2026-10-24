export type AuthRequest = {
  returnTo?: string;
  source?: HTMLElement;
};
export type AuthCompletion = { returnTo: string | null };
declare global {
  interface WindowEventMap {
    "yap:request-auth": CustomEvent<AuthRequest>;
    "yap:auth-complete": Event | CustomEvent<AuthCompletion>;
  }
}
