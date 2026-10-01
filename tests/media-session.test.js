import assert from "node:assert/strict";
import { it } from "node:test";

import {
  speakerButtonState,
  stopMediaSession,
} from "../public/media-session.js";

it("offers speaker connection only to an assigned seat that is not connected", () => {
  assert.equal(
    speakerButtonState({
      side: undefined,
      status: "ready",
      connected: false,
      joining: false,
    }).hidden,
    true,
  );
  assert.equal(
    speakerButtonState({
      side: "A",
      status: "ready",
      connected: false,
      joining: false,
    }).hidden,
    false,
  );
  assert.equal(
    speakerButtonState({
      side: "A",
      status: "live",
      connected: true,
      joining: false,
    }).hidden,
    true,
  );
  assert.equal(
    speakerButtonState({
      side: "A",
      status: "ended",
      connected: false,
      joining: false,
    }).hidden,
    true,
  );
});

it("clears video tiles and stops captured tracks when a debate ends", async () => {
  const calls = [];
  await stopMediaSession(
    {
      async disconnect(stopTracks) {
        calls.push(["disconnect", stopTracks]);
      },
    },
    {
      clear() {
        calls.push(["clear"]);
      },
    },
  );
  assert.deepEqual(calls, [["clear"], ["disconnect", true]]);
});
