/* global document, window */
for (const [id, path, retainCurrent] of [
  ["sign-out-all", "logout-all", false],
  ["sign-out-others", "logout-other-sessions", true],
]) {
  document.querySelector(`#${id}`)?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const notice = document.querySelector("#account-notice");
    const message = retainCurrent
      ? "Sign out every other session? This device will stay signed in."
      : "Sign out all sessions, including this device? You will need to sign in again.";
    if (!window.confirm(message)) return;
    button.disabled = true;
    try {
      const response = await fetch(`/api/auth/${path}`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error || "Sign-out failed. Please try again.");
      }
      if (retainCurrent) {
        notice.textContent =
          "Other sessions signed out. This device is still signed in.";
      } else {
        document.querySelector("#signed-in").hidden = true;
        document.querySelector("#signed-out").hidden = false;
        notice.textContent =
          "All sessions signed out, including this device. Sign in again to continue.";
      }
    } catch (error) {
      notice.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}
