import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mediaPresentation } from "../public/media-presentation.js";

describe("media page state", () => {
  it("shows recording failure after a page refresh and offers no replay action", () => {
    const view = mediaPresentation("ended", {
      state: "ended",
      recordingStatus: "failed",
    });
    assert.match(view.message, /Recording failed.*Replay is unavailable/);
    assert.equal(view.replayVisible, false);
    assert.equal(view.actions.replay, false);
    assert.equal(view.actions.end, false);
  });

  it("shows only actions valid for the current media state", () => {
    assert.equal(mediaPresentation("ready", null).actions.start, true);
    const running = mediaPresentation("live", {
      state: "running",
      activeSide: "A",
      recordingStatus: "recording",
    });
    assert.equal(running.actions.pause, true);
    assert.equal(running.actions.end, true);
    assert.equal(running.actions.replay, false);
    const paused = mediaPresentation("live", {
      state: "paused",
      recordingStatus: "recording",
    });
    assert.equal(paused.actions.resume, true);
    const broken = mediaPresentation("live", {
      state: "paused",
      recordingStatus: "failed",
    });
    assert.equal(broken.actions.resume, false);
    const complete = mediaPresentation("ended", {
      state: "ended",
      recordingStatus: "ready",
    });
    assert.equal(complete.actions.replay, true);
    assert.match(complete.message, /ready/);
  });
});
