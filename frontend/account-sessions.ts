// DOM assertions retain the existing server-rendered markup and event-target guarantees.
/* global document, window */
let accountVersion = 0;
window.addEventListener("yap:account-changed", () => accountVersion++);
window.addEventListener("yap:provider-logout", () => accountVersion++);
for (const [id, path, retainCurrent] of [
  ["sign-out-all", "logout-all", false],
  ["sign-out-others", "logout-other-sessions", true],
] as const) {
  document
    .querySelector<HTMLElement>(`#${id}`)
    ?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      const notice = document.querySelector<HTMLElement>("#account-notice")!;
      const message = retainCurrent
        ? "Sign out every other session? This device will stay signed in."
        : "Sign out all sessions, including this device? You will need to sign in again.";
      if (!window.confirm(message)) return;
      if (button.disabled) return;
      const version = accountVersion;
      button.disabled = true;
      try {
        const response = await fetch(`/api/auth/${path}`, {
          method: "POST",
          credentials: "same-origin",
          signal: AbortSignal.timeout(10000),
        });
        if (version !== accountVersion) return;
        if (!response.ok) {
          const body: { error?: string } = await response.json();
          throw new Error(body.error || "Sign-out failed. Please try again.");
        }
        if (retainCurrent) {
          notice.textContent =
            "Other sessions signed out. This device is still signed in.";
        } else {
          window.dispatchEvent(new Event("yap:provider-logout"));
          if ("BroadcastChannel" in window) {
            const channel = new BroadcastChannel("yaparena-account");
            channel.postMessage("changed");
            channel.close();
          }
          document.querySelector<HTMLElement>("#signed-in")!.hidden = true;
          document.querySelector<HTMLElement>("#signed-out")!.hidden = false;
          notice.textContent =
            "All sessions signed out, including this device. Sign in again to continue.";
        }
      } catch (error) {
        if (version === accountVersion)
          notice.textContent = (error as Error).message;
      } finally {
        button.disabled = false;
      }
    });
}
