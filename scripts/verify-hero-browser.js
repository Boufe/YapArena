/* global document, window */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import express from "express";
import { chromium } from "playwright-core";
import axe from "axe-core";
import { createDiscoveryRouter } from "../dist/features/discovery/router.js";

// Component trial only: synthetic local media, no hosted target or account writes.
const directory = "/private/tmp/yaparena-hero-browser";
await mkdir(directory, { recursive: true });
const fixtures = await mkdtemp(join(tmpdir(), "yaparena-hero-fixture-"));
const videoPath = join(fixtures, "preview.webm");
await promisify(execFile)("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=960x540:rate=12",
  "-t",
  "4",
  "-c:v",
  "libvpx",
  "-b:v",
  "300k",
  "-an",
  videoPath,
]);
const topic = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "cities",
  title: "Cities & society",
  summary: "Synthetic local interface fixture.",
  sideALabel: "People first",
  sideBLabel: "Keep cars moving",
  isDemo: false,
  createdAt: new Date(),
};
const debate = {
  id: "22222222-2222-4222-8222-222222222222",
  slug: "the-walkable-city",
  proposition: "Should cities prioritize walkability over cars?",
  status: "replay",
  rulesVersion: "prototype-media-1",
  scheduledAt: null,
  liveStartedAt: new Date(),
  liveEndedAt: new Date(),
  isDemo: false,
  createdAt: new Date(),
  topic,
  speakerA: { handle: "alex", displayName: "Alex Rivera" },
  speakerB: { handle: "morgan", displayName: "Morgan Lee" },
  sponsor: null,
};
const list = (items) => ({
  items,
  pagination: { limit: 3, offset: 0, hasMore: false },
});
let grants = 0,
  deny = false;
const app = express();
app.use(
  "/assets",
  express.static(new URL("../public/", import.meta.url).pathname),
);
app.get("/fixture.webm", (_r, s) => s.sendFile(videoPath));
app.get("/api/media/events/:id/replay", (_r, s) => {
  grants++;
  if (deny) return s.status(404).json({ error: "unavailable" });
  return s.json({
    type: "file",
    url: "/fixture.webm",
    expiresIn: 300,
    expiresAt: new Date(Date.now() + 300000).toISOString(),
  });
});
app.get("/api/media/events/:id", (_r, s) =>
  s.json({
    eventStatus: "replay",
    state: { state: "ended", recordingStatus: "ready" },
  }),
);
app.use(
  createDiscoveryRouter({
    discovery: {
      getFeaturedDebate: async () => debate,
      listDebates: async () => list([debate]),
      listTopics: async () => list([topic]),
      getDebate: async () => debate,
    },
    mediaEnabled: true,
    applicationOrigin: "http://localhost",
  }),
);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const checks = {},
  errors = [],
  requests = [];
try {
  browser = await chromium.launch({
    executablePath:
      process.env.BROWSER_CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1050 },
    reducedMotion: "no-preference",
  });
  await context.addInitScript(() =>
    window.localStorage.setItem("yaparena-measurement-declined", "1"),
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push(request.url()));
  await page.mouse.move(0, 0);
  await page.goto(base);
  await page.waitForFunction(
    () =>
      document.querySelector("[data-featured-preview]").dataset.playing ===
      "true",
  );
  assert.equal(await page.locator("h1").textContent(), debate.proposition);
  assert.equal(
    await page
      .locator("[data-featured-video]")
      .evaluate(
        (video) => video.muted && !video.paused && video.currentTime >= 0,
      ),
    true,
  );
  assert.equal(
    requests.some((url) =>
      /hero-live\.bundle|media\.bundle|replay\.bundle/.test(url),
    ),
    false,
    "native replay does not load a live SDK, full watching client or HLS library",
  );
  checks.mutedAutoplayAndDeferredTransport = true;
  await page.waitForFunction(
    () =>
      Number(
        window.getComputedStyle(document.querySelector("[data-featured-media]"))
          .opacity,
      ) === 1,
  );
  await page.screenshot({ path: directory + "/desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Pause video preview" }).click();
  assert.equal(
    await page
      .locator("[data-featured-video]")
      .evaluate((video) => video.paused && !video.getAttribute("src")),
    true,
  );
  await page.getByRole("button", { name: "Play video preview" }).click();
  await page.waitForFunction(
    () =>
      document.querySelector("[data-featured-preview]").dataset.playing ===
      "true",
  );
  await page.locator(".site-footer").scrollIntoViewIfNeeded();
  await page.waitForFunction(
    () =>
      document.querySelector("[data-featured-preview]").dataset.playing ===
      "false",
  );
  const stopped = grants;
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(
    () =>
      document.querySelector("[data-featured-preview]").dataset.playing ===
      "true",
  );
  assert.ok(grants > stopped);
  checks.pauseAndOffscreenRelease = true;
  await page.locator("[data-featured-open]").hover();
  await page.waitForFunction(() =>
    document
      .querySelector("[data-featured-preview]")
      .classList.contains("is-entering"),
  );
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".is-entering").count(), 0);
  await page.mouse.move(0, 0);
  await page.locator("[data-featured-open]").hover();
  await page.mouse.move(0, 0);
  assert.equal(await page.locator(".is-entering").count(), 0);
  checks.hoverCancellation = true;
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () =>
    (
      await window.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      })
    ).violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      targets: nodes.map((node) => node.target),
    })),
  );
  assert.deepEqual(violations, []);
  checks.axeNoViolations = true;
  await page.locator("[data-featured-open]").hover();
  await page.waitForURL("**/debates/the-walkable-city");
  assert.equal(await page.locator("[data-media-event]").count(), 1);
  checks.sustainedHoverEntersWatchingInterface = true;
  await page.emulateMedia({ reducedMotion: "reduce" });
  const beforeReduced = grants;
  await page.goto(base);
  await page.waitForFunction(
    () =>
      document.querySelector("[data-featured-status]").textContent ===
      "Preview paused",
  );
  await page.getByRole("button", { name: "Play video preview" }).click();
  await page.waitForFunction(
    () =>
      document.querySelector("[data-featured-preview]").dataset.playing ===
      "true",
  );
  assert.equal(grants, beforeReduced + 1);
  await page.locator("[data-featured-open]").hover();
  assert.equal(await page.locator(".is-entering").count(), 0);
  checks.reducedMotionUsesExplicitPlay = true;
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.screenshot({ path: directory + "/mobile.png", fullPage: true });
  await page.locator("[data-featured-open]").click();
  await page.waitForURL("**/debates/the-walkable-city");
  checks.mobileAndClickEntry = true;
  const saved = await context.newPage();
  await saved.addInitScript(() =>
    Object.defineProperty(window.navigator, "connection", {
      value: { saveData: true, effectiveType: "4g", addEventListener() {} },
      configurable: true,
    }),
  );
  const beforeSaved = grants;
  await saved.goto(base);
  await saved.getByRole("button", { name: "Play video preview" }).waitFor();
  await saved.evaluate(
    () => new Promise((resolve) => window.setTimeout(resolve, 2000)),
  );
  assert.equal(grants, beforeSaved);
  checks.saveDataSkipsAutoplay = true;
  deny = true;
  await saved.getByRole("button", { name: "Play video preview" }).click();
  await saved.waitForFunction(
    () =>
      document.querySelector("[data-featured-status]").textContent ===
      "Preview unavailable",
  );
  assert.equal(await saved.locator("h1").textContent(), debate.proposition);
  checks.deniedPreviewKeepsUsableHero = true;
  assert.deepEqual(errors, []);
  await writeFile(
    directory + "/evidence.json",
    JSON.stringify(
      {
        result: "PASS",
        checks,
        errors,
        scope:
          "Loopback component trial with synthetic WebM; real LiveKit/HLS delivery and devices are not assessed.",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ result: "PASS", checks }));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
