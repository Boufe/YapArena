import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import pg from "pg";
import { privateKeyToAccount } from "viem/accounts";
import type {} from "../frontend/account-types.ts";

// Only explicit disposable loopback databases and local application instances.
// Wallets are deterministic test signers; no provider or chain calls are made.
const base = process.env.BROWSER_BASE_URL ?? "http://127.0.0.1:53502";
const application = new URL(base);
assert.ok(["localhost", "127.0.0.1"].includes(application.hostname));
assert.ok(["http:", "https:"].includes(application.protocol));
assert.ok(
  process.env.WALLET_TEST_OWNER_DATABASE_URL,
  "Supply a disposable owner database URL",
);
const databaseUrl = new URL(process.env.WALLET_TEST_OWNER_DATABASE_URL);
assert.ok(["localhost", "127.0.0.1"].includes(databaseUrl.hostname));
assert.match(
  databaseUrl.pathname,
  /^\/(?:yaparena_f02|revocation_test)[a-z0-9_]*$/,
);
const directory = resolve(
  process.env.BROWSER_ARTIFACT_DIR ??
    "/private/tmp/yaparena-retained-wallet-browser",
);
const pool = new pg.Pool({
  connectionString: databaseUrl.toString(),
  connectionTimeoutMillis: 5000,
  query_timeout: 5000,
});
const signers = ["41", "42", "43", "44"].map((byte) =>
  privateKeyToAccount(`0x${byte.repeat(32)}`),
);
function signer(index: number) {
  const value = signers[index];
  assert.ok(value);
  return value;
}
type WalletRequest = { method: string; params?: unknown[] };
declare global {
  interface Window {
    retainedWalletFixtureRequest: (request: WalletRequest) => Promise<unknown>;
  }
}
const chainId = 7654321;
let activeSigner = signer(0);
let activeChain = chainId;
let rejectSignature = false;
let expireCompletion = false;
let unavailable = false;
let completed: { path: string; body: string } | null = null;
const suffix = randomUUID().slice(0, 8);
const email = `retained-wallet-browser-${suffix}@example.test`;
const password = "Synthetic browser operation passphrase";
const accounts: string[] = [];
const checks: string[] = [];
const errors: string[] = [];
let browser: Browser | undefined;
let failurePage: Page | undefined;
let phase = "start";
async function countWallets(accountId: string) {
  return (
    await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM wallet_identities WHERE user_id=$1",
      [accountId],
    )
  ).rows[0]?.count;
}
try {
  await mkdir(directory, { recursive: true });
  browser = await chromium.launch({
    executablePath:
      process.env.BROWSER_CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  await context.exposeFunction(
    "retainedWalletFixtureRequest",
    async ({ method, params }: WalletRequest) => {
      if (method === "eth_requestAccounts") return [activeSigner.address];
      if (method === "eth_chainId") return `0x${activeChain.toString(16)}`;
      assert.equal(method, "personal_sign");
      assert.ok(
        params &&
          typeof params[0] === "string" &&
          /^0x(?:[0-9a-f]{2})+$/i.test(params[0]),
      );
      assert.equal(
        String(params[1]).toLowerCase(),
        activeSigner.address.toLowerCase(),
      );
      if (rejectSignature) throw new Error("Synthetic user rejected signature");
      return activeSigner.signMessage({
        message: { raw: params[0] as `0x${string}` },
      });
    },
  );
  await context.addInitScript(() => {
    function request(input: {
      method: "eth_requestAccounts";
    }): Promise<string[]>;
    function request(input: { method: "eth_chainId" }): Promise<string>;
    function request(input: {
      method: "personal_sign";
      params: [string, string];
    }): Promise<string>;
    async function request(input: WalletRequest): Promise<string[] | string> {
      const value = await window.retainedWalletFixtureRequest(input);
      if (input.method === "eth_requestAccounts") {
        if (
          !Array.isArray(value) ||
          !value.every((entry: unknown) => typeof entry === "string")
        )
          throw new Error("Invalid fixture account response");
        return value;
      }
      if (typeof value !== "string")
        throw new Error("Invalid fixture wallet response");
      return value;
    }
    window.ethereum = { request };
  });
  const page = await context.newPage();
  failurePage = page;
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  const accountRefreshEntered = Promise.withResolvers<void>();
  const releaseAccountRefresh = Promise.withResolvers<void>();
  let holdAccountRefresh = false;
  await page.route("**/api/auth/me", async (route) => {
    if (!holdAccountRefresh) return route.continue();
    accountRefreshEntered.resolve();
    await releaseAccountRefresh.promise;
    return route.continue();
  });
  await page.route("**/api/auth/wallet/operations", async (route) => {
    if (unavailable)
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Synthetic wallet approval service unavailable",
        }),
      });
    return route.continue();
  });
  await page.route(
    "**/api/auth/wallet/operations/*/complete",
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (expireCompletion) {
        expireCompletion = false;
        const id = path.match(/\/operations\/([0-9a-f-]+)\/complete$/)?.[1];
        assert.ok(id && accounts[0]);
        await pool.query(
          "UPDATE wallet_operations SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1 AND user_id=$2 AND consumed_at IS NULL",
          [id, accounts[0]],
        );
      }
      const response = await route.fetch();
      if (response.ok())
        completed = { path, body: route.request().postData() ?? "{}" };
      await route.fulfill({ response });
    },
  );
  phase = "create disposable legacy account";
  await page.goto(`${base}/account`);
  await page.locator("#signed-out").waitFor({ state: "visible" });
  assert.equal(await page.locator("#wallet-link").count(), 0);
  await page.locator(".account-details summary").click();
  await page.locator("#email-register input[name=email]").fill(email);
  await page.locator("#email-register input[name=password]").fill(password);
  await page.locator("#email-register button").click();
  await page.locator("#signed-in").waitFor({ state: "visible" });
  const accountId = (
    await pool.query<{ id: string }>("SELECT id FROM users WHERE email=$1", [
      email,
    ])
  ).rows[0]?.id;
  assert.ok(accountId);
  accounts.push(accountId);
  assert.equal(await page.locator("#retained-wallets").isVisible(), false);
  // These existing-credential fixtures are deliberately seeded by the owner;
  // the product no longer exposes creation of external wallet links.
  for (const wallet of signers.slice(0, 3))
    await pool.query(
      "INSERT INTO wallet_identities(user_id,address,chain_id) VALUES($1,$2,$3)",
      [accountId, wallet.address.toLowerCase(), chainId],
    );
  await page.reload();
  await page.locator("#retained-wallets").waitFor({ state: "visible" });
  assert.equal(await page.locator("#wallet-link").count(), 0);
  const dialog = page.locator("#wallet-change");
  const notice = page.locator("#wallet-change-notice");
  const form = page.locator("#wallet-change-form");
  async function openRemoval(index: number) {
    await page
      .locator("#wallet-list li")
      .filter({ hasText: signer(index).address.slice(0, 8) })
      .getByRole("button", { name: "Unlink" })
      .click();
    await dialog.waitFor({ state: "visible" });
  }
  async function submitFailure(text: RegExp) {
    await form.locator("button[type=submit]").click();
    await form.locator("button[type=submit]:not([disabled])").waitFor();
    await notice.filter({ hasText: text }).waitFor();
    assert.equal(await dialog.isVisible(), true);
  }
  phase = "password retained-wallet removal";
  await openRemoval(0);
  await form
    .locator("input[name=password]")
    .fill("Incorrect synthetic passphrase");
  await submitFailure(/proof|password|credential|invalid/i);
  assert.equal(await countWallets(accountId), 3);
  await form.locator("input[name=password]").fill(password);
  await page.screenshot({
    path: resolve(directory, "password-removal-desktop.png"),
    fullPage: true,
  });
  await form.locator("button[type=submit]").click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await countWallets(accountId), 2);
  checks.push(
    "new external linking absent; empty retained section hidden; password rejects wrong proof and removes a retained wallet",
  );
  phase = "retained-wallet proof negatives";
  await openRemoval(1);
  const retained = (
    await pool.query<{ id: string }>(
      "SELECT id FROM wallet_identities WHERE user_id=$1 AND address=$2",
      [accountId, signer(2).address.toLowerCase()],
    )
  ).rows[0]?.id;
  assert.ok(retained);
  await form.locator("select[name=credential]").selectOption(retained);
  phase = "retained-wallet wrong-account proof";
  activeSigner = signer(1);
  await submitFailure(/Switch your wallet/);
  phase = "retained-wallet wrong-chain proof";
  activeSigner = signer(2);
  activeChain = 1;
  await submitFailure(new RegExp(`chain ${chainId}`));
  phase = "retained-wallet cancelled signature";
  activeChain = chainId;
  rejectSignature = true;
  await submitFailure(/rejected signature/);
  phase = "retained-wallet expired completion";
  rejectSignature = false;
  expireCompletion = true;
  await submitFailure(/expired or invalid/);
  assert.equal(await countWallets(accountId), 2);
  phase = "retained-wallet unavailable approval service";
  unavailable = true;
  await submitFailure(/service unavailable/);
  assert.equal(await page.locator("#signed-in").isVisible(), true);
  assert.equal(await page.locator("#sign-out").isEnabled(), true);
  assert.equal(await countWallets(accountId), 2);
  unavailable = false;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: resolve(directory, "retained-removal-mobile.png"),
    fullPage: true,
  });
  phase = "mobile retained-wallet removal while account refresh is held";
  holdAccountRefresh = true;
  const refreshBarrierDeadline = Promise.withResolvers<void>();
  let refreshBarrierTimedOut = false;
  const refreshBarrierTimer = setTimeout(() => {
    refreshBarrierTimedOut = true;
    releaseAccountRefresh.resolve();
    refreshBarrierDeadline.resolve();
  }, 10000);
  try {
    await form.locator("button[type=submit]").click();
    await dialog.waitFor({ state: "hidden" });
    await Promise.race([
      accountRefreshEntered.promise,
      refreshBarrierDeadline.promise,
    ]);
    assert.equal(refreshBarrierTimedOut, false);
    assert.equal(await countWallets(accountId), 1);
    // Refreshing the same account updates it in place: while the lookup is
    // held, the account area stays visible and is not reset to "Checking".
    assert.equal(await page.locator("#signed-in").isVisible(), true);
    assert.notEqual(
      await page.locator("#account-notice").textContent(),
      "Checking your account…",
    );
    assert.equal(await page.locator("#sign-out").isEnabled(), true);
  } finally {
    holdAccountRefresh = false;
    clearTimeout(refreshBarrierTimer);
    releaseAccountRefresh.resolve();
  }
  phase = "mobile retained-wallet removal after account refresh";
  await page.locator("#signed-in").waitFor({ state: "visible" });
  await page
    .locator("#account-notice")
    .getByText(
      "Wallet unlinked. Other sessions were signed out and your session was renewed.",
      { exact: true },
    )
    .waitFor();
  await page
    .locator("#account-notifications")
    .getByText("was unlinked", { exact: false })
    .first()
    .waitFor();
  assert.equal(await countWallets(accountId), 1);
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
  checks.push(
    "retained proof rejects wrong account, wrong chain, cancelled signature, expiry and synthetic service outage; committed mobile removal keeps the same account on screen during a held refresh without emptying it, then shows the renewed session and notification",
  );
  phase = "retained-wallet consumed completion replay";
  assert.ok(completed);
  const replay = await page.evaluate(
    async (operation: { path: string; body: string }) => {
      const response = await fetch(operation.path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: operation.body,
      });
      return response.status;
    },
    completed,
  );
  assert.equal(replay, 410);
  assert.equal(await countWallets(accountId), 1);
  checks.push("consumed wallet-removal proof cannot replay");
  phase = "retained wallet-only sign-in and last-method protection";
  const walletOnly = (
    await pool.query<{ id: string }>(
      "INSERT INTO users DEFAULT VALUES RETURNING id",
    )
  ).rows[0]?.id;
  assert.ok(walletOnly);
  accounts.push(walletOnly);
  await pool.query(
    "INSERT INTO wallet_identities(user_id,address,chain_id) VALUES($1,$2,$3)",
    [walletOnly, signer(3).address.toLowerCase(), chainId],
  );
  await page.locator("#sign-out").click();
  await page.locator("#signed-out").waitFor({ state: "visible" });
  activeSigner = signer(3);
  await page.locator("#wallet-login").click();
  await page.locator("#signed-in").waitFor({ state: "visible" });
  assert.equal(await page.locator("#wallet-link").count(), 0);
  await page.locator("#wallet-list button").click();
  await dialog.waitFor({ state: "visible" });
  assert.equal(await form.locator("button[type=submit]").isDisabled(), true);
  await notice
    .getByText("cannot remove your last sign-in method", { exact: false })
    .waitFor();
  assert.equal(await page.locator("#existing-wallet-help").isVisible(), false);
  await page.screenshot({
    path: resolve(directory, "sole-wallet-protection-mobile.png"),
    fullPage: true,
  });
  await page.locator("#cancel-wallet-change").click();
  assert.equal(await countWallets(walletOnly), 1);
  checks.push(
    "existing wallet-only identity signs in; last retained method cannot be removed",
  );
  assert.deepEqual(errors, []);
  const sourceHashes: Record<string, string> = {};
  for (const path of [
    "scripts/verify-wallet-browser.ts",
    "frontend/account.ts",
    "src/features/discovery/account-web.ts",
    "src/features/discovery/web.ts",
    "public/account.js",
  ])
    sourceHashes[path] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  await writeFile(
    resolve(directory, "acceptance.json"),
    JSON.stringify(
      {
        status: "passed",
        revision: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        testedAt: new Date().toISOString(),
        environment:
          "explicit disposable loopback PostgreSQL; real runtime HTTP; synthetic legacy wallet signers; no external provider or chain",
        checks,
        errors,
        sourceHashes,
        limitations: [
          "No genuine embedded wallet creation, hosted provider or physical device acceptance",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({
      status: "passed",
      groups: checks.length,
      artifactDirectory: directory,
    }),
  );
} catch (error) {
  const errorName =
    error instanceof Error &&
    ["AssertionError", "TimeoutError"].includes(error.name)
      ? error.name
      : "Error";
  const scriptLine =
    error instanceof Error
      ? error.stack?.match(/verify-wallet-browser\.ts:(\d+):\d+/)?.[1]
      : undefined;
  await failurePage
    ?.screenshot({ path: resolve(directory, "failure.png"), fullPage: true })
    .catch(() => {});
  console.error(
    JSON.stringify({
      status: "failed",
      phase,
      errorName,
      scriptLine: scriptLine ? Number(scriptLine) : null,
      artifactDirectory: directory,
      privateDetailsWithheld: true,
    }),
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (accounts.length) {
    // Only IDs returned from fixtures created by this run are eligible.
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
