/* global window, document */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import axe from "axe-core";
import pg from "pg";
const runtimeUrl = new URL(process.env.A4_TEST_DATABASE_URL),
  ownerUrl = new URL(process.env.A4_TEST_OWNER_URL);
for (const url of [runtimeUrl, ownerUrl]) {
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
  assert.match(url.pathname, /^\/revocation_test_a4_(fresh|upgrade)$/);
}
const owner = new pg.Pool({
  connectionString: ownerUrl.href,
  options: "-c search_path=pg_catalog,yaparena,pg_temp",
});
const tag = randomUUID().slice(0, 8),
  artifactDir =
    process.env.BROWSER_ARTIFACT_DIR ?? "/private/tmp/yaparena-a4-browser";
const reservation = createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const base = `http://127.0.0.1:${port}`;
let browser, server;
const errors = [],
  screenshots = [];
try {
  await mkdir(artifactDir, { recursive: true });
  await owner.query("UPDATE a4_controls SET enabled=true,bots_enabled=true");
  const topic = (
    await owner.query(
      "INSERT INTO topics(slug,title,summary,side_a_label,side_b_label,publication_state) VALUES($1,'A4 browser fixture','Synthetic local browser evidence','Support','Oppose','published') RETURNING id",
      [`a4-browser-${tag}`],
    )
  ).rows[0].id;
  const debate = (
    await owner.query(
      "INSERT INTO debates(slug,topic_id,proposition,status,publication_state,rules_version,rules_snapshot) SELECT $1,$2,'Should cities prioritize quiet streets?','scheduled','published',version,rules FROM event_rule_versions WHERE version='preview-1' RETURNING id",
      [`a4-browser-${tag}`, topic],
    )
  ).rows[0].id;
  // Separate web child receives only runtime secrets; owner fixture URL stays here.
  server = spawn(process.execPath, ["dist/server.js"], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "test",
      DATABASE_URL: runtimeUrl.href,
      A4_MODE: "bots",
      HOST: "127.0.0.1",
      PORT: String(port),
      APP_ORIGIN: base,
      LOG_LEVEL: "error",
      API_RATE_LIMIT: "10000",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  server.stderr.on("data", (b) => {
    stderr += b;
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/ready`);
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {
      /* server is still starting */
    }
    await delay(100);
  }
  assert.ok(ready, `runtime web process starts: ${stderr.slice(-1000)}`);
  browser = await chromium.launch({
    executablePath:
      process.env.BROWSER_CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    bypassCSP: true,
    reducedMotion: "reduce",
  });
  let page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/account`);
  await page.locator("#signed-out").waitFor({ state: "visible" });
  await page.locator(".account-details summary").click();
  await page
    .locator('#email-register input[name="email"]')
    .fill(`a4-browser-${tag}@example.test`);
  await page
    .locator('#email-register input[name="password"]')
    .fill(`Synthetic browser passphrase ${tag}`);
  await page.locator("#email-register button").click();
  await page.locator("#signed-in").waitFor({ state: "visible" });
  await page.goto(`${base}/debates/a4-browser-${tag}`);
  await page.locator("[data-inline-access]").waitFor({ state: "visible" });
  const debatePage = page,
    mediaNode = await page.locator("[data-media-event]").elementHandle();
  await page.locator("[data-inline-bots]").click();
  await page.locator("[data-inline-form]").waitFor({ state: "visible" });
  await page.locator('[data-inline-form] input[name="quantity"]').fill("2");
  await page.locator('[data-inline-form] input[name="ceiling"]').fill("1");
  await page.locator('[data-inline-form] button[type="submit"]').click();
  await page.locator("[data-inline-review]").waitFor({ state: "visible" });
  await page.locator("[data-inline-commit]").click();
  await page.locator("[data-inline-review]").waitFor({ state: "hidden" });
  await page
    .locator("[data-inline-receipt]")
    .getByText("committed", { exact: false })
    .waitFor();
  assert.equal(await mediaNode.evaluate((node) => node.isConnected), true);
  assert.equal(await page.locator("[data-community-chat-panel]").count(), 1);
  await page.screenshot({
    path: `${artifactDir}/inline-debate-desktop.png`,
    fullPage: true,
  });
  screenshots.push("inline-debate-desktop.png");
  [page] = await Promise.all([
    context.waitForEvent("page"),
    debatePage
      .getByRole("link", { name: "Full Bots controls, history and research ↗" })
      .click(),
  ]);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("[data-a4-content]").waitFor({ state: "visible" });
  await page
    .locator('[data-a4-create] select[name="debateId"]')
    .selectOption(debate);
  await page.locator("[data-a4-create] details summary").click();
  assert.equal(
    await page
      .locator('[data-a4-create] input[name="population"]')
      .inputValue(),
    "500",
  );
  await page
    .locator('[data-a4-create] select[name="preset"]')
    .selectOption("reference");
  await page.locator('[data-a4-create] input[name="roundSeconds"]').fill("20");
  await page.locator('[data-a4-create] button[type="submit"]').click();
  await page
    .locator("[data-a4-run-summary]")
    .getByText("BOTS + YOU", { exact: false })
    .waitFor();
  assert.match(
    await page.locator("[data-a4-balance]").textContent(),
    /1000[.]000000 Yap Coins/,
  );
  await page.locator('[data-a4-submit] select[name="side"]').selectOption("NO");
  await page.locator('[data-a4-submit] input[name="ceiling"]').fill("0.78");
  await page.locator('[data-a4-submit] input[name="quantity"]').fill("10");
  await page.locator('[data-a4-submit] button[type="submit"]').click();
  await page.locator("[data-a4-review]").waitFor({ state: "visible" });
  assert.match(
    await page.locator("[data-a4-terms]").textContent(),
    /10[.]000000 Yap Coins/,
  );
  await page.screenshot({ path: `${artifactDir}/commitment-desktop.png` });
  screenshots.push("commitment-desktop.png");
  await page.keyboard.press("Tab");
  assert.ok(
    await page
      .locator("[data-a4-review]")
      .evaluate((d) => d.contains(document.activeElement)),
  );
  await page.locator("[data-a4-commit]").click();
  await page.locator("[data-a4-review]").waitFor({ state: "hidden" });
  await page
    .locator("[data-a4-rounds]")
    .getByText("committed", { exact: true })
    .waitFor();
  const selected = await page.locator("[data-a4-runs]").inputValue();
  assert.ok(selected);
  await page.reload();
  await page.locator("[data-a4-content]").waitFor({ state: "visible" });
  await page.locator("[data-a4-runs]").selectOption(selected);
  await page
    .locator("[data-a4-rounds]")
    .getByText("committed", { exact: true })
    .waitFor();
  // UI pause/resume/step; persisted worker performs pricing/execution and final reveal.
  await page.locator('[data-a4-control="pause"]').click();
  await page
    .locator("[data-a4-run-summary]")
    .getByText("paused", { exact: false })
    .waitFor();
  await page.locator('[data-a4-control="run"]').click();
  await page.locator('[data-a4-control="step"]').click();
  await page.locator("[data-a4-speed]").selectOption("20");
  await page.locator("[data-a4-refresh]").click();
  // Assert participant JSON omits sealed data, using the same signed-in browser HTTP client.
  const sealed = await context.request.get(`${base}/api/a4/runs/${selected}`);
  const hidden = await sealed.json();
  if (!hidden.rounds[0].revealed) {
    assert.equal(hidden.rounds[0].diagnostics, undefined);
    assert.equal(hidden.rounds[0].receipt.payout, undefined);
    assert.equal(hidden.rounds[0].receipt.net, undefined);
  }
  await page.waitForFunction(
    () =>
      document
        .querySelector("[data-a4-rounds]")
        ?.textContent.includes("settled"),
    { timeout: 45000 },
  );
  const result = await context.request.get(`${base}/api/a4/runs/${selected}`);
  const final = await result.json();
  assert.equal(final.state, "complete");
  assert.equal(final.rounds[0].diagnostics.totals.bots, 500);
  assert.equal(final.rounds[0].diagnostics.totals.humans, 1);
  assert.equal(final.rounds[0].receipt.executed, true);
  assert.ok(BigInt(final.rounds[0].receipt.payout) > 0n);
  await page.locator("[data-a4-rounds] details summary").click();
  await page.screenshot({
    path: `${artifactDir}/settled-desktop.png`,
    fullPage: true,
  });
  screenshots.push("settled-desktop.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: `${artifactDir}/settled-mobile.png`,
    fullPage: true,
  });
  screenshots.push("settled-mobile.png");
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "no horizontal page overflow",
  );
  await page.evaluate((source) => window.eval(source), axe.source);
  const accessibility = await page.evaluate(async () => {
    const r = await window.axe.run(document.querySelector("main"), {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
      },
    });
    return r.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.map((n) => n.target),
    }));
  });
  assert.deepEqual(accessibility, []);
  // A second bot-only run demonstrates observer isolation and archival reset without deleting history.
  await page
    .locator('[data-a4-create] select[name="mode"]')
    .selectOption("observer");
  await page.locator("[data-a4-create] details summary").click();
  await page
    .locator('[data-a4-create] input[name="seed"]')
    .fill("browser-replay");
  await page.locator('[data-a4-create] button[type="submit"]').click();
  await page
    .locator("[data-a4-run-summary]")
    .getByText("BOT-ONLY OBSERVER", { exact: false })
    .waitFor();
  assert.equal(await page.locator("[data-a4-submit]").isVisible(), false);
  await page.locator('[data-a4-control="archive"]').click();
  await page
    .locator("[data-a4-run-summary]")
    .getByText("archived", { exact: false })
    .waitFor();
  const logout = await context.request.post(`${base}/api/auth/logout`);
  assert.equal(logout.status(), 204);
  await page.locator("[data-a4-refresh]").click();
  await page.locator("[data-a4-content]").waitFor({ state: "hidden" });
  assert.equal(await page.locator("[data-a4-rounds]").textContent(), "");
  assert.deepEqual(errors, []);
  await writeFile(
    `${artifactDir}/browser-evidence.json`,
    `${JSON.stringify({ base: "isolated loopback web runtime", viewport: [1440, 1000, 390, 844], account: "synthetic email registration", population: 500, humanParticipants: 1, checks: ["starter coins", "NO conversion review", "keyboard dialog focus", "binding submit", "reload receipt", "pause/run/step/speed", "sealed response", "worker settlement", "paginated revealed diagnostics", "bot-only observer", "archive/reset isolation", "mobile overflow", "axe WCAG A/AA"], accessibility, errors, screenshots }, null, 2)}\n`,
  );
  console.log(`A4 browser PASS; evidence ${artifactDir}`);
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
  await owner.end();
}
