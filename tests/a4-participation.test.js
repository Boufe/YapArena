import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderDebateWorkspace } from "../dist/features/discovery/debate-web.js";
import { debate } from "./page-fixtures.js";

// The browser build bundles React into the island. Compile the source with
// React imported from node_modules instead, so these renders and the island
// share one React and React itself stays out of the coverage report.
const compiled = await build({
  entryPoints: [
    new URL("../frontend/a4-participation.tsx", import.meta.url).pathname,
  ],
  bundle: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  plugins: [
    {
      name: "node-modules",
      setup(context) {
        context.onResolve({ filter: /^[^./]/ }, (args) => ({
          path: import.meta.resolve(args.path),
          external: true,
        }));
      },
    },
  ],
});
const { Panel, Review, estimate, initialView, money } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);

const signIn = "/account?next=%2Fdebates%2Fpublic-debate";
const intents = new Proxy({}, { get: () => () => {} });
const panel = (view = {}) =>
  renderToStaticMarkup(
    createElement(Panel, {
      view: { ...initialView, ...view },
      intents,
      signIn,
      debateId: debate.id,
    }),
  );
const review = (view = {}) =>
  renderToStaticMarkup(
    createElement(Review, { view: { ...initialView, ...view }, intents }),
  );
// The server writes empty attributes without a value and void elements
// without a closing slash.
const serverForm = (markup) =>
  markup.replaceAll('=""', "").replaceAll("/>", ">");
const controls = (markup) =>
  markup
    .slice(markup.indexOf("<div data-inline-access"))
    .match(/<(?:button|input|select)\b[^>]*>/g);

describe("A4 participation island", () => {
  it("formats amounts and the maximum reservation", () => {
    assert.equal(money(), "0.000000 Yap Coins");
    assert.equal(money("1500000", 2), "1.50 Yap Coins");
    assert.equal(money(-2250000n), "−2.250000 Yap Coins");
    assert.equal(money(42000000, 0), "42 Yap Coins");
    assert.deepEqual(estimate("YES", "10", 500), {
      help: "A YES contract pays the final YES share. Your ceiling sets the highest purchase price you accept.",
      reservation: "10 contracts · maximum reservation 10.50 Yap Coins",
    });
    assert.equal(
      estimate("NO", "100", 0).help,
      "A NO contract pays the final NO share. A ceiling of 0.78 corresponds to a YES-scale floor of 0.22.",
    );
    assert.equal(
      estimate("NO", "100", 0).reservation,
      "100 contracts · maximum reservation 100.00 Yap Coins",
    );
    for (const quantity of ["", "0", "101", "2.5", "x"])
      assert.equal(
        estimate("YES", quantity, 0).reservation,
        "Choose 1–100 contracts.",
      );
  });

  it("first renders the server shell, so mounting changes nothing visible", () => {
    const page = String(renderDebateWorkspace(debate, true, (name) => name));
    const start = page.indexOf("data-a4-participation>") + 22;
    // The template's trailing line break inside the section renders nothing.
    const shell = page
      .slice(start, page.indexOf("</section>", start))
      .trimEnd();
    const island = serverForm(panel());
    const access = island.indexOf("<div data-inline-access");
    assert.equal(
      island.slice(0, access) +
        island.slice(island.indexOf("<p data-arena-signin>")),
      shell,
    );
    // The dialog now comes from the island, not the server.
    assert.equal(page.includes("data-inline-review"), false);
    assert.equal(
      String(renderDebateWorkspace(debate, false, (name) => name)).includes(
        "data-a4-participation",
      ),
      false,
    );
  });

  it("keeps every control disabled until the first account read settles", () => {
    const starting = panel({ signedIn: true });
    assert.match(starting, /<div data-inline-access="" aria-busy="true">/);
    assert.match(starting, /<p data-arena-signin="" hidden="">/);
    const pending = controls(starting);
    assert.equal(pending.length, 16);
    for (const control of pending) assert.match(control, /disabled=""/);
    const ready = panel({ signedIn: true, starting: false });
    assert.match(ready, /<div data-inline-access="" aria-busy="false">/);
    for (const control of controls(ready))
      assert.doesNotMatch(control, /disabled/);
    assert.match(panel(), /<div data-inline-access="" hidden=""/);
  });

  it("renders the runs, balances and commitment form it is given", () => {
    const markup = panel({
      signedIn: true,
      starting: false,
      status: "Human-only round · running.",
      statusTitle: "Human-only round · running.",
      title: "Participate in Round 4",
      available: "Your balance 98.00 Yap Coins",
      balance: "Reserved 2.00 Yap Coins · Ordinary play balance",
      runs: [
        { value: "run-1", label: "Human-only · Opening · running" },
        { value: "run-0", label: "Selected historical run" },
      ],
      run: "run-1",
      setupRun: "run-1",
      setupOpen: false,
      argument: "Cost <analysis>",
      published: true,
      botsHidden: true,
      formOpen: true,
      feeBps: 500,
    });
    assert.match(
      markup,
      /<h2 id="arena-trade-title" data-arena-trade-title="">Participate in Round 4<\/h2>/,
    );
    assert.match(
      markup,
      /title="Human-only round · running.">Human-only round · running.<\/p>/,
    );
    assert.match(
      markup,
      /<span data-arena-available="">Your balance 98.00 Yap Coins<\/span>/,
    );
    assert.match(
      markup,
      /<option value="">Choose a round<\/option><option value="run-1" selected="">Human-only · Opening · running<\/option><option value="run-0">Selected historical run<\/option>/,
    );
    assert.match(
      markup,
      /<details class="arena-round-setup" data-inline-setup="" data-run-id="run-1">/,
    );
    assert.match(markup, /value="Cost &lt;analysis&gt;"/);
    assert.match(
      markup,
      /<input type="checkbox" data-inline-publish="" checked=""/,
    );
    assert.match(markup, /<button type="button" data-inline-bots="" hidden=""/);
    assert.match(
      markup,
      /<form data-inline-form="" class="arena-commit-form">/,
    );
    assert.match(
      markup,
      /data-arena-reservation="">10 contracts · maximum reservation 10.50 Yap Coins/,
    );
    assert.match(
      markup,
      /<div data-arena-commit-closed="" class="arena-commit-closed" hidden="">/,
    );
    assert.match(
      markup,
      /href="\/coins\?debate=33333333-3333-4333-8333-333333333333"/,
    );
  });

  it("explains why a round does not accept a commitment", () => {
    const markup = panel({
      signedIn: true,
      starting: false,
      formOpen: false,
      closed:
        "This run has settled. Inspect its results or start another round.",
    });
    assert.match(
      markup,
      /<form data-inline-form="" class="arena-commit-form" hidden="">/,
    );
    assert.match(
      markup,
      /<div data-arena-commit-closed="" class="arena-commit-closed">This run has settled/,
    );
    assert.match(
      markup,
      /<details class="arena-round-setup" data-inline-setup="" open="">/,
    );
  });

  it("shows the exact terms and the commit state in the review dialog", () => {
    const terms = "Account a. Proposition. YES; maximum purchase price 0.5.";
    const idle = review({
      terms,
      reviewStatus: "Network failed. Retry preserves your request key.",
    });
    assert.match(
      idle,
      /^<dialog data-inline-review="" class="information-card arena-review" aria-labelledby="a4-inline-review-title">/,
    );
    assert.match(idle, new RegExp(`<p data-inline-terms="">${terms}</p>`));
    assert.match(idle, /role="status" aria-live="polite">Network failed/);
    assert.match(
      idle,
      /<button type="button" data-inline-commit="" class="button">/,
    );
    assert.match(
      review({ committing: true }),
      /<button type="button" data-inline-commit="" class="button" disabled="">/,
    );
  });
});
