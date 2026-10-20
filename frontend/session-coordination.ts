import type {} from "./auth-events.js";

// This classic script loads before all account consumers. Only requests that
// can issue the shared HttpOnly app cookie take the origin-wide browser lock.
{
  const identifier = "[a-f0-9-]+";
  const postIssuers = [
    /^\/api\/auth\/(?:register|login|privy\/exchange|wallet\/login\/verify)$/,
    new RegExp(`^/api/auth/wallet/operations/${identifier}/complete$`),
    new RegExp(
      `^/api/auth/security/access/(?:login|reconciliation)/${identifier}/complete$`,
    ),
    new RegExp(
      `^/api/auth/security/(?:passkeys/enrollment|wallet/operations|provider/link)/${identifier}/complete$`,
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
    if (url.origin !== location.origin)
      throw new Error("Account requests must stay on YapArena.");
    if (!issuesCookie) return fetch(input, init);
    if (!isSecureContext || typeof navigator.locks?.request !== "function")
      throw new Error(
        "This browser cannot safely coordinate sign-in across tabs. Update your browser and try again.",
      );
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
          new Error("Another sign-in is still finishing. Wait and try again."),
        ),
      10000,
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
                  "Account request timed out. Refresh your account before trying again.",
                ),
              ),
            30000,
          );
          try {
            const response = await fetch(input, {
              ...init,
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
