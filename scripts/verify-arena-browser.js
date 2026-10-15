/* global document, window */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import axe from "axe-core";
export async function verifyArenaBrowser({
  base,
  context,
  debateSlug,
  artifactDir,
  setReplay,
}) {
  assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
  const directory = artifactDir;
  await mkdir(directory, { recursive: true });
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1050 });
  let phase = "register";
  const checks = {};
  async function api(path, body, method = body ? "post" : "get") {
    const r = await context.request[method](
      base + "/api/" + path,
      body ? { data: body, headers: { "Idempotency-Key": randomUUID() } } : {},
    );
    const data = await r.json();
    assert.ok(r.ok(), `${path}: ${r.status()} ${data.error ?? ""}`);
    return data;
  }
  try {
    await page.goto(base + "/account");
    const dismiss = page.getByRole("button", { name: "Not now", exact: true });
    if (await dismiss.isVisible()) await dismiss.click();
    await page.locator(".account-details summary").click();
    await page
      .locator("#email-register input[name=email]")
      .fill("neon-ui-" + randomUUID() + "@example.test");
    await page
      .locator("#email-register input[name=password]")
      .fill(randomUUID() + randomUUID());
    await page.locator("#email-register button").click();
    await page.locator("#signed-in").waitFor({ state: "visible" });
    await api("me/profile", {
      handle: "ui-trial-" + randomUUID().slice(0, 8),
      displayName: "UI Test Participant",
      bio: "Synthetic local interface trial.",
    });
    await api("me/profile", { publicationState: "published" }, "patch");
    const debates = await api("public/debates?limit=50"),
      debate = debates.items.find((d) => d.slug === debateSlug);
    assert.ok(debate);
    const histories = [];
    for (let i = 0; i < 2; i++)
      histories.push(
        await api("a4/runs", {
          debateId: debate.id,
          mode: "mixed",
          config: { population: 500, roundSeconds: 10 },
          speed: 20,
        }),
      );
    await page.goto(base + "/debates/" + debateSlug);
    if (await dismiss.isVisible()) await dismiss.click();
    await page.locator("[data-inline-access]").waitFor({ state: "visible" });
    await page.locator("[data-inline-bots]").click();
    await page.locator("[data-inline-form]").waitFor({ state: "visible" });
    phase = "live chat";
    await page.waitForFunction(
      () =>
        document.querySelector("[data-community-chat-form]").dataset
          .writable === "true",
    );
    const message = "Synthetic interface trial " + randomUUID().slice(0, 8);
    await page.locator("[data-community-chat-form] textarea").fill(message);
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await page
      .locator("[data-community-messages]")
      .getByText(message, { exact: true })
      .waitFor();
    checks.realLiveChat = true;
    phase = "dynamic chart";
    await page.waitForFunction(
      () => document.querySelectorAll("[data-chart-round]").length >= 2,
      {},
      { timeout: 45000 },
    );
    checks.chartUpdatedAfterRealSettlements = true;
    const media = await page.locator("[data-media-event]").elementHandle(),
      chat = await page.locator("[data-community-chat-panel]").elementHandle();
    phase = "expand";
    await page.locator("[data-arena-video]").hover();
    const original = await page.locator("[data-arena-video]").boundingBox();
    await page
      .getByRole("button", { name: "Enlarge video", exact: true })
      .click();
    assert.equal(
      await page.locator("[data-video-expand]").getAttribute("aria-expanded"),
      "true",
    );
    const enlarged = await page.locator("[data-arena-video]").boundingBox();
    assert.ok(enlarged.width > original.width * 2);
    await page.keyboard.press("Escape");
    assert.equal(
      await page.locator("[data-video-expand]").getAttribute("aria-expanded"),
      "false",
    );
    const restored = await page.locator("[data-arena-video]").boundingBox();
    assert.deepEqual(restored, original);
    assert.equal(await media.evaluate((n) => n.isConnected), true);
    assert.equal(await chat.evaluate((n) => n.isConnected), true);
    checks.expandEscapeRestoreExactBounds = true;
    phase = "desktop screenshot";
    await page.screenshot({ path: directory + "/desktop.png", fullPage: true });
    phase = "commit";
    await page.locator("[data-inline-form] input[name=side][value=NO]").check();
    await page.locator("[data-inline-form] input[name=ceiling]").fill("0.78");
    await page.locator('[data-inline-form] [data-quantity="50"]').click();
    assert.equal(
      await page
        .locator("[data-inline-form] input[name=quantity]")
        .inputValue(),
      "50",
    );
    await page.locator("[data-inline-form] button[type=submit]").click();
    await page.locator("[data-inline-review]").waitFor({ state: "visible" });
    await page.locator("[data-inline-commit]").click();
    await page.locator("[data-inline-review]").waitFor({ state: "hidden" });
    await page
      .locator("[data-inline-receipt]")
      .getByText("committed", { exact: true })
      .waitFor();
    checks.bindingCommitmentAndQuickQuantity = true;
    const active = await page.locator("[data-inline-runs]").inputValue();
    phase = "preserved live DOM";
    await page.locator("[data-arena-video]").hover();
    await page
      .getByRole("button", { name: "Enlarge video", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Restore video size", exact: true })
      .click();
    assert.equal(await media.evaluate((n) => n.isConnected), true);
    assert.equal(await chat.evaluate((n) => n.isConnected), true);
    phase = "round selection";
    await page
      .getByRole("button", { name: /Inspect settled round/ })
      .first()
      .click();
    await page.waitForFunction(
      (id) => document.querySelector("[data-inline-runs]").value !== id,
      active,
    );
    checks.chartSelectionLoadsRound = true;
    await page.locator("[data-detail-tab=info]").click();
    assert.equal(
      await page.locator("[data-detail-panel=info]").isVisible(),
      true,
    );
    await page.locator("[data-detail-tab=rounds]").click();
    checks.sidebarTabs = true;
    phase = "a11y";
    await page.addScriptTag({ content: axe.source });
    const a11y = await page.evaluate(async () => {
      const r = await window.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      });
      return r.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.map((n) => n.target),
      }));
    });
    await writeFile(directory + "/axe.json", JSON.stringify(a11y, null, 2));
    assert.deepEqual(
      a11y.filter((v) => ["critical", "serious"].includes(v.impact)),
      [],
    );
    checks.axeNoSeriousViolations = true;
    phase = "mobile";
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.locator("[data-inline-access]").waitFor({ state: "visible" });
    await page.evaluate(() => document.fonts.ready);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    await page.screenshot({ path: directory + "/mobile.png", fullPage: true });
    checks.mobileNoOverflow = true;
    phase = "search";
    await page.locator("#header-search").fill("walkability");
    await page.locator("#header-search").press("Enter");
    await page.waitForURL("**/debates?q=walkability");
    assert.ok(await page.locator(".debate-card").count());
    checks.headerSearch = true;
    phase = "replay layout and uninterrupted playback";
    await setReplay();
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.goto(base + "/debates/" + debateSlug);
    await page
      .getByRole("region", { name: "Debate replay", exact: true })
      .waitFor();
    await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext("2d");
      let frame = 0;
      const draw = () => {
        ctx.fillStyle = "#112d43";
        ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = "#64cfff";
        ctx.fillRect((frame++ * 8) % 640, 150, 50, 50);
      };
      draw();
      window.arenaSyntheticFrame = setInterval(draw, 80);
      const video = document.querySelector("[data-media-replay-video]");
      video.srcObject = canvas.captureStream(12);
      video.muted = true;
      video.hidden = false;
      await video.play();
      window.arenaSyntheticVideo = video;
    });
    await page.waitForFunction(
      () => window.arenaSyntheticVideo.currentTime > 0.2,
    );
    const beforeTime = await page
      .locator("[data-media-replay-video]")
      .evaluate((v) => v.currentTime);
    await page.locator("[data-arena-video]").hover();
    await page
      .getByRole("button", { name: "Enlarge video", exact: true })
      .click();
    await page.waitForFunction(
      (t) => window.arenaSyntheticVideo.currentTime > t + 0.2,
      beforeTime,
    );
    await page.keyboard.press("Escape");
    assert.equal(
      await page.evaluate(
        () =>
          document.querySelector("[data-media-replay-video]") ===
            window.arenaSyntheticVideo && !window.arenaSyntheticVideo.paused,
      ),
      true,
    );
    await page.locator("[data-detail-tab=info]").click();
    await page.locator("[data-detail-tab=rounds]").click();
    await page.screenshot({
      path: directory + "/replay-desktop.png",
      fullPage: true,
    });
    checks.replayLayoutAndUninterruptedSyntheticPlayback = true;
    assert.deepEqual(errors, []);
    checks.noPageErrors = true;
    await writeFile(
      directory + "/evidence.json",
      JSON.stringify(
        {
          result: "PASS",
          checks,
          scope:
            "Local browser with real PostgreSQL and actual settlement worker; media provider unavailable, transport not assessed",
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ result: "PASS", checks }));
  } catch (error) {
    await page.screenshot({ path: directory + "/failure.png", fullPage: true });
    await writeFile(
      directory + "/failure.json",
      JSON.stringify(
        { phase, message: error.message, errors, checks },
        null,
        2,
      ),
    );
    console.error(
      JSON.stringify({
        result: "FAIL",
        phase,
        message: error.message.slice(0, 500),
        errors,
      }),
    );
    throw error;
  } finally {
    await page.close();
  }
}
