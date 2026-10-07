import assert from "node:assert/strict";
import { it } from "node:test";
import { Registry } from "prom-client";
import {
  parsePlaybackReports,
  createMediaTelemetry,
} from "../dist/features/media/telemetry.js";
import {
  createPlaybackReporter,
  playbackDimensions,
} from "../public/media-telemetry.js";
const row = {
  event: "attempt",
  mode: "replay",
  prepared: false,
  browser: "safari",
  device: "iphone",
};

it("accepts bounded playback reports and excludes identities, URLs and arbitrary dimensions", () => {
  assert.deepEqual(parsePlaybackReports([row]), [row]);
  for (const value of [
    null,
    {},
    [],
    new Array(33).fill(row),
    [null],
    [[]],
    [{ ...row, url: "private" }],
    [{ ...row, event: "unknown" }],
    [{ ...row, mode: "unknown" }],
    [{ ...row, prepared: "false" }],
    [{ ...row, browser: "arbitrary" }],
    [{ ...row, device: "id" }],
    [{ ...row, elapsedMs: NaN }],
    [{ ...row, elapsedMs: -1 }],
    [{ ...row, durationMs: 86400001 }],
    [{ ...row, durationMs: "4" }],
    [{ ...row, outcome: "private reason" }],
    [{ ...row, kind: "other" }],
    [{ ...row, cause: "other" }],
    [{ ...row, videoStarted: "true" }],
  ])
    assert.equal(parsePlaybackReports(value), null);
  assert.ok(
    parsePlaybackReports([
      {
        ...row,
        event: "interruption_end",
        kind: "video",
        cause: "buffering",
        durationMs: 1,
        outcome: "allowed",
        videoStarted: true,
        audioStarted: false,
      },
    ]),
  );
});
it("aggregates operational durations with bounded labels and no session or recording identifiers", async () => {
  const registry = new Registry();
  const record = createMediaTelemetry(registry);
  record([
    { ...row },
    { ...row, event: "first_video_frame", elapsedMs: 500 },
    { ...row, event: "first_audio_playback_proxy", elapsedMs: 1000 },
    {
      ...row,
      event: "interruption_end",
      kind: "video",
      cause: "buffering",
      durationMs: 200,
    },
    { ...row, event: "restoration_playback", kind: "audio", elapsedMs: 2500 },
    { ...row, event: "active_viewing_sample", kind: "video", durationMs: 1000 },
    { ...row, event: "outcome", outcome: "completed" },
    { ...row, event: "interruption_end", durationMs: 1 },
    { ...row, event: "restoration_playback", elapsedMs: 1 },
  ]);
  const metrics = await registry.metrics();
  assert.match(metrics, /yaparena_playback_events_total/);
  assert.match(metrics, /measure="first_video_frame".* 0.5/);
  assert.match(metrics, /yaparena_playback_active_seconds_total.* 1/);
  assert.doesNotMatch(metrics, /recording|user_id|session_id/);
});
it("classifies supported client families without exposing raw user-agent strings", () => {
  assert.deepEqual(playbackDimensions("iPhone Safari/1"), {
    browser: "safari",
    device: "iphone",
  });
  assert.deepEqual(playbackDimensions("Android Chrome/1"), {
    browser: "chrome",
    device: "android",
  });
  assert.deepEqual(playbackDimensions("Windows Firefox/1"), {
    browser: "firefox",
    device: "desktop",
  });
  assert.deepEqual(playbackDimensions("unknown"), {
    browser: "other",
    device: "other",
  });
});
it("bounds reporting, strips private fields, flushes on exit and counts dropped reports", async () => {
  let id = 0;
  const jobs = new Map();
  const sent = [];
  const reporter = createPlaybackReporter({
    send: async (batch) => sent.push(batch),
    dimensions: { browser: "chrome", device: "desktop" },
    schedule: (fn, ms) => {
      jobs.set(++id, { fn, ms });
      return id;
    },
    cancel: (id) => jobs.delete(id),
  });
  reporter.record({ event: "webrtc_stats", mode: "live" });
  reporter.record({ event: "attempt" });
  assert.equal(jobs.size, 0);
  reporter.record({ ...row, prepared: true, attempt: 123, url: "secret" });
  for (let i = 0; i < 70; i++)
    reporter.record({ ...row, event: "first_video_frame", elapsedMs: 1 });
  assert.equal(reporter.dropped, 7);
  await reporter.flush();
  assert.equal(sent[0].length, 32);
  assert.equal(sent[0][0].prepared, true);
  assert.equal(sent[0][0].url, undefined);
  assert.equal(jobs.size, 1);
  await reporter.flush();
  reporter.stop();
  reporter.record(row);
  await reporter.flush();
  assert.equal(jobs.size, 0);
  const failed = createPlaybackReporter({
    send: async () => {
      throw Error("offline");
    },
    dimensions: { browser: "other", device: "other" },
    schedule: () => 1,
    cancel: () => {},
  });
  failed.record(row);
  await failed.flush();
  assert.equal(failed.dropped, 1);
  failed.stop();
});
