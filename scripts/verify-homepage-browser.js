/* global document, window, getComputedStyle, DOMMatrixReadOnly */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import express from "express";
import { chromium } from "playwright-core";
import axe from "axe-core";
import { createApp } from "../dist/app.js";
import { createLogger } from "../dist/platform/logger.js";

const referencePath = process.env.HOMEPAGE_REFERENCE_PATH;
if (!referencePath)
  throw new Error(
    "HOMEPAGE_REFERENCE_PATH must point to the supplied HTML export",
  );
const reference = await readFile(referencePath, "utf8");
assert.ok(
  reference.includes("ya-market-v4") && reference.includes("data-srcdoc"),
);
const directory =
  process.env.HOMEPAGE_ARTIFACT_DIR ?? "/private/tmp/yaparena-homepage-browser";
await mkdir(directory, { recursive: true });
const topic = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "published-idea",
  title: "Published public idea",
  summary: "Synthetic local integration fixture.",
  sideALabel: "Support",
  sideBLabel: "Oppose",
  isDemo: false,
  createdAt: new Date("2026-10-01"),
};
const debate = {
  id: "22222222-2222-4222-8222-222222222222",
  slug: "published-debate",
  proposition: "A public debate for the idea",
  status: "replay",
  rulesVersion: "prototype-media-1",
  scheduledAt: null,
  liveStartedAt: new Date("2026-10-01"),
  liveEndedAt: new Date("2026-10-01"),
  isDemo: false,
  createdAt: new Date("2026-10-01"),
  topic: {
    slug: topic.slug,
    title: topic.title,
    sideALabel: topic.sideALabel,
    sideBLabel: topic.sideBLabel,
  },
  speakerA: { handle: "alex", displayName: "Alex Public" },
  speakerB: { handle: "morgan", displayName: "Morgan Public" },
  sponsor: null,
};
const list = (items) => ({
  items,
  pagination: { limit: 12, offset: 0, hasMore: false },
});
let signedIn = false,
  followed = false,
  followWrites = 0,
  unavailable = false;
const app = express();
app.get("/reference", (_r, s) => s.type("html").send(reference));
app.get("/api/auth/me", (_r, s) =>
  signedIn
    ? s.json({ user: { id: "synthetic-local-user" } })
    : s.status(401).json({ error: "authentication required" }),
);
app.get("/api/me/profile", (_r, s) =>
  signedIn
    ? s.json({ profile: { displayName: "Local Tester" } })
    : s.sendStatus(401),
);
app.get("/api/a4/wallet", (_r, s) =>
  signedIn
    ? s.json({ balances: [{ kind: "available", amount: "1234000000" }] })
    : s.sendStatus(401),
);
app
  .route("/api/me/follows/topics/:slug")
  .get((_r, s) =>
    signedIn
      ? s.json({ following: followed })
      : s.status(401).json({ error: "authentication required" }),
  )
  .put((_r, s) => {
    if (!signedIn) return s.sendStatus(401);
    followWrites++;
    followed = true;
    return s.json({ following: true });
  })
  .delete((_r, s) => {
    if (!signedIn) return s.sendStatus(401);
    followWrites++;
    followed = false;
    return s.json({ following: false });
  });
app.use(
  createApp({
    discovery: {
      listTopics: async () => {
        if (unavailable) throw Error("local fixture unavailable");
        return list([topic]);
      },
      listWatchableDebates: async () => [debate],
      listDebates: async () => list([debate]),
      getDebate: async (slug) => (slug === debate.slug ? debate : null),
      getTopic: async (slug) => (slug === topic.slug ? topic : null),
    },
    homepageReferenceEnabled: true,
    // Configure the existing media boundary only to select its public playable list.
    // No provider connection is used by homepage cards.
    identity: {},
    matching: {},
    media: {},
    mediaProvider: {
      publicUrl: "wss://media.example.test",
      playbackOrigin: "https://media.example.test",
      playbackOrigins: ["https://media.example.test"],
    },
    messages: { isReady: async () => {} },
    users: {},
    sessions: { findUserByTokenHash: async () => null },
    logger: createLogger({ enabled: false }),
    applicationOrigin: "http://localhost",
    environment: "development",
  }),
);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const checks = {},
  errors = [],
  violations = [],
  comparisons = [];
try {
  browser = await chromium.launch({
    executablePath:
      process.env.BROWSER_CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    reducedMotion: "no-preference",
  });
  context.setDefaultTimeout(15000);
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem("yaparena-measurement-declined", "1");
    } catch {
      /* The exported reference iframe intentionally has an opaque origin. */
    }
    window.homeCsp = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      window.homeCsp.push({
        directive: e.violatedDirective,
        uri: e.blockedURI,
      }),
    );
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  async function openNative() {
    await page.mouse.move(0, 0);
    await page.goto(base + "/?reference=1");
    await page.locator("#ya-grid [data-expand]").first().waitFor();
  }
  async function pause(scope) {
    await scope
      .getByRole("button", { name: "Pause trending rotation", exact: true })
      .click();
  }
  async function stableShot(scope, name) {
    await scope.evaluate(() => {
      for (const a of document
        .querySelector("#ya-argument-track")
        .getAnimations()) {
        a.pause();
        a.currentTime = 0;
      }
      const fill = document.querySelector(
        ".ya-carousel-dot[aria-current=true] .ya-dot-fill",
      );
      for (const a of fill?.getAnimations() ?? []) a.cancel();
      if (fill) fill.style.transform = "scaleX(0)";
    });
    // Chrome clips cross-origin iframe rasterization to the outer viewport.
    // Use matching full-product capture viewports at the original responsive
    // width, changing only the export shell rather than its product DOM/CSS.
    const height = await scope
      .locator("#ya-market-v4")
      .evaluate((n) => n.scrollHeight);
    await page.setViewportSize({
      width: page.viewportSize().width,
      height: Math.ceil(height),
    });
    if (scope.frameElement) {
      await (
        await scope.frameElement()
      ).evaluate((frame, height) => {
        frame.style.height = `${height}px`;
      }, height);
    }
    await scope.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => window.scrollTo(0, 0));
    await scope
      .locator("#ya-market-v4")
      .screenshot({ path: `${directory}/${name}.png` });
  }
  async function geometry(scope) {
    return scope.evaluate(() => {
      const origin = document
        .querySelector("#ya-market-v4")
        .getBoundingClientRect();
      return Object.fromEntries(
        [
          ".ya-top",
          ".ya-content",
          ".ya-heading",
          ".ya-layout",
          ".ya-feature",
          ".ya-side",
          ".ya-grid",
          ".ya-marketcard",
        ].map((selector) => {
          const rect = document.querySelector(selector).getBoundingClientRect();
          return [
            selector,
            {
              x: rect.x - origin.x,
              y: rect.y - origin.y,
              width: rect.width,
              height: rect.height,
            },
          ];
        }),
      );
    });
  }
  async function compare(width) {
    await page.setViewportSize({ width, height: 1100 });
    await page.goto(base + "/reference");
    const ref = page.frames().find((f) => f.parentFrame());
    await ref.locator("[data-expand]").first().waitFor();
    await pause(ref);
    await stableShot(ref, `reference-${width}-initial`);
    const expected = await geometry(ref);
    await openNative();
    await pause(page);
    await stableShot(page, `implemented-${width}-initial`);
    const actual = await geometry(page);
    for (const key of Object.keys(expected))
      for (const dimension of ["x", "y", "width", "height"])
        assert.ok(
          Math.abs(expected[key][dimension] - actual[key][dimension]) < 1,
          `${width}px ${key}.${dimension}: reference ${expected[key][dimension]} / implementation ${actual[key][dimension]}`,
        );
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    comparisons.push({
      width,
      maxGeometryDifference: Math.max(
        ...Object.keys(expected).flatMap((k) =>
          Object.keys(expected[k]).map((d) =>
            Math.abs(expected[k][d] - actual[k][d]),
          ),
        ),
      ),
    });
    if (width === 1440 || width === 390) {
      await page.getByRole("button", { name: "Next trending idea" }).click();
      await page.waitForFunction(
        () => !document.querySelector(".ya-carousel-ghost"),
      );
      await stableShot(page, `implemented-${width}-second`);
      await page.locator("#ya-chart").hover({
        position: {
          x: Math.min(
            180,
            (await page.locator("#ya-chart").boundingBox()).width * 0.4,
          ),
          y: 60,
        },
      });
      await page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector("#ya-chart-tooltip"))
            .opacity === "1",
      );
      await page.screenshot({
        path: `${directory}/implemented-${width}-hover.png`,
        fullPage: true,
      });
      await page.locator('[data-expand="ai"]').click();
      await page.locator("#ya-detail").waitFor();
      await page.waitForFunction(
        () => document.querySelector("#ya-detail").getAnimations().length === 0,
      );
      await stableShot(page, `implemented-${width}-expanded`);
      await page.goto(base + "/reference");
      const r = page.frames().find((f) => f.parentFrame());
      await r.locator("[data-expand]").first().waitFor();
      await pause(r);
      await r.getByRole("button", { name: "Next trending idea" }).click();
      await r.waitForFunction(
        () => !document.querySelector(".ya-carousel-ghost"),
      );
      await stableShot(r, `reference-${width}-second`);
      await r.locator("#ya-chart").hover({
        position: {
          x: Math.min(
            180,
            (await r.locator("#ya-chart").boundingBox()).width * 0.4,
          ),
          y: 60,
        },
      });
      await r.waitForFunction(
        () =>
          getComputedStyle(document.querySelector("#ya-chart-tooltip"))
            .opacity === "1",
      );
      await r
        .locator("#ya-market-v4")
        .screenshot({ path: `${directory}/reference-${width}-hover.png` });
      await r.locator('[data-expand="ai"]').click();
      await r.waitForFunction(
        () =>
          document.querySelector("#ya-detail")?.getAnimations().length === 0,
      );
      await stableShot(r, `reference-${width}-expanded`);
    }
  }
  for (const width of [1440, 1920, 1024, 768, 390, 320]) await compare(width);
  checks.referenceGeometryAndResponsiveScreenshots = true;
  await page.setViewportSize({ width: 1440, height: 1100 });
  await openNative();
  await pause(page);
  // Every slide must use its own exact reference arguments and debate.
  await page.goto(base + "/reference");
  const ref = page.frames().find((f) => f.parentFrame());
  await ref.locator("[data-expand]").first().waitFor();
  await pause(ref);
  const expectedIdeas = [];
  for (const id of ["ai", "work", "nuclear", "ubi", "city", "growth"]) {
    await ref.locator(`[data-trending="${id}"]`).click();
    await ref.waitForFunction(
      () => !document.querySelector(".ya-carousel-ghost"),
    );
    expectedIdeas.push(
      await ref.evaluate(() => ({
        title: document.querySelector("#ya-title").textContent,
        arguments: [
          ...document.querySelectorAll(
            ".ya-argument-list:first-child .ya-argument-text",
          ),
        ].map((n) => n.textContent),
        rates: [
          ...document.querySelectorAll(".ya-argument-list:first-child strong"),
        ].map((n) => n.textContent),
        debate: document.querySelector("#ya-side .ya-debate-title").textContent,
      })),
    );
  }
  await openNative();
  await pause(page);
  for (const [i, id] of [
    "ai",
    "work",
    "nuclear",
    "ubi",
    "city",
    "growth",
  ].entries()) {
    await page.locator(`[data-trending="${id}"]`).click();
    await page.waitForFunction(
      () => !document.querySelector(".ya-carousel-ghost"),
    );
    const actual = await page.evaluate(() => ({
      title: document.querySelector("#ya-title").textContent,
      arguments: [
        ...document.querySelectorAll(
          ".ya-argument-list:first-child .ya-argument-text",
        ),
      ].map((n) => n.textContent),
      rates: [
        ...document.querySelectorAll(".ya-argument-list:first-child strong"),
      ].map((n) => n.textContent),
      debate: document.querySelector("#ya-side .ya-debate-title").textContent,
    }));
    assert.deepEqual(actual, expectedIdeas[i]);
  }
  checks.everySlideHasItsOwnArgumentsAndDebate = true;
  await page.getByRole("button", { name: "Next trending idea" }).click();
  let animation = await page.locator("#ya-trending-slide").evaluate((n) => ({
    first: n.getAnimations()[0].effect.getKeyframes()[0].transform,
    duration: n.getAnimations()[0].effect.getTiming().duration,
    easing: n.getAnimations()[0].effect.getTiming().easing,
  }));
  assert.equal(animation.first, "translateX(104%)");
  assert.equal(animation.duration, 620);
  assert.equal(animation.easing, "cubic-bezier(0.22, 0.68, 0.16, 1)");
  await page.getByRole("button", { name: "Previous trending idea" }).click();
  assert.equal(
    await page
      .locator("#ya-trending-slide")
      .evaluate((n) => n.getAnimations()[0].effect.getKeyframes()[0].transform),
    "translateX(-104%)",
  );
  for (let i = 0; i < 7; i++)
    await page.getByRole("button", { name: "Next trending idea" }).click();
  assert.equal(await page.locator(".ya-carousel-ghost").count(), 1);
  assert.deepEqual(
    await page.evaluate(() => {
      const seen = new Set(),
        duplicates = [];
      document.querySelectorAll("[id]").forEach((n) => {
        if (seen.has(n.id)) duplicates.push(n.id);
        seen.add(n.id);
      });
      return duplicates;
    }),
    [],
  );
  assert.equal(
    await page.evaluate(() => document.activeElement.dataset.carousel),
    "next",
  );
  await page.waitForFunction(
    () => !document.querySelector(".ya-carousel-ghost"),
  );
  checks.slideDirectionsTimingAndRapidNavigation = true;
  // Both chart sizes scrub locally at the actual pointer x and restore the latest readout.
  await page.locator('[data-trending="ai"]').click();
  await page.waitForFunction(
    () => !document.querySelector(".ya-carousel-ghost"),
  );
  async function scrub(selector, readout) {
    const chart = page.locator(selector),
      rect = await chart.boundingBox(),
      before = requests.length;
    await chart.hover({ position: { x: rect.width * 0.37, y: 70 } });
    await page.waitForFunction(
      (s) => document.querySelector(s).classList.contains("is-scrubbing"),
      selector,
    );
    const state = await chart.evaluate((n) => ({
      x: Number(n.querySelector("[data-chart-hover-guide]").getAttribute("x1")),
      width: n.getBoundingClientRect().width,
    }));
    assert.ok(Math.abs(state.x - state.width * 0.37) < 1);
    assert.notEqual(await page.locator(readout).textContent(), "68%");
    await page.mouse.move(rect.x + rect.width * 0.63, rect.y + 90);
    await page.waitForTimeout(40);
    assert.equal(requests.length, before);
    await page.mouse.move(0, 0);
    await page.waitForFunction(
      (s) => !document.querySelector(s).classList.contains("is-scrubbing"),
      selector,
    );
    assert.equal(await page.locator(readout).textContent(), "68%");
  }
  await scrub("#ya-chart", "#ya-value");
  await page.locator('[data-expand="ai"]').click();
  await scrub("#ya-detail-chart", "#ya-detail-value");
  const slider = page.getByRole("slider", {
    name: "Explore expanded idea chart history",
  });
  await slider.focus();
  await slider.press("ArrowLeft");
  assert.notEqual(await page.locator("#ya-detail-value").textContent(), "68%");
  await slider.press("Escape");
  assert.equal(await page.locator("#ya-detail-value").textContent(), "68%");
  await page.locator("#ya-detail-chart").dispatchEvent("pointerdown", {
    pointerType: "touch",
    clientX: (await page.locator("#ya-detail-chart").boundingBox()).x + 140,
  });
  await page.waitForFunction(() =>
    document
      .querySelector("#ya-detail-chart")
      .classList.contains("is-scrubbing"),
  );
  await page.locator("#ya-detail-chart").dispatchEvent("pointercancel");
  checks.mainExpandedPointerTouchAndKeyboardCharts = true;
  await page.getByRole("button", { name: "Next trending idea" }).click();
  assert.equal(
    await page.locator("#ya-detail h2").textContent(),
    "AI models should be open source.",
  );
  await page.selectOption("#ya-sort", "moves");
  const placement = await page.locator("#ya-detail").evaluate((n) => ({
    previous: n.previousElementSibling.dataset.expand,
    width: n.getBoundingClientRect().width,
    grid: n.parentElement.getBoundingClientRect().width,
  }));
  assert.equal(placement.previous, "work");
  assert.equal(placement.width, placement.grid);
  await page.locator('[data-debate-filter="replay"]').focus();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () =>
      document.querySelector("#ya-detail").previousElementSibling.dataset
        .expand === "ai",
  );
  assert.equal(
    await page.evaluate(() => document.activeElement.dataset.debateFilter),
    "replay",
  );
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.locator('[data-debate-filter="replay"]').click();
  assert.equal(await page.locator("[data-open-debate]").count(), 2);
  await page.locator("[data-open-debate]").first().click();
  assert.equal(await page.locator("#ya-player-preview").isVisible(), true);
  await page.getByRole("button", { name: "Close debate preview" }).click();
  await page.locator('[data-debate-filter="live"]').click();
  assert.equal(await page.locator("[data-open-debate]").count(), 3);
  await page.locator("[data-open-debate]").first().click();
  await page.getByRole("button", { name: "Enter this round" }).click();
  await page.locator("#ya-inline-expectation").fill("72");
  await page.getByRole("button", { name: "Preview position" }).click();
  assert.match(
    await page.locator("#ya-inline-review").textContent(),
    /No coins spent/,
  );
  await page.getByRole("button", { name: "Close expanded idea" }).click();
  assert.equal(await page.locator("#ya-detail").count(), 0);
  checks.independentExpansionPlacementAndDebateFilters = true;
  await page.locator("#ya-search").fill("nuclear");
  assert.equal(await page.locator("[data-expand]").count(), 1);
  await page.locator("#ya-search").fill("");
  await page.locator('[data-filter="Climate"]').click();
  assert.equal(await page.locator("[data-expand]").count(), 1);
  await page.locator('[data-filter="All"]').click();
  await page.locator('[data-nav="following"]').click();
  assert.equal(await page.locator("[data-expand]").count(), 2);
  assert.equal(followWrites, 0);
  checks.searchCategoriesSortingAndLocalDemoFollows = true;
  // Verify actual animation direction/loop period and independent pause.
  await page.locator('[data-nav="all"]').click();
  await page.locator('[data-trending="ai"]').click();
  await page.waitForFunction(
    () => !document.querySelector(".ya-carousel-ghost"),
  );
  await page.getByRole("button", { name: "Play trending rotation" }).click();
  await page.locator("#ya-search").focus();
  await page.mouse.move(0, 0);
  const transform = () =>
    page
      .locator("#ya-argument-track")
      .evaluate(
        (n) => new DOMMatrixReadOnly(getComputedStyle(n).transform).m42,
      );
  const first = await transform();
  await page.waitForTimeout(90);
  assert.ok((await transform()) < first);
  const cycle = await page.locator("#ya-argument-track").evaluate((n) => ({
    duration: n.getAnimations()[0].effect.getTiming().duration,
    children: n.children.length,
    hidden: n.children[1].getAttribute("aria-hidden"),
  }));
  assert.deepEqual(cycle, { duration: 32000, children: 2, hidden: "true" });
  await page.locator("#ya-arguments").hover();
  const held = await transform();
  await page.waitForTimeout(90);
  assert.ok(Math.abs((await transform()) - held) < 1);
  await page.getByRole("button", { name: "Pause argument flow" }).click();
  assert.equal(
    await page.locator("#ya-arguments").getAttribute("data-paused"),
    "true",
  );
  checks.upwardArgumentLoopAndPause = true;
  // Use the browser's controlled clock to inspect progress/advance over repeated cycles.
  const timed = await context.newPage();
  await timed.clock.install();
  await timed.goto(base + "/?reference=1");
  await timed.locator("[data-expand]").first().waitFor();
  await timed.mouse.move(0, 0);
  const selected = () =>
    timed
      .locator(".ya-carousel-dot[aria-current=true]")
      .getAttribute("data-trending");
  await timed.clock.runFor(2000);
  const elapsed = await timed
    .locator(".ya-carousel-dot[aria-current=true] .ya-dot-fill")
    .evaluate((n) => new DOMMatrixReadOnly(getComputedStyle(n).transform).m11);
  assert.ok(elapsed > 0.28 && elapsed < 0.36);
  await timed
    .locator("#ya-chart")
    .dispatchEvent("pointerenter", { pointerType: "mouse" }); // Hover the actual carousel region below.
  await timed
    .locator("#ya-carousel")
    .dispatchEvent("pointerenter", { pointerType: "mouse" });
  await timed.clock.runFor(10000);
  assert.equal(await selected(), "ai");
  const preserved = await timed
    .locator(".ya-carousel-dot[aria-current=true] .ya-dot-fill")
    .evaluate((n) => new DOMMatrixReadOnly(getComputedStyle(n).transform).m11);
  assert.ok(Math.abs(preserved - elapsed) < 0.01);
  await timed
    .locator("#ya-carousel")
    .dispatchEvent("pointerleave", { pointerType: "mouse" });
  await timed.clock.runFor(4700);
  assert.equal(await selected(), "work");
  await timed.clock.runFor(6520);
  assert.equal(await selected(), "nuclear");
  await timed.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      value: true,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await timed.clock.runFor(13000);
  assert.equal(await selected(), "nuclear");
  await timed.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      value: false,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await timed.locator('[data-carousel="pause"]').dispatchEvent("click");
  const savedFill = await timed
    .locator(".ya-carousel-dot[aria-current=true] .ya-dot-fill")
    .evaluate((n) => new DOMMatrixReadOnly(getComputedStyle(n).transform).m11);
  await timed.clock.runFor(8000);
  assert.equal(await selected(), "nuclear");
  await timed.locator('[data-carousel="pause"]').dispatchEvent("click");
  await timed.clock.runFor((1 - savedFill) * 6500 + 32);
  assert.equal(await selected(), "ubi");
  await timed.locator('#ya-side [data-action="trade"]').dispatchEvent("click");
  await timed.locator("#ya-search").focus();
  await timed.clock.runFor(13000);
  assert.equal(await selected(), "ubi");
  await timed.locator('#ya-side [data-action="live"]').dispatchEvent("click");
  await timed.locator("#ya-search").focus();
  await timed.clock.runFor(6520);
  assert.equal(await selected(), "city");
  await timed.close();
  // IntersectionObserver uses the actual compositor, independently of the
  // controlled animation clock above. Exercise offscreen suspension in real time.
  const offscreen = await context.newPage();
  await offscreen.setViewportSize({ width: 1440, height: 500 });
  await offscreen.goto(base + "/?reference=1");
  await offscreen.locator("#ya-grid [data-expand]").first().waitFor();
  await offscreen.mouse.move(0, 0);
  const offscreenSelected = await offscreen
    .locator(".ya-carousel-dot[aria-current=true]")
    .getAttribute("data-trending");
  await offscreen.evaluate(() =>
    window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }),
  );
  await offscreen.waitForFunction(
    () =>
      document.querySelector("#ya-market-v4").dataset.motionPaused === "true",
  );
  assert.ok(
    await offscreen
      .locator("#ya-carousel")
      .evaluate((n) => n.getBoundingClientRect().bottom < 0),
  );
  await offscreen.waitForTimeout(6700);
  assert.equal(
    await offscreen
      .locator(".ya-carousel-dot[aria-current=true]")
      .getAttribute("data-trending"),
    offscreenSelected,
  );
  await offscreen.close();
  checks.synchronizedProgressPauseResumeAndRepeatedCycles = true;
  checks.manualPauseAttentionAndOffscreenHold = true;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openNative();
  assert.equal(
    await page.getByRole("button", { name: "Play trending rotation" }).count(),
    1,
  );
  assert.equal(
    await page
      .locator("#ya-argument-track")
      .evaluate((n) => getComputedStyle(n).animationName),
    "none",
  );
  await page.getByRole("button", { name: "Next trending idea" }).click();
  assert.equal(await page.locator(".ya-carousel-ghost").count(), 0);
  checks.reducedMotionManualNavigation = true;
  const touchContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
  });
  const phone = await touchContext.newPage();
  phone.on("pageerror", (e) => errors.push(e.message));
  await phone.goto(base + "/?reference=1");
  await phone.locator("#ya-chart").waitFor();
  assert.ok(
    await phone.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await phone.locator("#ya-chart").scrollIntoViewIfNeeded();
  const phoneChart = await phone.locator("#ya-chart").boundingBox();
  await phone.touchscreen.tap(
    phoneChart.x + phoneChart.width * 0.4,
    phoneChart.y + 50,
  );
  await phone.waitForFunction(() =>
    document.querySelector("#ya-chart").classList.contains("is-scrubbing"),
  );
  await phone.locator("#ya-search").tap();
  assert.equal(
    await phone.locator("#ya-chart").getAttribute("class"),
    "ya-chart",
  );
  await touchContext.close();
  checks.coarsePointerMobileTouchInspection = true;
  // Real data uses nullable histories, actual wallet/follows and canonical routes.
  await page.goto(base);
  await page.locator("#ya-grid [data-expand]").first().waitFor();
  assert.equal(await page.locator("#ya-value").textContent(), "—");
  assert.equal(await page.locator("#ya-price").textContent(), "—");
  assert.equal(await page.locator("#ya-chart .ya-linepath").count(), 0);
  await page.locator('[data-nav="following"]').click();
  await page.waitForFunction(() =>
    document.querySelector("#ya-grid").textContent.includes("Sign in"),
  );
  signedIn = true;
  await page.reload();
  await page.waitForFunction(() =>
    document
      .querySelector("[data-header-balance]")
      .textContent.includes("1234.00"),
  );
  await page.locator("#ya-follow").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#ya-follow").getAttribute("aria-pressed") ===
      "true",
  );
  assert.equal(followWrites, 1);
  await page.locator('[data-nav="following"]').click();
  assert.equal(await page.locator("[data-expand]").count(), 1);
  await page.locator("[data-expand]").click();
  assert.equal(
    await page
      .locator('#ya-debate-grid a[href="/debates/published-debate"]')
      .count(),
    1,
  );
  assert.equal(
    requests.some((u) =>
      /viewer-token|\/replay\?|livekit|media\.bundle|replay\.bundle/.test(u),
    ),
    false,
  );
  await page.evaluate(() => {
    window.yapFollows.initialize(document);
    window.yapFollows.initialize(document);
  }); // Dynamic controls are initialized once.
  await page.locator("#ya-detail .ya-follow").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#ya-follow").getAttribute("aria-pressed") ===
      "false",
  );
  assert.equal(followWrites, 2);
  checks.realNullableDataWalletFollowsAndCanonicalDebates = true;
  await page.evaluate(axe.source);
  const axeViolations = await page.evaluate(async () =>
    (
      await window.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      })
    ).violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      targets: v.nodes.map((n) => n.target),
    })),
  );
  violations.push(...axeViolations);
  assert.deepEqual(violations, []);
  assert.deepEqual(await page.evaluate(() => window.homeCsp), []);
  checks.accessibilityAndCsp = true;
  const nojs = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 1440, height: 1100 },
    }),
    plain = await nojs.newPage();
  await plain.goto(base);
  assert.equal(await plain.locator("h1").textContent(), "Yap Arena");
  assert.equal(await plain.locator(".ya-heading").count(), 0);
  assert.equal(
    await plain.locator(".ya-cardtitle").textContent(),
    debate.proposition,
  );
  assert.equal(
    await plain
      .locator('a[data-expand][href="/topics/published-idea"]')
      .count(),
    1,
  );
  assert.equal(
    await plain.locator('#ya-side a[href="/debates/published-debate"]').count(),
    2,
  );
  await plain
    .getByRole("link", { name: "Explore debate", exact: true })
    .click();
  assert.ok(plain.url().endsWith("/debates/published-debate"));
  assert.equal(await plain.locator("[data-media-event]").count(), 1);
  await plain.goto(base);
  await plain.getByRole("link", { name: "Your account", exact: true }).click();
  assert.equal(await plain.locator("#wallet-login").count(), 1);
  await nojs.close();
  checks.serverRenderedNoJavaScriptFallback = true;
  checks.realDebateAndAccountNavigation = true;
  unavailable = true;
  const response = await page.goto(base);
  assert.equal(response.status(), 503);
  assert.match(await page.locator(".ya-empty").textContent(), /unavailable/);
  assert.equal(await page.locator("#ya-value").textContent(), "—");
  unavailable = false;
  checks.unavailableNeverSubstitutesConceptData = true;
  assert.deepEqual(errors, []);
  const evidence = {
    result: "PASS",
    referenceSha256: createHash("sha256").update(reference).digest("hex"),
    referenceBytes: Buffer.byteLength(reference),
    comparisons,
    checks,
    errors,
    violations,
    scope:
      "Loopback Express application with synthetic public records/auth responses and supplied original reference iframe; no hosted writes or media sessions.",
  };
  await writeFile(
    directory + "/evidence.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
