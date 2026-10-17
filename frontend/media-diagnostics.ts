import type {
  DiagnosticRow,
  DiagnosticValues,
  MediaKind,
  PlaybackElement,
  PlaybackMode,
} from "./media-types.js";

export function createMediaDiagnostics({
  now = () => performance.now(),
  limit = 10000,
} = {}) {
  const records: DiagnosticRow[] = [];
  let attempt:
    | {
        id: number;
        mode: PlaybackMode;
        prepared: boolean;
        tap: number;
        video: boolean;
        audio: boolean;
      }
    | undefined;
  let nextId = 0;
  let dropped = 0;
  let restoration:
    { at: number; trigger: string; video: boolean; audio: boolean } | undefined;
  let subscriber: ((row: DiagnosticRow) => void) | undefined;
  function record(event: string, values: DiagnosticValues = {}) {
    if (["network_restored", "foreground"].includes(event))
      restoration = { at: now(), trigger: event, video: false, audio: false };
    if (records.length >= limit) {
      records.shift();
      dropped++;
    }
    const row = {
      version: 1,
      at: now(),
      attempt: attempt?.id,
      mode: attempt?.mode,
      event,
      ...values,
    };
    records.push(row);
    subscriber?.(row);
  }
  return {
    get attemptId() {
      return attempt?.id;
    },
    record,
    subscribe(callback: (row: DiagnosticRow) => void) {
      subscriber = callback;
    },
    start(mode: PlaybackMode, prepared: boolean) {
      this.finish("abandoned");
      attempt = {
        id: ++nextId,
        mode,
        prepared,
        tap: now(),
        video: false,
        audio: false,
      };
      record("attempt", { prepared });
    },
    frame(kind: MediaKind) {
      if (restoration && !restoration[kind]) {
        restoration[kind] = true;
        record("restoration_playback", {
          kind,
          trigger: restoration.trigger,
          elapsedMs: now() - restoration.at,
        });
      }
      if (!attempt || attempt[kind]) return;
      attempt[kind] = true;
      record(
        kind === "video" ? "first_video_frame" : "first_audio_playback_proxy",
        { elapsedMs: now() - attempt.tap },
      );
    },
    finish(outcome: string) {
      if (!attempt) return;
      record("outcome", {
        outcome,
        videoStarted: attempt.video,
        audioStarted: attempt.audio,
        elapsedMs: now() - attempt.tap,
      });
      attempt = undefined;
    },
    export() {
      return {
        schema: "yaparena-playback-v1",
        dropped,
        records: records.map((row) => ({ ...row })),
      };
    },
  };
}

export function observePlayback(
  node: PlaybackElement,
  {
    kind,
    expected = () => true,
    diagnostics,
    now = () => performance.now(),
    schedule = setInterval,
    cancel = clearInterval,
    onProgress = () => {},
    onInterruption = () => {},
  }: {
    kind: MediaKind;
    expected?: () => boolean;
    diagnostics: ReturnType<typeof createMediaDiagnostics>;
    now?: () => number;
    schedule?: (callback: () => void, delay: number) => number;
    cancel?: (timer: number) => void;
    onProgress?: (at: number) => void;
    onInterruption?: () => void;
  },
) {
  let lastTime = node.currentTime;
  let lastProgress = now();
  let interruption: number | undefined;
  let interruptionEvent: string | undefined;
  let first = false;
  let frameCallback: number | undefined;
  let previousSample = now();
  let observedAttempt: number | undefined;
  function resetAttempt() {
    if (observedAttempt !== diagnostics.attemptId) {
      observedAttempt = diagnostics.attemptId;
      first = false;
      interruption = undefined;
      lastProgress = now();
    }
  }
  const handlers: [string, EventListener][] = [];
  const emit = (event: string, detail: DiagnosticValues = {}) =>
    diagnostics.record(event, { kind, ...detail });
  function listen(event: string, fn: EventListener) {
    node.addEventListener(event, fn);
    handlers.push([event, fn]);
  }
  function active() {
    return (
      expected() &&
      !node.paused &&
      !node.ended &&
      !node.seeking &&
      (kind !== "audio" || (!node.muted && node.volume > 0))
    );
  }
  function resume() {
    if (interruption !== undefined) {
      emit("interruption_end", {
        durationMs: now() - interruption,
        cause: interruptionEvent,
      });
      interruption = undefined;
    }
  }
  function progress() {
    resetAttempt();
    if (!active()) return;
    lastProgress = now();
    resume();
    first = true;
    diagnostics.frame(kind);
    onProgress(lastProgress);
  }
  function rendered() {
    progress();
    frameCallback = node.requestVideoFrameCallback!(rendered);
  }
  if (kind === "video" && node.requestVideoFrameCallback)
    frameCallback = node.requestVideoFrameCallback!(rendered);
  listen("timeupdate", () => {
    if (node.currentTime !== lastTime) {
      if (kind === "audio") progress();
      else if (!node.requestVideoFrameCallback) emit("video_progress_proxy");
      lastTime = node.currentTime;
    }
  });
  function interrupt(cause: string) {
    onInterruption();
    resetAttempt();
    if (!first) {
      if (active()) emit("startup_wait", { cause });
      return;
    }
    if (!active() || interruption !== undefined) return;
    interruption = now();
    interruptionEvent = cause;
    emit("interruption_start", { cause });
  }
  listen("waiting", () => interrupt("buffering"));
  listen("stalled", () => interrupt("stalled"));
  listen("pause", () => {
    onInterruption();
    resume();
    emit("intentional_pause");
  });
  listen("seeking", () => {
    onInterruption();
    resume();
    emit("seek");
  });
  listen("error", () => {
    onInterruption();
    emit("media_element_error", { code: node.error?.code });
  });
  const timer = schedule(() => {
    const sampleAt = now();
    if (active() && first)
      emit("active_viewing_sample", {
        durationMs: Math.min(1000, sampleAt - previousSample),
      });
    previousSample = sampleAt;
    if (!active()) {
      onInterruption();
      resume();
      lastProgress = now();
      return;
    }
    if (first && now() - lastProgress > 3000)
      interrupt(kind === "audio" ? "audio_loss_suspected" : "freeze_suspected");
  }, 1000);
  return () => {
    onInterruption();
    resume();
    cancel(timer);
    if (frameCallback !== undefined)
      node.cancelVideoFrameCallback!(frameCallback);
    for (const [event, fn] of handlers) node.removeEventListener(event, fn);
  };
}
