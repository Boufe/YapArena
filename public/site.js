/* global window, document */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

for (const button of document.querySelectorAll(".follow-button")) {
  const type = button.dataset.followType;
  const slug = button.dataset.followSlug;
  const endpoint = `/api/me/follows/${type}/${encodeURIComponent(slug)}`;
  const message = button.nextElementSibling;
  let following = false;
  const label = () => {
    button.setAttribute("aria-pressed", String(following));
    button.textContent = `${following ? "Following" : "Follow"} ${type === "topics" ? "topic" : "person"}`;
  };
  fetch(endpoint, { credentials: "same-origin" })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      following = Boolean(data?.following);
      label();
    })
    .catch(() => {});
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
      label();
      message.textContent = following
        ? "Added to your follows."
        : "Removed from your follows.";
    } catch (error) {
      message.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}
