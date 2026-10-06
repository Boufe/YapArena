/* global window, document */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import pg from "pg";
import { privateKeyToAccount } from "viem/accounts";

const base = process.env.BROWSER_BASE_URL ?? "http://127.0.0.1:53502";
const browserUrl = new URL(base);
assert.ok(["localhost", "127.0.0.1"].includes(browserUrl.hostname));
assert.ok(["http:", "https:"].includes(browserUrl.protocol));
const artifactDir =
  process.env.BROWSER_ARTIFACT_DIR ?? "/private/tmp/yaparena-f02-browser";
const databaseUrl = new URL(process.env.WALLET_TEST_OWNER_DATABASE_URL);
assert.ok(["localhost", "127.0.0.1"].includes(databaseUrl.hostname));
assert.match(
  databaseUrl.pathname,
  /^\/(?:yaparena_f02|revocation_test)[a-z0-9_]*$/,
);
const pool = new pg.Pool({ connectionString: databaseUrl.toString() });
const signers = ["41", "42", "43", "44"].map((byte) =>
  privateKeyToAccount(`0x${byte.repeat(32)}`),
);
const chainId = 7654321;
let activeSigner = signers[0];
let activeChain = chainId;
let rejectSignature = false;
const suffix = randomUUID().slice(0, 8);
const email = `f02-browser-${suffix}@example.test`;
const password = "Synthetic browser operation passphrase";
const accounts = [];
let browser;
try {
  browser = await chromium.launch({
    executablePath:
      process.env.BROWSER_CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  await mkdir(artifactDir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  await context.exposeFunction(
    "syntheticWalletRequest",
    async ({ method, params }) => {
      if (method === "eth_requestAccounts") return [activeSigner.address];
      if (method === "eth_chainId") return `0x${activeChain.toString(16)}`;
      if (method === "personal_sign") {
        assert.match(params[0], /^0x(?:[0-9a-f]{2})+$/i);
        if (rejectSignature)
          throw new Error("Synthetic user rejected signature");
        return activeSigner.signMessage({ message: { raw: params[0] } });
      }
      throw new Error("Unsupported synthetic wallet request");
    },
  );
  await context.addInitScript(() => {
    window.ethereum = {
      request: (args) => window.syntheticWalletRequest(args),
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/account`);
  await page.locator("#signed-out").waitFor({ state: "visible" });
  await page.locator(".account-details summary").click();
  await page.locator("#email-register input[name=email]").fill(email);
  await page.locator("#email-register input[name=password]").fill(password);
  await page.locator("#email-register button").click();
  await page.locator("#signed-in").waitFor({ state: "visible" });
  const user = (
    await pool.query("SELECT id FROM users WHERE email=$1", [email])
  ).rows[0];
  accounts.push(user.id);
  const notice = page.locator("#wallet-change-notice");
  const form = page.locator("#wallet-change-form");
  const change = page.locator("#wallet-change");

  // Password approval, rejected new-wallet signature, and retry before expiry.
  await page.locator("#wallet-link").click();
  await change.waitFor({ state: "visible" });
  await page
    .locator("#wallet-change-target")
    .getByText(signers[0].address.toLowerCase(), { exact: false })
    .waitFor();
  await form.locator("input[name=password]").fill(password);
  await page.screenshot({
    path: `${artifactDir}/password-approval-desktop.png`,
    fullPage: false,
  });
  await form.locator("button[type=submit]").click();
  await page.locator("#new-wallet-proof").waitFor({ state: "visible" });
  rejectSignature = true;
  await page.locator("#sign-new-wallet").click();
  await notice.getByText("rejected signature", { exact: false }).waitFor();
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM wallet_identities WHERE user_id=$1",
        [user.id],
      )
    ).rows[0].count,
    0,
  );
  rejectSignature = false;
  await page.locator("#sign-new-wallet").click();
  await change.waitFor({ state: "hidden" });
  await page
    .locator("#account-notice")
    .getByText("Wallet linked.", { exact: false })
    .waitFor();

  // Existing linked-wallet approval; wrong account and chain must never bypass it.
  activeSigner = signers[1];
  await page.locator("#wallet-link").click();
  await change.waitFor({ state: "visible" });
  const linked = (
    await pool.query("SELECT id FROM wallet_identities WHERE user_id=$1", [
      user.id,
    ])
  ).rows[0];
  await form.locator("select[name=credential]").selectOption(linked.id);
  await page.screenshot({
    path: `${artifactDir}/retained-wallet-approval-desktop.png`,
    fullPage: false,
  });
  await form.locator("button[type=submit]").click();
  await form.locator("button[type=submit]:not([disabled])").waitFor();
  await notice.getByText("Switch your wallet", { exact: false }).waitFor();
  activeSigner = signers[0];
  activeChain = 1;
  await form.locator("button[type=submit]").click();
  await form.locator("button[type=submit]:not([disabled])").waitFor();
  await notice.getByText(`chain ${chainId}`, { exact: false }).waitFor();
  activeChain = chainId;
  await form.locator("button[type=submit]").click();
  await page.locator("#new-wallet-proof").waitFor({ state: "visible" });
  await page.locator("#sign-new-wallet").click();
  await page.locator("#sign-new-wallet:not([disabled])").waitFor();
  await notice.getByText("Switch your wallet", { exact: false }).waitFor();
  activeSigner = signers[1];
  await page.locator("#sign-new-wallet").click();
  await change.waitFor({ state: "hidden" });
  await page
    .locator("#account-notice")
    .getByText("Wallet linked.", { exact: false })
    .waitFor();

  // Server expiry returns the form to a fresh approval, with no mutation.
  activeSigner = signers[2];
  await page.locator("#wallet-link").click();
  await form.locator("input[name=password]").fill(password);
  await form.locator("button[type=submit]").click();
  await page.locator("#new-wallet-proof").waitFor({ state: "visible" });
  await pool.query(
    "UPDATE wallet_operations SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE user_id=$1 AND consumed_at IS NULL",
    [user.id],
  );
  await page.locator("#sign-new-wallet").click();
  await notice.getByText("expired or invalid", { exact: false }).waitFor();
  await form.waitFor({ state: "visible" });
  await page.locator("#cancel-wallet-change").click();
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM wallet_identities WHERE user_id=$1",
        [user.id],
      )
    ).rows[0].count,
    2,
  );

  // Retained wallet approval for unlink in a mobile viewport.
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .locator("#wallet-list li")
    .first()
    .getByRole("button", { name: "Unlink" })
    .click();
  await change.waitFor({ state: "visible" });
  const retained = (
    await pool.query(
      "SELECT id FROM wallet_identities WHERE user_id=$1 AND address=$2",
      [user.id, signers[1].address.toLowerCase()],
    )
  ).rows[0];
  await form.locator("select[name=credential]").selectOption(retained.id);
  activeSigner = signers[1];
  await page.screenshot({
    path: `${artifactDir}/unlink-approval-mobile.png`,
    fullPage: false,
  });
  await form.locator("button[type=submit]").click();
  await change.waitFor({ state: "hidden" });
  await page
    .locator("#account-notice")
    .getByText("Wallet unlinked.", { exact: false })
    .waitFor();
  assert.equal(await page.locator("#signed-in").isVisible(), true);
  assert.ok(
    await page
      .locator("#account-notifications")
      .getByText("was unlinked", { exact: false })
      .count(),
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );

  // Wallet-only account: sole method protected; linked method supports another addition.
  await page.locator("#sign-out").click();
  await page.locator("#signed-out").waitFor({ state: "visible" });
  activeSigner = signers[3];
  await page.locator("#wallet-login").click();
  await page.locator("#signed-in").waitFor({ state: "visible" });
  const walletOnly = (
    await pool.query(
      "SELECT user_id FROM wallet_identities WHERE address=$1 AND chain_id=$2",
      [signers[3].address.toLowerCase(), chainId],
    )
  ).rows[0];
  accounts.push(walletOnly.user_id);
  await page.locator("#wallet-list button").click();
  await change.waitFor({ state: "visible" });
  assert.equal(await form.locator("button[type=submit]").isDisabled(), true);
  await notice
    .getByText("cannot remove your last sign-in method", { exact: false })
    .waitFor();
  assert.equal(await page.locator("#existing-wallet-help").isVisible(), false);
  await page.screenshot({
    path: `${artifactDir}/sole-wallet-protection-mobile.png`,
    fullPage: false,
  });
  await page.locator("#cancel-wallet-change").click();
  activeSigner = signers[2];
  await page.locator("#wallet-link").click();
  await change.waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#current-password-label").isVisible(),
    false,
  );
  activeSigner = signers[3];
  await form.locator("button[type=submit]").click();
  await page.locator("#new-wallet-proof").waitFor({ state: "visible" });
  activeSigner = signers[2];
  await page.locator("#sign-new-wallet").click();
  await change.waitFor({ state: "hidden" });
  await page
    .locator("#account-notice")
    .getByText("Wallet linked.", { exact: false })
    .waitFor();
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM wallet_identities WHERE user_id=$1",
        [walletOnly.user_id],
      )
    ).rows[0].count,
    2,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Browser verified: password + retained-wallet approvals, wallet-only access, account/chain switching, rejected signature, expiry, mobile unlink, notifications and final-method gate. Screenshots saved.",
  );
} finally {
  await browser?.close();
  if (accounts.length) {
    await pool.query("DELETE FROM users WHERE id=ANY($1::bigint[])", [
      accounts,
    ]);
    await pool.query(
      "DELETE FROM identity_audit_events WHERE user_id=ANY($1::bigint[])",
      [accounts],
    );
  }
  await pool.end();
}
