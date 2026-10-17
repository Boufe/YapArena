import type { MediaRequest, MediaResponse } from "./media-types.js";
import type { createHeroLive as CreateHeroLive } from "./hero-live.js";

/* global document, window, IntersectionObserver */
import {
  previewAutoplayAllowed,
  createHoverIntent,
  selectPreview,
} from "./hero-policy.js";
import { createReplayPlayer } from "./media-replay.js";
import { createReplayLibraryLoader } from "./media-replay-library.js";

const roots = [
  ...document.querySelectorAll<HTMLElement>("[data-debate-preview]"),
];
if (roots.length) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const loadHls = createReplayLibraryLoader({
    document,
    source: roots[0]!.dataset.hlsSource!,
    getLibrary: () => window.yapReplayHls,
  });
  let ready = false,
    pageHidden = false,
    preferred: ReturnType<typeof createPreview> | undefined,
    current: ReturnType<typeof createPreview> | undefined;

  // The server-rendered preview template supplies these typed controls.
  function createPreview(root: HTMLElement) {
    const link = root.querySelector<HTMLAnchorElement>("[data-preview-open]")!,
      thumbnail = root.querySelector<HTMLImageElement>(
        "[data-preview-thumbnail]",
      )!,
      video = root.querySelector<HTMLVideoElement>("[data-preview-video]")!,
      toggle = root.querySelector<HTMLButtonElement>("[data-preview-toggle]")!,
      status = root.querySelector<HTMLElement>("[data-preview-status]")!,
      icon = root.querySelector<SVGPathElement>("[data-preview-toggle-icon]")!,
      hero = root.hasAttribute("data-featured-preview");
    let paused = false,
      manual = false,
      hovering = false,
      generation = 0,
      active: { start?(): Promise<void>; stop(): void } | undefined,
      abort: AbortController | undefined,
      budget: number | undefined,
      startup: number | undefined,
      thumbnailTimer: number | undefined,
      thumbnailRetries = 0,
      failed = false;
    const preview = {
      root,
      ratio: 0,
      eligible() {
        return (
          !paused &&
          !failed &&
          ready &&
          preview.ratio >= (hero ? 0.25 : 0.5) &&
          !document.hidden &&
          !pageHidden &&
          navigator.onLine !== false &&
          (manual ||
            previewAutoplayAllowed({
              reducedMotion: reduced.matches,
              saveData: navigator.connection?.saveData,
              effectiveType: navigator.connection?.effectiveType,
            }))
        );
      },
      start,
      stop,
      retryThumbnail,
      cancelIntent,
      resetPolicy() {
        manual = false;
      },
      retry() {
        failed = false;
      },
    };
    function retryThumbnail() {
      if (
        !thumbnail.hidden ||
        thumbnailTimer ||
        pageHidden ||
        document.hidden ||
        preview.ratio <= 0 ||
        thumbnailRetries >= 3
      )
        return;
      thumbnailTimer = window.setTimeout(() => {
        thumbnailTimer = undefined;
        if (pageHidden || document.hidden || preview.ratio <= 0) return;
        thumbnailRetries++;
        const source = new URL(thumbnail.src);
        source.searchParams.set("retry", String(thumbnailRetries));
        thumbnail.src = source.href;
      }, 5000);
    }
    thumbnail.addEventListener("load", () => {
      thumbnail.hidden = false;
      window.clearTimeout(thumbnailTimer);
      thumbnailTimer = undefined;
    });
    thumbnail.addEventListener("error", () => {
      thumbnail.hidden = true;
      retryThumbnail();
    });
    if (thumbnail.complete && !thumbnail.naturalWidth) thumbnail.hidden = true;
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
    function pauseIntent() {
      intent.stop();
      root.classList.remove("is-entering");
    }
    function cancelIntent() {
      hovering = false;
      pauseIntent();
    }
    function beginIntent() {
      if (
        !hero ||
        !hovering ||
        reduced.matches ||
        root.dataset.playing !== "true" ||
        root.classList.contains("is-entering")
      )
        return;
      root.classList.add("is-entering");
      intent.start();
    }
    function stop() {
      generation++;
      abort?.abort();
      abort = undefined;
      const player = active;
      active = undefined;
      root.dataset.playing = "false";
      root.dataset.active = "false";
      player?.stop();
      window.clearTimeout(budget);
      window.clearTimeout(startup);
      window.clearTimeout(thumbnailTimer);
      thumbnailTimer = budget = startup = undefined;
      cancelIntent();
      paint();
    }
    async function start() {
      if (!preview.eligible() || active) return;
      const epoch = ++generation;
      abort = new AbortController();
      const signal = abort.signal;
      const request: MediaRequest = async <Path extends string>(
        path: Path,
        options: RequestInit = {},
      ): Promise<MediaResponse<Path>> => {
        const response = await fetch(
          `/api/media/events/${encodeURIComponent(root.dataset.event!)}${path}`,
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
        return response.json() as Promise<MediaResponse<Path>>;
      };
      const unavailable = () => {
        if (epoch !== generation) return;
        failed = true;
        stop();
        reconcile();
      };
      const playing = () => {
        if (epoch !== generation) return;
        window.clearTimeout(startup);
        startup = undefined;
        root.dataset.playing = "true";
        status.textContent = "Muted preview";
        beginIntent();
        // The hero keeps its short teaser budget; a selected card loops until
        // it leaves view or another card is selected. Only one transport runs.
        if (hero && !budget)
          budget = window.setTimeout(() => {
            paused = true;
            reconcile();
          }, 30_000);
      };
      status.textContent = "Loading preview…";
      startup = window.setTimeout(unavailable, 12_000);
      active = { stop() {} };
      root.dataset.active = "true";
      try {
        if (root.dataset.mode === "live") {
          const { createHeroLive } = (await import(
            root.dataset.liveSource!
          )) as { createHeroLive: typeof CreateHeroLive };
          if (epoch !== generation) return;
          active = createHeroLive({
            container: root.querySelector<HTMLElement>("[data-preview-live]")!,
            request,
            playing,
            unavailable,
          });
        } else {
          video.muted = true;
          video.loop = true;
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
          active = {
            start: () => player.start(),
            stop: () => player.destroy(),
          };
          video.onplaying = playing;
        }
        paint();
        await active!.start!();
      } catch {
        unavailable();
      }
    }
    root.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "mouse") return;
      preferred = preview;
      reconcile();
    });
    root.addEventListener("pointerleave", () => {
      if (preferred === preview && !root.contains(document.activeElement))
        preferred = undefined;
    });
    root.addEventListener("focusin", () => {
      preferred = preview;
      reconcile();
    });
    root.addEventListener("focusout", (event) => {
      if (
        preferred === preview &&
        !root.contains(event.relatedTarget as Node | null)
      )
        preferred = undefined;
    });
    link.addEventListener("pointerenter", (event) => {
      hovering = event.pointerType === "mouse";
      beginIntent();
    });
    link.addEventListener("pointerleave", cancelIntent);
    link.addEventListener("click", () => {
      paused = true;
      stop();
    });
    toggle.addEventListener("click", () => {
      if (active) paused = true;
      else {
        paused = failed = false;
        manual = true;
        preferred = preview;
      }
      reconcile();
    });
    video.addEventListener("waiting", () => {
      root.dataset.playing = "false";
      pauseIntent();
    });
    video.addEventListener("pause", () => {
      if (root.dataset.playing === "true" && active) {
        paused = true;
        reconcile();
      }
    });
    paint();
    return preview;
  }
  const previews = roots.map(createPreview);
  const byRoot = new Map(previews.map((preview) => [preview.root, preview]));
  function reconcile() {
    const next = selectPreview(previews, current, preferred);
    if (current !== next) {
      current?.stop();
      current = next;
      if (current) void current.start();
    }
    for (const preview of previews) preview.retryThumbnail();
  }
  const cancelIntents = () =>
    previews.forEach((preview) => preview.cancelIntent());
  window.addEventListener("scroll", cancelIntents, { passive: true });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") cancelIntents();
  });
  document.addEventListener("visibilitychange", reconcile);
  window.addEventListener("offline", reconcile);
  window.addEventListener("online", () => {
    previews.forEach((preview) => preview.retry());
    reconcile();
  });
  const policyChanged = () => {
    previews.forEach((preview) => preview.resetPolicy());
    reconcile();
  };
  reduced.addEventListener("change", policyChanged);
  navigator.connection?.addEventListener("change", policyChanged);
  window.addEventListener("pagehide", () => {
    pageHidden = true;
    // Also clears thumbnail retries for inactive cards.
    previews.forEach((preview) => preview.stop());
    current = undefined;
  });
  window.addEventListener("pageshow", () => {
    pageHidden = false;
    reconcile();
  });
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        byRoot.get(entry.target as HTMLElement)!.ratio = entry.isIntersecting
          ? entry.intersectionRatio
          : 0;
      }
      reconcile();
    },
    { threshold: [0, 0.25, 0.5, 0.75, 1] },
  );
  roots.forEach((root) => observer.observe(root));
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
}
