import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { it } from "node:test";
import {
  createMediaRecovery,
  mayRecoverDisconnect,
} from "../public/media-recovery.js";
import {
  createMediaDiagnostics,
  observePlayback,
} from "../public/media-diagnostics.js";
import { createReplayPlayer } from "../public/media-replay.js";
import { createReplayLibraryLoader } from "../public/media-replay-library.js";
import {
  createPlaybackReporter,
  playbackDimensions,
} from "../public/media-telemetry.js";
import { createMediaTracks } from "../public/media-tracks.js";
import {
  speakerButtonState,
  stopMediaSession,
} from "../public/media-session.js";
import { joinSpeaker } from "../public/media-speaker.js";
import { mediaPresentation } from "../public/media-presentation.js";

const source = readFileSync(
  new URL("../public/media-entry.js", import.meta.url),
  "utf8",
).replace(/^import[\s\S]*?;\n/gm, "");
const settle = async () => {
  for (let i = 0; i < 8; i++)
    await new Promise((resolve) => setImmediate(resolve));
};
function node() {
  const handlers = new Map();
  return {
    handlers,
    dataset: {},
    hidden: true,
    disabled: false,
    textContent: "",
    currentTime: 0,
    paused: true,
    textTracks: [],
    addEventListener(event, fn) {
      handlers.set(event, fn);
    },
    removeEventListener(event) {
      handlers.delete(event);
    },
    async click() {
      await handlers.get("click")?.({ currentTarget: this });
      await settle();
    },
    setAttribute() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    replaceChildren() {},
    append() {},
    removeAttribute() {},
    remove() {},
    load() {},
    pause() {
      this.paused = true;
    },
    async play() {
      this.paused = false;
    },
    canPlayType() {
      return "probably";
    },
  };
}
function fixture() {
  const elements = new Map();
  for (const name of [
    "status",
    "clock",
    "microphone",
    "videos",
    "viewer",
    "speaker",
    "replay",
    "replay-video",
    "operator",
    "sound",
    "leave",
    "mute",
  ])
    elements.set(`[data-media-${name}]`, node());
  const captionButton = node();
  elements.get("[data-media-operator]").querySelector = () => captionButton;
  const root = {
    dataset: {
      mediaEvent: "33333333-3333-4333-8333-333333333333",
      mediaReplayPlayer: "/assets/replay.bundle.js",
    },
    querySelector: (selector) => elements.get(selector),
  };
  const jobs = new Map();
  const intervals = new Map();
  const listeners = new Map();
  let index = 0;
  let viewerGrant;
  let eventStatus = "live";
  let speaker = false;
  const requests = [];
  const rooms = [];
  const calls = [];
  const RoomEvent = Object.fromEntries(
    [
      "TrackSubscribed",
      "TrackUnsubscribed",
      "ParticipantDisconnected",
      "Reconnecting",
      "Reconnected",
      "ParticipantPermissionsChanged",
      "AudioPlaybackStatusChanged",
      "Disconnected",
    ].map((name) => [name, name]),
  );
  class Room {
    constructor(options = {}) {
      this.options = options;
      this.handlers = new Map();
      this.remoteParticipants = new Map();
      this.canPlaybackAudio = false;
      this.localParticipant = {
        identity: "speaker-1",
        permissions: { canPublishSources: [1, 2] },
        isMicrophoneEnabled: false,
        async setCameraEnabled() {
          return {
            track: { kind: "video", attach: () => node(), detach() {} },
          };
        },
        async setMicrophoneEnabled(enabled) {
          this.isMicrophoneEnabled = enabled;
          calls.push(["microphone", enabled]);
        },
        async publishTrack(track) {
          calls.push(["publish", track]);
          return { track };
        },
      };
      rooms.push(this);
    }
    on(event, fn) {
      this.handlers.set(event, fn);
    }
    emit(event, ...args) {
      this.handlers.get(event)?.(...args);
    }
    async prepareConnection() {
      calls.push("prepare");
    }
    async startAudio() {
      calls.push("sound");
      this.canPlaybackAudio = true;
    }
    async connect() {
      calls.push("connect");
    }
    async disconnect() {
      calls.push("disconnect");
      this.emit("Disconnected", 1);
    }
    sdkPageLeave() {
      // LiveKit's default beforeunload handler emits CLIENT_INITIATED before
      // application pagehide cleanup. Preserve this order in the regression.
      if (this.options.disconnectOnPageLeave !== false) void this.disconnect();
    }
  }
  const storage = new Map();
  const window = {
    crypto: { randomUUID: () => "synthetic" },
    sessionStorage: {
      getItem: (key) => storage.get(key),
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    setTimeout: (fn, ms) => {
      jobs.set(++index, { fn, ms });
      return index;
    },
    clearTimeout: (id) => jobs.delete(id),
    setInterval: (fn) => {
      intervals.set(++index, fn);
      return index;
    },
    clearInterval: (id) => intervals.delete(id),
    addEventListener: (event, fn) => listeners.set(event, fn),
  };
  const navigator = {
    onLine: true,
    userAgent: "synthetic Chrome/1",
    mediaDevices: {
      async getUserMedia() {
        calls.push("capture");
        const mic = {
          enabled: true,
          stop() {},
          getSettings: () => ({ deviceId: "microphone-1" }),
        };
        const camera = {
          stop() {},
          getSettings: () => ({ deviceId: "camera-1" }),
        };
        return {
          getAudioTracks: () => [mic],
          getVideoTracks: () => [camera],
          getTracks: () => [mic, camera],
        };
      },
    },
  };
  const document = {
    hidden: false,
    querySelector: () => root,
    addEventListener: (event, fn) => listeners.set(event, fn),
  };
  const response = (body, status = 200) => ({
    ok: status < 400,
    status,
    async json() {
      return body;
    },
  });
  const fetch = async (url) => {
    requests.push(url);
    if (url.endsWith("/roles")) return response({ roles: [] });
    if (url.endsWith("/speaker-seat"))
      return speaker
        ? response({ side: "A", userId: "1" })
        : response({ error: "not a speaker" }, 404);
    if (url.endsWith("/viewer-token"))
      return viewerGrant
        ? viewerGrant
        : response({ token: "synthetic", url: "wss://synthetic.example" });
    if (url.endsWith("/speaker-token"))
      return response({
        token: "synthetic",
        url: "wss://synthetic.example",
        side: "A",
      });
    if (url.endsWith("/device-check")) return response({});
    if (url.endsWith("/playback")) return response({}, 204);
    return response({
      eventStatus,
      preparationUrl: "wss://synthetic.example",
      state: { revision: 1, state: "running", activeSide: "A" },
      serverNow: new Date().toISOString(),
    });
  };
  const context = vm.createContext({
    window,
    document,
    navigator,
    fetch,
    Room,
    RoomEvent,
    Track: { Source: { Microphone: 2 }, sourceToProto: (value) => value },
    createMediaRecovery,
    mayRecoverDisconnect,
    createMediaDiagnostics,
    observePlayback: (element, options) =>
      observePlayback(element, {
        ...options,
        schedule: window.setInterval,
        cancel: window.clearInterval,
      }),
    createReplayPlayer,
    createReplayLibraryLoader,
    createPlaybackReporter,
    playbackDimensions,
    createMediaTracks,
    speakerButtonState,
    stopMediaSession,
    joinSpeaker,
    mediaPresentation,
    performance,
    setInterval: window.setInterval,
    clearInterval: window.clearInterval,
    Date,
    console,
  });
  return {
    rooms,
    storage,
    intervals,
    requests,
    calls,
    jobs,
    listeners,
    navigator,
    document,
    window,
    element: (name) => elements.get(`[data-media-${name}]`),
    async start() {
      vm.runInContext(source, context);
      await settle();
    },
    setGrant: (grant) => {
      viewerGrant = grant;
    },
    response,
    setStatus: (status) => {
      eventStatus = status;
    },
    speaker: () => {
      speaker = true;
    },
    async timer(ms) {
      const [id, job] = [...jobs].find(([, job]) => job.ms === ms) || [];
      assert.ok(job, `timer ${ms}`);
      jobs.delete(id);
      await job.fn();
      await settle();
    },
  };
}

it("prepares without joining or capturing and rejoins viewers only after terminal transport failure", async () => {
  const f = fixture();
  await f.start();
  assert.deepEqual(f.calls, ["prepare"]);
  assert.equal(
    f.requests.some((url) => url.endsWith("/viewer-token")),
    false,
  );
  await f.element("viewer").click();
  assert.ok(f.calls.includes("sound"));
  assert.ok(f.calls.includes("connect"));
  const room = f.rooms[0];
  room.emit("Reconnecting");
  await f.timer(3000);
  assert.match(f.element("status").textContent, /Reconnecting/);
  assert.equal(
    f.requests.filter((url) => url.endsWith("/viewer-token")).length,
    1,
  );
  room.emit("Disconnected", 9);
  const retry = [...f.jobs.values()].find((job) => job.ms < 400);
  assert.ok(retry);
  await f.timer(retry.ms);
  assert.equal(
    f.requests.filter((url) => url.endsWith("/viewer-token")).length,
    2,
  );
  await f.element("leave").click();
  assert.equal(f.element("leave").hidden, true);
  f.listeners.get("pagehide")();
  assert.equal(f.jobs.size, 0);
});
it("preserves speaker rejoin and mute intent through SDK navigation while releasing page resources", async () => {
  const f = fixture();
  f.speaker();
  await f.start();
  await f.element("speaker").click();
  await f.element("mute").click();
  const key = "media-speaker:33333333-3333-4333-8333-333333333333:1";
  assert.equal(f.storage.get(key), "1");
  for (const room of f.rooms) room.sdkPageLeave();
  f.listeners.get("pagehide")();
  await settle();
  assert.equal(f.storage.get(key), "1");
  assert.equal(f.storage.get(`${key}:muted`), "1");
  assert.ok(f.calls.includes("disconnect"));
  assert.equal(f.jobs.size, 0);
  assert.equal(f.intervals.size, 0);
});
it("cancels joins whose authorization response arrives after leave", async () => {
  const f = fixture();
  await f.start();
  let resolveGrant;
  f.setGrant(
    new Promise((resolve) => {
      resolveGrant = resolve;
    }),
  );
  const joining = f.element("viewer").click();
  await settle();
  await f.element("leave").click();
  resolveGrant(f.response({ token: "late", url: "wss://synthetic.example" }));
  await joining;
  assert.equal(f.calls.includes("connect"), false);
  f.listeners.get("pagehide")();
});
it("does not fight duplicate identity or removal and suspends application retries offline", async () => {
  for (const reason of [2, 4, 5, 10]) {
    const f = fixture();
    await f.start();
    await f.element("viewer").click();
    f.rooms[0].emit("Disconnected", reason);
    assert.equal(
      [...f.jobs.values()].some((job) => job.ms < 400),
      false,
    );
    f.listeners.get("online")();
    await settle();
    assert.equal(
      f.requests.filter((url) => url.endsWith("/viewer-token")).length,
      1,
    );
    f.listeners.get("pagehide")();
  }
  const f = fixture();
  await f.start();
  await f.element("viewer").click();
  f.navigator.onLine = false;
  f.listeners.get("offline")();
  f.rooms[0].emit("Disconnected", 9);
  assert.equal(
    [...f.jobs.values()].some((job) => job.ms < 400),
    false,
  );
  f.navigator.onLine = true;
  f.listeners.get("online")();
  assert.ok([...f.jobs.values()].some((job) => job.ms < 400));
  f.listeners.get("pagehide")();
});
it("stops after debate end and preserves a speaker's deliberate mute and chosen devices", async () => {
  const f = fixture();
  f.speaker();
  await f.start();
  await f.element("speaker").click();
  assert.equal(f.element("mute").hidden, false);
  await f.element("mute").click();
  assert.ok(
    f.calls.some(
      (call) =>
        Array.isArray(call) && call[0] === "microphone" && call[1] === false,
    ),
  );
  f.rooms[0].emit(
    "ParticipantPermissionsChanged",
    {},
    f.rooms[0].localParticipant,
  );
  await settle();
  assert.equal(
    f.calls.filter((call) => Array.isArray(call) && call[0] === "publish")
      .length,
    1,
  );
  f.setStatus("ended");
  await f.timer(3000);
  assert.equal(f.calls.at(-1), "disconnect");
  assert.equal(
    [...f.jobs.values()].some((job) => job.ms < 400),
    false,
  );
  f.listeners.get("pagehide")();
});
