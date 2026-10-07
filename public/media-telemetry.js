const events = new Set([
  "attempt",
  "first_video_frame",
  "first_audio_playback_proxy",
  "outcome",
  "authorization",
  "sound_activation_required",
  "sound_activation_tap",
  "interruption_start",
  "interruption_end",
  "restoration_playback",
  "recovery_stable",
  "active_viewing_sample",
]);
const fields = [
  "elapsedMs",
  "durationMs",
  "outcome",
  "kind",
  "cause",
  "videoStarted",
  "audioStarted",
];
export function playbackDimensions(userAgent) {
  return {
    browser: /Firefox\//.test(userAgent)
      ? "firefox"
      : /Chrome\/|CriOS\//.test(userAgent)
        ? "chrome"
        : /Safari\//.test(userAgent)
          ? "safari"
          : "other",
    device: /iPhone/.test(userAgent)
      ? "iphone"
      : /Android/.test(userAgent)
        ? "android"
        : /Macintosh|Windows|Linux/.test(userAgent)
          ? "desktop"
          : "other",
  };
}
export function createPlaybackReporter({ send, dimensions, schedule, cancel }) {
  let queue = [];
  let prepared = false;
  let timer;
  let stopped = false;
  let sending = false;
  let dropped = 0;
  async function flush() {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
    if (sending || !queue.length) return;
    sending = true;
    const batch = queue.splice(0, 32);
    try {
      await send(batch);
    } catch {
      dropped += batch.length;
    } finally {
      sending = false;
      if (queue.length && !stopped) timer = schedule(flush, 5000);
    }
  }
  return {
    record(row) {
      if (stopped || !row.mode || !events.has(row.event)) return;
      if (row.event === "attempt") prepared = row.prepared;
      const report = {
        event: row.event,
        mode: row.mode,
        prepared,
        ...dimensions,
      };
      for (const field of fields)
        if (row[field] !== undefined) report[field] = row[field];
      if (queue.length >= 64) {
        dropped++;
        return;
      }
      queue.push(report);
      if (timer === undefined && !sending) timer = schedule(flush, 5000);
    },
    flush,
    stop() {
      stopped = true;
      if (timer !== undefined) cancel(timer);
      timer = undefined;
      void flush();
    },
    get dropped() {
      return dropped;
    },
  };
}
