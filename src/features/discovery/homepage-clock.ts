// A single elapsed-time clock drives both the progress fill and advancement.
// Browser effects are injected so pause/resume and repeated cycles are testable.
export function createRotationClock({
  duration = 6500,
  now,
  frame,
  cancel,
  progress,
  advance,
}: {
  duration?: number;
  now: () => number;
  frame: (callback: () => void) => number;
  cancel: (id: number) => void;
  progress: (fraction: number) => void;
  advance: () => void;
}) {
  let elapsed = 0,
    started: number | null = null,
    request: number | null = null,
    destroyed = false;
  const fraction = () =>
    Math.min(
      1,
      (elapsed + (started === null ? 0 : now() - started)) / duration,
    );
  function tick() {
    request = null;
    if (destroyed || started === null) return;
    const value = fraction();
    progress(value);
    if (value >= 1) {
      elapsed = 0;
      started = null;
      advance();
    } else request = frame(tick);
  }
  function pause() {
    if (started !== null) {
      elapsed = Math.min(duration, elapsed + now() - started);
      started = null;
    }
    if (request !== null) cancel(request);
    request = null;
    progress(fraction());
  }
  return {
    pause,
    resume() {
      if (destroyed || started !== null) return;
      started = now();
      request = frame(tick);
    },
    reset() {
      pause();
      elapsed = 0;
      progress(0);
    },
    fraction,
    destroy() {
      pause();
      destroyed = true;
    },
  };
}
