/* global document, window */
const form = document.querySelector("#affiliation-form");
if (form) {
  const status = document.querySelector("#affiliation-status");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    status.textContent = "Saving classification…";
    try {
      const data = Object.fromEntries(new FormData(form));
      const response = await fetch("/api/measurement/affiliations", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(result.error || "Could not save classification.");
      status.textContent = "Saved. Refreshing dashboard…";
      window.location.reload();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}
