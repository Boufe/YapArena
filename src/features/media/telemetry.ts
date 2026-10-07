import { Counter, Histogram, type Registry } from "prom-client";

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
const outcomes = new Set([
  "allowed",
  "denied",
  "technical_error",
  "abandoned",
  "authorization_denied",
  "technical_failure",
  "voluntary_leave",
  "debate_ended",
  "stopped",
  "completed",
]);
const causes = new Set([
  "buffering",
  "stalled",
  "audio_loss_suspected",
  "freeze_suspected",
]);
const keys = new Set([
  "event",
  "mode",
  "prepared",
  "browser",
  "device",
  "elapsedMs",
  "durationMs",
  "outcome",
  "kind",
  "cause",
  "videoStarted",
  "audioStarted",
]);
export interface PlaybackReport {
  event: string;
  mode: "live" | "replay" | "speaker";
  prepared: boolean;
  browser: "safari" | "chrome" | "firefox" | "other";
  device: "iphone" | "android" | "desktop" | "other";
  elapsedMs?: number;
  durationMs?: number;
  outcome?: string;
  kind?: "video" | "audio";
  cause?: string;
  videoStarted?: boolean;
  audioStarted?: boolean;
}
export function parsePlaybackReports(value: unknown): PlaybackReport[] | null {
  if (!Array.isArray(value) || !value.length || value.length > 32) return null;
  for (const row of value) {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      Object.keys(row).some((key) => !keys.has(key))
    )
      return null;
    if (
      !events.has(row.event) ||
      !["live", "replay", "speaker"].includes(row.mode) ||
      typeof row.prepared !== "boolean" ||
      !["safari", "chrome", "firefox", "other"].includes(row.browser) ||
      !["iphone", "android", "desktop", "other"].includes(row.device)
    )
      return null;
    for (const key of ["elapsedMs", "durationMs"])
      if (
        row[key] !== undefined &&
        (typeof row[key] !== "number" ||
          !Number.isFinite(row[key]) ||
          row[key] < 0 ||
          row[key] > 86_400_000)
      )
        return null;
    if (row.outcome !== undefined && !outcomes.has(row.outcome)) return null;
    if (row.kind !== undefined && !["video", "audio"].includes(row.kind))
      return null;
    if (row.cause !== undefined && !causes.has(row.cause)) return null;
    for (const key of ["videoStarted", "audioStarted"])
      if (row[key] !== undefined && typeof row[key] !== "boolean") return null;
  }
  return value as PlaybackReport[];
}

export function createMediaTelemetry(registry: Registry) {
  const labels = ["mode", "prepared", "browser", "device"];
  const count = new Counter({
    name: "yaparena_playback_events_total",
    help: "Untrusted anonymous client playback health events; labels are bounded",
    labelNames: [...labels, "event", "outcome"],
    registers: [registry],
  });
  const duration = new Histogram({
    name: "yaparena_playback_duration_seconds",
    help: "Client-observed startup, interruption and restoration durations (audio is a proxy)",
    labelNames: [...labels, "measure"],
    buckets: [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10, 30, 90],
    registers: [registry],
  });
  const viewing = new Counter({
    name: "yaparena_playback_active_seconds_total",
    help: "Sampled active playback time, including unplanned buffering",
    labelNames: labels,
    registers: [registry],
  });
  return (rows: PlaybackReport[]) => {
    for (const row of rows) {
      const dimensions = {
        mode: row.mode,
        prepared: String(row.prepared),
        browser: row.browser,
        device: row.device,
      };
      count.inc({
        ...dimensions,
        event: row.event,
        outcome: row.outcome || "none",
      });
      const milliseconds = row.elapsedMs ?? row.durationMs;
      if (
        milliseconds !== undefined &&
        [
          "first_video_frame",
          "first_audio_playback_proxy",
          "interruption_end",
          "restoration_playback",
        ].includes(row.event)
      )
        duration.observe(
          {
            ...dimensions,
            measure:
              row.event === "interruption_end"
                ? `interruption_${row.cause || "unknown"}_${row.kind || "unknown"}`
                : row.event === "restoration_playback"
                  ? `restoration_${row.kind || "unknown"}`
                  : row.event,
          },
          milliseconds / 1000,
        );
      if (
        row.event === "active_viewing_sample" &&
        row.kind === "video" &&
        row.durationMs !== undefined
      )
        viewing.inc(dimensions, row.durationMs / 1000);
    }
  };
}
