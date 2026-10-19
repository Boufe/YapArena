import type { AccountWalletSummary } from "../src/features/account-wallet/types.js";

type WalletView = AccountWalletSummary & {
  enabled: boolean;
  withdrawalsEnabled: boolean;
};
const walletChannel =
  "BroadcastChannel" in window
    ? new BroadcastChannel("yaparena-account")
    : null;
walletChannel?.addEventListener("message", () =>
  window.dispatchEvent(new Event("yap:account-changed")),
);
let walletRead: Promise<WalletView | null> | undefined;
let walletEpoch = 0;
window.addEventListener("yap:account-changed", () => {
  walletEpoch++;
  walletRead = undefined;
});
function readWallet() {
  const epoch = walletEpoch;
  walletRead ??= fetch("/api/account-wallet", {
    credentials: "same-origin",
    cache: "no-store",
  })
    .then(async (response) => {
      if (response.status === 401) return null;
      if (!response.ok)
        throw new Error("Balance unavailable. Try again shortly.");
      const value: WalletView = await response.json();
      return value.enabled && epoch === walletEpoch ? value : null;
    })
    .finally(() => {
      if (epoch === walletEpoch) walletRead = undefined;
    });
  return walletRead;
}
function showWalletSummary(target: HTMLElement, value: WalletView) {
  const heading = document.createElement("strong");
  heading.textContent = `Available for withdrawal: ${value.withdrawable} YC`;
  const note = document.createElement("p");
  note.textContent = value.withdrawalsEnabled
    ? "Purchased coins have no profit target. Grant principal stays spend-only."
    : "Withdrawals are not open yet. Grant principal stays spend-only.";
  const list = document.createElement("div");
  list.className = "wallet-grant-progress";
  if (!value.grants.length) {
    const empty = document.createElement("p");
    empty.textContent =
      "No promotional grants yet. Purchased coins have no profit target.";
    list.append(empty);
  }
  for (const [index, grant] of value.grants.entries()) {
    const row = document.createElement("div"),
      label = document.createElement("label"),
      bar = document.createElement("progress"),
      detail = document.createElement("p");
    const id = `${target.id}-grant-${index}`;
    label.htmlFor = id;
    label.textContent = `${grant.label}: ${grant.qualified ? "qualified" : `${grant.percent}%`}`;
    bar.id = id;
    bar.max = 100;
    bar.value = grant.percent;
    bar.setAttribute(
      "aria-valuetext",
      grant.qualified
        ? "Qualified; this grant stays qualified"
        : `${grant.netProfit} of ${grant.target} YC net profit. ${grant.remaining} YC still needed.`,
    );
    detail.textContent = grant.qualified
      ? "Qualified. Remaining profits stay eligible after losses."
      : `${grant.netProfit} / ${grant.target} YC net profit · ${grant.remaining} YC to qualify`;
    row.append(label, bar, detail);
    list.append(row);
  }
  target.replaceChildren(heading, note, list);
  target.hidden = false;
}
const moneyCard = document.querySelector<HTMLElement>(
  "#account-wallet-progress",
);
async function refreshMoneyCard() {
  if (!moneyCard) return;
  const epoch = walletEpoch;
  try {
    const value = await readWallet();
    if (epoch !== walletEpoch) return;
    if (value) showWalletSummary(moneyCard, value);
    else {
      moneyCard.replaceChildren();
      moneyCard.hidden = true;
    }
  } catch {
    if (epoch !== walletEpoch) return;
    moneyCard.textContent =
      "Withdrawal progress is temporarily unavailable. Try your balance menu again shortly.";
    moneyCard.hidden = false;
  }
}
for (const [index, menu] of document
  .querySelectorAll<HTMLDetailsElement>(".arena-wallet-menu")
  .entries()) {
  const popover = menu.querySelector<HTMLElement>(".arena-wallet-popover");
  if (
    !popover ||
    (!document.documentElement.hasAttribute("data-email-first") &&
      !document.querySelector("#email-auth"))
  )
    continue;
  const summary = document.createElement("section");
  summary.id = `wallet-withdrawal-${index}`;
  summary.className = "wallet-money-summary";
  summary.hidden = true;
  const status = document.createElement("p");
  status.role = "status";
  popover.classList.add("wallet-progress-enabled");
  popover.prepend(summary);
  popover.append(status);
  let version = 0;
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menu.open) {
      event.preventDefault();
      menu.open = false;
      menu.querySelector("summary")?.focus();
    }
  });
  menu.addEventListener("toggle", async () => {
    const current = ++version;
    if (!menu.open) return;
    status.textContent = "Checking withdrawal balance…";
    // Remove stale values while refreshing; never keep another account's data.
    summary.hidden = true;
    try {
      const value = await readWallet();
      if (current !== version || !menu.open) return;
      status.textContent = "";
      if (value) showWalletSummary(summary, value);
    } catch {
      if (current === version)
        status.textContent =
          "Withdrawal balance unavailable. Close and reopen to retry.";
    }
  });
  window.addEventListener("yap:account-changed", () => {
    version++;
    summary.replaceChildren();
    summary.hidden = true;
    status.textContent = "";
    if (menu.open) {
      menu.open = false;
    }
  });
}
window.addEventListener("yap:account-changed", () => {
  void refreshMoneyCard();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void refreshMoneyCard();
});
for (const opener of document.querySelectorAll<HTMLAnchorElement>(
  "[data-wallet-progress-open]",
)) {
  const dialog = document.createElement("dialog"),
    title = document.createElement("h2"),
    body = document.createElement("section"),
    close = document.createElement("button"),
    status = document.createElement("p"),
    account = document.createElement("a");
  dialog.className = "wallet-balance-dialog information-card";
  title.id = "wallet-progress-title";
  title.textContent = "Your Yap Coins";
  dialog.setAttribute("aria-labelledby", title.id);
  body.id = "homepage-withdrawal-summary";
  body.className = "wallet-money-summary";
  close.type = "button";
  close.className = "button-secondary";
  close.textContent = "Close";
  status.role = "status";
  account.href = "/account#account-wallet";
  account.textContent = "Account balances and settings →";
  dialog.append(title, status, body, account, close);
  document.body.append(dialog);
  let version = 0;
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    version++;
    body.replaceChildren();
    opener.focus();
  });
  window.addEventListener("yap:account-changed", () => dialog.close());
  opener.addEventListener("click", async (event) => {
    event.preventDefault();
    if (dialog.open) return;
    const current = ++version;
    status.textContent = "Checking your withdrawal balance…";
    body.replaceChildren();
    dialog.showModal();
    try {
      const value = await readWallet();
      if (!dialog.open || current !== version) return;
      status.textContent = value
        ? ""
        : "Sign in to view your balance and withdrawal progress.";
      if (value) showWalletSummary(body, value);
    } catch {
      if (dialog.open && current === version)
        status.textContent =
          "Withdrawal balance is temporarily unavailable. Close and try again.";
    }
  });
}
void refreshMoneyCard();
