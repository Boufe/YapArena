import assert from "node:assert/strict";
import { it } from "node:test";
import {
  createMediaDiagnostics,
  observePlayback,
} from "../public/media-diagnostics.js";
import {
  distribution,
  failureInterval,
  reportTrials,
} from "../scripts/report-playback.js";

it("separates tap startup, rendered frames, sound activation, outcomes and bounded diagnostics", () => {
  let now = 0;
  const d = createMediaDiagnostics({ now: () => now, limit: 30 });
  d.frame("video");
  d.start("live", true);
  now = 450;
  d.frame("video");
  now = 500;
  d.frame("video");
  d.record("sound_activation_required");
  now = 1250;
  d.frame("audio");
  d.record("network_restored");
  now = 2000;
  d.frame("video");
  d.frame("audio");
  d.start("replay", false);
  d.finish("authorization_denied");
  const result = d.export();
  assert.equal(
    result.records.find((r) => r.event === "first_video_frame").elapsedMs,
    450,
  );
  assert.equal(
    result.records.find((r) => r.event === "first_audio_playback_proxy")
      .elapsedMs,
    1250,
  );
  assert.equal(
    result.records.filter((r) => r.event === "first_video_frame").length,
    1,
  );
  assert.ok(result.records.some((r) => r.outcome === "abandoned"));
  for (let i = 0; i < 35; i++) d.record("sample");
  assert.ok(d.export().dropped > 0);
  assert.equal(d.export().records.length, 30);
});
it("observes actual frames and advancing audio, excludes intentional pauses and disabled media, and cleans up", () => {
  for (const kind of ["video", "audio"]) {
    let now = 0;
    let tick;
    let frame;
    let cancelled = false;
    let expected = true;
    const progress = [];
    let interruptions = 0;
    const handlers = new Map();
    const d = createMediaDiagnostics({ now: () => now });
    d.start("replay", false);
    const node = {
      currentTime: 0,
      paused: false,
      ended: false,
      seeking: false,
      muted: false,
      volume: 1,
      requestVideoFrameCallback: (fn) => {
        frame = fn;
        return 1;
      },
      cancelVideoFrameCallback: (id) => assert.equal(id, 1),
      addEventListener: (event, fn) => handlers.set(event, fn),
      removeEventListener: (event) => handlers.delete(event),
    };
    const cleanup = observePlayback(node, {
      kind,
      diagnostics: d,
      now: () => now,
      expected: () => expected,
      schedule: (fn) => {
        tick = fn;
        return 1;
      },
      cancel: () => {
        cancelled = true;
      },
      onProgress: (at) => progress.push(at),
      onInterruption: () => interruptions++,
    });
    now = 100;
    if (kind === "video") frame();
    else {
      node.currentTime = 1;
      handlers.get("timeupdate")();
    }
    now = 4000;
    tick();
    assert.ok(d.export().records.some((r) => r.event === "interruption_start"));
    now = 4100;
    handlers.get("waiting")();
    if (kind === "video") frame();
    else {
      node.currentTime = 2;
      handlers.get("timeupdate")();
    }
    handlers.get("stalled")();
    node.paused = true;
    handlers.get("pause")();
    handlers.get("seeking")();
    handlers.get("error")();
    expected = false;
    now = 5000;
    tick();
    cleanup();
    assert.equal(cancelled, true);
    assert.deepEqual(progress, [100, 4100]);
    assert.ok(interruptions >= 5);
    assert.equal(handlers.size, 0);
    assert.ok(d.export().records.some((r) => r.event === "interruption_end"));
  }
});
it("does not claim rendered frames where only element progress is available", () => {
  let tick;
  const handlers = new Map();
  const d = createMediaDiagnostics();
  d.start("live", false);
  const node = {
    currentTime: 0,
    paused: false,
    seeking: false,
    addEventListener: (e, fn) => handlers.set(e, fn),
    removeEventListener: (e) => handlers.delete(e),
  };
  const stop = observePlayback(node, {
    kind: "video",
    diagnostics: d,
    schedule: (fn) => {
      tick = fn;
      return 1;
    },
    cancel: () => {},
  });
  node.currentTime = 1;
  handlers.get("timeupdate")();
  tick();
  stop();
  assert.ok(d.export().records.some((r) => r.event === "video_progress_proxy"));
  assert.equal(
    d.export().records.some((r) => r.event === "first_video_frame"),
    false,
  );
});
it("reports distributions, denominator uncertainty and rejects incomplete trial metadata", () => {
  assert.deepEqual(distribution([]), {
    n: 0,
    median: null,
    p95: null,
    p99: null,
  });
  assert.equal(distribution([30, 10, 20]).median, 20);
  assert.equal(failureInterval(0, 0).upper95, null);
  assert.ok(failureInterval(0, 100).upper95 > 0.001);
  const d = createMediaDiagnostics();
  d.start("replay", false);
  d.record("authorization", { outcome: "allowed" });
  d.frame("video");
  d.frame("audio");
  d.record("active_viewing_sample", { kind: "video", durationMs: 1000 });
  d.record("interruption_end", {
    kind: "video",
    durationMs: 10,
    cause: "buffering",
  });
  d.finish("technical_failure");
  const trial = {
    device: "synthetic",
    os: "test",
    browser: "test",
    geography: "CA",
    network: "normal",
    load: "500",
    commit: "test",
    diagnostics: d.export(),
  };
  const report = reportTrials([trial])[0];
  assert.equal(report.buffering.ratio, 0.01);
  assert.equal(
    report.startup.find((row) => row.mode === "replay" && !row.prepared).failure
      .n,
    1,
  );
  assert.equal(report.releaseReady, false);
  assert.throws(() => reportTrials([{ ...trial, device: null }]));
  assert.throws(() =>
    reportTrials([
      { ...trial, diagnostics: { ...trial.diagnostics, dropped: 1 } },
    ]),
  );
});
