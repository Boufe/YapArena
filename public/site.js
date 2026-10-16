/* global window, document */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

const headerBalance = document.querySelector("[data-header-balance]");
if (headerBalance) {
  const reserved = document.querySelector("[data-header-reserved]");
  const avatar = document.querySelector("[data-header-account]");
  const coins = (value) => {
    const n = BigInt(value);
    return `${n / 1000000n}.${String(n % 1000000n)
      .padStart(6, "0")
      .slice(0, 2)} YC`;
  };
  function showBalance(value) {
    headerBalance.textContent = value ? coins(value.available) : "Yap Coins";
    reserved.textContent = value
      ? `${value.scope} · reserved ${coins(value.reserved)}`
      : "Sign in to view balances.";
  }
  async function refreshHeader() {
    try {
      const auth = await fetch("/api/auth/me", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!auth.ok) {
        showBalance(null);
        avatar.textContent = "↗";
        return;
      }
      avatar.textContent = "You";
      const profileResponse = await fetch("/api/me/profile", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (profileResponse.ok) {
        const { profile } = await profileResponse.json();
        if (profile?.displayName)
          avatar.textContent = profile.displayName
            .trim()
            .split(/\s+/)
            .slice(0, 2)
            .map((part) => part[0])
            .join("")
            .toUpperCase();
      }
      avatar.setAttribute("aria-label", "Your signed-in account");
      if (document.querySelector("[data-a4-inline]")) return;
      const response = await fetch("/api/a4/wallet", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) {
        showBalance(null);
        return;
      }
      const result = await response.json();
      showBalance({
        available:
          result.balances.find((b) => b.kind === "available")?.amount ?? "0",
        reserved:
          result.balances.find((b) => b.kind === "reserved")?.amount ?? "0",
        scope: "Ordinary balance",
      });
    } catch {
      showBalance(null);
    }
  }
  window.addEventListener("yap:balance", (event) => showBalance(event.detail));
  window.addEventListener("focus", refreshHeader);
  setInterval(() => {
    if (!document.hidden) void refreshHeader();
  }, 45000);
  void refreshHeader();
}

// One shared follow controller handles initial and progressively inserted controls.
const followReads = new Map();
const initializedFollows = new WeakMap();
const followKey = (type, slug) => `${type}/${slug}`;
function readFollow(type, slug) {
  const key = followKey(type, slug);
  if (!followReads.has(key)) {
    const read = fetch(`/api/me/follows/${type}/${encodeURIComponent(slug)}`, {
      credentials: "same-origin",
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok)
          throw Object.assign(new Error("Follow status unavailable"), {
            status: response.status,
          });
        return Boolean((await response.json()).following);
      })
      .catch((error) => {
        followReads.delete(key);
        throw error;
      });
    followReads.set(key, read);
  }
  return followReads.get(key);
}
function initializeFollows(scope = document) {
  for (const button of scope.querySelectorAll(".follow-button")) {
    if (initializedFollows.has(button)) continue;
    const type = button.dataset.followType,
      slug = button.dataset.followSlug;
    const endpoint = `/api/me/follows/${type}/${encodeURIComponent(slug)}`;
    const message = button.nextElementSibling;
    let following = false;
    function label() {
      button.setAttribute("aria-pressed", String(following));
      button.textContent = button.dataset.followCompact
        ? following
          ? "✓ Following"
          : "+ Follow"
        : `${following ? "Following" : "Follow"} ${type === "topics" ? "topic" : "person"}`;
    }
    readFollow(type, slug)
      .then((value) => {
        following = value;
        label();
      })
      .catch(() => {});
    initializedFollows.set(button, {
      set(value) {
        following = value;
        label();
      },
    });
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const response = await fetch(endpoint, {
          method: following ? "DELETE" : "PUT",
          credentials: "same-origin",
        });
        if (response.status === 401) {
          window.location.assign(
            `/account?next=${encodeURIComponent(window.location.pathname)}`,
          );
          return;
        }
        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || "Could not update follow.");
        }
        following = !following;
        followReads.set(followKey(type, slug), Promise.resolve(following));
        label();
        message.textContent = following
          ? "Added to your follows."
          : "Removed from your follows.";
        window.dispatchEvent(
          new CustomEvent("yap:follow", { detail: { type, slug, following } }),
        );
      } catch (error) {
        message.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
  }
}
window.addEventListener("yap:follow", (event) => {
  for (const button of document.querySelectorAll(".follow-button")) {
    if (
      button.dataset.followType === event.detail.type &&
      button.dataset.followSlug === event.detail.slug
    )
      initializedFollows.get(button)?.set(event.detail.following);
  }
});
window.yapFollows = { initialize: initializeFollows, read: readFollow };
initializeFollows();
