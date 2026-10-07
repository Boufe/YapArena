import assert from "node:assert/strict";
import { it } from "node:test";
import {
  createReplayAccess,
  replayPrefix,
} from "../dist/features/media/replay.js";
import {
  authorized,
  rewritePlaylist,
  serveReplay,
} from "../edge/replay-worker.js";
const secret = "synthetic-test-secret-32-characters-only";
const recording = "debates/33333333-3333-4333-8333-333333333333/recording.mp4";
const access = () =>
  createReplayAccess(recording, "https://media.example", secret);
function setup() {
  const cached = new Map();
  const reads = [];
  const pending = [];
  const cache = {
    async match(key) {
      return cached.get(key.url)?.clone();
    },
    async put(key, response) {
      cached.set(key.url, response);
    },
  };
  const env = {
    REPLAY_SIGNING_SECRET: secret,
    APP_ORIGIN: "https://app.example",
    REPLAY_BUCKET: {
      async get(path, options) {
        reads.push({ path, options });
        if (path.includes("missing")) return null;
        const body = path.endsWith("master.m3u8")
          ? "#EXTM3U\n240/index.m3u8\n"
          : path.endsWith("index.m3u8")
            ? "#EXTM3U\nsegment00000.ts\n"
            : "test";
        return {
          body,
          size: body.length,
          ...(options ? { range: { offset: 1, length: 2 }, body: "es" } : {}),
        };
      },
    },
  };
  return {
    env,
    reads,
    cached,
    cache,
    pending,
    async serve(url = access().url, options = {}) {
      return serveReplay(
        new Request(url, options),
        env,
        { waitUntil: (p) => pending.push(p) },
        cache,
      );
    },
  };
}
it("issues five-minute scoped credentials and refuses tampering, expiry and cross-recording paths", async () => {
  const grant = access();
  const url = new URL(grant.url);
  const path = url.pathname.slice(1);
  const token = url.searchParams.get("access");
  assert.equal(grant.type, "hls");
  assert.equal(grant.expiresIn, 300);
  assert.match(grant.captionsUrl, /captions.vtt\?access=/);
  assert.equal(await authorized(token, path, secret), true);
  assert.equal(
    await authorized(token, path.replace("recording/", "other/"), secret),
    false,
  );
  assert.equal(
    await authorized(token, path, secret, Date.now() + 301000),
    false,
  );
  assert.equal(await authorized(token + "a", path, secret), false);
  assert.equal(await authorized("bad..extra", path, secret), false);
  assert.equal(await authorized(null, path, secret), false);
  assert.equal(await authorized(token, path, "short"), false);
  assert.throws(() => replayPrefix("../secret"));
});
it("signs child playlist paths and checks credentials even for cached segments", async () => {
  const f = setup();
  let response = await f.serve();
  assert.equal(response.status, 200);
  assert.match(await response.text(), /240\/index.m3u8\?access=/);
  const segment = new URL("240/segment00000.ts", access().url);
  segment.search = new URL(access().url).search;
  response = await f.serve(segment);
  assert.equal(await response.text(), "test");
  await Promise.all(f.pending);
  const reads = f.reads.length;
  assert.equal((await f.serve(segment)).status, 200);
  assert.equal(f.reads.length, reads);
  segment.search = "?access=bad";
  assert.equal((await f.serve(segment)).status, 403);
  assert.equal(f.reads.length, reads);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.throws(() =>
    rewritePlaylist("https://evil.example/file", access().url),
  );
  assert.match(
    rewritePlaylist('#EXTM3U\n#EXT-X-MEDIA:URI="captions.vtt"\n', access().url),
    /captions.vtt\?access=/,
  );
});
it("handles CORS, range seeking, HEAD, malformed requests and missing objects", async () => {
  const f = setup();
  assert.equal(
    (await f.serve(undefined, { headers: { Origin: "https://evil.example" } }))
      .status,
    403,
  );
  assert.equal((await f.serve(undefined, { method: "OPTIONS" })).status, 204);
  assert.equal((await f.serve(undefined, { method: "POST" })).status, 405);
  assert.equal((await f.serve("https://media.example/secrets")).status, 403);
  assert.equal(
    (await f.serve(undefined, { headers: { Range: "bytes=1-2,3-4" } })).status,
    416,
  );
  const segment = new URL("240/segment00000.ts", access().url);
  segment.search = new URL(access().url).search;
  const range = await f.serve(segment, { headers: { Range: "bytes=1-2" } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("Content-Range"), "bytes 1-2/4");
  assert.equal(await range.text(), "es");
  assert.equal(await (await f.serve(undefined, { method: "HEAD" })).text(), "");
  f.env.REPLAY_BUCKET.get = async () => null;
  assert.equal((await f.serve()).status, 404);
  f.env.REPLAY_BUCKET.get = async () => ({ body: "../secret", size: 9 });
  assert.equal((await f.serve()).status, 502);
  f.env.REPLAY_BUCKET.get = async () => ({
    body: "x".repeat(256001),
    size: 256001,
  });
  assert.equal((await f.serve()).status, 502);
  f.env.REPLAY_BUCKET.get = async () => ({ body: "x", size: 1 });
  assert.equal(
    (await f.serve(segment, { headers: { Range: "bytes=1-" } })).status,
    416,
  );
});
