// DOM assertions retain the existing server-rendered markup and event-target guarantees.
import type {
  Profile,
  LinkedWallet,
  WalletChangeTarget,
  WalletOperation,
  PendingWalletChange,
  WalletChallenge,
  AccountUser,
  FollowEntry,
  ActivityEntry,
  CollectionPage,
  AccountError,
} from "./account-types.js";
interface ProfileForm extends HTMLFormElement {
  readonly elements: HTMLFormControlsCollection & {
    handle: HTMLInputElement;
    displayName: HTMLInputElement;
    bio: HTMLTextAreaElement;
    publicationState: HTMLSelectElement;
  };
}
interface WalletChangeForm extends HTMLFormElement {
  readonly elements: HTMLFormControlsCollection & {
    credential: HTMLSelectElement;
    password: HTMLInputElement;
  };
}
/* global window, document */
const notice = document.querySelector<HTMLElement>("#account-notice")!;
const signedOut = document.querySelector<HTMLElement>("#signed-out")!;
const signedIn = document.querySelector<HTMLElement>("#signed-in")!;
const profileForm = document.querySelector<ProfileForm>("#profile-form")!;
let currentProfile: Profile | null = null;
let linkedWallets: LinkedWallet[] = [];
let passwordAvailable = false;
let pendingChange: PendingWalletChange | null = null;
let expiryTimer: number | undefined;
const changeDialog =
  document.querySelector<HTMLDialogElement>("#wallet-change")!;
const changeForm = document.querySelector<WalletChangeForm>(
  "#wallet-change-form",
)!;
const changeNotice = document.querySelector<HTMLElement>(
  "#wallet-change-notice",
)!;

function say(message: string) {
  notice.textContent = message;
}

async function api<T = void>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
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
            ? "Too many attempts. Wait before starting a new wallet approval."
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

function walletMessageHex(message: string) {
  const bytes = new TextEncoder().encode(message);
  return (
    "0x" +
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  );
}

async function walletAction(purpose: "login" | "link") {
  const provider = window.ethereum;
  if (!provider?.request) {
    say(
      "No EVM wallet was found. Install or open a wallet browser extension, then try again.",
    );
    return;
  }
  try {
    say("Requesting your wallet address…");
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    const address = accounts?.[0];
    const chainHex = await provider.request({ method: "eth_chainId" });
    const chainId = Number.parseInt(chainHex, 16);
    if (!address || !Number.isSafeInteger(chainId) || chainId < 1)
      throw new Error(
        "Your wallet did not provide a valid account and network.",
      );
    if (purpose === "link") {
      openWalletChange({ purpose, address: address.toLowerCase(), chainId });
      return;
    }
    const base = "/api/auth/wallet/login";
    const challenge = await api<WalletChallenge>(`${base}/challenge`, "POST", {
      address,
      chainId,
    });
    say(
      "Review the sign-in message in your wallet. It does not approve a transaction.",
    );
    const signature = await provider.request({
      method: "personal_sign",
      params: [walletMessageHex(challenge.message), address],
    });
    await api(`${base}/verify`, "POST", {
      challengeId: challenge.id,
      signature,
    });
    say((purpose as string) === "link" ? "Wallet linked." : "Signed in.");
    if (purpose === "login" && returnToRequestedPage()) return;
    await loadAccount();
  } catch (error) {
    say(
      (error as AccountError | null)?.message ||
        "Wallet sign-in failed. Please try again.",
    );
  }
}

function returnToRequestedPage() {
  const next = new URLSearchParams(window.location.search).get("next");
  if (!next?.startsWith("/") || next.startsWith("//") || next.includes("\\"))
    return false;
  const destination = new URL(next, window.location.origin);
  if (destination.origin !== window.location.origin) return false;
  window.location.assign(
    destination.pathname + destination.search + destination.hash,
  );
  return true;
}

async function loadProfile() {
  let profile: Profile | null = null;
  try {
    profile = (await api<{ profile: Profile }>("/api/me/profile")).profile;
  } catch (error) {
    if ((error as AccountError).message !== "profile not found") throw error;
  }
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

async function loadWallets() {
  const list = document.querySelector<HTMLElement>("#wallet-list")!;
  list.replaceChildren();
  const wallets = (await api<{ wallets: LinkedWallet[] }>("/api/auth/wallets"))
    .wallets;
  linkedWallets = wallets;
  if (!wallets.length) list.append(item("No wallet linked yet."));
  for (const wallet of wallets) {
    const row = item(
      `${wallet.address.slice(0, 8)}…${wallet.address.slice(-6)} · chain ${wallet.chainId}`,
    );
    const button = document.createElement("button");
    button.type = "button";
    button.className = "small-button";
    button.textContent = "Unlink";
    button.addEventListener("click", () =>
      openWalletChange({
        purpose: "unlink",
        address: wallet.address,
        chainId: Number(wallet.chainId),
        targetWalletId: wallet.id,
      }),
    );
    row.append(button);
    list.append(row);
  }
}

async function loadCollection<T>(
  path: string,
  selector: string,
  render: (entry: T) => HTMLLIElement,
) {
  const list = document.querySelector<HTMLElement>(selector)!;
  list.replaceChildren();
  let offset = 0;
  async function nextPage() {
    const data = await api<CollectionPage<T>>(
      `${path}?limit=20&offset=${offset}`,
    );
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
  try {
    const { user } = await api<{ user: AccountUser }>("/api/auth/me");
    passwordAvailable = Boolean(user.email);
    signedOut.hidden = true;
    signedIn.hidden = false;
    document.querySelector<HTMLElement>("#account-name")!.textContent =
      user.email || "Wallet account";
    await Promise.all([
      loadProfile(),
      loadWallets(),
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
    say("Account ready.");
  } catch (error) {
    if ((error as AccountError).message === "authentication required") {
      signedIn.hidden = true;
      signedOut.hidden = false;
      say("Sign in to create a profile and follow people or topics.");
      return;
    }
    say((error as AccountError).message);
  }
}

document
  .querySelector<HTMLElement>("#wallet-login")!
  .addEventListener("click", () => walletAction("login"));
document
  .querySelector<HTMLElement>("#wallet-link")!
  .addEventListener("click", () => walletAction("link"));
document
  .querySelector<HTMLElement>("#sign-out")!
  .addEventListener("click", async () => {
    try {
      await api("/api/auth/logout", "POST");
      await loadAccount();
    } catch (error) {
      say((error as AccountError).message);
    }
  });

for (const [formId, path] of [
  ["email-login", "login"],
  ["email-register", "register"],
]) {
  document
    .querySelector<HTMLElement>(`#${formId}`)!
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget as HTMLFormElement);
      try {
        await api(`/api/auth/${path}`, "POST", {
          email: data.get("email"),
          password: data.get("password"),
        });
        if (returnToRequestedPage()) return;
        await loadAccount();
      } catch (error) {
        say((error as AccountError).message);
      }
    });
}

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

async function loadNotifications() {
  const list = document.querySelector<HTMLElement>("#account-notifications")!;
  list.replaceChildren();
  const { notifications } = await api<{ notifications: { message: string }[] }>(
    "/api/matching/notifications",
  );
  if (!notifications.length) list.append(item("No account notifications."));
  for (const notification of notifications)
    list.append(item(notification.message));
}

function resetWalletChange() {
  window.clearTimeout(expiryTimer);
  pendingChange = null;
  changeForm.reset();
  changeForm.hidden = false;
  document.querySelector<HTMLElement>("#new-wallet-proof")!.hidden = true;
}

function openWalletChange(target: WalletChangeTarget) {
  resetWalletChange();
  pendingChange = { target: target! };
  changeNotice.textContent =
    "Verify an existing sign-in method for this change. Approval expires in five minutes.";
  document.querySelector<HTMLElement>("#wallet-change-target")!.textContent =
    `${target.purpose === "link" ? "Link" : "Unlink"} ${target.address} on chain ${target.chainId}`;
  const select = changeForm.elements.credential;
  select.replaceChildren();
  function option(value: string, label: string) {
    const element = document.createElement("option");
    element.value = value;
    element.textContent = label;
    select.append(element);
  }
  if (passwordAvailable) option("password", "Current password");
  for (const wallet of linkedWallets) {
    if (
      wallet.address === target.address &&
      Number(wallet.chainId) === target.chainId
    )
      continue;
    option(wallet.id, `${wallet.address} · chain ${wallet.chainId}`);
  }
  changeForm.querySelector<HTMLButtonElement>(
    'button[type="submit"]',
  )!.disabled = !select.options.length;
  select.disabled = !select.options.length;
  if (!select.options.length)
    changeNotice.textContent =
      target.purpose === "unlink"
        ? "You need another retained sign-in method to unlink this wallet. You cannot remove your last sign-in method."
        : "This wallet cannot approve its own addition. Use your current password or another linked wallet.";
  updateCredentialChoice();
  changeDialog.showModal();
}

function updateCredentialChoice() {
  const password = changeForm.elements.credential.value === "password";
  document.querySelector<HTMLElement>("#current-password-label")!.hidden =
    !password;
  changeForm.elements.password.required = password;
  changeForm.elements.password.value = "";
  const help = document.querySelector<HTMLElement>("#existing-wallet-help")!;
  const wallet = linkedWallets.find(
    (entry) => entry.id === changeForm.elements.credential.value,
  );
  help.hidden = password || !wallet;
  help.textContent = wallet
    ? `Switch your wallet extension to existing wallet ${wallet.address} on chain ${wallet.chainId} before continuing.`
    : "";
}

async function signForWallet(
  message: string,
  address: string,
  chainId: number | string,
) {
  const provider = window.ethereum;
  if (!provider?.request)
    throw new Error("Open your wallet extension to sign this approval.");
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const currentChain = Number.parseInt(
    await provider.request({ method: "eth_chainId" }),
    16,
  );
  if (
    accounts?.[0]?.toLowerCase() !== address.toLowerCase() ||
    currentChain !== Number(chainId)
  )
    throw new Error(
      `Switch your wallet to ${address} on chain ${chainId}, then try again.`,
    );
  return provider.request({
    method: "personal_sign",
    params: [walletMessageHex(message), address],
  });
}

async function finishWalletChange(proposedSignature?: string) {
  const change = pendingChange!;
  await api(
    `/api/auth/wallet/operations/${change.operation!.id}/complete`,
    "POST",
    {
      ...change.target,
      password: change.password,
      authorizationSignature: change.authorizationSignature,
      proposedSignature,
    },
  );
  const action = change.target.purpose;
  changeDialog.close();
  resetWalletChange();
  await loadAccount();
  say(
    action === "link"
      ? "Wallet linked. Your session was renewed."
      : "Wallet unlinked. Other sessions were signed out and your session was renewed.",
  );
}

changeForm.elements.credential.addEventListener(
  "change",
  updateCredentialChoice,
);
changeDialog.addEventListener("close", resetWalletChange);
changeDialog.addEventListener("cancel", resetWalletChange);
document
  .querySelector<HTMLElement>("#cancel-wallet-change")!
  .addEventListener("click", () => changeDialog.close());
changeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = changeForm.querySelector<HTMLButtonElement>(
    'button[type="submit"]',
  )!;
  button.disabled = true;
  try {
    const target = pendingChange!.target;
    const value = changeForm.elements.credential.value;
    const credential =
      value === "password"
        ? { type: "password" }
        : { type: "wallet", walletId: value };
    const operation = await api<WalletOperation>(
      "/api/auth/wallet/operations",
      "POST",
      {
        ...target,
        credential,
      },
    );
    pendingChange!.operation = operation;
    pendingChange!.password =
      value === "password" ? changeForm.elements.password.value : undefined;
    changeForm.elements.password.value = "";
    if (operation.authorizationMessage)
      pendingChange!.authorizationSignature = await signForWallet(
        operation.authorizationMessage,
        operation.authorizingAddress!,
        operation.authorizingChainId!,
      );
    if (target.purpose === "unlink") {
      await finishWalletChange();
      return;
    }
    changeForm.hidden = true;
    document.querySelector<HTMLElement>("#new-wallet-proof")!.hidden = false;
    changeNotice.textContent = `Now switch to the NEW wallet ${target.address} on chain ${target.chainId}. Sign its separate proof to finish linking. Neither signature approves spending.`;
    expiryTimer = window.setTimeout(
      () => {
        changeDialog.close();
        resetWalletChange();
        say(
          "Wallet operation expired. Start again to verify an existing credential.",
        );
      },
      Math.max(0, new Date(operation.expiresAt).getTime() - Date.now()),
    );
  } catch (error) {
    if (pendingChange) {
      delete pendingChange.password;
      delete pendingChange.authorizationSignature;
    }
    changeNotice.textContent =
      (error as AccountError | null)?.message ||
      "Approval rejected. Start again when ready.";
  } finally {
    button.disabled = false;
  }
});
document
  .querySelector<HTMLElement>("#sign-new-wallet")!
  .addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    try {
      const change = pendingChange!;
      const signature = await signForWallet(
        change.operation!.proposedMessage!,
        change.target.address,
        change.target.chainId,
      );
      await finishWalletChange(signature);
    } catch (error) {
      if ((error as AccountError).status) {
        const target = pendingChange?.target;
        resetWalletChange();
        pendingChange = { target: target! };
        updateCredentialChoice();
      }
      changeNotice.textContent =
        (error as AccountError | null)?.message ||
        "Signature rejected. Try again before approval expires.";
    } finally {
      button.disabled = false;
    }
  });

loadAccount();
