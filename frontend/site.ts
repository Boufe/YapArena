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
          const returnTo =
            window.location.pathname +
            window.location.search +
            window.location.hash;
          if (
            window.dispatchEvent(
              new CustomEvent("yap:request-auth", {
                cancelable: true,
                detail: { returnTo },
              }),
            )
          )
            window.location.assign(
              `/account?next=${encodeURIComponent(returnTo)}`,
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

// Retain the current round/action when this page's sign-in link returns here.
document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const link = event.target.closest<HTMLAnchorElement>(
    'a[href^="/account?next="]',
  );
  if (!link) return;
  const account = new URL(link.href, window.location.origin);
  const next = account.searchParams.get("next");
  if (!next?.startsWith("/") || next.startsWith("//") || next.includes("\\"))
    return;
  const destination = new URL(next, window.location.origin);
  if (
    destination.origin === window.location.origin &&
    destination.pathname === window.location.pathname
  ) {
    account.searchParams.set(
      "next",
      window.location.pathname + window.location.search + window.location.hash,
    );
    link.href = account.pathname + account.search;
  }
});
