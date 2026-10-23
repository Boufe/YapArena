// DOM assertions retain the existing server-rendered markup and event-target guarantees.
import type {
  Profile,
  AccountUser,
  FollowEntry,
  ActivityEntry,
  CollectionPage,
  AccountError,
} from "./account-types.js";
import type {} from "./auth-events.js";
interface ProfileForm extends HTMLFormElement {
  readonly elements: HTMLFormControlsCollection & {
    handle: HTMLInputElement;
    displayName: HTMLInputElement;
    bio: HTMLTextAreaElement;
    publicationState: HTMLSelectElement;
  };
}
/* global window, document */
const notice = document.querySelector<HTMLElement>("#account-notice")!;
const signedOut = document.querySelector<HTMLElement>("#signed-out")!;
const signedIn = document.querySelector<HTMLElement>("#signed-in")!;
const checkingSignOut = document.createElement("button");
checkingSignOut.id = "account-checking-sign-out";
checkingSignOut.type = "button";
checkingSignOut.className = "button-secondary account-checking-signout";
checkingSignOut.textContent = "Sign out";
checkingSignOut.hidden = true;
notice.parentElement!.append(checkingSignOut);
const profileForm = document.querySelector<ProfileForm>("#profile-form")!;
let currentProfile: Profile | null = null;
let accountVersion = 0;
let signOutPending = false;
let endedSessionNotice = "";
function say(message: string) {
  notice.textContent = message;
}

async function api<T = void>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const coordinated = path.startsWith("/api/auth/") && method !== "GET";
  const send = coordinated ? window.yapSessionFetch : fetch;
  if (!send)
    throw new Error(
      "Secure account controls are unavailable. Reload and try again.",
    );
  const response = await send(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (response.status === 204) return null as T;
  const json = response.headers
    .get("Content-Type")
    ?.includes("application/json");
  const data: { error?: string } = json
    ? await response.json()
    : {
        error:
          response.status === 429
            ? "Too many attempts. Wait a moment, then try again."
            : "Request failed. Please try again.",
      };
  if (!response.ok) {
    const error = new Error(data.error || "Request failed. Please try again.");
    (error as AccountError).status = response.status;
    throw error;
  }
  return data as T;
}

function item(text: string, href?: string) {
  const row = document.createElement("li");
  const content = href
    ? document.createElement("a")
    : document.createElement("span");
  content.textContent = text;
  if (href) (content as HTMLAnchorElement).href = href;
  row.append(content);
  return row;
}

// Sign-in is a full-page redirect through the provider. Return to the page
// that sent the reader here, or to this account page.
function signInReturn() {
  const next = new URLSearchParams(window.location.search).get("next");
  if (
    next?.startsWith("/") &&
    !next.startsWith("//") &&
    !next.includes("\\") &&
    !next.startsWith("/api/")
  ) {
    const destination = new URL(next, window.location.origin);
    if (destination.origin === window.location.origin)
      return destination.pathname + destination.search + destination.hash;
  }
  return "/account";
}
for (const link of document.querySelectorAll<HTMLAnchorElement>(
  "#account-sign-in a[data-sign-in]",
)) {
  const target = new URL(link.href, window.location.origin);
  target.searchParams.set("return", signInReturn());
  link.href = target.pathname + target.search;
}
const back = document.querySelector<HTMLAnchorElement>("[data-auth-return]");
if (back && signInReturn() !== "/account") back.href = signInReturn();

async function loadProfile(version = accountVersion) {
  let profile: Profile | null = null;
  try {
    profile = (await api<{ profile: Profile }>("/api/me/profile")).profile;
  } catch (error) {
    if ((error as AccountError).message !== "profile not found") throw error;
  }
  if (version !== accountVersion) return;
  currentProfile = profile;
  profileForm.elements.handle.value = profile?.handle ?? "";
  profileForm.elements.handle.disabled = Boolean(profile);
  profileForm.elements.displayName.value = profile?.displayName ?? "";
  profileForm.elements.bio.value = profile?.bio ?? "";
  profileForm.elements.publicationState.value =
    profile?.publicationState === "published" ? "published" : "draft";
  document.querySelector<HTMLElement>("#profile-state")!.textContent = profile
    ? profile.publicationState === "hidden"
      ? "Your profile is restricted. Contact support before publishing."
      : `@${profile.handle} · ${profile.publicationState}`
    : "Create a private draft. You decide when to publish it.";
  profileForm.querySelector<HTMLButtonElement>(
    'button[type="submit"]',
  )!.disabled = profile?.publicationState === "hidden";
}

async function loadCollection<T>(
  path: string,
  selector: string,
  render: (entry: T) => HTMLLIElement,
  version = accountVersion,
) {
  const list = document.querySelector<HTMLElement>(selector)!;
  let offset = 0;
  async function nextPage() {
    const data = await api<CollectionPage<T>>(
      `${path}?limit=20&offset=${offset}`,
    );
    if (version !== accountVersion) return;
    if (!offset) list.replaceChildren();
    if (!offset && !data.items.length) list.append(item("Nothing here yet."));
    for (const entry of data.items) list.append(render(entry));
    offset += data.items.length;
    const oldButton = list.querySelector<HTMLElement>(".load-more")!;
    oldButton?.remove();
    if (data.pagination.hasMore) {
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "small-button load-more";
      button.textContent = "Load more";
      button.addEventListener("click", () =>
        nextPage().catch((error: unknown) =>
          say((error as AccountError).message),
        ),
      );
      row.append(button);
      list.append(row);
    }
  }
  await nextPage();
}

async function loadAccount() {
  // Refreshing the account already on screen updates it in place, so the page
  // does not collapse and lose the reader's place. Another account, or none,
  // still clears everything first.
  const shown = signedIn.hidden
    ? null
    : (window.yapCurrentSessionAccount?.() ?? null);
  if (shown) ++accountVersion;
  else {
    clearAccountState(true);
    say("Checking your account…");
  }
  let version = accountVersion;
  try {
    const { user } = await api<{ user: AccountUser }>("/api/auth/me");
    if (version !== accountVersion) return;
    if (shown && user.id !== shown) {
      clearAccountState(true);
      version = accountVersion;
    }
    window.yapRememberSessionAccount?.(user.id);
    endedSessionNotice = "";
    checkingSignOut.hidden = true;
    signedOut.hidden = true;
    signedIn.hidden = false;
    document.querySelector<HTMLElement>("#account-name")!.textContent =
      user.email || "Your account";
    const methods = await api<{
      methods: { method: "email" | "google"; email: string }[];
    }>("/api/auth/methods");
    if (version !== accountVersion) return;
    document.querySelector<HTMLElement>("#account-name")!.textContent =
      methods.methods[0]?.email || user.email || "Your account";
    const methodList = document.querySelector<HTMLElement>("#sign-in-methods");
    methodList?.replaceChildren(
      ...methods.methods.map((entry) =>
        item(
          `${entry.method === "google" ? "Google" : "Email code"} · ${entry.email}`,
        ),
      ),
    );
    const balance = await api<{
      available: string;
      reserved: string;
      pending: string;
      promotional: string;
    }>("/api/account-wallet");
    if (version !== accountVersion) return;
    for (const [kind, amount] of Object.entries(balance)) {
      const target = document.querySelector<HTMLElement>(
        `[data-funds="${kind}"]`,
      );
      if (target) target.textContent = `${amount} YC`;
    }
    await Promise.all([
      loadProfile(),
      loadNotifications(),
      loadCollection<FollowEntry>("/api/me/follows", "#follow-list", (entry) =>
        item(
          `${entry.targetType === "topic" ? "Topic" : "Person"}: ${entry.title}`,
          entry.targetType === "topic"
            ? `/topics/${encodeURIComponent(entry.slug)}`
            : `/people/${encodeURIComponent(entry.slug)}`,
        ),
      ),
      loadCollection<ActivityEntry>(
        "/api/me/activity",
        "#activity-list",
        (entry) =>
          item(
            `${entry.eventType.replace(".", " ")} · ${new Date(entry.occurredAt).toLocaleDateString()}`,
          ),
      ),
    ]);
    if (version !== accountVersion) return;
    say("Account ready.");
  } catch (error) {
    if (version !== accountVersion) return;
    if ((error as AccountError).status === 401) {
      window.yapRememberSessionAccount?.(null);
      clearAccountState();
      say(
        endedSessionNotice ||
          "Sign in to create a profile and follow people or topics.",
      );
      return;
    }
    // An in-place refresh that cannot confirm the account must not leave the
    // previous details on screen.
    if (shown) clearAccountState(true);
    say((error as AccountError).message);
  }
}

const signOutButtons = [
  document.querySelector<HTMLButtonElement>("#sign-out")!,
  checkingSignOut,
];
for (const button of signOutButtons)
  button.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    if (signOutPending || button.disabled) return;
    signOutPending = true;
    const version = accountVersion;
    const expectedAccount = window.yapCurrentSessionAccount?.();
    for (const control of signOutButtons) control.disabled = true;
    say("Signing out…");
    try {
      if (!window.yapSessionFetch)
        throw new Error(
          "Secure account controls are unavailable. Reload and try again.",
        );
      const response = await window.yapSessionFetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        signal: AbortSignal.timeout(45000),
      });
      const body: { error?: string; redirectTo?: unknown } = response.headers
        .get("Content-Type")
        ?.includes("application/json")
        ? await response.json()
        : {};
      if (!response.ok && response.status !== 401)
        throw new Error(
          body.error || "Sign out could not complete. Try again.",
        );
      const expired = response.status === 401;
      if (version !== accountVersion) {
        if (
          expectedAccount &&
          expectedAccount === window.yapCurrentSessionAccount?.()
        )
          window.dispatchEvent(new Event("yap:account-changed"));
        return;
      }
      window.dispatchEvent(
        new CustomEvent("yap:provider-logout", { detail: expired }),
      );
      window.dispatchEvent(new Event("yap:account-changed"));
      if ("BroadcastChannel" in window) {
        const channel = new BroadcastChannel("yaparena-account");
        channel.postMessage("changed");
        channel.close();
      }
      // Signing out also ends this browser's provider session; the provider
      // then returns to the home page.
      if (typeof body.redirectTo === "string") {
        const target = new URL(body.redirectTo);
        if (target.protocol === "https:" || target.protocol === "http:") {
          window.location.assign(target.href);
          return;
        }
      }
      document
        .querySelector<HTMLAnchorElement>("#account-sign-in a[data-sign-in]")
        ?.focus();
    } catch (error) {
      if (version === accountVersion) say((error as AccountError).message);
    } finally {
      signOutPending = false;
      for (const control of signOutButtons) control.disabled = false;
    }
  });

profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(profileForm);
  try {
    if (!currentProfile) {
      await api("/api/me/profile", "POST", {
        handle: form.get("handle"),
        displayName: form.get("displayName"),
        bio: form.get("bio"),
      });
    } else {
      await api("/api/me/profile", "PATCH", {
        displayName: form.get("displayName"),
        bio: form.get("bio"),
        publicationState: form.get("publicationState"),
      });
    }
    if (!currentProfile && form.get("publicationState") === "published") {
      await api("/api/me/profile", "PATCH", { publicationState: "published" });
    }
    await loadProfile();
    say("Profile saved.");
  } catch (error) {
    say((error as AccountError).message);
  }
});

async function loadNotifications(version = accountVersion) {
  const list = document.querySelector<HTMLElement>("#account-notifications")!;
  const { notifications } = await api<{ notifications: { message: string }[] }>(
    "/api/matching/notifications",
  );
  if (version !== accountVersion) return;
  list.replaceChildren();
  if (!notifications.length) list.append(item("No account notifications."));
  for (const notification of notifications)
    list.append(item(notification.message));
}

function clearAccountState(checking = false) {
  ++accountVersion;
  currentProfile = null;
  signedIn.hidden = true;
  signedOut.hidden = checking;
  checkingSignOut.hidden = !checking;
  document.querySelector<HTMLElement>("#account-name")!.textContent = "";
  profileForm.reset();
  profileForm.elements.handle.disabled = false;
  document.querySelector<HTMLElement>("#profile-state")!.textContent = "";
  for (const selector of [
    "#sign-in-methods",
    "#follow-list",
    "#activity-list",
    "#account-notifications",
  ])
    document.querySelector<HTMLElement>(selector)!.replaceChildren();
  for (const target of document.querySelectorAll<HTMLElement>("[data-funds]"))
    target.textContent = "—";
}

window.addEventListener("yap:provider-logout", (event) => {
  const expired: unknown = event instanceof CustomEvent ? event.detail : false;
  endedSessionNotice =
    expired === true
      ? "This session had already ended. Sign in again to continue."
      : "";
  clearAccountState();
  say(
    endedSessionNotice ||
      "Sign in to create a profile and follow people or topics.",
  );
});
window.addEventListener("yap:account-changed", () => void loadAccount());
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void loadAccount();
});
loadAccount();
