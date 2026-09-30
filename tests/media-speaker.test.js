import assert from "node:assert/strict";
import { it } from "node:test";

import { joinSpeaker } from "../public/media-speaker.js";

it("shows the first speaker's camera and permits reconnect after a pause", async () => {
  const button = { disabled: false };
  const steps = [];
  let paused = false;
  let readyCalls = 0;
  const camera = { kind: "video" };
  const options = {
    button,
    mediaDevices: {
      async getUserMedia() {
        return {
          getVideoTracks: () => [{}],
          getAudioTracks: () => [{}],
          getTracks: () => [{ stop: () => steps.push("preview stopped") }],
        };
      },
    },
    async request(path) {
      if (path === "/speaker-token")
        return { token: "token", url: "wss://example.test", side: "A" };
      if (path === "")
        return {
          eventStatus: paused ? "live" : "ready",
          state: paused ? { state: "paused" } : null,
        };
      return {};
    },
    async connect() {
      assert.equal(button.disabled, true);
      return {
        localParticipant: {
          identity: "speaker-1",
          async setCameraEnabled() {
            assert.ok(steps.includes("preview stopped"));
            steps.push("camera opened");
            return { track: camera };
          },
          async setMicrophoneEnabled(enabled) {
            assert.equal(enabled, false);
          },
        },
      };
    },
    tracks: {
      attach(track, identity) {
        assert.equal(track, camera);
        assert.equal(identity, "speaker-1");
        steps.push("camera shown");
      },
    },
    setSide(side) {
      assert.equal(side, "A");
    },
    async markReady() {
      readyCalls += 1;
    },
    async refresh() {},
  };

  assert.match(await joinSpeaker(options), /Connected as speaker A/);
  assert.equal(button.disabled, false);
  assert.deepEqual(steps.slice(0, 3), [
    "preview stopped",
    "camera opened",
    "camera shown",
  ]);
  assert.equal(readyCalls, 1);

  paused = true;
  assert.match(await joinSpeaker(options), /Reconnected as speaker A/);
  assert.equal(button.disabled, false);
  assert.equal(readyCalls, 1);
  assert.equal(steps.filter((step) => step === "camera shown").length, 2);
});

it("restores the join control when camera publishing fails", async () => {
  const button = { disabled: false };
  const preview = { stopped: false };
  await assert.rejects(
    joinSpeaker({
      button,
      mediaDevices: {
        async getUserMedia() {
          return {
            getVideoTracks: () => [{}],
            getAudioTracks: () => [{}],
            getTracks: () => [
              {
                stop: () => {
                  preview.stopped = true;
                },
              },
            ],
          };
        },
      },
      async request(path) {
        return path === "/speaker-token"
          ? { token: "token", url: "wss://example.test", side: "A" }
          : {};
      },
      async connect() {
        return {
          localParticipant: {
            async setCameraEnabled() {
              return undefined;
            },
          },
        };
      },
    }),
    /Could not open camera/,
  );
  assert.equal(preview.stopped, true);
  assert.equal(button.disabled, false);
});
