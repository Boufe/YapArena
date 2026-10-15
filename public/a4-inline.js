/* global document, Option, window */
import { createRoundChart, sharePercent } from "./arena-chart.js";
const root = document.querySelector("[data-a4-inline]");
if (root) {
  const el = (name) => root.querySelector(`[data-inline-${name}]`);
  const ui = (name) => root.querySelector(`[data-arena-${name}]`);
  const status = (text) => {
    if (el("status").textContent !== text) el("status").textContent = text;
  };
  const money = (value = "0", precision = 6) => {
    const n = BigInt(value),
      a = n < 0n ? -n : n;
    const fractional = String(a % 1000000n)
      .padStart(6, "0")
      .slice(0, precision);
    return `${n < 0n ? "−" : ""}${a / 1000000n}${precision ? "." + fractional : ""} Yap Coins`;
  };
  const escape = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  let userId,
    run,
    pending,
    timeline,
    selectedRound,
    busy = false,
    listSignature;
  const chart = createRoundChart(root, (item) =>
    act(async () => {
      selectedRound = item.id;
      run = { id: item.runId };
      await list(run.id);
      await refresh();
    }),
  );
  function clearPrivate() {
    userId = null;
    run = null;
    pending = null;
    timeline = null;
    selectedRound = null;
    el("review").close();
    el("access").hidden = true;
    el("receipt").textContent = "Sign in to view your commitments.";
    ui("history").textContent = "Sign in to view your history.";
    ui("round-list").replaceChildren();
    delete ui("round-list").dataset.signature;
    ui("volume").textContent = "— Yap Coins";
    ui("participants").textContent = "Finalized commitments";
    ui("available").textContent = "Your balance —";
    ui("yes").textContent = "—";
    ui("no").textContent = "—";
    ui("sentiment-bar").style.removeProperty("--yes-share");
    ui("sentiment-bar").dataset.empty = "true";
    ui("signin").hidden = false;
    chart.clear();
    window.dispatchEvent(new CustomEvent("yap:balance", { detail: null }));
  }
  async function api(path, body, key) {
    const response = await fetch(`/api/${path}`, {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: body
        ? {
            "Content-Type": "application/json",
            "Idempotency-Key": key ?? crypto.randomUUID(),
          }
        : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 401) clearPrivate();
      if (
        response.status === 404 &&
        (path.includes("/timeline") || path.includes("/workspace"))
      ) {
        timeline = null;
        chart.clear("This debate's settled history is unavailable.");
        ui("round-list").replaceChildren();
        delete ui("round-list").dataset.signature;
        ui("volume").textContent = "— Yap Coins";
        ui("participants").textContent = "History unavailable";
        ui("yes").textContent = "—";
        ui("no").textContent = "—";
        ui("sentiment-bar").dataset.empty = "true";
      }
      throw new Error(result.error ?? "Unable to load Yap Coins");
    }
    return result;
  }
  async function act(work) {
    if (busy) return;
    busy = true;
    try {
      await work();
    } catch (error) {
      status(error.message);
      ui("sync").textContent = "Connection interrupted · retrying";
    } finally {
      busy = false;
    }
  }
  async function list(selected) {
    const data = await api(
      `a4/runs?debateId=${encodeURIComponent(root.dataset.a4Inline)}`,
    );
    const next = populateRuns(data, selected);
    run = next ? { id: next } : null;
  }
  function populateRuns(data, selected) {
    const signature = JSON.stringify([data.items, selected]);
    if (signature === listSignature) return el("runs").value;
    listSignature = signature;
    const items = data.items.filter((r) => r.mode !== "observer");
    const next =
      selected ?? items.find((r) => r.state === "running")?.id ?? items[0]?.id;
    el("runs").replaceChildren(
      new Option("Choose a round", ""),
      ...items.map(
        (r) =>
          new Option(
            `${r.mode === "mixed" ? "BOTS + YOU" : "Human-only"} · ${r.state} · ${r.id.slice(0, 8)}`,
            r.id,
          ),
      ),
    );
    if (next && !items.some((r) => r.id === next))
      el("runs").add(new Option("Selected historical run", next));
    if (next) {
      el("runs").value = next;
    }
    return next;
  }
  function renderReceipts() {
    const receipts = run?.rounds.filter((r) => r.receipt) ?? [];
    const open = receipts.filter((r) => !r.revealed && r.state !== "void");
    const history = receipts.filter((r) => r.revealed || r.state === "void");
    ui("open-count").textContent = `(${open.length})`;
    const table = (rows) =>
      `<div class="arena-table-scroll"><table class="arena-order-table"><thead><tr><th>Side</th><th>Contracts</th><th>Limit</th><th>Status</th></tr></thead><tbody>${rows.map((r) => `<tr><td class="${r.receipt.side === "YES" ? "yes" : "no"}">${escape(r.receipt.side)}</td><td>${r.receipt.quantity}</td><td>${escape(r.receipt.limit)}</td><td>${escape(r.receipt.status.replaceAll("_", " "))}</td></tr><tr class="arena-receipt-detail"><td colspan="4">Round ${r.period} · reserved ${money(r.receipt.reserved)}${r.receipt.premium !== undefined ? ` · premium ${money(r.receipt.premium)} · fee ${money(r.receipt.fee)} · released ${money(r.receipt.released)}` : " · Binding commitment recorded"}${r.receipt.payout !== undefined ? `<br>Payout ${money(r.receipt.payout)} · net ${money(r.receipt.net)}` : " · Awaiting final reveal"}</td></tr>`).join("")}</tbody></table></div>`;
    el("receipt").innerHTML = open.length
      ? table(open)
      : '<p class="arena-order-empty">No open commitments in this run.</p>';
    ui("history").innerHTML = history.length
      ? table(history)
      : '<p class="arena-order-empty">No settled commitments in this run yet.</p>';
  }
  function renderRounds() {
    const current = run?.rounds.filter((r) => !r.revealed) ?? [];
    const latestNumber = timeline.items.at(-1)?.number ?? 0;
    const rows = [
      ...current.map((r, i) => ({
        ...r,
        runId: run.id,
        number: latestNumber + i + 1,
        current: true,
      })),
      ...[...timeline.items].reverse(),
    ];
    const signature = JSON.stringify(
      rows.map((r) => [
        r.id,
        r.state,
        r.number,
        r.share,
        r.id === selectedRound,
      ]),
    );
    const listNode = ui("round-list");
    if (listNode.dataset.signature === signature) return;
    listNode.dataset.signature = signature;
    listNode.replaceChildren();
    for (const row of rows) {
      const li = document.createElement("li"),
        button = document.createElement("button");
      button.type = "button";
      button.className = "arena-round-item";
      button.classList.toggle("is-selected", row.id === selectedRound);
      button.dataset.roundId = row.id;
      const percent = sharePercent(row.share);
      button.innerHTML = `<span class="arena-round-dot"></span><span>Round ${row.number}</span>${row.current ? `<small>${escape(row.state)}</small>` : ""}<strong>${percent === null ? "—" : percent.toFixed(0) + "%"}</strong>`;
      button.setAttribute(
        "aria-label",
        `Round ${row.number}, ${row.current ? row.state : percent === null ? "empty" : percent.toFixed(2) + "% YES"}`,
      );
      button.setAttribute("aria-pressed", String(row.id === selectedRound));
      button.addEventListener("click", () =>
        act(async () => {
          selectedRound = row.id;
          run = { id: row.runId };
          await list(run.id);
          await refresh();
        }),
      );
      li.append(button);
      listNode.append(li);
    }
    if (!rows.length)
      listNode.innerHTML =
        '<li class="arena-round-empty">No revealed rounds yet. Start a round to get going.</li>';
  }
  function describeSelection() {
    const active =
      run?.rounds.find((r) => r.id === selectedRound) ??
      run?.rounds.find((r) => r.state === "open") ??
      run?.rounds.at(-1);
    if (active) selectedRound = active.id;
    const historical = timeline?.items.find((r) => r.id === selectedRound);
    const number =
      historical?.number ??
      (timeline?.items.at(-1)?.number ?? 0) + (active?.period ?? 1);
    ui("round-label").textContent = active
      ? `Round ${number}`
      : "Round history";
    ui("round-state").textContent =
      active?.state === "open" ? "open" : (active?.state ?? "waiting");
    ui("round-state").classList.toggle("is-open", active?.state === "open");
    ui("trade-title").textContent = active
      ? `Participate in Round ${number}`
      : "Participate in a round";
    ui("countdown").dataset.closes = active?.closesAt ?? "";
    ui("countdown").dataset.state = active?.state ?? "";
    const selected =
      historical ?? timeline?.items.findLast((r) => r.share !== null);
    const share = sharePercent(selected?.share);
    ui("yes").textContent = share === null ? "—" : `${share.toFixed(1)}%`;
    ui("no").textContent =
      share === null ? "—" : `${(100 - share).toFixed(1)}%`;
    ui("sentiment-caption").textContent = selected
      ? `Settled round ${selected.number}`
      : "Latest revealed round";
    ui("sentiment-bar").style.setProperty(
      "--yes-share",
      share === null ? "0%" : `${share}%`,
    );
    ui("sentiment-bar").dataset.empty = String(share === null);
    ui("sentiment-bar").setAttribute(
      "aria-label",
      share === null
        ? "No settled endorsement share yet"
        : `YES ${share.toFixed(1)}%, NO ${(100 - share).toFixed(1)}%`,
    );
    const open = run?.rounds.find(
      (r) => r.state === "open" && new Date(r.closesAt) > new Date(),
    );
    el("form").hidden = !open || !!open.receipt || run?.state !== "running";
    ui("commit-closed").hidden = !el("form").hidden;
    ui("commit-closed").textContent = open?.receipt
      ? "Your commitment is recorded. Continue watching while the round settles."
      : run?.state === "complete"
        ? "This run has settled. Inspect its results or start another round."
        : run
          ? "The round is processing. Your existing commitment remains recorded."
          : "Choose a round or start a sandbox to participate.";
    countdown();
  }
  function countdown() {
    const node = ui("countdown");
    if (!node.dataset.closes) return;
    if (node.dataset.state !== "open") {
      node.textContent =
        node.dataset.state === "settled"
          ? "Final result revealed"
          : "Awaiting final reveal";
      return;
    }
    const seconds = Math.max(
      0,
      Math.ceil((new Date(node.dataset.closes) - Date.now()) / 1000),
    );
    node.textContent = seconds
      ? `Ends in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
      : "Cutoff reached · processing";
  }
  function updateEstimate() {
    const fields = new FormData(el("form")),
      q = Number(fields.get("quantity")),
      side = fields.get("side");
    ui("order-help").textContent =
      side === "NO"
        ? "A NO contract pays the final NO share. A ceiling of 0.78 corresponds to a YES-scale floor of 0.22."
        : "A YES contract pays the final YES share. Your ceiling sets the highest purchase price you accept.";
    const fee = run?.config.feeBps ?? 0;
    ui("reservation").textContent =
      Number.isInteger(q) && q >= 1 && q <= 100
        ? `${q} contracts · maximum reservation ${money((BigInt(q) * 1000000n * BigInt(10000 + fee)) / 10000n, 2)}`
        : "Choose 1–100 contracts.";
  }
  async function refresh() {
    const data = await api(
      `a4/debates/${root.dataset.a4Inline}/workspace${run ? `?runId=${encodeURIComponent(run.id)}` : ""}`,
    );
    if (data.accountId !== userId) {
      clearPrivate();
      throw new Error("Account changed. Reload before reviewing a commitment.");
    }
    populateRuns(data.runs, run?.id ?? "");
    run = data.run;
    const wallet = data.wallet;
    const balances = wallet.balances,
      available = balances.find((b) => b.kind === "available")?.amount ?? "0",
      reserved = balances.find((b) => b.kind === "reserved")?.amount ?? "0";
    ui("available").textContent = `Your balance ${money(available, 2)}`;
    el("balance").textContent =
      `Reserved ${money(reserved, 2)} · ${run?.mode === "mixed" ? "Private bot sandbox balance" : "Ordinary play balance"}`;
    window.dispatchEvent(
      new CustomEvent("yap:balance", {
        detail: {
          available,
          reserved,
          scope: run?.mode === "mixed" ? "Bot sandbox" : "Ordinary balance",
        },
      }),
    );
    el("bots").hidden =
      wallet.mode === "yap-coins" || wallet.mode === "disabled";
    timeline = data.timeline;
    describeSelection();
    renderRounds();
    chart.render(timeline, selectedRound);
    renderReceipts();
    updateEstimate();
    ui("volume").textContent = money(timeline.totals.premium, 2);
    ui("participants").textContent =
      `${timeline.totals.humanCommitments.toLocaleString()} human commitments${timeline.totals.botCommitments ? ` · ${timeline.totals.botCommitments.toLocaleString()} bot commitments` : ""}`;
    ui("scope").textContent =
      timeline.scope === "sandbox"
        ? "Your private synthetic bot sandboxes · latest 100 settled rounds"
        : "Human-only activity · latest 100 settled rounds";
    ui("sync").textContent = "● Connected · updates after settlement";
    status(
      run
        ? `${run.mode === "mixed" ? run.config.population + " synthetic bots + you" : "Human-only round"} · ${run.state}. ${run.config.feeBps ? "5% premium fee." : "No fee."} ${run.state === "complete" ? "Final results are available." : "Diagnostics stay sealed until final reveal."}`
        : "Choose a round or start a labeled sandbox.",
    );
  }
  async function create(mode) {
    const result = await api("a4/runs", {
      debateId: root.dataset.a4Inline,
      mode,
    });
    selectedRound = null;
    run = { id: result.id };
    await list(result.id);
    await refresh();
  }
  el("human").addEventListener("click", () => act(() => create("human")));
  el("bots").addEventListener("click", () => act(() => create("mixed")));
  el("refill").addEventListener("click", () =>
    act(async () => {
      await api("a4/refill", run ? { runId: run.id } : {});
      await refresh();
    }),
  );
  el("refresh").addEventListener("click", () =>
    act(async () => {
      await list(run?.id);
      await refresh();
    }),
  );
  el("runs").addEventListener("change", () =>
    act(async () => {
      selectedRound = null;
      run = el("runs").value ? { id: el("runs").value } : null;
      await refresh();
    }),
  );
  el("form").addEventListener("input", updateEstimate);
  for (const button of root.querySelectorAll("[data-quantity]"))
    button.addEventListener("click", () => {
      el("form").elements.quantity.value = button.dataset.quantity;
      updateEstimate();
    });
  el("form").addEventListener("submit", (event) => {
    event.preventDefault();
    const round = run?.rounds.find((r) => r.state === "open" && !r.receipt);
    if (!round) return;
    const fields = Object.fromEntries(new FormData(event.target)),
      quantity = Number(fields.quantity);
    pending = {
      roundId: round.id,
      key: crypto.randomUUID(),
      body: {
        accountId: userId,
        side: fields.side,
        ceiling: fields.ceiling,
        quantity,
        rule: run.config.rule,
      },
    };
    const reserve =
      (BigInt(quantity) * 1000000n * BigInt(10000 + run.config.feeBps)) /
      10000n;
    el("terms").textContent =
      `Account ${userId}. ${run.debate.proposition}. ${fields.side}; maximum purchase price ${fields.ceiling} Yap Coins; ${quantity} contracts. Maximum reservation and potential loss ${money(reserve)}, including maximum fee allowance. Actual price is drawn later and execution needs an accepting opposite side. Unused reservation is released. Cutoff ${new Date(round.closesAt).toLocaleString()}; lockup until reveal ${new Date(run.revealAt).toLocaleString()}. No edits or cancellation after commitment.`;
    el("review-status").textContent = "";
    el("review").showModal();
    el("commit").focus();
  });
  el("cancel").addEventListener("click", () => el("review").close());
  el("commit").addEventListener("click", async () => {
    if (!pending || busy) return;
    busy = true;
    el("commit").disabled = true;
    try {
      const auth = await api("auth/me");
      if (auth.user.id !== pending.body.accountId) {
        clearPrivate();
        throw new Error("Account changed. Reload and review again.");
      }
      await api(
        `a4/rounds/${pending.roundId}/submit`,
        pending.body,
        pending.key,
      );
      pending = null;
      el("review").close();
      await refresh();
    } catch (error) {
      el("review-status").textContent =
        `${error.message}. Retry preserves your request key.`;
    } finally {
      busy = false;
      el("commit").disabled = false;
    }
  });
  setInterval(countdown, 1000);
  setInterval(() => {
    if (userId && !busy && !document.hidden && !el("review").open) act(refresh);
  }, 5000);
  window.addEventListener("focus", () => {
    if (userId && !busy && !el("review").open) act(refresh);
  });
  act(async () => {
    userId = (await api("auth/me")).user.id;
    el("access").hidden = false;
    ui("signin").hidden = true;
    await list();
    await refresh();
  });
}
