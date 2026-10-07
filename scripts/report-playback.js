import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function quantile(values, proportion) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * proportion) - 1)];
}
export function distribution(values) {
  return {
    n: values.length,
    median: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    p99: quantile(values, 0.99),
  };
}
export function failureInterval(failed, count) {
  if (!count) return { n: 0, failures: failed, rate: null, upper95: null };
  const z = 1.96;
  const rate = failed / count;
  const denominator = 1 + (z * z) / count;
  const center = (rate + (z * z) / (2 * count)) / denominator;
  const margin =
    (z *
      Math.sqrt((rate * (1 - rate)) / count + (z * z) / (4 * count * count))) /
    denominator;
  return {
    n: count,
    failures: failed,
    rate,
    lower95: Math.max(0, center - margin),
    upper95: Math.min(1, center + margin),
  };
}
export function reportTrials(trials) {
  const groups = new Map();
  for (const trial of trials) {
    if (trial.diagnostics.dropped)
      throw new Error("truncated diagnostics cannot establish acceptance");
    for (const key of [
      "device",
      "os",
      "browser",
      "geography",
      "network",
      "load",
      "commit",
    ])
      if (!trial[key]) throw new Error(`trial ${key} required`);
    const key = JSON.stringify(
      Object.fromEntries(
        [
          "device",
          "os",
          "browser",
          "geography",
          "network",
          "load",
          "commit",
        ].map((name) => [name, trial[name]]),
      ),
    );
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trial);
  }
  return [...groups].map(([key, rows]) => {
    const starts = [];
    for (const trial of rows) {
      const attempts = new Map();
      for (const record of trial.diagnostics.records) {
        if (record.event === "attempt") {
          const attempt = {
            mode: record.mode,
            prepared: record.prepared,
            records: [],
          };
          attempts.set(record.attempt, attempt);
          starts.push(attempt);
        }
        if (attempts.has(record.attempt))
          attempts.get(record.attempt).records.push(record);
      }
    }
    const startup = [];
    for (const mode of ["live", "replay"])
      for (const prepared of [false, true]) {
        const attempts = starts.filter(
          (a) => a.mode === mode && a.prepared === prepared,
        );
        const eligible = attempts.filter((a) => {
          const authorization = a.records.find(
            (r) => r.event === "authorization",
          );
          return (
            authorization &&
            ["allowed", "technical_error"].includes(authorization.outcome)
          );
        });
        const metric = (name) =>
          distribution(
            attempts.flatMap((a) =>
              a.records.filter((r) => r.event === name).map((r) => r.elapsedMs),
            ),
          );
        startup.push({
          mode,
          prepared,
          attempts: attempts.length,
          unfinished: attempts.filter(
            (a) => !a.records.some((r) => r.event === "outcome"),
          ).length,
          firstVideoMs: metric("first_video_frame"),
          audioProxyMs: metric("first_audio_playback_proxy"),
          failure: failureInterval(
            eligible.filter((a) =>
              a.records.some(
                (r) =>
                  r.event === "outcome" && r.outcome === "technical_failure",
              ),
            ).length,
            eligible.length,
          ),
          authorizationDenied: attempts.filter((a) =>
            a.records.some(
              (r) => r.event === "authorization" && r.outcome === "denied",
            ),
          ).length,
          abandoned: attempts.filter((a) =>
            a.records.some(
              (r) =>
                r.event === "outcome" &&
                r.outcome === "abandoned" &&
                !r.videoStarted,
            ),
          ).length,
        });
      }
    const records = rows.flatMap((row) => row.diagnostics.records);
    const buffering = records
      .filter(
        (r) =>
          r.mode === "replay" &&
          r.kind === "video" &&
          r.event === "interruption_end" &&
          ["buffering", "stalled"].includes(r.cause),
      )
      .map((r) => r.durationMs);
    const activeMs = records
      .filter(
        (r) =>
          r.mode === "replay" &&
          r.kind === "video" &&
          r.event === "active_viewing_sample",
      )
      .reduce((sum, r) => sum + r.durationMs, 0);
    const bufferingMs = buffering.reduce((sum, value) => sum + value, 0);
    return {
      dimensions: JSON.parse(key),
      startup,
      buffering: {
        episodes: buffering.length,
        totalMs: bufferingMs,
        longestMs: buffering.length ? Math.max(...buffering) : null,
        activeMs,
        ratio: activeMs ? bufferingMs / activeMs : null,
      },
      restorationMs: {
        video: distribution(
          records
            .filter(
              (r) => r.event === "restoration_playback" && r.kind === "video",
            )
            .map((r) => r.elapsedMs),
        ),
        audioProxy: distribution(
          records
            .filter(
              (r) => r.event === "restoration_playback" && r.kind === "audio",
            )
            .map((r) => r.elapsedMs),
        ),
      },
      liveDelayMs: distribution(
        rows.flatMap((r) => r.synchronizedLiveDelayMs || []),
      ),
      verifiedAudibleStartupMs: distribution(
        rows.flatMap((r) => r.acousticStartupMs || []),
      ),
      releaseReady: false,
    };
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const data = JSON.parse(await readFile(process.argv[2], "utf8"));
  console.log(JSON.stringify(reportTrials(data), null, 2));
}
