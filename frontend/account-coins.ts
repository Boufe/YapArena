interface CoinRequest {
  id: string;
  kind: string;
  status: string;
  terms: Record<string, string>;
  expiresAt: string | null;
}
interface CoinSummary {
  sessionId: string;
  simulation: boolean;
  rail: string;
  initialized: boolean;
  financialReviewRequired: boolean;
  projection: {
    grantPrincipal: string;
    grantProfit: string;
    purchasedPrincipal: string;
    purchasedProfit: string;
    withdrawable: string;
    grants: {
      id: string;
      kind: string;
      qualified: boolean;
      remainingTarget: string;
      netProfit: string;
      withdrawableProfit: string;
    }[];
  };
  balances: {
    cashAvailable: string;
    reserved: string;
    pending: string;
    promotionalPrincipal: string;
  };
  requests: CoinRequest[];
}
interface CoinRound {
  id: string;
  proposition: string;
  state: string;
  closesAt: string;
  own: { side: string; quantity: number; requestId: string } | null;
  outcome?: {
    premium: string;
    fee: string;
    payout: string;
    net: string;
    executed: boolean;
  };
}
const container = document.querySelector<HTMLElement>("#account-wallet");
const usdc = (value: string) => {
  const n = BigInt(value),
    a = n < 0n ? -n : n;
  return `${n < 0n ? "−" : ""}${a / 1_000_000n}.${
    String(a % 1_000_000n)
      .padStart(6, "0")
      .replace(/0+$/, "") || "0"
  } USDC`;
};
const yc = (value: string) => {
  const n = BigInt(value),
    a = n < 0n ? -n : n;
  const fraction = String(a % 10_000n)
    .padStart(4, "0")
    .replace(/0+$/, "");
  return `${n < 0n ? "−" : ""}${a / 10_000n}${fraction ? `.${fraction}` : ""} YC`;
};
function amount(value: string) {
  if (!/^(0|[1-9][0-9]{0,20})(\.\d{1,6})?$/.test(value))
    throw new Error("Enter an amount with at most six decimal places.");
  const [whole, fraction = ""] = value.split(".");
  const n = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (n <= 0n) throw new Error("Enter a positive amount.");
  return String(n);
}
if (container) {
  const root = document.createElement("section");
  root.id = "coin-sandbox";
  root.hidden = true;
  root.innerHTML = `<h3>Coin sandbox</h3><p class="form-note">Simulated funds. No cash value. These balances are separate from historical play coins and live funds.</p>
    <p data-coin-notice role="status" aria-live="polite" aria-atomic="true"></p><dl class="account-balances" data-coin-balances></dl>
    <button type="button" class="button-secondary" data-coin-refresh>Refresh sandbox</button>
    <button type="button" class="button-secondary" data-coin-initialize>Enter sandbox / claim welcome grant</button>
    <button type="button" class="button-secondary" data-coin-daily>Claim daily 500 YC</button><ul class="account-list" data-coin-grants></ul>
    <details class="account-details"><summary>Simulate a purchase</summary><form class="stack-form" data-coin-funding><label>Test USDC amount<input name="amount" inputmode="decimal" value="10" required autocomplete="off"></label><p>Fixed simulation: 1 test USDC buys 100 YC. No crypto is sent and no provider conversion is performed.</p><button class="button" type="submit">Get simulated quote</button></form></details>
    <details class="account-details"><summary>Request a simulated withdrawal</summary><form class="stack-form" data-coin-withdraw><label>Total to deduct (USDC)<input name="gross" inputmode="decimal" value="5" required autocomplete="off"></label><label>External wallet destination<input name="destination" maxlength="200" required autocomplete="off" spellcheck="false"></label><p>Minimum deduction: 5 USDC. The displayed fee comes out of that amount. No daily cap. Purchased funds need no profit target; only grant profits have qualification rules.</p><p>Manual review target: two business days (Toronto weekdays, excluding Canadian federal holidays). Network confirmation time is additional. Pending funds stay reserved.</p><button class="button" type="submit">Review amount and network fee</button></form></details>
    <details class="account-details"><summary>Join a YES/NO debate with sandbox coins</summary><label>Existing debate<select data-coin-debate></select></label><button type="button" class="button-secondary" data-coin-open>Open or join a 5-minute round</button><div data-coin-rounds></div><form class="stack-form" data-coin-participate hidden><label>Position<select name="side"><option value="YES">YES</option><option value="NO">NO</option></select></label><label>Maximum purchase price per YC (0–1)<input name="ceiling" inputmode="decimal" value="0.5" required></label><label>Quantity (1–100)<input name="quantity" type="number" min="1" max="100" value="1" required></label><p>The first commitment is final. Oldest grants are used first. A4 uses the existing YES/NO mechanism; participation is not a bet on an externally judged winner.</p><button class="button" type="submit">Review and commit participation</button></form></details>
    <h4>Sandbox receipts</h4><ul class="account-list" data-coin-receipts></ul>`;
  container.append(root);
  const select = <T extends Element>(selector: string) =>
    root.querySelector<T>(selector)!;
  const notice = select<HTMLElement>("[data-coin-notice]"),
    balanceList = select<HTMLElement>("[data-coin-balances]"),
    grants = select<HTMLElement>("[data-coin-grants]"),
    receipts = select<HTMLElement>("[data-coin-receipts]");
  const funding = select<HTMLFormElement>("[data-coin-funding]"),
    withdraw = select<HTMLFormElement>("[data-coin-withdraw]"),
    participation = select<HTMLFormElement>("[data-coin-participate]"),
    debate = select<HTMLSelectElement>("[data-coin-debate]");
  let version = 0,
    busy = false,
    roundId: string | null = null,
    sessionId: string | null = null;
  const keys = new Map<string, string>();
  const key = (scope: string) => {
    let k = keys.get(scope);
    if (!k) {
      k = crypto.randomUUID();
      keys.set(scope, k);
    }
    return k;
  };
  async function api<T>(
    path: string,
    method = "GET",
    data?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const response = await fetch(`/api/coin-sandbox${path}`, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        ...(data === undefined ? {} : { "Content-Type": "application/json" }),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        ...(method !== "GET" && sessionId
          ? { "X-YapArena-Session": sessionId }
          : {}),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const message: { error?: string } = await response
        .json()
        .catch(() => ({}));
      throw new Error(
        message.error ??
          (response.status === 404
            ? "Sandbox is disabled."
            : "Could not confirm the result. Refresh receipts before retrying."),
      );
    }
    return response.json();
  }
  function setBusy(value: boolean) {
    busy = value;
    for (const button of root.querySelectorAll<HTMLButtonElement>("button"))
      button.disabled = value;
  }
  async function action(work: (generation: number) => Promise<void>) {
    if (busy) return;
    const generation = version;
    const initiatingControl =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setBusy(true);
    notice.textContent = "Working…";
    try {
      await work(generation);
    } catch (error) {
      if (generation === version)
        notice.textContent =
          error instanceof Error
            ? error.message
            : "Could not confirm the result. Refresh receipts before retrying.";
    } finally {
      if (generation === version) {
        setBusy(false);
        if (
          initiatingControl?.isConnected &&
          !root.hidden &&
          initiatingControl.getClientRects().length &&
          !document.querySelector("dialog[open]")
        )
          initiatingControl.focus();
      }
    }
  }
  async function load(generation = version) {
    const summary = await api<CoinSummary>("/summary");
    if (generation !== version) return;
    sessionId = summary.sessionId;
    // This browser journey intentionally supports the deterministic staging rail
    // only. Real testnet signing/reconciliation runs in its isolated operator DB.
    if (!summary.simulation || summary.rail !== "simulation") {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    balanceList.replaceChildren();
    grants.replaceChildren();
    receipts.replaceChildren();
    for (const [label, value] of [
      ["Purchased principal", summary.projection.purchasedPrincipal],
      ["Purchased profit", summary.projection.purchasedProfit],
      ["Grant principal (spend-only)", summary.projection.grantPrincipal],
      ["Grant profit", summary.projection.grantProfit],
      ["Withdrawal-eligible", summary.projection.withdrawable],
      ["Reserved cash", summary.balances.reserved],
      ["Pending cash", summary.balances.pending],
    ]) {
      const item = document.createElement("div"),
        term = document.createElement("dt"),
        valueElement = document.createElement("dd");
      term.textContent = label!;
      valueElement.textContent = yc(value!);
      item.append(term, valueElement);
      balanceList.append(item);
    }
    for (const grant of summary.projection.grants) {
      const item = document.createElement("li");
      item.textContent = `${grant.kind === "welcome" ? "Welcome" : "Daily"} grant: ${grant.qualified ? "permanently qualified" : `${yc(grant.remainingTarget)} new net profit needed`}; ${yc(grant.withdrawableProfit)} eligible profit. Principal stays spend-only.`;
      grants.append(item);
    }
    for (const request of summary.requests) {
      const item = document.createElement("li");
      item.textContent = `${request.kind} · ${request.status} · ${request.terms.gross ? `deduct ${usdc(request.terms.gross)}, fee ${usdc(request.terms.fee!)}, receive ${usdc(request.terms.net!)}` : request.terms.amount ? usdc(request.terms.amount) : `${request.terms.side ?? ""} ${request.terms.quantity ?? ""} YC`} · ${request.id}`;
      receipts.append(item);
    }
    select<HTMLButtonElement>("[data-coin-initialize]").hidden =
      summary.initialized;
    notice.textContent = summary.financialReviewRequired
      ? "Financial activity is paused for correction review. Ordinary account access remains available."
      : "Sandbox balances refreshed. Simulated withdrawals require manual operator review.";
  }
  async function loadRounds(generation = version) {
    if (!debate.value) return;
    const rows = await api<CoinRound[]>(
      `/debates/${encodeURIComponent(debate.value)}/rounds`,
    );
    if (generation !== version) return;
    roundId = rows.find((r) => r.state === "open" && !r.own)?.id ?? null;
    participation.hidden = !roundId;
    const list = select<HTMLElement>("[data-coin-rounds]");
    list.replaceChildren();
    for (const round of rows) {
      const p = document.createElement("p");
      p.textContent = `${round.proposition}: ${round.state}, cutoff ${new Date(round.closesAt).toLocaleString()}.${round.own ? ` Your ${round.own.side} ${round.own.quantity} YC commitment is final.` : ""}${round.outcome ? ` Paid ${yc(String(BigInt(round.outcome.premium) + BigInt(round.outcome.fee)))}, received ${yc(round.outcome.payout)}, net ${yc(round.outcome.net)}.` : ""}`;
      list.append(p);
    }
  }
  select<HTMLButtonElement>("[data-coin-refresh]").onclick = () =>
    void action(async (g) => {
      await api("/settlements", "POST", {});
      await load(g);
      await loadRounds(g);
    });
  select<HTMLButtonElement>("[data-coin-initialize]").onclick = () =>
    void action(async (g) => {
      await api("/initialize", "POST", {});
      await load(g);
    });
  select<HTMLButtonElement>("[data-coin-daily]").onclick = () =>
    void action(async (g) => {
      await api("/grants/daily", "POST", {});
      await load(g);
    });
  funding.onsubmit = (event) => {
    event.preventDefault();
    void action(async (g) => {
      const input = amount(String(new FormData(funding).get("amount"))),
        scope = `funding:${input}`;
      const quote = await api<CoinRequest>(
        "/funding/quotes",
        "POST",
        { amount: input },
        key(scope),
      );
      if (g !== version) return;
      if (
        !window.confirm(
          `SIMULATION ONLY: ${usdc(input)} → ${yc(input)}. No conversion fee. Quote expires ${new Date(quote.expiresAt!).toLocaleTimeString()}. Confirm simulated funding?`,
        )
      ) {
        notice.textContent = "Quote cancelled. No coins issued.";
        return;
      }
      await api(`/funding/${quote.id}/confirm`, "POST", {});
      if (g !== version) return;
      keys.delete(scope);
      await load(g);
    });
  };
  withdraw.onsubmit = (event) => {
    event.preventDefault();
    void action(async (g) => {
      const data = new FormData(withdraw),
        gross = amount(String(data.get("gross"))),
        destination = String(data.get("destination")).trim();
      if (BigInt(gross) < 5_000_000n)
        throw new Error("The total deduction must be at least 5 USDC.");
      const scope = `withdrawal:${gross}:${destination}`,
        quote = await api<CoinRequest>(
          "/withdrawals/quotes",
          "POST",
          { gross, destination },
          key(scope),
        );
      if (g !== version) return;
      if (
        !window.confirm(
          `SIMULATION ONLY\nDeduct: ${usdc(quote.terms.gross!)}\nNetwork fee included: ${usdc(quote.terms.fee!)}\nWallet receives: ${usdc(quote.terms.net!)}\nDestination: ${quote.terms.destination}\nManual review; no real payment. Continue to security approval?`,
        )
      ) {
        notice.textContent = "Withdrawal cancelled. Nothing reserved.";
        return;
      }
      if (!window.yapApproveCoinWithdrawal)
        throw new Error(
          "Security approval is still loading. Try again shortly.",
        );
      if (!sessionId)
        throw new Error("Refresh the account before authorizing.");
      const approval = await window.yapApproveCoinWithdrawal(
        quote.id,
        quote.terms,
        sessionId,
      );
      if (g !== version) return;
      await api(`/withdrawals/${quote.id}`, "POST", { approval });
      if (g !== version) return;
      keys.delete(scope);
      await load(g);
    });
  };
  select<HTMLButtonElement>("[data-coin-open]").onclick = () =>
    void action(async (g) => {
      if (!debate.value) throw new Error("Choose a published debate.");
      const scope = `round:${debate.value}`;
      await api(`/debates/${debate.value}/rounds`, "POST", {}, key(scope));
      if (g !== version) return;
      keys.delete(scope);
      await loadRounds(g);
      notice.textContent = "Round ready. Review a position before committing.";
    });
  debate.onchange = () =>
    void action(async (g) => {
      await loadRounds(g);
      notice.textContent = "Debate rounds refreshed.";
    });
  participation.onsubmit = (event) => {
    event.preventDefault();
    void action(async (g) => {
      if (!roundId) throw new Error("Choose an open round.");
      const selected = roundId,
        data = new FormData(participation),
        side = String(data.get("side")),
        ceiling = String(data.get("ceiling")),
        quantity = Number(data.get("quantity"));
      if (
        !/^(0(\.\d{1,6})?|1(\.0{1,6})?)$/.test(ceiling) ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 100
      )
        throw new Error(
          "Use a price from 0 to 1 and an integer quantity from 1 to 100.",
        );
      if (
        !window.confirm(
          `SIMULATION: commit ${side}, ${quantity} YC at a maximum ${ceiling} per YC? Up to ${quantity} YC will be reserved, oldest grant first. The first commitment cannot be edited or cancelled.`,
        )
      ) {
        notice.textContent = "Participation cancelled. Nothing reserved.";
        return;
      }
      await api(
        `/rounds/${selected}/submit`,
        "POST",
        { side, ceiling, quantity },
        key(`stake:${selected}:${side}:${ceiling}:${quantity}`),
      );
      if (g !== version) return;
      await load(g);
      await loadRounds(g);
      notice.textContent =
        "Commitment recorded. Settlement occurs after the five-minute cutoff.";
    });
  };
  async function start() {
    const generation = ++version;
    setBusy(false);
    sessionId = null;
    root.hidden = true;
    keys.clear();
    roundId = null;
    debate.replaceChildren();
    try {
      await load(generation);
      if (generation !== version || root.hidden) return;
      const response = await fetch("/api/public/debates?limit=100", {
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return;
      const data: { items: { id: string; proposition: string }[] } =
        await response.json();
      if (generation !== version) return;
      for (const item of data.items) {
        const option = document.createElement("option");
        option.value = item.id;
        option.textContent = item.proposition;
        debate.append(option);
      }
      await loadRounds(generation);
    } catch {
      if (generation === version) root.hidden = true;
    }
  }
  window.addEventListener("yap:account-changed", () => void start());
  window.addEventListener("yap:provider-logout", () => {
    ++version;
    root.hidden = true;
    keys.clear();
    receipts.replaceChildren();
    grants.replaceChildren();
    balanceList.replaceChildren();
  });
  void start();
}
