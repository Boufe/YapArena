/* global document, Option */
const root = document.querySelector("[data-a4-inline]");
if (root) {
  const el = (name) => root.querySelector(`[data-inline-${name}]`);
  const status = (text) => {
    el("status").textContent = text;
  };
  const money = (value = "0") => {
    const n = BigInt(value),
      a = n < 0n ? -n : n;
    return `${n < 0n ? "−" : ""}${a / 1000000n}.${String(a % 1000000n).padStart(6, "0")} Yap Coins`;
  };
  let userId,
    run,
    pending,
    busy = false;
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
      if (response.status === 401) {
        userId = null;
        run = null;
        pending = null;
        el("review").close();
        el("access").hidden = true;
        el("receipt").textContent = "";
      }
      throw new Error(result.error ?? "Unable to load Yap Coins");
    }
    return result;
  }
  async function act(work) {
    if (busy) return;
    busy = true;
    root.setAttribute("aria-busy", "true");
    try {
      await work();
    } catch (error) {
      status(error.message);
    } finally {
      busy = false;
      root.removeAttribute("aria-busy");
    }
  }
  async function list(selected) {
    const data = await api(
      `a4/runs?debateId=${encodeURIComponent(root.dataset.a4Inline)}`,
    );
    const items = data.items.filter((r) => r.mode !== "observer");
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
    if (selected) el("runs").value = selected;
    else if (items[0]) {
      el("runs").value = items[0].id;
      run = { id: items[0].id };
    }
  }
  async function refresh() {
    const auth = await api("auth/me");
    if (auth.user.id !== userId) {
      run = null;
      pending = null;
      el("review").close();
      el("access").hidden = true;
      throw new Error("Account changed. Reload before reviewing a commitment.");
    }
    const wallet = run
      ? await api(`a4/runs/${run.id}?limit=1`)
      : await api("a4/wallet");
    if (run) run = wallet;
    const balances = wallet.balances;
    el("balance").textContent =
      `Available ${money(balances.find((b) => b.kind === "available")?.amount)}; reserved ${money(balances.find((b) => b.kind === "reserved")?.amount)}. ${run?.mode === "mixed" ? "Isolated bot sandbox balance." : "Ordinary play balance."}`;
    el("bots").hidden =
      wallet.mode === "yap-coins" || wallet.mode === "disabled";
    const round = run?.rounds.find(
      (r) => r.state === "open" && new Date(r.closesAt) > new Date(),
    );
    el("form").hidden = !round || !!round.receipt || run?.state !== "running";
    const receipt = run?.rounds.findLast((r) => r.receipt)?.receipt;
    if (run) {
      const active = round ?? run.rounds.at(-1);
      const share = active.diagnostics?.pricing?.share;
      status(
        `${run.mode === "mixed" ? `${run.config.population} SYNTHETIC BOTS + YOU` : "Human-only"} · ${run.state}. Cutoff ${new Date(active.closesAt).toLocaleString()}; reveal ${new Date(run.revealAt).toLocaleString()}. ${share ? `Revealed YES endorsement share ${((100 * Number(share.n)) / Number(share.d)).toFixed(2)}%.` : "Round diagnostics remain sealed."}`,
      );
    }
    el("receipt").textContent = receipt
      ? `Your ${receipt.side} order: ${receipt.status.replaceAll("_", " ")}. Reserved ${money(receipt.reserved)}.${receipt.premium !== undefined ? ` Premium ${money(receipt.premium)}, fee ${money(receipt.fee)}, released ${money(receipt.released)}.` : ""}${receipt.payout !== undefined ? ` Payout ${money(receipt.payout)}, net profit/loss ${money(receipt.net)}.` : ""}`
      : "";
  }
  async function create(mode) {
    const result = await api("a4/runs", {
      debateId: root.dataset.a4Inline,
      mode,
    });
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
      run = el("runs").value ? { id: el("runs").value } : null;
      await refresh();
    }),
  );
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
      (BigInt(quantity) * 1000000n * (10000n + BigInt(run.config.feeBps))) /
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
      if (auth.user.id !== pending.body.accountId)
        throw new Error("Account changed. Reload and review again.");
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
  async function start() {
    try {
      userId = (await api("auth/me")).user.id;
      el("access").hidden = false;
      await list();
      await refresh();
      if (!run)
        status(
          "Choose a round or start a labeled sandbox. You can keep watching and chatting while you participate.",
        );
    } catch (error) {
      status(error.message);
    }
  }
  setInterval(() => {
    if (
      userId &&
      !busy &&
      !document.hidden &&
      !el("review").open &&
      run?.state !== "complete" &&
      run?.state !== "archived"
    )
      act(refresh);
  }, 5000);
  start();
}
