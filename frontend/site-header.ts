import { safeAuthReturn } from "./auth-return.js";
import type { AuthMode, AuthRequest } from "./auth-events.js";

const header = document.querySelector<HTMLElement>("[data-site-header]");
if (header) {
  header.dataset.enhanced = "true";
  const guest = header.querySelector<HTMLElement>("[data-header-guest]")!;
  const member = header.querySelector<HTMLElement>("[data-header-member]")!;
  const checking = header.querySelector<HTMLElement>("[data-header-checking]")!;
  const retry = header.querySelector<HTMLButtonElement>("[data-header-retry]")!;
  const status = header.querySelector<HTMLElement>("[data-header-status]")!;
  const balance = header.querySelector<HTMLElement>("[data-header-balance]")!;
  const reserved = header.querySelector<HTMLElement>("[data-header-reserved]")!;
  const avatar = header.querySelector<HTMLElement>("[data-header-account]")!;
  const avatarIcon = [...avatar.childNodes].map((node) => node.cloneNode(true));
  const emailFirst =
    document.documentElement.hasAttribute("data-email-first") ||
    Boolean(document.querySelector("#email-auth"));
  const channel =
    "BroadcastChannel" in window
      ? new BroadcastChannel("yaparena-account")
      : null;
  let version = 0;
  function clearAccount() {
    balance.textContent = "—";
    reserved.textContent = "Checking balance…";
    avatar.replaceChildren(...avatarIcon.map((node) => node.cloneNode(true)));
    for (const menu of header!.querySelectorAll<HTMLDetailsElement>("details"))
      menu.open = false;
  }
  function session(state: "checking" | "guest" | "member" | "unavailable") {
    header!.dataset.session = state;
    guest.hidden = state !== "guest";
    member.hidden = state !== "member";
    checking.hidden = state !== "checking";
    retry.hidden = state !== "unavailable";
  }
  function legacyBalance(
    value: { available: string; reserved: string; scope: string } | null,
  ) {
    const coins = (raw: string) => {
      const amount = BigInt(raw);
      return `${amount / 1000000n}.${String(amount % 1000000n)
        .padStart(6, "0")
        .slice(0, 2)} YC`;
    };
    balance.textContent = value ? coins(value.available) : "—";
    reserved.textContent = value
      ? `${value.scope} · reserved ${coins(value.reserved)}`
      : "Balance unavailable. Reopen to retry.";
  }
  async function refresh() {
    const current = ++version;
    try {
      const auth = await fetch("/api/auth/me", {
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });
      if (current !== version) return;
      if (auth.status === 401 || auth.status === 403) {
        clearAccount();
        session("guest");
        status.textContent = "";
        return;
      }
      if (!auth.ok) throw new Error("account unavailable");
      session("member");
      status.textContent = "";
      const [profileResponse, walletResponse] = await Promise.all([
        fetch("/api/me/profile", {
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.timeout(10000),
        }),
        fetch(emailFirst ? "/api/account-wallet" : "/api/a4/wallet", {
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.timeout(10000),
        }),
      ]);
      if (current !== version) return;
      if (profileResponse.ok) {
        const value: { profile: { displayName: string } | null } =
          await profileResponse.json();
        if (current !== version) return;
        const initials = value.profile?.displayName
          .trim()
          .split(/\s+/)
          .slice(0, 2)
          .map((part) => part[0])
          .join("")
          .toUpperCase();
        if (initials) avatar.textContent = initials;
      }
      if (walletResponse.status === 401 || walletResponse.status === 403) {
        clearAccount();
        session("guest");
        return;
      }
      if (!walletResponse.ok) {
        balance.textContent = "—";
        reserved.textContent = "Balance unavailable. Reopen to retry.";
        return;
      }
      if (emailFirst) {
        const value: { available: string; reserved: string } =
          await walletResponse.json();
        if (current !== version) return;
        balance.textContent = `${value.available} YC`;
        reserved.textContent = `Reserved ${value.reserved} YC`;
      } else {
        const value: { balances: { kind: string; amount: string }[] } =
          await walletResponse.json();
        if (current !== version) return;
        legacyBalance({
          available:
            value.balances.find((item) => item.kind === "available")?.amount ??
            "0",
          reserved:
            value.balances.find((item) => item.kind === "reserved")?.amount ??
            "0",
          scope: "Ordinary play balance",
        });
        header!.querySelector<HTMLElement>(
          "[data-header-balance-heading]",
        )!.textContent = "Your play balance";
        header!.querySelector<HTMLAnchorElement>(
          "[data-header-balances-link]",
        )!.href = "/coins";
      }
    } catch {
      if (current !== version) return;
      clearAccount();
      session("unavailable");
      status.textContent =
        "Account access is temporarily unavailable. Retry when your connection returns.";
    }
  }
  window.addEventListener("yap:balance", (event) => {
    if (!emailFirst && header.dataset.session === "member")
      legacyBalance(event.detail);
  });
  window.addEventListener("yap:account-changed", () => {
    clearAccount();
    session("checking");
    void refresh();
  });
  window.addEventListener("focus", () => void refresh());
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      clearAccount();
      session("checking");
      void refresh();
    }
  });
  retry.addEventListener("click", () => {
    session("checking");
    void refresh();
  });
  setInterval(() => {
    if (!document.hidden) void refresh();
  }, 45000);
  void refresh();

  const authDialog = document.createElement("dialog");
  authDialog.id = "site-auth-dialog";
  authDialog.className = "site-auth-dialog";
  authDialog.setAttribute("aria-label", "Log in to YapArena");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "site-auth-close";
  close.setAttribute("aria-label", "Close sign-in");
  close.textContent = "×";
  const panel = document.createElement("div");
  panel.className = "site-auth-panel";
  authDialog.append(close, panel);
  document.body.append(authDialog);
  let authRoot = document.querySelector<HTMLElement>("#email-auth");
  const accountRoot = authRoot;
  let marker: Comment | undefined;
  let opener: HTMLElement | null = null;
  let scriptLoad: Promise<void> | undefined;
  let closingFromHistory = false;
  let completed = false;
  function returnPath(candidate?: string) {
    return (
      safeAuthReturn(candidate ?? null, location.origin) ??
      safeAuthReturn(
        location.pathname + location.search + location.hash,
        location.origin,
      ) ??
      undefined
    );
  }
  function loadProvider() {
    if (accountRoot) return Promise.resolve();
    scriptLoad ??= new Promise<void>((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = header!.dataset.authStyle!;
      document.head.append(css);
      const script = document.createElement("script");
      script.src = header!.dataset.authScript!;
      script.addEventListener("load", () => resolve(), { once: true });
      script.addEventListener(
        "error",
        () => {
          script.remove();
          css.remove();
          scriptLoad = undefined;
          reject(new Error("sign-in unavailable"));
        },
        { once: true },
      );
      document.head.append(script);
    });
    return scriptLoad;
  }
  function openAuth(mode: AuthMode, next?: string, push = true) {
    if (!emailFirst) return false;
    if (!authRoot) {
      authRoot = document.createElement("div");
      authRoot.id = "email-auth";
      authRoot.className = "auth-mount";
      const loading = document.createElement("p");
      loading.role = "status";
      loading.textContent = "Preparing secure sign-in…";
      authRoot.append(loading);
    }
    if (!authDialog.open) {
      opener =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      if (accountRoot) {
        marker = document.createComment("Account auth panel");
        accountRoot.before(marker);
      }
      panel.append(authRoot);
      authDialog.showModal();
      if (push)
        history.pushState(
          { yapAuthDialog: true, mode, returnTo: returnPath(next) },
          "",
          location.href,
        );
    }
    authRoot.dataset.authSurface = "modal";
    authRoot.dataset.authMode = mode;
    const target = returnPath(next);
    if (target) authRoot.dataset.authReturn = target;
    else delete authRoot.dataset.authReturn;
    authDialog.setAttribute(
      "aria-label",
      mode === "signup" ? "Sign up for YapArena" : "Log in to YapArena",
    );
    window.dispatchEvent(new CustomEvent("yap:auth-mode", { detail: mode }));
    requestAnimationFrame(() => {
      if (authDialog.open)
        authRoot
          ?.querySelector<HTMLInputElement>("input:not([disabled])")
          ?.focus();
    });
    void loadProvider().catch(() => {
      if (!authRoot) return;
      authRoot.replaceChildren();
      const notice = document.createElement("p");
      notice.role = "status";
      notice.textContent =
        "Sign-in could not load. Check your connection, then close and reopen this window to retry.";
      authRoot.append(notice);
    });
    return true;
  }
  function isAuthHistory() {
    const value: unknown = history.state;
    return Boolean(
      value &&
      typeof value === "object" &&
      "yapAuthDialog" in value &&
      value.yapAuthDialog === true,
    );
  }
  close.addEventListener("click", () => authDialog.close());
  authDialog.addEventListener("click", (event) => {
    if (event.target === authDialog) {
      const box = authDialog.getBoundingClientRect();
      if (
        event.clientX < box.left ||
        event.clientX > box.right ||
        event.clientY < box.top ||
        event.clientY > box.bottom
      )
        authDialog.close();
    }
  });
  authDialog.addEventListener("close", () => {
    window.dispatchEvent(new Event("yap:auth-dismissed"));
    if (marker && accountRoot) {
      marker.replaceWith(accountRoot);
      marker = undefined;
      delete accountRoot.dataset.authSurface;
      delete accountRoot.dataset.authReturn;
      delete accountRoot.dataset.authMode;
      window.dispatchEvent(new CustomEvent("yap:auth-mode", { detail: null }));
    }
    if (!completed)
      try {
        sessionStorage.removeItem("yaparena-auth-return");
      } catch {
        /* Navigation storage is optional. */
      }
    if (isAuthHistory() && !closingFromHistory) {
      if (completed) history.replaceState(null, "", location.href);
      else history.back();
    }
    closingFromHistory = false;
    completed = false;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  });
  window.addEventListener("popstate", () => {
    if (authDialog.open && !isAuthHistory()) {
      closingFromHistory = true;
      authDialog.close();
    }
  });
  window.addEventListener("yap:auth-complete", () => {
    completed = true;
    if (authDialog.open) authDialog.close();
  });
  window.addEventListener(
    "yap:request-auth",
    (event: CustomEvent<AuthRequest>) => {
      if (openAuth(event.detail.mode ?? "login", event.detail.returnTo))
        event.preventDefault();
    },
  );
  document.addEventListener("click", (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      !(event.target instanceof Element)
    )
      return;
    const control = event.target.closest<HTMLElement>(
      "[data-auth-open],a[href]",
    );
    if (!control || control.hasAttribute("data-auth-fallback")) return;
    const explicitMode = control.dataset.authOpen;
    const link =
      control instanceof HTMLAnchorElement
        ? new URL(control.href, location.origin)
        : null;
    if (
      control instanceof HTMLAnchorElement &&
      ((control.target && control.target !== "_self") ||
        control.hasAttribute("download"))
    )
      return;
    const protectedAccount =
      link?.pathname.startsWith("/account/") &&
      header.dataset.session === "guest";
    if (
      !explicitMode &&
      !(
        link?.origin === location.origin &&
        ((link.pathname === "/account" &&
          (link.searchParams.has("next") ||
            header.dataset.session === "guest")) ||
          protectedAccount)
      )
    )
      return;
    const mode = explicitMode === "signup" ? "signup" : "login";
    const candidate = safeAuthReturn(
      (protectedAccount && link
        ? link.pathname + link.search + link.hash
        : link?.searchParams.get("next")) ?? null,
      location.origin,
    );
    const destination = candidate ? new URL(candidate, location.origin) : null;
    const next =
      destination?.origin === location.origin &&
      destination.pathname === location.pathname
        ? undefined
        : (candidate ?? undefined);
    if (openAuth(mode, next)) event.preventDefault();
  });
  try {
    const raw = sessionStorage.getItem("yaparena-auth-return");
    if (raw && !accountRoot) {
      const pending: unknown = JSON.parse(raw);
      if (
        pending &&
        typeof pending === "object" &&
        "next" in pending &&
        typeof pending.next === "string"
      )
        openAuth("login", returnPath(pending.next), false);
    }
  } catch {
    /* Storage is optional; ordinary email sign-in remains available. */
  }

  header
    .querySelector<HTMLButtonElement>("[data-header-logout]")!
    .addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      try {
        const response = await fetch("/api/auth/logout", {
          method: "POST",
          credentials: "same-origin",
        });
        if (!response.ok) throw new Error("logout unavailable");
        clearAccount();
        session("guest");
        window.dispatchEvent(new Event("yap:provider-logout"));
        window.dispatchEvent(new Event("yap:account-changed"));
        channel?.postMessage("changed");
        guest.querySelector<HTMLAnchorElement>("a")?.focus();
      } catch {
        status.textContent = "Log out could not complete. Please try again.";
      } finally {
        button.disabled = false;
      }
    });
  for (const menu of header.querySelectorAll<HTMLDetailsElement>("details")) {
    menu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        menu.open = false;
        menu.querySelector("summary")?.focus();
      }
    });
    menu.addEventListener("toggle", () => {
      if (menu.open)
        for (const other of header.querySelectorAll<HTMLDetailsElement>(
          "details",
        ))
          if (other !== menu) other.open = false;
    });
  }
  document.addEventListener("click", (event) => {
    for (const menu of header.querySelectorAll<HTMLDetailsElement>("details"))
      if (event.target instanceof Node && !menu.contains(event.target))
        menu.open = false;
  });

  const deposit = document.createElement("dialog");
  deposit.className = "header-deposit-dialog";
  deposit.setAttribute("aria-labelledby", "deposit-title");
  const depositClose = document.createElement("button");
  depositClose.type = "button";
  depositClose.className = "site-auth-close";
  depositClose.setAttribute("aria-label", "Close deposit");
  depositClose.textContent = "×";
  const depositTitle = document.createElement("h2");
  depositTitle.id = "deposit-title";
  depositTitle.textContent = "Add Yap Coins";
  const depositEyebrow = document.createElement("span");
  depositEyebrow.className = "eyebrow accent";
  depositEyebrow.textContent = "YOUR ACCOUNT WALLET";
  const depositRate = document.createElement("strong");
  depositRate.className = "deposit-rate";
  depositRate.textContent = "100 YC = 1 USDC";
  const depositNotice = document.createElement("p");
  depositNotice.textContent =
    "Deposits are not open yet. Crypto purchases will appear here when funding is available.";
  const depositLink = document.createElement("a");
  depositLink.className = "header-signup";
  depositLink.href = "/account#account-wallet";
  depositLink.textContent = "View your balance →";
  deposit.append(
    depositClose,
    depositEyebrow,
    depositTitle,
    depositRate,
    depositNotice,
    depositLink,
  );
  document.body.append(deposit);
  const depositButton = header.querySelector<HTMLButtonElement>(
    "[data-deposit-open]",
  )!;
  depositButton.addEventListener("click", () => {
    if (header.dataset.session === "member") deposit.showModal();
  });
  depositClose.addEventListener("click", () => deposit.close());
  deposit.addEventListener("close", () => depositButton.focus());
  window.addEventListener("yap:account-changed", () => {
    if (deposit.open) deposit.close();
  });
}
