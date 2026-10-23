import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePrivy } from "@privy-io/react-auth";
import type {} from "./auth-events.js";

type Projection = {
  accountId: string;
  subject: string | null;
  state:
    | "pending"
    | "provisioning"
    | "ready"
    | "retry_wait"
    | "review_required"
    | "unavailable";
  chain: "ethereum";
  address: string | null;
  canRetry: boolean;
  retryAt: string | null;
};
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function projection(value: unknown): Projection {
  if (
    !object(value) ||
    typeof value.accountId !== "string" ||
    !value.accountId ||
    !(value.subject === null || typeof value.subject === "string") ||
    ![
      "pending",
      "provisioning",
      "ready",
      "retry_wait",
      "review_required",
      "unavailable",
    ].includes(String(value.state)) ||
    value.chain !== "ethereum" ||
    typeof value.canRetry !== "boolean" ||
    !(
      value.retryAt === null ||
      (typeof value.retryAt === "string" &&
        Number.isFinite(Date.parse(value.retryAt)))
    ) ||
    !(
      value.address === null ||
      (typeof value.address === "string" &&
        /^0x[0-9a-fA-F]{40}$/.test(value.address))
    ) ||
    (value.state === "ready" && (!value.address || !value.subject)) ||
    (value.state !== "ready" && value.address !== null)
  )
    throw new Error("Wallet status unavailable");
  return {
    accountId: value.accountId,
    subject: value.subject,
    state: value.state as Projection["state"],
    chain: "ethereum",
    address: value.address,
    canRetry: value.canRetry,
    retryAt: value.retryAt,
  };
}

// Creation is a durable server job queued with the verified account mapping.
// This component reads owned status and requests a bounded server-side retry;
// navigation, SDK readiness and this component's lifetime do not create wallets.
export function EmbeddedWallet() {
  const { ready, authenticated, user } = usePrivy();
  const [wallet, setWallet] = useState<Projection | null>(null);
  const [message, setMessage] = useState("Checking your wallet…");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [version, setVersion] = useState(0);
  const actor = useRef<AbortController | null>(null);
  const live = useRef({ ready, authenticated, subject: user?.id ?? null });
  live.current = { ready, authenticated, subject: user?.id ?? null };
  useEffect(() => {
    const fallback = document.querySelector<HTMLElement>(
      "#embedded-wallet-fallback",
    );
    if (!fallback) return;
    const wasHidden = fallback.hidden;
    fallback.hidden = true;
    return () => {
      fallback.hidden = wasHidden;
    };
  }, []);
  function sameOwner(value: Projection) {
    const accountId = window.yapCurrentSessionAccount?.() ?? null;
    return (
      live.current.ready &&
      (accountId === null || accountId === value.accountId) &&
      (!live.current.authenticated || live.current.subject === value.subject)
    );
  }
  useEffect(() => {
    const cancel = () => {
      actor.current?.abort();
      actor.current = null;
      setWallet(null);
      setBusy(false);
      setMessage("Checking your wallet…");
      setVersion((current) => current + 1);
    };
    const channel =
      "BroadcastChannel" in window
        ? new BroadcastChannel("yaparena-account")
        : null;
    if (channel) channel.onmessage = cancel;
    window.addEventListener("yap:account-changed", cancel);
    window.addEventListener("yap:wallet-status-refresh", cancel);
    window.addEventListener("yap:provider-logout", cancel);
    return () => {
      actor.current?.abort();
      window.removeEventListener("yap:account-changed", cancel);
      window.removeEventListener("yap:wallet-status-refresh", cancel);
      window.removeEventListener("yap:provider-logout", cancel);
      channel?.close();
    };
  }, []);
  useEffect(() => {
    actor.current?.abort();
    setWallet(null);
    setBusy(false);
    setMessage("Checking your wallet…");
    if (!ready) return;
    const current = new AbortController();
    actor.current = current;
    let timer: number | undefined;
    let polls = 0;
    let failures = 0;
    const deadline = Date.now() + 60000;
    const expectedAccount = window.yapCurrentSessionAccount?.() ?? null;
    function schedule(delay: number) {
      if (polls < 15 && Date.now() + delay < deadline)
        timer = window.setTimeout(() => void refresh(), delay);
    }
    async function refresh() {
      if (current.signal.aborted || polls >= 15 || Date.now() >= deadline)
        return;
      polls++;
      let transient = true;
      try {
        const response = await fetch("/api/auth/embedded-wallet", {
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.any([
            current.signal,
            AbortSignal.timeout(
              Math.max(1, Math.min(10000, deadline - Date.now())),
            ),
          ]),
        });
        transient = response.status >= 500;
        if (!response.ok) throw new Error("Wallet status unavailable");
        const value = projection(await response.json());
        if (
          current.signal.aborted ||
          actor.current !== current ||
          !sameOwner(value) ||
          (expectedAccount !== null && expectedAccount !== value.accountId)
        )
          return;
        setWallet(value);
        setMessage("");
        failures = 0;
        if (value.state === "pending" || value.state === "provisioning")
          schedule(2000);
        else if (value.state === "retry_wait" && value.retryAt !== null)
          schedule(Math.max(2000, Date.parse(value.retryAt) - Date.now()));
      } catch {
        if (!current.signal.aborted && actor.current === current) {
          setWallet(null);
          setMessage(
            "Wallet status is temporarily unavailable. Your account is still available.",
          );
          if (transient && ++failures < 3) schedule(failures * 2000);
        }
      }
    }
    void refresh();
    return () => {
      current.abort();
      clearTimeout(timer);
      if (actor.current === current) actor.current = null;
    };
  }, [ready, authenticated, user?.id, version]);

  async function retry(value: Projection) {
    if (busy || !value.canRetry || !sameOwner(value)) return;
    actor.current?.abort();
    const current = new AbortController();
    actor.current = current;
    setBusy(true);
    try {
      const response = await fetch("/api/auth/embedded-wallet", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-YapArena-Expected-Account": value.accountId,
        },
        body: "{}",
        signal: AbortSignal.any([current.signal, AbortSignal.timeout(10000)]),
      });
      if (!response.ok) throw new Error("Retry unavailable");
      const next = projection(await response.json());
      if (
        actor.current !== current ||
        current.signal.aborted ||
        next.accountId !== value.accountId ||
        next.subject !== value.subject ||
        !sameOwner(next)
      )
        return;
      setWallet(next);
      setVersion((previous) => previous + 1);
    } catch {
      if (
        actor.current === current &&
        !current.signal.aborted &&
        sameOwner(value)
      )
        setMessage(
          "Wallet setup could not be retried. Check its status before trying again.",
        );
    } finally {
      if (actor.current === current) setBusy(false);
    }
  }
  const visible = wallet && sameOwner(wallet) ? wallet : null;
  const status =
    visible?.state === "ready"
      ? "Your wallet is ready."
      : visible?.state === "pending" || visible?.state === "provisioning"
        ? "Setting up your wallet. You can keep using your account."
        : visible?.state === "review_required"
          ? "Wallet access needs an ownership review. Your existing wallet will not be replaced automatically."
          : visible?.state === "retry_wait"
            ? "Wallet setup is waiting to be confirmed. Your account is still available."
            : visible?.state === "unavailable"
              ? "Wallet setup is temporarily unavailable. Your account is still available."
              : message;
  const tone =
    visible?.state === "ready"
      ? "ready"
      : visible?.state === "pending" || visible?.state === "provisioning"
        ? "working"
        : visible?.state === "review_required" ||
            visible?.state === "retry_wait"
          ? "attention"
          : visible?.state === "unavailable" ||
              (!visible && message !== "Checking your wallet…")
            ? "unavailable"
            : "checking";
  const title = {
    ready: "Wallet ready",
    working: "Creating your wallet",
    attention:
      visible?.state === "review_required"
        ? "Needs review"
        : "Waiting to finish",
    unavailable: "Temporarily unavailable",
    checking: "Checking wallet",
  }[tone];
  async function copyAddress(address: string) {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  const mount = document.querySelector<HTMLElement>("#embedded-wallet");
  return mount
    ? createPortal(
        <>
          <div className="wallet-status" data-state={tone}>
            <span className="wallet-status-indicator" aria-hidden="true" />
            <div>
              <strong className="wallet-status-title">{title}</strong>
              <p role="status" aria-live="polite" aria-atomic="true">
                {message && visible ? `${status} ${message}` : status}
              </p>
            </div>
          </div>
          {tone === "working" && (
            <div className="wallet-progress" aria-hidden="true">
              <span />
            </div>
          )}
          {visible?.state === "ready" && visible.address && (
            <div className="wallet-address">
              <div>
                <span className="wallet-address-label">
                  Ethereum-compatible address
                </span>
                <code title={visible.address}>
                  {`${visible.address.slice(0, 6)}…${visible.address.slice(-4)}`}
                </code>
                <span className="sr-only">{visible.address}</span>
              </div>
              <button
                type="button"
                className="button-secondary"
                onClick={() => void copyAddress(visible.address!)}
              >
                {copied ? "Copied" : "Copy address"}
              </button>
            </div>
          )}
          {visible?.retryAt && (
            <p className="form-note">
              Wallet setup can retry after{" "}
              {new Date(visible.retryAt).toLocaleString()}.
            </p>
          )}
          <div className="wallet-actions">
            {visible?.canRetry && (
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => void retry(visible)}
              >
                Retry wallet setup
              </button>
            )}
            <button
              type="button"
              className="button-secondary"
              disabled={busy || !ready}
              onClick={() => setVersion((current) => current + 1)}
            >
              Check wallet status
            </button>
          </div>
          <p className="form-note">
            Crypto deposits and withdrawals are not available yet. Do not send
            funds to this address.
          </p>
        </>,
        mount,
      )
    : null;
}
