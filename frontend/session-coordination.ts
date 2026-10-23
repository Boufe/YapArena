import type {} from "./auth-events.js";

// This classic script loads before all account consumers. Sign-in is a
// full-page navigation through Auth0 (Decision 0009), so no fetch issues a
// session cookie. The requests that revoke the shared HttpOnly session (sign
// out and removing one session) take an origin-wide browser lock so two tabs
// never revoke at once, and carry the account this page last verified.
{
  let verifiedAccountId: string | null = null;
  window.yapRememberSessionAccount = (id) => {
    verifiedAccountId = id;
  };
  window.yapCurrentSessionAccount = () => verifiedAccountId;
  window.addEventListener("yap:provider-logout", () => {
    verifiedAccountId = null;
  });
  window.yapSessionFetch = async (input, init = {}) => {
    const url = new URL(input, location.origin);
    const method = (init.method ?? "GET").toUpperCase();
    const revokesSession =
      (method === "POST" && url.pathname === "/api/auth/logout") ||
      (method === "DELETE" &&
        /^\/api\/auth\/sessions\/[1-9][0-9]*$/.test(url.pathname));
    if (url.origin !== location.origin)
      throw new Error("Account requests must stay on YapArena.");
    if (!revokesSession) return fetch(input, init);
    if (!isSecureContext || typeof navigator.locks?.request !== "function")
      throw new Error(
        "This browser cannot safely coordinate account changes across tabs. Update your browser and try again.",
      );
    // This is a comparison hint, never authentication. Capture it before a
    // sign-in in another tab can change the browser cookie to another account.
    const expectedAccount = verifiedAccountId;
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
            const headers = new Headers(init.headers);
            if (expectedAccount)
              headers.set("X-YapArena-Expected-Account", expectedAccount);
            const response = await fetch(input, {
              ...init,
              headers,
              credentials: "same-origin",
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
  };
}
