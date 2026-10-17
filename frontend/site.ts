interface HeaderBalance {
  available: string;
  reserved: string;
  scope: string;
}
interface FollowDetail {
  type: string;
  slug: string;
  following: boolean;
}
declare global {
  interface Window {
    yapFollows: {
      initialize(scope?: ParentNode): void;
      read(type: string, slug: string): Promise<boolean>;
    };
  }
  interface WindowEventMap {
    "yap:balance": CustomEvent<HeaderBalance | null>;
    "yap:follow": CustomEvent<FollowDetail>;
  }
}
/* global window, document */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

const headerBalance = document.querySelector<HTMLElement>(
  "[data-header-balance]",
)!;
if (headerBalance) {
  const reserved = document.querySelector<HTMLElement>(
    "[data-header-reserved]",
  )!;
  const avatar = document.querySelector<HTMLElement>("[data-header-account]")!;
  const coins = (value: string) => {
    const n = BigInt(value);
    return `${n / 1000000n}.${String(n % 1000000n)
      .padStart(6, "0")
      .slice(0, 2)} YC`;
  };
  function showBalance(value: HeaderBalance | null) {
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
        const { profile }: { profile: { displayName: string } | null } =
          await profileResponse.json();
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
      const result: { balances: { kind: string; amount: string }[] } =
        await response.json();
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
const followReads = new Map<string, Promise<boolean>>();
const initializedFollows = new WeakMap<
  Element,
  { set(value: boolean): void }
>();
const followKey = (type: string, slug: string) => `${type}/${slug}`;
function readFollow(type: string, slug: string) {
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
        return Boolean(
          ((await response.json()) as { following: boolean }).following,
        );
      })
      .catch((error: unknown) => {
        followReads.delete(key);
        throw error;
      });
    followReads.set(key, read);
  }
  return followReads.get(key)!;
}
function initializeFollows(scope: ParentNode = document) {
  for (const button of scope.querySelectorAll<HTMLButtonElement>(
    ".follow-button",
  )) {
    if (initializedFollows.has(button)) continue;
    const type = button.dataset.followType!,
      slug = button.dataset.followSlug!;
    const endpoint = `/api/me/follows/${type}/${encodeURIComponent(slug)}`;
    const message = button.nextElementSibling!;
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
          const data: { error?: string } = await response.json();
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
        message.textContent = (error as Error).message;
      } finally {
        button.disabled = false;
      }
    });
  }
}
window.addEventListener("yap:follow", (event) => {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    ".follow-button",
  )) {
    if (
      button.dataset.followType === event.detail.type &&
      button.dataset.followSlug === event.detail.slug
    )
      initializedFollows.get(button)?.set(event.detail.following);
  }
});
window.yapFollows = { initialize: initializeFollows, read: readFollow };
initializeFollows();
