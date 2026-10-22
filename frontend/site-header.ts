import {
  captureAuthReturn,
  clearAuthReturn,
  readAuthReturn,
  safeAuthReturn,
  type AuthResumeAction,
} from "./auth-return.js";
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
  let endedSessionNotice = "";
  let resumeNotice = "";
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
        window.yapRememberSessionAccount?.(null);
        clearAccount();
        session("guest");
        status.textContent = endedSessionNotice;
        return;
      }
      if (!auth.ok) throw new Error("account unavailable");
      const identity: { user: { id: string } } = await auth.json();
      if (current !== version) return;
      window.yapRememberSessionAccount?.(identity.user.id);
      endedSessionNotice = "";
      session("member");
      status.textContent = resumeNotice;
      resumeConfirmedAction();
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
    resumeNotice = "";
    clearAccount();
    session("checking");
    void refresh();
  });
  window.addEventListener("yap:provider-logout", (event) => {
    clearAuthReturn();
    cancelResume?.();
    resumeOpener = null;
    resumeNotice = "";
    ++version;
    const expired: unknown =
      event instanceof CustomEvent ? event.detail : false;
    endedSessionNotice =
      expired === true
        ? "This session has ended. Sign in again to sign out other devices."
        : "";
    clearAccount();
    session("guest");
    status.textContent = endedSessionNotice;
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
  let resumeOpener: HTMLElement | null = null;
  let cancelResume: (() => void) | undefined;
  // A reload discards the dialog but retains history.state. Bind entries to
  // this document so Back cannot mistake an older dialog entry for this one.
  const authHistoryId = crypto.randomUUID();
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
  function resumeAction(source: HTMLElement | null): AuthResumeAction {
    const follow = source?.closest<HTMLElement>(".follow-button");
    if (
      follow &&
      (follow.dataset.followType === "topics" ||
        follow.dataset.followType === "people") &&
      /^[a-z0-9][a-z0-9-]{2,79}$/.test(follow.dataset.followSlug ?? "")
    )
      return {
        kind: "follow",
        type: follow.dataset.followType,
        slug: follow.dataset.followSlug!,
      };
    if (source?.closest("[data-community-like]"))
      return { kind: "community-like" };
    if (
      source?.closest("[data-community-chat-form],[data-community-send-status]")
    )
      return { kind: "community-chat" };
    if (source?.closest("[data-community-report-form]"))
      return { kind: "community-report" };
    if (source?.closest("#match-signed-out,#match-signed-in"))
      return { kind: "matching" };
    if (source?.closest("[data-a4]")) return { kind: "a4" };
    if (source?.closest("[data-a4-inline]")) return { kind: "inline-a4" };
    return { kind: "page" };
  }
  function focusable(node: HTMLElement | null): node is HTMLElement {
    return Boolean(
      node?.isConnected &&
      node !== document.body &&
      node !== document.documentElement &&
      node.getClientRects().length &&
      getComputedStyle(node).visibility !== "hidden" &&
      !node.matches(":disabled,[aria-disabled='true']"),
    );
  }
  function actionControl(action: AuthResumeAction): HTMLElement | null {
    if (action.kind === "follow")
      return (
        [...document.querySelectorAll<HTMLElement>(".follow-button")].find(
          (node) =>
            node.dataset.followType === action.type &&
            node.dataset.followSlug === action.slug,
        ) ?? null
      );
    if (action.kind === "page" && location.hash)
      try {
        const fragment = document.getElementById(
          decodeURIComponent(location.hash.slice(1)),
        );
        if (focusable(fragment)) return fragment;
      } catch {
        // An invalid fragment cannot select a different action.
      }
    const selectors = {
      page: "[data-header-account]",
      "community-chat": "[data-community-chat-form] textarea",
      "community-like": "[data-community-like]",
      "community-report": "[data-community-report-form] select",
      matching: "#request-create input",
      a4: "[data-a4-create] select",
      "inline-a4": "[data-inline-form] select,[data-inline-setup] summary",
    };
    return document.querySelector<HTMLElement>(selectors[action.kind]);
  }
  function resumeConfirmedAction() {
    if (
      authDialog.open ||
      document.hidden ||
      header!.dataset.session !== "member"
    )
      return;
    const intent = readAuthReturn();
    if (
      (intent && (intent.phase === "oauth" || intent.next !== returnPath())) ||
      (!intent && !resumeOpener)
    )
      return;
    const action = intent?.action ?? resumeAction(resumeOpener);
    cancelResume?.();
    const original = resumeOpener;
    const stop = () => {
      observer.disconnect();
      clearTimeout(timer);
      document.removeEventListener("pointerdown", stop);
      document.removeEventListener("keydown", stop);
      cancelResume = undefined;
      resumeOpener = null;
      clearAuthReturn();
    };
    const focus = () => {
      if (authDialog.open || header!.dataset.session !== "member") return;
      const source =
        original instanceof HTMLFormElement
          ? original.querySelector<HTMLElement>("input,textarea,select,button")
          : original;
      const loginLink =
        source instanceof HTMLAnchorElement &&
        new URL(source.href, location.origin).pathname.startsWith("/account");
      const control =
        focusable(source) && !(loginLink && action.kind !== "page")
          ? source
          : actionControl(action);
      if (!focusable(control)) return;
      resumeNotice =
        "You’re signed in. Review the action, then confirm when you’re ready.";
      status.textContent = resumeNotice;
      if (
        !control.matches(
          "a[href],button,input,textarea,select,summary,[tabindex],[contenteditable]",
        )
      )
        control.tabIndex = -1;
      control.focus({ preventScroll: control === source });
      stop();
    };
    const observer = new MutationObserver(focus);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["hidden", "disabled", "aria-disabled", "class"],
    });
    const timer = window.setTimeout(() => {
      if (focusable(avatar)) avatar.focus({ preventScroll: true });
      stop();
    }, 12000);
    cancelResume = stop;
    document.addEventListener("pointerdown", stop, { once: true });
    document.addEventListener("keydown", stop, { once: true });
    focus();
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
  function openAuth(
    mode: AuthMode,
    next?: string,
    push = true,
    source?: HTMLElement,
  ) {
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
      cancelResume?.();
      completed = false;
      resumeOpener = null;
      resumeNotice = "";
      opener =
        source ??
        (document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null);
      if (push)
        captureAuthReturn(returnPath(next) ?? null, resumeAction(opener));
      if (accountRoot) {
        marker = document.createComment("Account auth panel");
        accountRoot.before(marker);
      }
      panel.append(authRoot);
      authDialog.showModal();
      if (push)
        history.pushState(
          { yapAuthDialog: authHistoryId, mode, returnTo: returnPath(next) },
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
      value.yapAuthDialog === authHistoryId,
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
    if (!completed) clearAuthReturn();
    if (isAuthHistory() && !closingFromHistory) {
      if (completed) history.replaceState(null, "", location.href);
      else history.back();
    }
    closingFromHistory = false;
    const resume = completed;
    completed = false;
    if (resume) resumeConfirmedAction();
    else if (focusable(opener)) opener.focus({ preventScroll: true });
  });
  window.addEventListener("popstate", () => {
    if (authDialog.open && !isAuthHistory()) {
      closingFromHistory = true;
      authDialog.close();
    }
  });
  window.addEventListener("yap:auth-complete", (event) => {
    completed = true;
    resumeOpener = opener;
    if (event instanceof CustomEvent && event.detail?.returnTo === returnPath())
      event.preventDefault();
    if (authDialog.open) authDialog.close();
    else resumeConfirmedAction();
  });
  window.addEventListener(
    "yap:request-auth",
    (event: CustomEvent<AuthRequest>) => {
      if (
        openAuth(
          event.detail.mode ?? "login",
          event.detail.returnTo,
          true,
          event.detail.source,
        )
      )
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
    if (openAuth(mode, next, true, control)) event.preventDefault();
  });
  const pendingReturn = readAuthReturn();
  if (
    pendingReturn?.phase === "oauth" &&
    pendingReturn.next === returnPath() &&
    !accountRoot
  )
    openAuth("login", pendingReturn.next, false);

  header
    .querySelector<HTMLButtonElement>("[data-header-logout]")!
    .addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      if (button.disabled) return;
      const logoutVersion = version;
      const expectedAccount = window.yapCurrentSessionAccount?.();
      button.disabled = true;
      status.textContent = "Finishing account changes and signing out…";
      try {
        if (!window.yapSessionFetch)
          throw new Error("account controls unavailable");
        const response = await window.yapSessionFetch("/api/auth/logout", {
          method: "POST",
          credentials: "same-origin",
          signal: AbortSignal.timeout(45000),
        });
        if (logoutVersion !== version) {
          if (
            expectedAccount &&
            expectedAccount === window.yapCurrentSessionAccount?.()
          )
            window.dispatchEvent(new Event("yap:account-changed"));
          return;
        }
        if (!response.ok && response.status !== 401)
          throw new Error("logout unavailable");
        clearAccount();
        session("guest");
        window.dispatchEvent(
          new CustomEvent("yap:provider-logout", {
            detail: response.status === 401,
          }),
        );
        window.dispatchEvent(new Event("yap:account-changed"));
        channel?.postMessage("changed");
        guest.querySelector<HTMLAnchorElement>("a")?.focus();
      } catch {
        if (logoutVersion === version)
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
