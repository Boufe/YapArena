import type {} from "./auth-events.js";

// This classic script loads before all account consumers. Only requests that
// can issue or revoke the shared HttpOnly app session take the origin-wide
// browser lock. Native credential ceremonies run before these HTTP requests.
{
  let verifiedAccountId: string | null = null;
  window.yapRememberSessionAccount = (id) => {
    verifiedAccountId = id;
  };
  window.yapCurrentSessionAccount = () => verifiedAccountId;
  window.addEventListener("yap:provider-logout", () => {
    verifiedAccountId = null;
  });
  const identifier = "[a-f0-9-]+";
  const postIssuers = [
    /^\/api\/auth\/(?:register|login|privy\/exchange|wallet\/login\/verify)$/,
    new RegExp(`^/api/auth/wallet/operations/${identifier}/complete$`),
    new RegExp(
      `^/api/auth/security/access/(?:login|reconciliation)/${identifier}/complete$`,
    ),
    new RegExp(
      `^/api/auth/security/(?:passkeys/enrollment|wallet/operations|provider/link|provider/recovery)/${identifier}/complete$`,
    ),
  ];
  const deleteIssuer = new RegExp(
    `^/api/auth/security/passkeys/${identifier}$`,
  );
  window.yapSessionFetch = async (input, init = {}) => {
    const url = new URL(input, location.origin);
    const method = (init.method ?? "GET").toUpperCase();
    const issuesCookie =
      (method === "POST" &&
        postIssuers.some((pattern) => pattern.test(url.pathname))) ||
      (method === "DELETE" && deleteIssuer.test(url.pathname));
    const revokesSession =
      (method === "POST" &&
        /^\/api\/auth\/logout(?:-all|-other-sessions)?$/.test(url.pathname)) ||
      (method === "DELETE" &&
        /^\/api\/auth\/sessions\/[1-9][0-9]*$/.test(url.pathname));
    if (url.origin !== location.origin)
      throw new Error("Account requests must stay on YapArena.");
    if (!issuesCookie && !revokesSession) return fetch(input, init);
    if (!isSecureContext || typeof navigator.locks?.request !== "function")
      throw new Error(
        "This browser cannot safely coordinate account changes across tabs. Update your browser and try again.",
      );
    // This is a comparison hint, never authentication. Capture it before a
    // queued login can change the browser cookie to a different account.
    const expectedAccount = revokesSession ? verifiedAccountId : null;
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
            revokesSession
              ? "Another account change is still finishing. Sign-out is unconfirmed; wait and try again."
              : "Another sign-in is still finishing. Wait and try again.",
          ),
        ),
      revokesSession ? 35000 : 10000,
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
                  revokesSession
                    ? "Sign-out could not be confirmed. Refresh your account and try again."
                    : "Account request timed out. Refresh your account before trying again.",
                ),
              ),
            revokesSession ? 10000 : 30000,
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
            // Cookies are processed with headers. Retain ownership through the
            // bounded full response so no older header remains in flight when
            // another tab is allowed to issue its replacement session.
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
