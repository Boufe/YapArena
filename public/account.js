/* global window, document */
const notice = document.querySelector("#account-notice");
const signedOut = document.querySelector("#signed-out");
const signedIn = document.querySelector("#signed-in");
const profileForm = document.querySelector("#profile-form");
let currentProfile = null;

function say(message) {
  notice.textContent = message;
}

async function api(path, method = "GET", body) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || "Request failed. Please try again.");
  return data;
}

function item(text, href) {
  const row = document.createElement("li");
  const content = href
    ? document.createElement("a")
    : document.createElement("span");
  content.textContent = text;
  if (href) content.href = href;
  row.append(content);
  return row;
}

async function walletAction(purpose) {
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
    const base =
      purpose === "link" ? "/api/auth/wallet/link" : "/api/auth/wallet/login";
    const challenge = await api(`${base}/challenge`, "POST", {
      address,
      chainId,
    });
    say(
      "Review the sign-in message in your wallet. It does not approve a transaction.",
    );
    const signature = await provider.request({
      method: "personal_sign",
      params: [challenge.message, address],
    });
    await api(`${base}/verify`, "POST", {
      challengeId: challenge.id,
      signature,
    });
    say(purpose === "link" ? "Wallet linked." : "Signed in.");
    if (purpose === "login" && returnToRequestedPage()) return;
    await loadAccount();
  } catch (error) {
    say(error?.message || "Wallet sign-in failed. Please try again.");
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
  let profile = null;
  try {
    profile = (await api("/api/me/profile")).profile;
  } catch (error) {
    if (error.message !== "profile not found") throw error;
  }
  currentProfile = profile;
  profileForm.elements.handle.value = profile?.handle ?? "";
  profileForm.elements.handle.disabled = Boolean(profile);
  profileForm.elements.displayName.value = profile?.displayName ?? "";
  profileForm.elements.bio.value = profile?.bio ?? "";
  profileForm.elements.publicationState.value =
    profile?.publicationState === "published" ? "published" : "draft";
  document.querySelector("#profile-state").textContent = profile
    ? profile.publicationState === "hidden"
      ? "Your profile is restricted. Contact support before publishing."
      : `@${profile.handle} · ${profile.publicationState}`
    : "Create a private draft. You decide when to publish it.";
  profileForm.querySelector('button[type="submit"]').disabled =
    profile?.publicationState === "hidden";
}

async function loadWallets() {
  const list = document.querySelector("#wallet-list");
  list.replaceChildren();
  const wallets = (await api("/api/auth/wallets")).wallets;
  if (!wallets.length) list.append(item("No wallet linked yet."));
  for (const wallet of wallets) {
    const row = item(
      `${wallet.address.slice(0, 8)}…${wallet.address.slice(-6)} · chain ${wallet.chainId}`,
    );
    const button = document.createElement("button");
    button.type = "button";
    button.className = "small-button";
    button.textContent = "Unlink";
    button.addEventListener("click", async () => {
      if (
        !window.confirm(
          "Unlink this wallet? All sessions, including this device, will be signed out. Sign in again with a remaining credential.",
        )
      )
        return;
      try {
        await api(
          `/api/auth/wallets/${encodeURIComponent(wallet.id)}`,
          "DELETE",
        );
        await loadAccount();
        say(
          "Wallet unlinked. All sessions signed out. Sign in with a remaining credential.",
        );
      } catch (error) {
        say(error.message);
      }
    });
    row.append(button);
    list.append(row);
  }
}

async function loadCollection(path, selector, render) {
  const list = document.querySelector(selector);
  list.replaceChildren();
  let offset = 0;
  async function nextPage() {
    const data = await api(`${path}?limit=20&offset=${offset}`);
    if (!offset && !data.items.length) list.append(item("Nothing here yet."));
    for (const entry of data.items) list.append(render(entry));
    offset += data.items.length;
    const oldButton = list.querySelector(".load-more");
    oldButton?.remove();
    if (data.pagination.hasMore) {
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "small-button load-more";
      button.textContent = "Load more";
      button.addEventListener("click", () =>
        nextPage().catch((error) => say(error.message)),
      );
      row.append(button);
      list.append(row);
    }
  }
  await nextPage();
}

async function loadAccount() {
  try {
    const { user } = await api("/api/auth/me");
    signedOut.hidden = true;
    signedIn.hidden = false;
    document.querySelector("#account-name").textContent =
      user.email || "Wallet account";
    await Promise.all([
      loadProfile(),
      loadWallets(),
      loadCollection("/api/me/follows", "#follow-list", (entry) =>
        item(
          `${entry.targetType === "topic" ? "Topic" : "Person"}: ${entry.title}`,
          entry.targetType === "topic"
            ? `/topics/${encodeURIComponent(entry.slug)}`
            : `/people/${encodeURIComponent(entry.slug)}`,
        ),
      ),
      loadCollection("/api/me/activity", "#activity-list", (entry) =>
        item(
          `${entry.eventType.replace(".", " ")} · ${new Date(entry.occurredAt).toLocaleDateString()}`,
        ),
      ),
    ]);
    say("Account ready.");
  } catch (error) {
    if (error.message === "authentication required") {
      signedIn.hidden = true;
      signedOut.hidden = false;
      say("Sign in to create a profile and follow people or topics.");
      return;
    }
    say(error.message);
  }
}

document
  .querySelector("#wallet-login")
  .addEventListener("click", () => walletAction("login"));
document
  .querySelector("#wallet-link")
  .addEventListener("click", () => walletAction("link"));
document.querySelector("#sign-out").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", "POST");
    await loadAccount();
  } catch (error) {
    say(error.message);
  }
});

for (const [formId, path] of [
  ["email-login", "login"],
  ["email-register", "register"],
]) {
  document
    .querySelector(`#${formId}`)
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      try {
        await api(`/api/auth/${path}`, "POST", {
          email: data.get("email"),
          password: data.get("password"),
        });
        if (returnToRequestedPage()) return;
        await loadAccount();
      } catch (error) {
        say(error.message);
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
    say(error.message);
  }
});

loadAccount();
