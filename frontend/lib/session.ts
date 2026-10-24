import type { AccountUser } from "../account-types.js";
import { apiError, apiErrorStatus, apiFetch, sameOriginUrl } from "./api.js";

// One session store per page. It reads /api/auth/me once per account
// generation and shares that request between every caller, remembers the
// account the page last verified, owns the page's only
// BroadcastChannel("yaparena-account") and serializes session revocation
// across tabs.
//
// Page scripts are built separately: classic scripts such as account.js are
// bundled with their own copy of this module, while ES modules import
// /assets/lib/session.js. window.yapSession is the one global that lets all of
// them reach the same store; sessionStore() creates it on first use.
// session-coordination.js loads first on every page, so its listeners run
// before any page script's.

export type SessionState =
  | { status: "checking" }
  | { status: "signed-in"; user: AccountUser }
  | { status: "signed-out" }
  | { status: "unavailable"; error: unknown };

export interface SessionStore {
  /** The account this page last verified, or null. */
  account(): string | null;
  /** Records the account this page verified, or null to forget it. */
  remember(accountId: string | null): void;
  /**
   * The signed-in user, or null for 401. Callers share one request per
   * account generation; fresh asks for a new read unless one is in flight.
   * Any other failure, including 403, rejects (ApiError for HTTP failures).
   */
  me(options?: { fresh?: boolean }): Promise<AccountUser | null>;
  state(): SessionState;
  /** Calls the listener after each change of state; returns an unsubscribe. */
  subscribe(listener: (state: SessionState) => void): () => void;
  /**
   * Sends a same-origin account request. Requests that revoke the shared
   * HttpOnly session (sign-out, or removing one session) take an origin-wide
   * lock so two tabs never revoke at once, and carry the account this page
   * last verified. Other requests pass straight through.
   */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Announces sign-out to this page and to other tabs. */
  signedOut(expired: boolean): void;
}

declare global {
  interface Window {
    yapSession?: SessionStore;
  }
  interface WindowEventMap {
    "yap:provider-logout": Event | CustomEvent<boolean>;
    "yap:account-changed": Event;
  }
}

/** The account pages' message for a failure whose body carries no error. */
export const accountErrorMessage = (status: number) =>
  status === 429
    ? "Too many attempts. Wait a moment, then try again."
    : "Request failed. Please try again.";

export function createSessionStore(): SessionStore {
  // Events and the channel belong to the page that created the store.
  const page = window;
  let generation = 0;
  let verifiedAccount: string | null = null;
  let current: SessionState = { status: "checking" };
  let settled: { generation: number; user: AccountUser | null } | undefined;
  let pending:
    { generation: number; read: Promise<AccountUser | null> } | undefined;
  const listeners = new Set<(state: SessionState) => void>();
  const channel =
    "BroadcastChannel" in page
      ? new BroadcastChannel("yaparena-account")
      : null;

  function publish(state: SessionState) {
    current = state;
    for (const listener of [...listeners]) listener(state);
  }
  function nextGeneration() {
    ++generation;
    settled = undefined;
  }

  function read(): Promise<AccountUser | null> {
    const readGeneration = generation;
    if (current.status !== "checking") publish({ status: "checking" });
    const request = apiFetch("/api/auth/me", {
      cache: "no-store",
      timeout: 10000,
    }).then(async (response) => {
      if (response.status === 401) return null;
      if (!response.ok) throw await apiError(response, accountErrorMessage);
      const { user }: { user: AccountUser } = await response.json();
      return user;
    });
    const entry = { generation: readGeneration, read: request };
    pending = entry;
    request.then(
      (user) => {
        if (pending === entry) pending = undefined;
        if (readGeneration !== generation) return;
        settled = { generation: readGeneration, user };
        verifiedAccount = user?.id ?? null;
        publish(
          user ? { status: "signed-in", user } : { status: "signed-out" },
        );
      },
      (error: unknown) => {
        if (pending === entry) pending = undefined;
        if (readGeneration !== generation) return;
        // A failed read is never reused: the next read asks again.
        settled = undefined;
        if (apiErrorStatus(error) === 403) {
          verifiedAccount = null;
          publish({ status: "signed-out" });
        } else publish({ status: "unavailable", error });
      },
    );
    return request;
  }

  function me({ fresh = false } = {}) {
    if (!fresh && settled?.generation === generation)
      return Promise.resolve(settled.user);
    if (pending?.generation === generation) return pending.read;
    return read();
  }

  page.addEventListener("yap:account-changed", () => {
    nextGeneration();
    if (listeners.size) me().catch(() => {});
  });
  page.addEventListener("yap:provider-logout", () => {
    nextGeneration();
    verifiedAccount = null;
    publish({ status: "signed-out" });
  });
  page.addEventListener("pageshow", (event) => {
    if (event.persisted) nextGeneration();
  });
  // Another tab signed in or out.
  channel?.addEventListener("message", () =>
    page.dispatchEvent(new Event("yap:account-changed")),
  );

  async function sessionFetch(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const url = sameOriginUrl(path);
    const method = (init.method ?? "GET").toUpperCase();
    const revokesSession =
      (method === "POST" && url.pathname === "/api/auth/logout") ||
      (method === "DELETE" &&
        /^\/api\/auth\/sessions\/[1-9][0-9]*$/.test(url.pathname));
    if (!revokesSession) return fetch(path, init);
    if (!isSecureContext || typeof navigator.locks?.request !== "function")
      throw new Error(
        "This browser cannot safely coordinate account changes across tabs. Update your browser and try again.",
      );
    // Capture the account before a sign-in in another tab can change the
    // browser cookie to another account.
    const expectedAccount = verifiedAccount;
    const queued = new AbortController(),
      network = new AbortController();
    const abortFromCaller = () => {
      queued.abort(init.signal?.reason);
      network.abort(init.signal?.reason);
    };
    init.signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (init.signal?.aborted) abortFromCaller();
    const queueTimer = setTimeout(
      () =>
        queued.abort(
          new Error(
            "Another account change is still finishing. Sign-out is unconfirmed; wait and try again.",
          ),
        ),
      35000,
    );
    try {
      return await navigator.locks.request(
        "yaparena-application-session",
        { mode: "exclusive", signal: queued.signal },
        async () => {
          clearTimeout(queueTimer);
          const networkTimer = setTimeout(
            () =>
              network.abort(
                new Error(
                  "Sign-out could not be confirmed. Refresh your account and try again.",
                ),
              ),
            10000,
          );
          try {
            const response = await apiFetch(path, {
              ...init,
              expectedAccount,
              signal: network.signal,
            });
            // Retain the lock through the bounded full response so the next
            // revocation starts only after this one has finished.
            await response.clone().arrayBuffer();
            return response;
          } finally {
            clearTimeout(networkTimer);
          }
        },
      );
    } finally {
      clearTimeout(queueTimer);
      init.signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  return {
    account: () => verifiedAccount,
    remember(accountId) {
      verifiedAccount = accountId;
    },
    me,
    state: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    fetch: sessionFetch,
    signedOut(expired) {
      page.dispatchEvent(
        new CustomEvent("yap:provider-logout", { detail: expired }),
      );
      page.dispatchEvent(new Event("yap:account-changed"));
      channel?.postMessage("changed");
    },
  };
}

/** The page's session store, created on first use. */
export function sessionStore(): SessionStore {
  return (window.yapSession ??= createSessionStore());
}
