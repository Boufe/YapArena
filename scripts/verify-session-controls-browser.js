import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

// Synthetic local-only accounts; launch a fresh profile, never inspect an existing
// browser profile or dump cookies. The caller runs an isolated migrated preview.
const origin =
  process.env.REVOCATION_BROWSER_ORIGIN || "http://localhost:53023";
const target = new URL(origin);
if (
  !/^https?:$/.test(target.protocol) ||
  !["localhost", "127.0.0.1"].includes(target.hostname)
)
  throw new Error("Browser verification requires a local isolated preview");
const output =
  process.env.REVOCATION_BROWSER_EVIDENCE ||
  "/private/tmp/yaparena-f03-browser-evidence";
const email = `f03-browser-${randomUUID()}@example.test`;
const password = "Synthetic browser account passphrase";
let browser;
try {
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const first = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
  });
  const second = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
  });
  const a = await first.newPage(),
    b = await second.newPage();
  await a.goto(`${origin}/account`);
  await a.locator("#signed-out:not([hidden])").waitFor();
  await a.locator(".account-details").evaluate((element) => {
    element.open = true;
  });
  await a.locator('#email-register input[name="email"]').fill(email);
  await a.locator('#email-register input[name="password"]').fill(password);
  await a.locator('#email-register button[type="submit"]').click();
  await a.locator("#signed-in:not([hidden])").waitFor();
  await a
    .locator("#account-notice")
    .filter({ hasText: "Account ready." })
    .waitFor();
  await b.goto(`${origin}/account`);
  await b.locator("#signed-out:not([hidden])").waitFor();
  await b.locator(".account-details").evaluate((element) => {
    element.open = true;
  });
  await b.locator('#email-login input[name="email"]').fill(email);
  await b.locator('#email-login input[name="password"]').fill(password);
  await b.locator('#email-login button[type="submit"]').click();
  await b.locator("#signed-in:not([hidden])").waitFor();
  await a.locator("#sign-out-others").scrollIntoViewIfNeeded();
  await a.screenshot({ path: `${output}/signed-in-controls.png` });
  a.once("dialog", (dialog) => dialog.accept());
  await a.locator("#sign-out-others").click();
  await a
    .locator("#account-notice")
    .filter({
      hasText: "Other sessions signed out. This device is still signed in.",
    })
    .waitFor();
  assert.equal(await a.locator("#signed-in").isVisible(), true);
  await b.reload();
  await b.locator("#signed-out:not([hidden])").waitFor();
  await a.screenshot({ path: `${output}/other-sessions-signed-out.png` });
  await a.reload();
  await a.locator("#signed-in:not([hidden])").waitFor();
  a.once("dialog", (dialog) => dialog.accept());
  await a.locator("#sign-out-all").click();
  await a
    .locator("#account-notice")
    .filter({ hasText: "All sessions signed out, including this device." })
    .waitFor();
  await a.locator("#signed-out:not([hidden])").waitFor();
  await a.screenshot({ path: `${output}/all-sessions-signed-out.png` });
  await a.reload();
  await a.locator("#signed-out:not([hidden])").waitFor();
  console.log(
    "Two-context browser controls PASS: other sessions denied, current retained, logout-all current denied; screenshots saved.",
  );
} finally {
  await browser?.close();
}
