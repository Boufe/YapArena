/* global window, document */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import axe from "axe-core";
import pg from "pg";
import { verifyChatClient } from "./verify-chat-client.js";

const base = process.env.BROWSER_BASE_URL ?? "http://localhost:53000";
const chromePath =
  process.env.BROWSER_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const artifactDir = process.env.BROWSER_ARTIFACT_DIR ?? "/private/tmp";
if (!process.env.DATABASE_URL)
  throw new Error("DATABASE_URL is required for the local fixture");
const databaseUrl = new URL(
  process.env.DATABASE_FIXTURE_URL ?? process.env.DATABASE_URL,
);
if (process.env.BROWSER_DATABASE_PORT)
  databaseUrl.port = process.env.BROWSER_DATABASE_PORT;
const hosted = !["localhost", "127.0.0.1"].includes(databaseUrl.hostname);
if (hosted) {
  assert.equal(process.env.BROWSER_HOSTED_SYNTHETIC, "1");
  assert.equal(base, "https://yaparena-staging-web.onrender.com");
  assert.equal(databaseUrl.port, "5432");
  assert.equal(databaseUrl.searchParams.get("sslmode"), "verify-full");
}
const pool = new pg.Pool({
  connectionString: databaseUrl.toString(),
  max: 2,
  connectionTimeoutMillis: 10000,
  query_timeout: 15000,
  options: "-c search_path=pg_catalog,yaparena,pg_temp",
});
const suffix = randomUUID().slice(0, 8);
const eventId = randomUUID();
const eventSlug = `community-browser-${suffix}`;
const accounts = [];
let topicId;
let browser;
const timings = {};
const connectionReady = /(?:Live|Polling) updates on/;

async function axeViolations(page, selector) {
  await page.evaluate((source) => {
    window.eval(source);
  }, axe.source);
  return page.evaluate(async (target) => {
    const result = await window.axe.run(document.querySelector(target), {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
    });
    return result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => node.target),
    }));
  }, selector);
}

async function register(name, publishProfile = false) {
  const email = `community-browser-${name}-${suffix}@example.test`;
  const password = `Test-only-${randomUUID()}-Aa1!`;
  const context = await browser.newContext({ bypassCSP: true });
  const page = await context.newPage();
  await page.goto(`${base}/account`);
  await page.locator("#signed-out").waitFor({ state: "visible" });
  await page.locator(".account-details summary").click();
  await page.locator("#email-register input[name=email]").fill(email);
  await page.locator("#email-register input[name=password]").fill(password);
  await page.locator("#email-register button").click();
  await page.locator("#signed-in").waitFor({ state: "visible" });
  const result = await pool.query("SELECT id FROM users WHERE email = $1", [
    email,
  ]);
  const userId = result.rows[0]?.id;
  assert.ok(userId, `registered ${name}`);
  accounts.push(userId);
  if (publishProfile) {
    await page
      .locator("#profile-form input[name=handle]")
      .fill(`browser-${name}-${suffix}`);
    await page.locator("#profile-form input[name=displayName]").fill(name);
    await page
      .locator("#profile-form select[name=publicationState]")
      .selectOption("published");
    await page.locator("#profile-form button").click();
    await page
      .locator("#profile-state")
      .getByText("published", { exact: false })
      .waitFor();
  }
  return { context, page, userId };
}

async function grantModerator(userId) {
  await pool.query(
    "INSERT INTO account_roles (user_id, role) VALUES ($1, 'moderator') ON CONFLICT DO NOTHING",
    [userId],
  );
}

try {
  if (hosted)
    assert.equal(
      (await pool.query("SELECT current_user AS identity")).rows[0].identity,
      "yaparena_owner",
    );
  const topic = await pool.query(
    `INSERT INTO topics (slug, title, summary, side_a_label, side_b_label, publication_state)
     VALUES ($1, 'Community browser trial', 'Temporary local browser verification', 'For', 'Against', 'published')
     RETURNING id`,
    [`community-browser-topic-${suffix}`],
  );
  topicId = topic.rows[0].id;
  await pool.query(
    `INSERT INTO debates (id, slug, topic_id, proposition, status, publication_state,
       rules_version, rules_snapshot, scheduled_at, live_started_at)
     SELECT $1, $2, $3, 'Should live debates have a community chat?',
       'live', 'published', version, rules, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
     FROM event_rule_versions WHERE version = 'prototype-media-1'`,
    [eventId, eventSlug, topicId],
  );
  browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: ["--no-sandbox"],
  });
  await mkdir(artifactDir, { recursive: true });
  const author = await register("author", true);
  await author.page.goto(`${base}/debates/${eventSlug}`);
  await author.page
    .locator("[data-community-chat-form]")
    .waitFor({ state: "visible" });
  const reporter = await register("reporter", true);
  await reporter.page.goto(`${base}/debates/${eventSlug}`);
  await reporter.page.getByText(connectionReady).waitFor();
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    bypassCSP: true,
  });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(`${base}/debates/${eventSlug}`);
  await mobilePage.getByText(connectionReady).waitFor();
  await author.page.locator("[data-community-like]").click();
  try {
    await author.page
      .locator('[data-community-like][aria-pressed="true"]')
      .waitFor({ state: "visible", timeout: 5000 });
  } catch {
    throw new Error(
      `Like failed: ${await author.page.locator("[data-community-status]").textContent()}`,
    );
  }
  assert.equal(
    await author.page
      .locator("[data-community-like]")
      .getAttribute("aria-pressed"),
    "true",
  );
  await author.page
    .locator("[data-community-chat-form] textarea")
    .fill("A useful public comment");
  const firstMessageAt = performance.now();
  await author.page.locator("[data-community-chat-form] button").click();
  await author.page.getByText("A useful public comment").waitFor();
  await reporter.page.getByText("A useful public comment").waitFor();
  timings.desktopChatDeliveryMs = Math.round(
    performance.now() - firstMessageAt,
  );
  await mobilePage.getByText("A useful public comment").waitFor();
  timings.mobileViewportChatDeliveryMs = Math.round(
    performance.now() - firstMessageAt,
  );
  assert.equal(
    await reporter.page
      .locator("[data-community-messages] [data-message-id]")
      .count(),
    1,
  );
  await reporter.context.setOffline(true);
  await reporter.page
    .getByText("Connection interrupted", { exact: false })
    .waitFor();
  await pool.query(
    "UPDATE event_chat_messages SET created_at = CURRENT_TIMESTAMP - INTERVAL '20 seconds' WHERE debate_id = $1",
    [eventId],
  );
  await author.page
    .locator("[data-community-chat-form] textarea")
    .fill("Arrived while disconnected");
  await author.page.locator("[data-community-chat-form] button").click();
  await mobilePage.getByText("Arrived while disconnected").waitFor();
  const reconnectAt = performance.now();
  await reporter.context.setOffline(false);
  await reporter.page.getByText("Arrived while disconnected").waitFor();
  timings.reconnectCatchupMs = Math.round(performance.now() - reconnectAt);
  assert.deepEqual(
    await reporter.page
      .locator(
        "[data-community-messages] [data-message-id] .community-message-body",
      )
      .allTextContents(),
    ["A useful public comment", "Arrived while disconnected"],
  );
  await author.page
    .locator("[data-community-chat-form] textarea")
    .fill("Too soon");
  await author.page.locator("[data-community-chat-form] button").click();
  await author.page
    .locator("[data-community-send-status]")
    .getByText("chat limit reached", { exact: false })
    .waitFor();
  assert.equal(
    await author.page
      .locator("[data-community-chat-form] textarea")
      .inputValue(),
    "",
  );
  await author.page
    .locator(".community-message")
    .filter({ hasText: "Too soon" })
    .getByRole("button", { name: "Recover to draft" })
    .click();
  assert.equal(
    await author.page
      .locator("[data-community-chat-form] textarea")
      .inputValue(),
    "Too soon",
  );
  const desktopConsent = author.page.getByRole("button", {
    name: "Not now",
    exact: true,
  });
  if (await desktopConsent.isVisible()) await desktopConsent.click();
  await author.page.screenshot({
    path: `${artifactDir}/community-desktop.png`,
    fullPage: true,
  });
  assert.deepEqual(await axeViolations(author.page, ".detail-grid"), []);
  assert.deepEqual(await axeViolations(author.page, ".community-section"), []);

  await reporter.page
    .getByRole("button", { name: "Report message" })
    .first()
    .click();
  const reportForm = reporter.page.locator(".community-message form");
  await reportForm.locator("select").selectOption("spam");
  await reportForm.locator("textarea").fill("This needs moderator review");
  await reportForm.locator("button[type=submit]").click();
  await reporter.page
    .getByText("Report submitted privately", { exact: false })
    .waitFor();
  await reporter.page
    .locator("[data-community-report-form] select")
    .selectOption("other");
  await reporter.page
    .locator("[data-community-report-form] textarea")
    .fill("Event chat needs review");
  await reporter.page.locator("[data-community-report-form] button").click();
  await reporter.page
    .getByText("Report submitted privately", { exact: false })
    .waitFor();

  const moderatorA = await register("moderator-a");
  await grantModerator(moderatorA.userId);
  await moderatorA.page.goto(`${base}/moderation`);
  await moderatorA.page
    .locator("[data-community-cases] .community-case")
    .first()
    .waitFor();
  await moderatorA.page.screenshot({
    path: `${artifactDir}/community-moderation.png`,
    fullPage: true,
  });
  assert.deepEqual(await axeViolations(moderatorA.page, "main"), []);
  const chatCase = moderatorA.page
    .locator("[data-community-cases] .community-case")
    .filter({ hasText: "chat · open" })
    .first();
  await chatCase.locator("select").first().selectOption("remove_chat");
  await chatCase.locator("select").nth(1).selectOption("spam");
  await chatCase
    .locator("textarea")
    .fill("This message needs removal pending appeal");
  await chatCase.getByRole("button", { name: "Save decision" }).click();
  await chatCase.waitFor({ state: "hidden" });
  await reporter.page
    .getByText("A useful public comment")
    .waitFor({ state: "hidden" });
  await mobilePage
    .getByText("A useful public comment")
    .waitFor({ state: "hidden" });
  const eventCase = moderatorA.page
    .locator("[data-community-cases] .community-case")
    .filter({ hasText: "event · open" })
    .first();
  await eventCase.locator("select").first().selectOption("pause_chat");
  await eventCase.locator("select").nth(1).selectOption("other");
  await eventCase.locator("textarea").fill("Pause chat for moderator review");
  await eventCase.getByRole("button", { name: "Save decision" }).click();
  await eventCase.waitFor({ state: "hidden" });
  await reporter.page
    .locator('[data-community-chat-form] button[type="submit"]:disabled')
    .waitFor({ state: "visible" });
  await mobilePage
    .locator('[data-community-chat-form] button[type="submit"]:disabled')
    .waitFor({ state: "visible" });
  await moderatorA.page
    .locator("[data-community-case-filter]")
    .selectOption("actioned");
  const pausedCase = moderatorA.page
    .locator("[data-community-cases] .community-case")
    .filter({ hasText: "pause_chat" })
    .first();
  await pausedCase.locator("textarea").fill("Review is complete, resume chat");
  await pausedCase.getByRole("button", { name: "Resume event chat" }).click();
  await reporter.page
    .locator('[data-community-chat-form] button[type="submit"]:enabled')
    .waitFor({ state: "visible" });

  await author.page.goto(`${base}/account/moderation`);
  const appealForm = author.page.locator("[data-community-list] form").first();
  await appealForm.waitFor();
  await appealForm
    .locator("textarea")
    .fill("The message was ordinary discussion, not spam");
  await appealForm.getByRole("button", { name: "Submit appeal" }).click();
  await author.page.getByText("Appeal: open").waitFor();

  const moderatorB = await register("moderator-b");
  await grantModerator(moderatorB.userId);
  await moderatorB.page.goto(`${base}/moderation`);
  const appealCard = moderatorB.page
    .locator("[data-community-appeals] .community-case")
    .first();
  await appealCard.waitFor();
  await appealCard.locator("select").selectOption("overturned");
  await appealCard
    .locator("textarea")
    .fill("The message is permitted after a second review");
  await appealCard
    .getByRole("button", { name: "Save appeal decision" })
    .click();
  await appealCard.waitFor({ state: "hidden" });
  await reporter.page.getByText("A useful public comment").waitFor();
  await mobilePage.getByText("A useful public comment").waitFor();
  assert.equal(
    await reporter.page.getByText("A useful public comment").count(),
    1,
  );
  await author.page.goto(`${base}/debates/${eventSlug}`);
  await author.page.getByText("A useful public comment").waitFor();
  if (process.env.COMMUNITY_DURABLE_TRIAL === "1") {
    // The HTTPS write commits, its response is lost, and the live stream plus
    // authenticated reconciliation must resolve the optimistic row exactly once.
    await author.page.getByText("Live updates on", { exact: true }).waitFor();
    await pool.query(
      "UPDATE event_chat_messages SET created_at=clock_timestamp()-INTERVAL '20 seconds' WHERE debate_id=$1",
      [eventId],
    );
    let lostConfirmation = false;
    await author.page.route(
      `**/api/community/events/${eventId}/chat`,
      async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        const accepted = await route.fetch();
        assert.equal(accepted.status(), 201);
        lostConfirmation = true;
        await route.abort("failed");
      },
    );
    await author.page
      .locator("[data-community-chat-form] textarea")
      .fill("Stream resolves lost confirmation");
    await author.page.locator("[data-community-chat-form] button").click();
    await mobilePage
      .getByText("Stream resolves lost confirmation", { exact: true })
      .waitFor();
    await author.page
      .locator("[data-message-id]")
      .filter({ hasText: "Stream resolves lost confirmation" })
      .waitFor();
    assert.equal(lostConfirmation, true);
    await author.page.waitForFunction(
      () =>
        [...document.querySelectorAll(".community-message-body")].filter(
          (node) => node.textContent === "Stream resolves lost confirmation",
        ).length === 1,
    );
    assert.equal(
      await author.page
        .getByText("Stream resolves lost confirmation", { exact: true })
        .count(),
      1,
    );
    const accepted = await pool.query(
      "SELECT count(*)::int AS count FROM event_chat_messages WHERE debate_id=$1 AND body=$2",
      [eventId, "Stream resolves lost confirmation"],
    );
    assert.equal(accepted.rows[0].count, 1);
    await author.page.unroute(`**/api/community/events/${eventId}/chat`);
  }
  const overflow = await mobilePage.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  assert.ok(overflow <= 1, `mobile horizontal overflow: ${overflow}px`);
  assert.deepEqual(await axeViolations(mobilePage, ".detail-grid"), []);
  assert.deepEqual(await axeViolations(mobilePage, ".community-section"), []);
  const touchTargets = await mobilePage
    .locator(".community-message-actions button")
    .evaluateAll((buttons) =>
      buttons.map((button) => ({
        width: button.getBoundingClientRect().width,
        height: button.getBoundingClientRect().height,
      })),
    );
  assert.ok(
    touchTargets.length > 0 &&
      touchTargets.every((target) => target.width >= 44 && target.height >= 44),
    "mobile emulation uses 44px message actions",
  );
  const mobileConsent = mobilePage.getByRole("button", {
    name: "Not now",
    exact: true,
  });
  if (await mobileConsent.isVisible()) await mobileConsent.click();
  await mobilePage.screenshot({
    path: `${artifactDir}/community-mobile.png`,
    fullPage: true,
  });
  await reporter.context.setOffline(true);
  await pool.query(
    `INSERT INTO event_chat_messages (debate_id, author_user_id, body)
     SELECT $1, $2, 'Backlog ' || value FROM generate_series(1, 55) AS value`,
    [eventId, author.userId],
  );
  await reporter.context.setOffline(false);
  await reporter.page.getByText("Backlog 55", { exact: true }).waitFor();
  const backlog = await reporter.page
    .locator(
      "[data-community-messages] [data-message-id] .community-message-body",
    )
    .allTextContents();
  assert.deepEqual(
    backlog.filter((text) => text.startsWith("Backlog ")),
    Array.from({ length: 55 }, (_, index) => `Backlog ${index + 1}`),
  );
  await reporter.page.locator("[data-community-messages]").evaluate((node) => {
    node.scrollTop = 0;
  });
  await pool.query(
    "INSERT INTO event_chat_messages (debate_id, author_user_id, body) VALUES ($1, $2, 'Latest while reading')",
    [eventId, author.userId],
  );
  await reporter.page
    .getByRole("button", { name: /new message.*Jump to latest/ })
    .waitFor();
  assert.ok(
    (await reporter.page
      .locator("[data-community-messages]")
      .evaluate((node) => node.scrollTop)) < 50,
  );
  await reporter.page
    .getByRole("button", { name: /new message.*Jump to latest/ })
    .click();
  assert.equal(
    await reporter.page
      .getByText("Latest while reading", { exact: true })
      .count(),
    1,
  );
  const archiveContext = await browser.newContext({ bypassCSP: true });
  const archivePage = await archiveContext.newPage();
  await archivePage.goto(`${base}/debates/${eventSlug}`);
  await archivePage
    .locator("[data-community-older]")
    .waitFor({ state: "visible" });
  await archivePage.locator("[data-community-older]").click();
  await archivePage.getByText("Backlog 1", { exact: true }).waitFor();
  await pool.query(
    "INSERT INTO event_chat_messages (debate_id, author_user_id, body) VALUES ($1, $2, 'After history load')",
    [eventId, author.userId],
  );
  await archivePage.getByText("After history load", { exact: true }).waitFor();
  assert.equal(
    await archivePage.getByText("Backlog 1", { exact: true }).count(),
    1,
  );
  let stalePage;
  let releaseHistory;
  let historyCaptured;
  let staleMessageId;
  if (process.env.COMMUNITY_DURABLE_TRIAL === "1") {
    const staleContext = await browser.newContext({ bypassCSP: true });
    stalePage = await staleContext.newPage();
    await stalePage.addInitScript(() => {
      window.__communityTrialFrames = [];
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(...args) {
          super(...args);
          this.addEventListener("community", (event) => {
            window.__communityTrialFrames.push(JSON.parse(event.data));
          });
        }
      };
    });
    await stalePage.goto(`${base}/debates/${eventSlug}`);
    await stalePage.getByText("Live updates on", { exact: true }).waitFor();
    const captured = new Promise((resolve) => {
      historyCaptured = resolve;
    });
    const release = new Promise((resolve) => {
      releaseHistory = resolve;
    });
    await stalePage.route(
      `**/api/community/events/${eventId}/chat?before=*`,
      async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        assert.ok(
          body.items.some((m) => m.body === "Backlog 1"),
          "held history contains pre-removal content",
        );
        staleMessageId = body.items.find((m) => m.body === "Backlog 1").id;
        historyCaptured();
        await release;
        await route.fulfill({ response });
      },
    );
    await stalePage.locator("[data-community-older]").click();
    await captured;
  }
  const oldMessage = reporter.page
    .locator("[data-community-messages] [data-message-id]")
    .filter({ hasText: "Backlog 1" })
    .first();
  await oldMessage.getByRole("button", { name: "Report message" }).click();
  await oldMessage.locator("form select").selectOption("spam");
  await oldMessage
    .locator("form textarea")
    .fill("Old chat message needs review");
  await oldMessage.locator("form button[type=submit]").click();
  await oldMessage.locator("form").waitFor({ state: "hidden" });
  await moderatorB.page.locator("[data-community-refresh]").click();
  const oldCase = moderatorB.page
    .locator("[data-community-cases] .community-case")
    .filter({ hasText: "Old chat message needs review" });
  await oldCase.locator("select").first().selectOption("remove_chat");
  await oldCase.locator("select").nth(1).selectOption("spam");
  await oldCase.locator("textarea").fill("Remove older reported chat message");
  const removalAt = performance.now();
  await oldCase.getByRole("button", { name: "Save decision" }).click();
  await archivePage
    .getByText("Backlog 1", { exact: true })
    .waitFor({ state: "hidden" });
  timings.moderationRemovalMs = Math.round(performance.now() - removalAt);
  if (stalePage) {
    await stalePage.waitForFunction(
      (id) =>
        window.__communityTrialFrames.some((frame) =>
          frame.changes?.some(
            (change) =>
              change.message?.id === id &&
              change.message.state === "removed" &&
              change.message.body === null,
          ),
        ),
      staleMessageId,
    );
    releaseHistory();
    await stalePage.locator("[data-community-older]:enabled").waitFor();
    assert.equal(
      await stalePage.getByText("Backlog 1", { exact: true }).count(),
      0,
    );
    await stalePage.unroute(`**/api/community/events/${eventId}/chat?before=*`);
    await stalePage.locator("[data-community-older]").click();
    await stalePage.getByText("Backlog 2", { exact: true }).waitFor();
    assert.equal(
      await stalePage.getByText("Backlog 1", { exact: true }).count(),
      0,
    );
    timings.healthyStreamHttpRaces =
      "PASS: lost confirmation and delayed pre-removal history";
  }
  if (process.env.COMMUNITY_DURABLE_TRIAL === "1") {
    await reporter.page.getByText("Live updates on", { exact: true }).waitFor();
    await archivePage.getByText("Live updates on", { exact: true }).waitFor();
    await archivePage
      .locator("[data-community-chat-form] textarea")
      .fill("Draft survives event ending");
    await pool.query(
      "UPDATE debates SET status='ended',live_ended_at=clock_timestamp() WHERE id=$1",
      [eventId],
    );
    await archivePage
      .locator('[data-community-chat-form] button[type="submit"]:disabled')
      .waitFor();
    assert.equal(
      await archivePage
        .locator("[data-community-chat-form] textarea")
        .inputValue(),
      "Draft survives event ending",
    );
    assert.equal(
      await reporter.page
        .getByText("After history load", { exact: true })
        .count(),
      1,
    );
    await pool.query(
      "UPDATE topics SET publication_state='draft' WHERE id=$1",
      [topicId],
    );
    await archivePage
      .getByText("This event is no longer public.", { exact: true })
      .waitFor();
    assert.equal(await archivePage.locator("[data-message-id]").count(), 0);
    await pool.query(
      "UPDATE topics SET publication_state='published' WHERE id=$1",
      [topicId],
    );
    await pool.query("UPDATE debates SET status='live' WHERE id=$1", [eventId]);
  }
  const overlay = await mobilePage.goto(`${base}/overlay/${eventSlug}`);
  assert.equal(overlay.status(), 200);
  assert.equal(
    await mobilePage
      .getByText("No winner or official support is shown")
      .count(),
    1,
  );
  const qr = await mobilePage.goto(`${base}/debates/${eventSlug}/qr.svg`);
  assert.equal(qr.status(), 200);
  assert.match(qr.headers()["content-type"], /image\/svg\+xml/);
  await verifyChatClient({ browser, base, eventSlug, eventId, artifactDir });
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      base,
      viewport: { desktop: "1280x720 or default", mobile: "390x844 emulation" },
      timings,
      result: "Community browser journeys verified at desktop and mobile sizes",
    }),
  );
} finally {
  if (browser) await browser.close();
  try {
    await pool.query("DELETE FROM moderation_cases WHERE debate_id = $1", [
      eventId,
    ]);
    await pool.query("DELETE FROM event_chat_messages WHERE debate_id = $1", [
      eventId,
    ]);
    await pool.query("DELETE FROM event_like_changes WHERE debate_id = $1", [
      eventId,
    ]);
    await pool.query("DELETE FROM event_likes WHERE debate_id = $1", [eventId]);
    await pool.query("DELETE FROM event_chat_controls WHERE debate_id = $1", [
      eventId,
    ]);
    await pool.query("DELETE FROM debates WHERE id = $1", [eventId]);
    if (topicId)
      await pool.query("DELETE FROM topics WHERE id = $1", [topicId]);
    for (const id of accounts) {
      await pool.query("DELETE FROM sessions WHERE user_id = $1", [id]);
      await pool.query("DELETE FROM public_profiles WHERE user_id = $1", [id]);
      await pool.query("DELETE FROM account_roles WHERE user_id = $1", [id]);
      await pool.query("DELETE FROM identity_audit_events WHERE user_id = $1", [
        id,
      ]);
      await pool.query("DELETE FROM users WHERE id = $1", [id]);
    }
  } finally {
    await pool.end();
  }
}
