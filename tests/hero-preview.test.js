import assert from "node:assert/strict";
import { it } from "node:test";
import { RoomEvent, Track, VideoQuality } from "livekit-client";
import { createHeroLive } from "../public/hero-live.js";
import {
  createHoverIntent,
  previewAutoplayAllowed,
} from "../public/hero-policy.js";

it("suppresses automatic video for motion, data and very slow connection preferences", () => {
  assert.equal(previewAutoplayAllowed({}), true);
  assert.equal(previewAutoplayAllowed({ reducedMotion: true }), false);
  assert.equal(previewAutoplayAllowed({ saveData: true }), false);
  for (const effectiveType of ["2g", "slow-2g"])
    assert.equal(previewAutoplayAllowed({ effectiveType }), false);
  assert.equal(previewAutoplayAllowed({ effectiveType: "4g" }), true);
});

it("requires a continuous hover and cancels or restarts its entry countdown", () => {
  let opened = 0,
    sequence = 0;
  const jobs = new Map();
  const intent = createHoverIntent({
    open: () => opened++,
    schedule: (fn, delay) => {
      assert.equal(delay, 2600);
      jobs.set(++sequence, fn);
      return sequence;
    },
    cancel: (id) => jobs.delete(id),
  });
  intent.stop();
  intent.start();
  intent.start();
  assert.equal(jobs.size, 1);
  intent.stop();
  assert.equal(jobs.size, 0);
  intent.start();
  jobs.get(sequence)();
  assert.equal(opened, 1);
  intent.stop();
});

it("uses viewer-only small camera subscriptions and releases preview tracks/room", async () => {
  const previousDocument = globalThis.document;
  const nodes = [];
  globalThis.document = {
    createElement() {
      const events = new Map();
      const node = {
        setAttribute() {},
        addEventListener: (event, fn) => events.set(event, fn),
        play: async () => events.get("playing")(),
        remove() {
          this.removed = true;
        },
      };
      nodes.push(node);
      return node;
    },
  };
  const instances = [];
  let ready = 0,
    unavailable = 0;
  const video = {
    kind: Track.Kind.Video,
    source: Track.Source.Camera,
    setSubscribed(value) {
      this.subscribed = value;
    },
    setVideoQuality(value) {
      this.quality = value;
    },
  };
  const audio = {
    kind: Track.Kind.Audio,
    source: Track.Source.Microphone,
    setSubscribed(value) {
      this.subscribed = value;
    },
  };
  class FakeRoom {
    constructor(options) {
      assert.equal(options.adaptiveStream, false);
      this.events = new Map();
      this.remoteParticipants = new Map([
        [
          "speaker",
          {
            trackPublications: new Map([
              ["video", video],
              ["audio", audio],
            ]),
          },
        ],
      ]);
      instances.push(this);
    }
    on(event, fn) {
      this.events.set(event, fn);
    }
    async connect(url, token, options) {
      assert.equal(url, "wss://example.test");
      assert.equal(token, "test");
      assert.equal(options.autoSubscribe, false);
      this.connected = true;
    }
    async disconnect() {
      this.connected = false;
    }
  }
  try {
    const preview = createHeroLive({
      RoomClass: FakeRoom,
      container: { append() {} },
      request: async (path, options) => {
        assert.equal(path, "/viewer-token");
        assert.equal(options.method, "POST");
        return { token: "test", url: "wss://example.test" };
      },
      playing: () => ready++,
      unavailable: () => unavailable++,
    });
    await preview.start();
    const instance = instances[0];
    assert.equal(video.subscribed, true);
    assert.equal(video.quality, VideoQuality.LOW);
    assert.equal(audio.subscribed, false);
    const track = {
      kind: Track.Kind.Video,
      attach(node) {
        this.node = node;
      },
      detach() {
        this.detached = true;
      },
    };
    instance.events.get(RoomEvent.TrackSubscribed)(track);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ready, 1);
    assert.equal(nodes[0].muted, true);
    assert.equal(nodes[0].playsInline, true);
    instance.events.get(RoomEvent.TrackUnsubscribed)(track);
    assert.equal(nodes[0].removed, true);
    instance.events.get(RoomEvent.TrackSubscribed)(track);
    instance.events.get(RoomEvent.Disconnected)();
    assert.equal(unavailable, 1);
    preview.stop();
    assert.equal(instance.connected, false);
    assert.equal(track.detached, true);
    instance.events.get(RoomEvent.TrackPublished)(audio);
    instance.events.get(RoomEvent.TrackSubscribed)({ kind: Track.Kind.Audio });
    instance.events.get(RoomEvent.Disconnected)();
    assert.equal(unavailable, 1);
  } finally {
    globalThis.document = previousDocument;
  }
});
