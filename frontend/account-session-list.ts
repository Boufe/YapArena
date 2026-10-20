type ManagedAccountSession = {
  id: string;
  current: boolean;
  createdAt: string;
  expiresAt: string;
};

const sessionControls = document.querySelector<HTMLElement>(
  ".account-session-controls",
);
if (sessionControls) {
  const section = document.createElement("section");
  section.setAttribute("aria-label", "Active YapArena sessions");
  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.className = "button-secondary";
  refreshButton.textContent = "Refresh active sessions";
  const sessionNotice = document.createElement("p");
  sessionNotice.role = "status";
  sessionNotice.setAttribute("aria-live", "polite");
  sessionNotice.setAttribute("aria-atomic", "true");
  const list = document.createElement("ul");
  list.className = "account-list";
  section.append(refreshButton, sessionNotice, list);
  sessionControls.append(section);
  let version = 0;
  let removalOwner: symbol | undefined;
  function clearSessions() {
    ++version;
    removalOwner = undefined;
    list.replaceChildren();
    sessionNotice.textContent = "";
  }
  function announceSignedOut(unconfirmed = false) {
    clearSessions();
    const signedIn = document.querySelector<HTMLElement>("#signed-in");
    const signedOut = document.querySelector<HTMLElement>("#signed-out");
    if (signedIn) signedIn.hidden = true;
    if (signedOut) signedOut.hidden = false;
    window.dispatchEvent(
      new CustomEvent("yap:provider-logout", { detail: unconfirmed }),
    );
    window.dispatchEvent(new Event("yap:account-changed"));
    if ("BroadcastChannel" in window) {
      const channel = new BroadcastChannel("yaparena-account");
      channel.postMessage("changed");
      channel.close();
    }
    const notice = document.querySelector<HTMLElement>("#account-notice");
    if (notice)
      notice.textContent = unconfirmed
        ? "This session has ended. Sign in again to sign out other devices."
        : "This session is signed out. Sign in again to continue.";
  }
  async function removeSession(session: ManagedAccountSession) {
    if (
      removalOwner !== undefined ||
      !window.confirm(
        session.current
          ? "Sign out this session, including other tabs using this browser session?"
          : "Sign out this session? It will need to authenticate again.",
      )
    )
      return;
    const owner = Symbol("session removal");
    removalOwner = owner;
    const removalVersion = version;
    refreshButton.disabled = true;
    for (const button of list.querySelectorAll("button"))
      button.disabled = true;
    try {
      const response = await fetch(
        `/api/auth/sessions/${encodeURIComponent(session.id)}`,
        {
          method: "DELETE",
          credentials: "same-origin",
          signal: AbortSignal.timeout(10000),
        },
      );
      if (removalVersion !== version) return;
      if (response.status === 401) {
        announceSignedOut(true);
        return;
      }
      if (!response.ok && response.status !== 404)
        throw new Error("revocation unavailable");
      if (response.ok) {
        const removed: { current?: unknown } = await response.json();
        if (removalVersion !== version) return;
        if (typeof removed.current !== "boolean")
          throw new Error("revocation unavailable");
        if (removed.current) {
          announceSignedOut();
          return;
        }
      }
      await loadSessions();
      sessionNotice.textContent = "Session signed out.";
      refreshButton.focus();
    } catch {
      if (removalVersion === version)
        sessionNotice.textContent =
          "Session sign-out could not be confirmed. Refresh and try again.";
    } finally {
      if (removalOwner === owner) removalOwner = undefined;
      if (removalVersion === version) {
        refreshButton.disabled = false;
        for (const button of list.querySelectorAll("button"))
          button.disabled = false;
      }
    }
  }
  async function loadSessions() {
    const requestVersion = ++version;
    refreshButton.disabled = true;
    sessionNotice.textContent = "Checking active sessions…";
    try {
      const response = await fetch("/api/auth/sessions", {
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });
      if (requestVersion !== version) return;
      if (response.status === 401) {
        clearSessions();
        return;
      }
      if (!response.ok) throw new Error("sessions unavailable");
      const data: { sessions: ManagedAccountSession[]; hasMore: boolean } =
        await response.json();
      if (requestVersion !== version) return;
      list.replaceChildren();
      for (const session of data.sessions) {
        const item = document.createElement("li");
        const description = document.createElement("p");
        const created = new Date(session.createdAt).toLocaleString();
        const expiry = new Date(session.expiresAt).toLocaleString();
        description.textContent = `${session.current ? "This browser session" : "Other session"} · Started ${created} · Expires ${expiry}`;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "button-secondary";
        button.textContent = session.current
          ? "Sign out this session"
          : "Sign out session";
        button.setAttribute(
          "aria-label",
          `${button.textContent}, started ${created}`,
        );
        button.addEventListener("click", () => void removeSession(session));
        item.append(description, button);
        list.append(item);
      }
      sessionNotice.textContent = data.hasMore
        ? "Showing the latest 100 active sessions. Use Sign out other sessions to end all other access."
        : `${data.sessions.length} active ${data.sessions.length === 1 ? "session" : "sessions"}. Devices and locations are not collected.`;
    } catch {
      if (requestVersion === version)
        sessionNotice.textContent =
          "Active sessions are unavailable. Refresh to try again. Sign out all sessions remains available above.";
    } finally {
      if (requestVersion === version) refreshButton.disabled = false;
    }
  }
  refreshButton.addEventListener("click", () => void loadSessions());
  window.addEventListener("yap:account-changed", () => {
    clearSessions();
    void loadSessions();
  });
  window.addEventListener("yap:provider-logout", clearSessions);
  void loadSessions();
}
