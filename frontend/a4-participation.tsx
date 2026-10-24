// The A4 participation panel as a React island: the debate page's side panel
// that starts rounds, refills play coins, publishes aggregates and reviews a
// commitment. frontend/a4-inline.ts mounts it over the server-rendered shell
// and keeps the account, requests and refresh timing; the island renders what
// that module publishes and reports what the reader does.
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal, flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

export type RoundMode = "human" | "mixed";
export type Side = "YES" | "NO";

export interface RunOption {
  value: string;
  label: string;
}

/** What the panel shows. The page module publishes it after each change. */
export interface ParticipationView {
  /** The first account and workspace read is running; controls are disabled. */
  starting: boolean;
  /** An account is verified: the controls replace the sign-in link. */
  signedIn: boolean;
  status: string;
  /** The status tooltip, present once the page reports its first status. */
  statusTitle: string | undefined;
  title: string;
  available: string;
  /** Runs after the "Choose a round" placeholder. */
  runs: RunOption[];
  run: string;
  /** The run whose selection last set the New round section's open state. */
  setupRun: string | undefined;
  setupOpen: boolean;
  argument: string;
  published: boolean;
  balance: string;
  botsHidden: boolean;
  /** An open round accepts a commitment; otherwise `closed` says why not. */
  formOpen: boolean;
  closed: string;
  feeBps: number;
  review: boolean;
  terms: string;
  reviewStatus: string;
  committing: boolean;
}

export interface CommitmentFields {
  side: Side;
  quantity: string;
  ceiling: string;
}

/** What the reader asks for. The page module serializes the requests. */
export interface ParticipationIntents {
  start(mode: RoundMode): void;
  refill(): void;
  reload(): void;
  chooseRun(id: string): void;
  publish(published: boolean): void;
  draft(argument: string): void;
  setup(open: boolean): void;
  review(fields: CommitmentFields): void;
  cancelReview(): void;
  commit(): void;
}

export interface Participation {
  view(): ParticipationView;
  /** Publishes changed fields; the panel re-renders only when one differs. */
  update(next: Partial<ParticipationView>): void;
}

// The panel before any account read. It matches the server-rendered shell in
// src/features/discovery/debate-web.ts, so mounting causes no visible change.
export const initialView: ParticipationView = {
  starting: true,
  signedIn: false,
  status: "Checking your Yap Coins account…",
  statusTitle: undefined,
  title: "Participate in a round",
  available: "Your balance —",
  runs: [],
  run: "",
  setupRun: undefined,
  setupOpen: true,
  argument: "",
  published: false,
  balance: "",
  botsHidden: false,
  formOpen: false,
  closed: "Choose a round or start a sandbox to participate.",
  feeBps: 0,
  review: false,
  terms: "",
  reviewStatus: "",
  committing: false,
};

/** Formats micro Yap Coins: money(1500000, 2) is "1.50 Yap Coins". */
export function money(value: string | number | bigint = "0", precision = 6) {
  const n = BigInt(value),
    a = n < 0n ? -n : n;
  const fractional = String(a % 1000000n)
    .padStart(6, "0")
    .slice(0, precision);
  return `${n < 0n ? "−" : ""}${a / 1000000n}${precision ? "." + fractional : ""} Yap Coins`;
}

/** The price help and maximum reservation for the form's current values. */
export function estimate(side: Side, quantity: string, feeBps: number) {
  const q = Number(quantity);
  return {
    help:
      side === "NO"
        ? "A NO contract pays the final NO share. A ceiling of 0.78 corresponds to a YES-scale floor of 0.22."
        : "A YES contract pays the final YES share. Your ceiling sets the highest purchase price you accept.",
    reservation:
      Number.isInteger(q) && q >= 1 && q <= 100
        ? `${q} contracts · maximum reservation ${money((BigInt(q) * 1000000n * BigInt(10000 + feeBps)) / 10000n, 2)}`
        : "Choose 1–100 contracts.",
  };
}

interface PanelProps {
  view: ParticipationView;
  intents: ParticipationIntents;
  signIn: string;
  debateId: string;
}

export function Panel({ view, intents, signIn, debateId }: PanelProps) {
  const [side, setSide] = useState<Side>("YES");
  const [quantity, setQuantity] = useState("10");
  const [ceiling, setCeiling] = useState("0.50");
  const { help, reservation } = estimate(side, quantity, view.feeBps);
  const busy = view.starting;
  return (
    <>
      <div className="arena-section-top">
        <h2 id="arena-trade-title" data-arena-trade-title="">
          {view.title}
        </h2>
        <span data-arena-available="">{view.available}</span>
      </div>
      <p
        data-inline-status=""
        className="arena-inline-status"
        role="status"
        aria-live="polite"
        title={view.statusTitle}
      >
        {view.status}
      </p>
      <div data-inline-access="" hidden={!view.signedIn} aria-busy={busy}>
        <label className="arena-publish-choice">
          <input
            type="checkbox"
            data-inline-publish=""
            checked={view.published}
            disabled={busy}
            onChange={(event) => intents.publish(event.currentTarget.checked)}
          />{" "}
          Share my settled Bots + you and Bots-only aggregates publicly
        </label>
        <div className="arena-run-tools">
          <label className="sr-only" htmlFor="arena-runs">
            Select a run
          </label>
          <select
            id="arena-runs"
            data-inline-runs=""
            value={view.run}
            disabled={busy}
            onChange={(event) => intents.chooseRun(event.currentTarget.value)}
          >
            <option value="">Choose a round</option>
            {view.runs.map((run) => (
              <option key={run.value} value={run.value}>
                {run.label}
              </option>
            ))}
          </select>
          <details
            className="arena-round-setup"
            data-inline-setup=""
            data-run-id={view.setupRun}
            open={view.setupOpen}
            onToggle={(event) => intents.setup(event.currentTarget.open)}
          >
            <summary>New round</summary>
            <label>
              Argument label
              <input
                data-inline-argument=""
                maxLength={80}
                placeholder="e.g. Cost analysis"
                autoComplete="off"
                value={view.argument}
                disabled={busy}
                onChange={(event) => intents.draft(event.currentTarget.value)}
              />
            </label>
            <div className="arena-create-buttons">
              <button
                type="button"
                data-inline-bots=""
                hidden={view.botsHidden}
                disabled={busy}
                onClick={() => intents.start("mixed")}
              >
                Start Bots mode · 500 synthetic bots
              </button>
              <button
                type="button"
                data-inline-human=""
                disabled={busy}
                onClick={() => intents.start("human")}
              >
                Open human-only round
              </button>
            </div>
          </details>
          <button
            className="arena-icon-button"
            type="button"
            data-inline-refresh=""
            aria-label="Refresh rounds"
            disabled={busy}
            onClick={() => intents.reload()}
          >
            ↻
          </button>
        </div>
        <p data-inline-balance="" className="arena-balance-note">
          {view.balance}
        </p>
        <form
          data-inline-form=""
          className="arena-commit-form"
          hidden={!view.formOpen}
          onSubmit={(event) => {
            event.preventDefault();
            intents.review({ side, quantity, ceiling });
          }}
        >
          <div className="arena-position-row">
            <fieldset className="arena-side-choices">
              <legend className="sr-only">Your position</legend>
              <label className="arena-side yes">
                <input
                  type="radio"
                  name="side"
                  value="YES"
                  checked={side === "YES"}
                  disabled={busy}
                  onChange={() => setSide("YES")}
                />
                <span>Endorse (YES)</span>
              </label>
              <label className="arena-side no">
                <input
                  type="radio"
                  name="side"
                  value="NO"
                  checked={side === "NO"}
                  disabled={busy}
                  onChange={() => setSide("NO")}
                />
                <span>Reject (NO)</span>
              </label>
            </fieldset>
            <label className="arena-quantity">
              Contracts
              <input
                name="quantity"
                type="number"
                min="1"
                max="100"
                value={quantity}
                required
                disabled={busy}
                onChange={(event) => setQuantity(event.currentTarget.value)}
              />
            </label>
          </div>
          <div
            className="arena-quick-amounts"
            aria-label="Choose contract quantity"
          >
            {[1, 10, 50, 100].map((amount) => (
              <button
                key={amount}
                type="button"
                data-quantity={amount}
                disabled={busy}
                onClick={() => setQuantity(String(amount))}
              >
                {amount}
              </button>
            ))}
          </div>
          <div className="arena-price-row">
            <label>
              Maximum price · Yap Coins
              <input
                name="ceiling"
                inputMode="decimal"
                pattern="(0([.][0-9]{1,6})?|1([.]0{1,6})?)"
                value={ceiling}
                required
                disabled={busy}
                onChange={(event) => setCeiling(event.currentTarget.value)}
              />
            </label>
            <details className="arena-order-explanation">
              <summary>How the price works</summary>
              <p data-arena-order-help="">{help}</p>
            </details>
          </div>
          <p className="arena-reservation" data-arena-reservation="">
            {reservation}
          </p>
          <button type="submit" className="arena-commit-button" disabled={busy}>
            Review commitment
          </button>
        </form>
        <div
          data-arena-commit-closed=""
          className="arena-commit-closed"
          hidden={view.formOpen}
        >
          {view.closed}
        </div>
        <div className="arena-wallet-actions">
          <button
            type="button"
            data-inline-refill=""
            disabled={busy}
            onClick={() => intents.refill()}
          >
            Get daily play coins
          </button>
          <a href={`/coins?debate=${debateId}`} target="_blank" rel="noopener">
            Full controls ↗
          </a>
        </div>
      </div>
      <p data-arena-signin="" hidden={view.signedIn}>
        <a href={signIn}>Log in to participate →</a>
      </p>
      <p className="arena-play-note">
        Play coins · no cash value. Each locked endorsement counts equally.
      </p>
    </>
  );
}

interface ReviewProps {
  view: ParticipationView;
  intents: ParticipationIntents;
}

export function Review({ view, intents }: ReviewProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const commit = useRef<HTMLButtonElement>(null);
  // The dialog is modal, so it opens and closes through its methods rather
  // than the open attribute. Escape closes it natively; onClose reports that.
  useLayoutEffect(() => {
    const node = dialog.current!;
    if (view.review && !node.open) {
      node.showModal();
      commit.current!.focus();
    } else if (!view.review && node.open) node.close();
  }, [view.review]);
  return (
    <dialog
      ref={dialog}
      data-inline-review=""
      className="information-card arena-review"
      aria-labelledby="a4-inline-review-title"
      onClose={() => intents.cancelReview()}
    >
      <span className="eyebrow accent">REVIEW BEFORE COMMITTING</span>
      <h2 id="a4-inline-review-title">Your exact commitment</h2>
      <p data-inline-terms="">{view.terms}</p>
      <p data-inline-review-status="" role="status" aria-live="polite">
        {view.reviewStatus}
      </p>
      <button
        ref={commit}
        type="button"
        data-inline-commit=""
        className="button"
        disabled={view.committing}
        onClick={() => intents.commit()}
      >
        Commit these exact terms
      </button>
      <button
        type="button"
        data-inline-cancel=""
        onClick={() => intents.cancelReview()}
      >
        Back
      </button>
    </dialog>
  );
}

interface Store {
  view(): ParticipationView;
  subscribe(listener: () => void): () => void;
}

function Island({
  store,
  intents,
  signIn,
  debateId,
  workspace,
}: Omit<PanelProps, "view"> & { store: Store; workspace: HTMLElement }) {
  const view = useSyncExternalStore(store.subscribe, store.view);
  return (
    <>
      <Panel
        view={view}
        intents={intents}
        signIn={signIn}
        debateId={debateId}
      />
      {/* The dialog stays a child of the workspace, where its styles apply. */}
      {createPortal(<Review view={view} intents={intents} />, workspace)}
    </>
  );
}

/**
 * Renders the panel into its server-rendered section, replacing the shell,
 * and the review dialog at the end of the workspace. The first render is
 * synchronous, so the controls exist when this returns.
 */
export function mountParticipation(
  section: HTMLElement,
  workspace: HTMLElement,
  intents: ParticipationIntents,
): Participation {
  let view = initialView;
  const listeners = new Set<() => void>();
  const store: Store = {
    view: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  // The shell's sign-in link carries this page's return path.
  const signIn = section
    .querySelector("[data-arena-signin] a")!
    .getAttribute("href")!;
  const root = createRoot(section);
  flushSync(() =>
    root.render(
      <Island
        store={store}
        intents={intents}
        signIn={signIn}
        debateId={workspace.dataset.a4Inline!}
        workspace={workspace}
      />,
    ),
  );
  return {
    view: () => view,
    update(next) {
      const keys = Object.keys(next) as (keyof ParticipationView)[];
      if (keys.every((key) => Object.is(next[key], view[key]))) return;
      view = { ...view, ...next };
      for (const listener of listeners) listener();
    },
  };
}
