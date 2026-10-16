/* global document, window, IntersectionObserver */
import { previewAutoplayAllowed, createHoverIntent } from "./hero-policy.js";
import { createReplayPlayer } from "./media-replay.js";
import { createReplayLibraryLoader } from "./media-replay-library.js";

const root = document.querySelector("[data-featured-preview]");
if (root) {
  const link = root.querySelector("[data-featured-open]"),
    video = root.querySelector("[data-featured-video]"),
    toggle = root.querySelector("[data-featured-toggle]"),
    status = root.querySelector("[data-featured-status]"),
    icon = root.querySelector("[data-featured-toggle-icon]"),
    reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  let ready = false,
    visible = false,
    paused = false,
    manual = false,
    generation = 0,
    active,
    abort,
    budget,
    startup,
    failed = false,
    pageHidden = false;
  const loadHls = createReplayLibraryLoader({
    document,
    source: root.dataset.hlsSource,
    getLibrary: () => window.yapReplayHls,
  });
  const allowed = () =>
    !paused &&
    !failed &&
    ready &&
    visible &&
    !document.hidden &&
    !pageHidden &&
    navigator.onLine !== false &&
    (manual ||
      previewAutoplayAllowed({
        reducedMotion: reduced.matches,
        saveData: navigator.connection?.saveData,
        effectiveType: navigator.connection?.effectiveType,
      }));
  function paint() {
    const running = Boolean(active);
    toggle.setAttribute(
      "aria-label",
      running ? "Pause video preview" : "Play video preview",
    );
    toggle.setAttribute("aria-pressed", String(!running));
    icon.setAttribute("d", running ? "M8 5v14M16 5v14" : "m8 5 11 7-11 7Z");
    if (!running)
      status.textContent = failed ? "Preview unavailable" : "Preview paused";
  }
  const intent = createHoverIntent({
    open: () => {
      root.classList.remove("is-entering");
      if (root.dataset.playing === "true" && !document.hidden && !pageHidden)
        window.location.assign(link.href);
    },
  });
  function cancelIntent() {
    intent.stop();
    root.classList.remove("is-entering");
  }
  function stop() {
    generation++;
    abort?.abort();
    abort = undefined;
    active?.stop();
    active = undefined;
    window.clearTimeout(budget);
    window.clearTimeout(startup);
    budget = undefined;
    startup = undefined;
    root.dataset.playing = "false";
    cancelIntent();
    paint();
  }
  async function start() {
    if (!allowed() || active) {
      paint();
      return;
    }
    const epoch = ++generation;
    abort = new AbortController();
    const signal = abort.signal;
    const request = async (path, options = {}) => {
      const response = await fetch(
        `/api/media/events/${encodeURIComponent(root.dataset.event)}${path}`,
        {
          ...options,
          credentials: "same-origin",
          cache: "no-store",
          signal,
        },
      );
      if (!response.ok)
        throw Object.assign(new Error("Preview unavailable"), {
          status: response.status,
        });
      return response.json();
    };
    const unavailable = () => {
      if (epoch !== generation) return;
      failed = true;
      stop();
    };
    const playing = () => {
      if (epoch !== generation) return;
      window.clearTimeout(startup);
      startup = undefined;
      root.dataset.playing = "true";
      status.textContent = "Muted preview";
      if (!budget)
        budget = window.setTimeout(() => {
          paused = true;
          stop();
        }, 30_000);
    };
    status.textContent = "Loading preview…";
    startup = window.setTimeout(unavailable, 12_000);
    // Mark loading as active so observer/visibility events never start duplicates.
    active = { stop() {} };
    try {
      if (root.dataset.mode === "live") {
        const { createHeroLive } = await import(root.dataset.liveSource);
        if (epoch !== generation) return;
        active = createHeroLive({
          container: root.querySelector("[data-featured-live]"),
          request,
          playing,
          unavailable,
        });
      } else {
        video.muted = true;
        const diagnostics = { start() {}, record() {}, finish() {} };
        const player = createReplayPlayer({
          video,
          loadHls,
          request,
          diagnostics,
          preview: true,
          say: unavailable,
          soundRequired: (required) => {
            if (required) unavailable();
          },
        });
        active = { start: () => player.start(), stop: () => player.destroy() };
        video.onplaying = playing;
      }
      paint();
      await active.start();
    } catch {
      unavailable();
    }
  }
  function reconcile() {
    if (allowed()) void start();
    else stop();
  }
  link.addEventListener("pointerenter", (event) => {
    if (
      event.pointerType !== "mouse" ||
      reduced.matches ||
      root.dataset.playing !== "true"
    )
      return;
    root.classList.add("is-entering");
    intent.start();
  });
  link.addEventListener("pointerleave", cancelIntent);
  link.addEventListener("click", stop);
  window.addEventListener("scroll", cancelIntent, { passive: true });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") cancelIntent();
  });
  toggle.addEventListener("click", () => {
    if (active) {
      paused = true;
      stop();
    } else {
      paused = false;
      failed = false;
      manual = true;
      reconcile();
    }
  });
  document.addEventListener("visibilitychange", reconcile);
  window.addEventListener("offline", reconcile);
  window.addEventListener("online", () => {
    failed = false;
    reconcile();
  });
  reduced.addEventListener("change", () => {
    manual = false;
    reconcile();
  });
  navigator.connection?.addEventListener("change", () => {
    manual = false;
    reconcile();
  });
  window.addEventListener("pagehide", () => {
    pageHidden = true;
    stop();
  });
  window.addEventListener("pageshow", () => {
    pageHidden = false;
    reconcile();
  });
  const observer = new IntersectionObserver(
    ([entry]) => {
      visible = entry.isIntersecting && entry.intersectionRatio >= 0.25;
      reconcile();
    },
    { threshold: [0, 0.25] },
  );
  observer.observe(root);
  function loaded() {
    const begin = () => {
      ready = true;
      reconcile();
    };
    if (window.requestIdleCallback)
      window.requestIdleCallback(begin, { timeout: 1800 });
    else window.setTimeout(begin, 400);
  }
  if (document.readyState === "complete") loaded();
  else window.addEventListener("load", loaded, { once: true });
  paint();
}
