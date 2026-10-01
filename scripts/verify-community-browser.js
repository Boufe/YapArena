/* global window, document */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import axe from "axe-core";
import pg from "pg";

const base = process.env.BROWSER_BASE_URL ?? "http://localhost:53000";
const chromePath =
  process.env.BROWSER_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const artifactDir = process.env.BROWSER_ARTIFACT_DIR ?? "/private/tmp";
if (!process.env.DATABASE_URL)
  throw new Error("DATABASE_URL is required for the local fixture");
const databaseUrl = new URL(process.env.DATABASE_URL);
if (process.env.BROWSER_DATABASE_PORT)
  databaseUrl.port = process.env.BROWSER_DATABASE_PORT;
if (!["localhost", "127.0.0.1"].includes(databaseUrl.hostname))
  throw new Error(
    "browser verification accepts only a local PostgreSQL database",
  );
const pool = new pg.Pool({ connectionString: databaseUrl.toString() });
const suffix = randomUUID().slice(0, 8);
const eventId = randomUUID();
const eventSlug = `community-browser-${suffix}`;
const accounts = [];
let topicId;
let browser;

async function axeViolations(page, selector) {
  await page.evaluate((source) => {
    window.eval(source);
  }, axe.source);
  return page.evaluate(async (target) => {
    const result = await window.axe.run(document.querySelector(target), {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
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
  await author.page.locator("[data-community-chat-form] button").click();
  await author.page.getByText("A useful public comment").waitFor();
  await author.page
    .locator("[data-community-chat-form] textarea")
    .fill("Too soon");
  await author.page.locator("[data-community-chat-form] button").click();
  await author.page.getByText("chat limit reached", { exact: false }).waitFor();
  await author.page.screenshot({
    path: `${artifactDir}/community-desktop.png`,
    fullPage: true,
  });
  assert.deepEqual(await axeViolations(author.page, ".community-section"), []);

  const reporter = await register("reporter", true);
  await reporter.page.goto(`${base}/debates/${eventSlug}`);
  await reporter.page.getByText("A useful public comment").waitFor();
  await reporter.page.getByRole("button", { name: "Report message" }).click();
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
  await moderatorA.page
    .getByText("Case decision saved", { exact: false })
    .waitFor();

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
  await moderatorB.page
    .getByText("Appeal decision saved", { exact: false })
    .waitFor();
  await author.page.goto(`${base}/debates/${eventSlug}`);
  await author.page.getByText("A useful public comment").waitFor();

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    bypassCSP: true,
  });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(`${base}/debates/${eventSlug}`);
  await mobilePage
    .locator("[data-community-status]")
    .getByText("up to date", { exact: false })
    .waitFor();
  const overflow = await mobilePage.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  assert.ok(overflow <= 1, `mobile horizontal overflow: ${overflow}px`);
  assert.deepEqual(await axeViolations(mobilePage, ".community-section"), []);
  await mobilePage.screenshot({
    path: `${artifactDir}/community-mobile.png`,
    fullPage: true,
  });
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
  console.log(
    "Community browser journeys verified at desktop and mobile sizes",
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
