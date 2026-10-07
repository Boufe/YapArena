/* global document, window */
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { createReplayAccess } from "../dist/features/media/replay.js";

// Separate authorized staging operator. Fixture includes a temporary synthetic
// session cookie: never print it, signed URLs or environment values. Caller owns
// its DB connection and the final exact-prefix database/provider/storage cleanup.
export async function verifyHostedMediaReplay({
  owner,
  environment,
  base,
  fixture,
  sourceCommit,
  artifactDirectory,
  executablePath,
  reviewedCaptionFile,
}) {
  assert.equal(base, "https://yaparena-staging-web.onrender.com");
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(fixture.tag, /^media-browser-[a-f0-9]{8}$/);
  assert.match(fixture.room, /^[a-f0-9-]{36}$/);
  assert.ok(fixture.recordingKey.startsWith("debates/" + fixture.room + "/"));
  assert.match(fixture.operatorToken, /^[a-f0-9]{64}$/);
  assert.equal(
    (await owner.query("SELECT current_user AS role")).rows[0].role,
    "yaparena_owner",
  );
  const vars = environment;
  assert.equal(vars.MEDIA_REPLAY_EDGE_ROOMS, fixture.room);
  assert.ok(vars.MEDIA_REPLAY_SIGNING_SECRET);
  const directory = resolve(artifactDirectory);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const save = (name, value) =>
    writeFile(
      resolve(directory, name + ".json"),
      JSON.stringify(value, null, 2) + "\n",
      { mode: 0o600 },
    );
  let browser,
    page,
    phase = "publish";
  const record = {
    at: new Date().toISOString(),
    sourceCommit,
    synthetic: true,
    physicalDevices: false,
    measurements: {},
    checks: {},
  };
  const access = [];
  async function until(fn, ms = 30000) {
    const start = performance.now();
    while (!(await fn())) {
      assert.ok(performance.now() - start < ms, "trial deadline " + phase);
      await delay(200);
    }
  }
  async function edge(url, options = {}, status = 200) {
    const r = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(r.status, status, "private edge " + phase);
    return r;
  }
  async function action(path, method, body, status) {
    const r = await fetch(base + "/api/media/events/" + fixture.room + path, {
      method,
      signal: AbortSignal.timeout(15000),
      headers: {
        Origin: base,
        Cookie: "__Host-session=" + fixture.operatorToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, status, "authorized " + path);
    if (status !== 204) await r.body?.cancel();
  }
  try {
    const existing = (
      await owner.query(
        "SELECT slug,status,publication_state FROM debates WHERE id=$1",
        [fixture.room],
      )
    ).rows[0];
    assert.equal(existing?.slug, fixture.tag);
    if (existing.publication_state === "hidden")
      await owner.query(
        "UPDATE debates SET publication_state='published' WHERE id=$1 AND slug=$2",
        [fixture.room, fixture.tag],
      );
    const captions = await readFile(reviewedCaptionFile, "utf8");
    await action("/captions", "PUT", { vtt: captions }, 204);
    if (existing.status === "ended")
      await action(
        "/replay",
        "POST",
        { reason: "Synthetic private edge playback trial" },
        200,
      );
    else assert.equal(existing.status, "replay");
    phase = "browser";
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext();
    page = await context.newPage();
    let renewals = 0;
    await page.route(
      "**/api/media/events/" + fixture.room + "/replay",
      async (route) => {
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        const body = await response.json();
        assert.equal(body.type, "hls");
        access.push(body);
        renewals++;
        // Accelerate only the application renewal timer. Real edge capabilities keep
        // their unmodified 300-second signature/expiry and are tested below.
        if (renewals === 1) {
          body.expiresIn = 45;
          body.expiresAt = new Date(Date.now() + 45000).toISOString();
        }
        await route.fulfill({ response, json: body });
      },
    );
    await page.goto(base + "/debates/" + fixture.tag);
    const asset = await page
      .locator('script[src*="media.bundle.js"]')
      .getAttribute("src");
    assert.equal(
      new URL(asset, base).searchParams.get("v"),
      sourceCommit.slice(0, 12),
    );
    await page.locator("[data-media-replay]").waitFor({ state: "visible" });
    await page.evaluate(() => {
      const v = document.querySelector("[data-media-replay-video]");
      window.__trialLoads = 0;
      v.addEventListener("loadedmetadata", () => window.__trialLoads++);
    });
    const start = performance.now();
    await page.locator("[data-media-replay]").focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => {
        const v = document.querySelector("[data-media-replay-video]");
        return v.videoWidth > 0 && v.currentTime > 0 && !v.paused;
      },
      {},
      { timeout: 30000 },
    );
    record.measurements.replayKeyboardToVideoProgressMs = Math.round(
      performance.now() - start,
    );
    const sound = page.locator("[data-media-sound]");
    record.soundActivationRequired = await sound.isVisible();
    if (record.soundActivationRequired) await sound.click();
    // Browsers do not fetch a disabled text track. Explicitly enable captions as
    // a viewer would before asserting its loaded cues.
    await page.evaluate(
      () =>
        (document.querySelector(
          "[data-media-replay-video]",
        ).textTracks[0].mode = "showing"),
    );
    await page.waitForFunction(() => {
      const v = document.querySelector("[data-media-replay-video]");
      return v.textTracks[0]?.cues?.length === 3;
    });
    phase = "seek-and-renewal";
    const before = await page.evaluate(() => {
      const v = document.querySelector("[data-media-replay-video]");
      v.pause();
      v.currentTime = 20;
      v.playbackRate = 1.25;
      v.textTracks[0].mode = "showing";
      return window.__trialLoads;
    });
    await until(() => renewals >= 2, 25000);
    await page.waitForFunction(
      (previous) => {
        const v = document.querySelector("[data-media-replay-video]");
        return (
          window.__trialLoads > previous &&
          v.readyState >= 2 &&
          v.paused &&
          Math.abs(v.currentTime - 20) < 0.5 &&
          v.playbackRate === 1.25 &&
          v.textTracks[0]?.mode === "showing"
        );
      },
      before,
      { timeout: 30000 },
    );
    record.checks.hlsBrowserDecodedVideo = "PASS";
    record.checks.webVttCues = "PASS";
    record.checks.keyboardPlayback = "PASS";
    record.checks.seekRatePauseCaptionRenewal = "PASS";
    record.renewalTimer =
      "First application expiresIn accelerated to 45s; real signed edge lifetime remains 300s";
    const grant = access[0];
    const master = await edge(grant.url, { headers: { Origin: base } });
    assert.equal(master.headers.get("access-control-allow-origin"), base);
    assert.match(master.headers.get("cache-control"), /no-store/);
    const playlist = (await master.text())
      .split("\n")
      .find((l) => l && !l.startsWith("#"));
    const variant = await edge(playlist, { headers: { Origin: base } });
    const segment = (await variant.text())
      .split("\n")
      .find((l) => l && !l.startsWith("#"));
    const first = await edge(segment, { headers: { Origin: base } });
    const firstBytes = new Uint8Array(await first.arrayBuffer());
    assert.ok(firstBytes.length > 1000);
    const head = await edge(segment, {
      method: "HEAD",
      headers: { Origin: base },
    });
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal(Number(head.headers.get("content-length")), firstBytes.length);
    const range = await edge(
      segment,
      { headers: { Origin: base, Range: "bytes=0-99" } },
      206,
    );
    assert.equal((await range.arrayBuffer()).byteLength, 100);
    assert.match(range.headers.get("content-range"), /^bytes 0-99\/[0-9]+$/);
    const cached = await edge(segment, { headers: { Origin: base } });
    assert.deepEqual(new Uint8Array(await cached.arrayBuffer()), firstBytes);
    const unsigned = new URL(segment);
    unsigned.search = "";
    await edge(unsigned.href, {}, 403);
    const tampered = new URL(segment);
    tampered.searchParams.set(
      "access",
      tampered.searchParams.get("access") + "x",
    );
    await edge(tampered.href, {}, 403);
    const cross = new URL(segment);
    cross.pathname = cross.pathname.replace(fixture.room, randomUUID());
    await edge(cross.href, {}, 403);
    await edge(
      segment,
      { headers: { Origin: "https://invalid.example" } },
      403,
    );
    const expired = createReplayAccess(
      fixture.recordingKey,
      vars.MEDIA_REPLAY_EDGE_URL,
      vars.MEDIA_REPLAY_SIGNING_SECRET,
      Date.now() - 301000,
    );
    await edge(expired.url, {}, 403);
    record.checks.edgeCorsHeadRange = "PASS";
    record.checks.cachedResourceStillRequiresCapability = "PASS";
    record.checks.tamperedUnsignedCrossRecordingExpiredDenial = "PASS";
    record.edgeCacheHit =
      "Repeated same segment bytes; cache-hit origin not independently observable";
    phase = "visibility-removal";
    await owner.query(
      "UPDATE debates SET publication_state='hidden' WHERE id=$1 AND slug=$2",
      [fixture.room, fixture.tag],
    );
    const denied = await fetch(
      base + "/api/media/events/" + fixture.room + "/replay",
      { signal: AbortSignal.timeout(15000) },
    );
    assert.equal(denied.status, 404);
    await denied.body?.cancel();
    await page.waitForFunction(
      () => {
        const v = document.querySelector("[data-media-replay-video]");
        return (
          v.paused && v.hidden && !v.getAttribute("src") && v.readyState === 0
        );
      },
      {},
      { timeout: 30000 },
    );
    record.checks.removalDeniesFreshGrantAndStopsPublicPlayer = "PASS";
    const last = access.at(-1);
    const residual = await edge(last.url);
    await residual.body?.cancel();
    record.preExpiryCapabilityAfterRemovalStatus = 200;
    await browser.close();
    browser = undefined;
    console.log(
      JSON.stringify({
        phase: "hosted-replay-browser-and-removal",
        result: "PASS",
        checks: record.checks,
        measurements: record.measurements,
        remainingCapabilityWindow:
          "Waiting for actual issued signature expiry; pre-expiry access remains allowed",
      }),
    );
    phase = "natural-capability-expiry";
    const expiresAt = new Date(last.expiresAt).getTime();
    const originalLifetime = last.expiresIn;
    assert.equal(originalLifetime, 300);
    while (Date.now() <= expiresAt + 1000)
      await delay(Math.min(15000, expiresAt + 1001 - Date.now()));
    await edge(last.url, {}, 403);
    record.checks.naturallyExpiredIssuedCapability = "PASS";
    record.capabilityLifetimeSeconds = 300;
    record.result = "PASS";
    record.finishedAt = new Date().toISOString();
    await save("media-replay", record);
    return record;
  } catch (error) {
    record.result = "FAIL";
    record.phase = phase;
    record.errorName = error.name;
    record.code = error.code;
    record.finishedAt = new Date().toISOString();
    if (page && !page.isClosed())
      record.browserState = await page.evaluate(() => ({
        status: document.querySelector("[data-media-status]")?.textContent,
        readyState: document.querySelector("[data-media-replay-video]")
          ?.readyState,
        currentTime: document.querySelector("[data-media-replay-video]")
          ?.currentTime,
        paused: document.querySelector("[data-media-replay-video]")?.paused,
      }));
    await save("media-replay-failed", record);
    return record;
  } finally {
    if (browser) await browser.close();
  }
}
