import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Captcha,
  PrivyProvider,
  usePrivy,
  useLoginWithEmail,
  useLoginWithOAuth,
  useLoginWithPasskey,
  useLinkAccount,
  useLinkWithPasskey,
  useLinkEmail,
  useUpdateEmail,
  useUnlinkEmail,
  useUnlinkOAuth,
  useUnlinkPasskey,
} from "@privy-io/react-auth";
import {
  startAuthentication,
  WebAuthnAbortService,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import {
  safeAuthReturn,
  completeAuthReturn,
  rememberAuthReturn,
  clearAuthReturn,
} from "./auth-return.js";
import type {
  AuthMode,
  ProviderChange,
  ProviderPasskeyTerms,
  SecurityApproval,
} from "./auth-events.js";

type Config = {
  enabled: boolean;
  appId?: string;
  clientId?: string;
  google?: boolean;
  passkeys?: boolean;
};
const root = document.querySelector<HTMLElement>("#email-auth");
for (const link of document.querySelectorAll<HTMLAnchorElement>(
  "[data-auth-return]",
))
  link.href =
    safeAuthReturn(
      new URLSearchParams(location.search).get("next"),
      location.origin,
    ) ?? "/debates";
const channel =
  "BroadcastChannel" in window
    ? new BroadcastChannel("yaparena-account")
    : null;
function measure(event: string, seconds?: number) {
  void fetch("/api/auth/journey", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, seconds }),
  }).catch(() => {});
}

function announceSession() {
  window.dispatchEvent(new Event("yap:account-changed"));
  channel?.postMessage("changed");
}
class SecurityRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}
async function securityRequest(
  path: string,
  body: unknown,
  token?: string,
  signal?: AbortSignal,
): Promise<Response> {
  if (!window.yapSessionFetch)
    throw new Error(
      "Secure account controls are unavailable. Reload and try again.",
    );
  const response = await window.yapSessionFetch(`/api/auth/security/${path}`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    const value: { error?: string; code?: string } = await response
      .json()
      .catch(() => ({}));
    throw new SecurityRequestError(
      value.error ?? "Security verification is unavailable. Try again.",
      response.status,
      value.code,
    );
  }
  return response;
}
async function securityJSON<T>(
  path: string,
  body: unknown,
  token?: string,
  signal?: AbortSignal,
): Promise<T> {
  return (await securityRequest(path, body, token, signal)).json();
}
function rememberLink(value: boolean) {
  try {
    if (value) sessionStorage.setItem("yaparena-provider-link", "1");
    else sessionStorage.removeItem("yaparena-provider-link");
  } catch {
    /* Intent only, never authentication evidence. */
  }
}
function hasLinkIntent() {
  try {
    return sessionStorage.getItem("yaparena-provider-link") === "1";
  } catch {
    return false;
  }
}

class RecoveryStateError extends Error {}
const recoveryStorageKey = "yaparena-provider-recovery";
type RecoveryIntent = {
  id: string;
  accountId: string;
  expiresAt: number;
  status: "pending" | "cancelled";
};
function recoveryIntent(): RecoveryIntent | "blocked" | null {
  try {
    const raw = localStorage.getItem(recoveryStorageKey);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== "object" ||
      !("id" in value) ||
      typeof value.id !== "string" ||
      !("accountId" in value) ||
      typeof value.accountId !== "string" ||
      !("expiresAt" in value) ||
      typeof value.expiresAt !== "number" ||
      !("status" in value) ||
      (value.status !== "pending" && value.status !== "cancelled")
    )
      return "blocked";
    return {
      id: value.id,
      accountId: value.accountId,
      expiresAt: value.expiresAt,
      status: value.status,
    };
  } catch {
    return "blocked";
  }
}
function requireRecoveryStorage() {
  const key = `${recoveryStorageKey}-probe-${crypto.randomUUID()}`;
  try {
    localStorage.setItem(key, "1");
    if (localStorage.getItem(key) !== "1")
      throw new Error("storage write was not retained");
    localStorage.removeItem(key);
  } catch {
    throw new RecoveryStateError(
      "Browser storage is required to safely finish sign-in. Allow storage, then restart sign-in. Sign-in is paused and no new YapArena account was created.",
    );
  }
}
function storeRecoveryIntent(value: RecoveryIntent) {
  try {
    const raw = JSON.stringify(value);
    localStorage.setItem(recoveryStorageKey, raw);
    if (localStorage.getItem(recoveryStorageKey) !== raw)
      throw new Error("storage write was not retained");
  } catch {
    throw new RecoveryStateError(
      "Browser storage is required to safely recover sign-in. Allow storage, then try again. No account was changed.",
    );
  }
}
function authReturn() {
  return (
    root?.dataset.authReturn ?? new URLSearchParams(location.search).get("next")
  );
}

function Auth({ google, passkeys }: { google: boolean; passkeys: boolean }) {
  const [intent, setIntent] = useState<AuthMode | null>(
    root?.dataset.authMode === "signup"
      ? "signup"
      : root?.dataset.authMode === "login"
        ? "login"
        : null,
  );
  const { ready, authenticated, getAccessToken, logout } = usePrivy();
  const [reconciliationToken, setReconciliationToken] = useState<string | null>(
    null,
  );
  const linkIntent = useRef(hasLinkIntent());
  const failedRecoveryStart = useRef(false);
  const [recovering, setRecovering] = useState(Boolean(recoveryIntent()));
  const [recoveryCancelled, setRecoveryCancelled] = useState(() => {
    const value = recoveryIntent();
    return (
      value !== null && value !== "blocked" && value.status === "cancelled"
    );
  });
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [message, setMessage] = useState("Preparing secure sign-in…");
  const [requestBusy, setBusy] = useState(false);
  const [exchanging, setExchanging] = useState(false);
  const busy = requestBusy || exchanging;
  const journeyStart = useRef<number | null>(null);
  const replacementStart = useRef<number | null>(null);
  function replacementOutcome(event: string) {
    measure(
      event,
      Math.min(
        600,
        Math.max(
          0,
          (performance.now() -
            (replacementStart.current ?? performance.now())) /
            1000,
        ),
      ),
    );
  }
  const [resendAt, setResendAt] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const pending = useRef(false);
  const codeInput = useRef<HTMLInputElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  const { sendCode, loginWithCode } = useLoginWithEmail({
    onComplete: () => {
      if (!cancelled.current) void complete();
    },
  });
  const { initOAuth } = useLoginWithOAuth({
    onComplete: () => {
      if (!cancelled.current) void complete();
    },
  });
  const { loginWithPasskey } = useLoginWithPasskey({
    onComplete: () => {
      if (!cancelled.current) void complete();
    },
  });
  useEffect(() => {
    if (ready)
      setMessage(
        "One account for the ideas you follow. No password to remember.",
      );
  }, [ready]);
  useEffect(() => {
    if (step === "code") codeInput.current?.focus();
  }, [step]);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const end = () => {
      setReconciliationToken(null);
      WebAuthnAbortService.cancelCeremony();
      void logout().catch(() => {});
    };
    window.addEventListener("yap:provider-logout", end);
    return () => window.removeEventListener("yap:provider-logout", end);
  }, [logout]);
  useEffect(() => {
    const link = () => {
      linkIntent.current = true;
      rememberLink(true);
      setMessage("Verify the sign-in method to link to your existing account.");
    };
    const recover = () => {
      failedRecoveryStart.current = true;
      setRecovering(true);
      setRecoveryCancelled(false);
      // Show an actionable notice even when the storage preflight fails.
      window.dispatchEvent(
        new CustomEvent("yap:request-auth", { detail: { mode: "login" } }),
      );
      try {
        const accountId = window.yapCurrentSessionAccount?.();
        if (!accountId)
          throw new Error(
            "Use your retained YapArena security passkey to sign in first, then reopen account settings.",
          );
        storeRecoveryIntent({
          id: crypto.randomUUID(),
          accountId,
          expiresAt: Date.now() + 30 * 60_000,
          status: "pending",
        });
        failedRecoveryStart.current = false;
        linkIntent.current = false;
        rememberLink(false);
        replacementStart.current = performance.now();
        measure("recovery_started");
        setRecovering(true);
        setRecoveryCancelled(false);
        setCode("");
        setEmail("");
        setStep("email");
        setMessage(
          "Verify a new email with Privy, then approve permanently replacing the lost sign-in with your retained YapArena security passkey.",
        );
      } catch (error) {
        setMessage(
          error instanceof Error
            ? error.message
            : "Recovery could not start. Allow browser storage and retry.",
        );
      }
    };
    const storage = (event: StorageEvent) => {
      if (event.key === recoveryStorageKey) {
        const value = recoveryIntent();
        setRecovering(Boolean(value));
        setRecoveryCancelled(
          value !== null && value !== "blocked" && value.status === "cancelled",
        );
      }
    };
    const mode = (event: CustomEvent<AuthMode | null>) =>
      setIntent(event.detail);
    const dismiss = () => {
      linkIntent.current = false;
      rememberLink(false);
      cancelled.current = true;
      if (journeyStart.current !== null) measure("cancelled");
      journeyStart.current = null;
      setCode("");
      setEmail("");
      setStep("email");
      setMessage(
        "One account for the ideas you follow. No password to remember.",
      );
    };
    window.addEventListener("yap:recover-provider", recover);
    window.addEventListener("storage", storage);
    window.addEventListener("yap:auth-mode", mode);
    window.addEventListener("yap:link-provider", link);
    window.addEventListener("yap:auth-dismissed", dismiss);
    return () => {
      window.removeEventListener("yap:recover-provider", recover);
      window.removeEventListener("storage", storage);
      window.removeEventListener("yap:auth-mode", mode);
      window.removeEventListener("yap:link-provider", link);
      window.removeEventListener("yap:auth-dismissed", dismiss);
    };
  }, []);
  useEffect(() => {
    if (ready && intent && root?.closest<HTMLDialogElement>("dialog")?.open)
      emailInput.current?.focus();
  }, [ready, intent]);

  async function run(
    action: () => Promise<void>,
    failure: string,
    detail = false,
  ) {
    if (pending.current || completing.current) return;
    if (journeyStart.current === null) {
      journeyStart.current = performance.now();
      measure("started");
    }
    pending.current = true;
    setBusy(true);
    cancelled.current = false;
    try {
      await action();
    } catch (error) {
      measure("provider_error");
      if (failedRecoveryStart.current || recoveryIntent())
        replacementOutcome("recovery_failed");
      setMessage(
        navigator.onLine
          ? (detail || error instanceof RecoveryStateError) &&
            error instanceof Error
            ? error.message
            : failure
          : "You’re offline. Reconnect, then try again.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  function finishJourney() {
    if (journeyStart.current === null) return;
    measure(
      "completed",
      Math.min(600, (performance.now() - journeyStart.current) / 1000),
    );
    journeyStart.current = null;
  }
  const completing = useRef(false);
  async function complete() {
    if (completing.current || cancelled.current) return;
    completing.current = true;
    setExchanging(true);
    setMessage("Verified. Opening your YapArena account…");
    try {
      requireRecoveryStorage();
      if (failedRecoveryStart.current)
        throw new RecoveryStateError(
          "Recovery could not be started safely. Allow browser storage, then retry recovery from account settings or cancel it successfully. No new YapArena account was created.",
        );
      const current = await fetch("/api/auth/me", {
        credentials: "same-origin",
        cache: "no-store",
      });
      const recovery = recoveryIntent();
      if (recovery) {
        if (recovery === "blocked")
          throw new RecoveryStateError(
            "Browser storage could not be checked safely. Allow storage and restart sign-in. No new YapArena account was created.",
          );
        if (recovery.status !== "pending" || recovery.expiresAt <= Date.now())
          throw new Error(
            "Recovery is paused or expired. Cancel recovery before starting an ordinary sign-in, or restart recovery in account settings.",
          );
        if (!current.ok)
          throw new Error(
            "Use your retained YapArena security passkey to restore app access, then retry this recovery. The new email will not create another YapArena account.",
          );
        const account: { user?: { id?: string } } = await current.json();
        if (account.user?.id !== recovery.accountId)
          throw new Error(
            "The active account changed. Cancel and restart recovery from the correct account settings.",
          );
        if (!window.yapRecoverProviderIdentity)
          throw new Error("Open account settings and retry recovery.");
        const token = await getAccessToken();
        if (!token || cancelled.current) return;
        await window.yapRecoverProviderIdentity(token);
        replacementOutcome("recovery_completed");
        replacementStart.current = null;
        // Clear only our completed intent. A newer tab's recovery must remain fenced.
        const latest = recoveryIntent();
        if (latest && latest !== "blocked" && latest.id === recovery.id)
          localStorage.removeItem(recoveryStorageKey);
        setRecovering(Boolean(recoveryIntent()));
        finishJourney();
        announceSession();
        if (!completeAuthReturn(authReturn()))
          setMessage(
            "Sign-in replaced. Your account and balances are preserved; the old sign-in is permanently retired.",
          );
        return;
      }
      if (linkIntent.current || hasLinkIntent()) {
        if (!current.ok)
          throw new Error(
            "Sign in to your existing account before linking another sign-in method.",
          );
        if (!window.yapLinkProviderIdentity)
          throw new Error("Open account settings and retry linking.");
        const token = await getAccessToken();
        if (!token || cancelled.current) return;
        await window.yapLinkProviderIdentity(token);
        finishJourney();
        linkIntent.current = false;
        rememberLink(false);
        announceSession();
        window.dispatchEvent(new Event("yap:auth-complete"));
        setMessage("Sign-in linked to your existing account.");
        return;
      }
      if (current.status !== 200) {
        if (cancelled.current) return;
        const token = await getAccessToken();
        if (cancelled.current) return;
        if (!token) throw new Error("no provider token");
        if (!window.yapSessionFetch)
          throw new Error(
            "Secure sign-in is unavailable. Reload and try again.",
          );
        const response = await window.yapSessionFetch(
          "/api/auth/privy/exchange",
          {
            method: "POST",
            credentials: "same-origin",
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        if (!response.ok) {
          // Concurrent tabs may have completed the single-use exchange. Trust
          // the server cookie only, never provider state as application access.
          const check = await fetch("/api/auth/me", {
            cache: "no-store",
            credentials: "same-origin",
          });
          if (!check.ok) {
            const failure: unknown = await response.json().catch(() => null);
            const code =
              failure &&
              typeof failure === "object" &&
              "code" in failure &&
              typeof failure.code === "string"
                ? failure.code
                : null;
            if (code === "provider_credentials_changed") {
              setReconciliationToken(token);
              return;
            }
            setMessage(
              code === "provider_reset_pending"
                ? "Your previous sign-out is still being completed. Wait a moment, then start a new sign-in."
                : code === "provider_reset_review_required"
                  ? "Your previous sign-out could not be confirmed with the sign-in provider. Account access needs a security review before you can sign in again. You do not need to add or replace a passkey to resolve this."
                  : code === "provider_identity_retired"
                    ? "This sign-in was replaced and no longer opens the earlier YapArena account. Use the replacement sign-in."
                    : code === "provider_access_review_required" ||
                        response.status === 403
                      ? "Account access needs a security review before signing in again. No sign-in method has been accepted or replaced."
                      : code === "provider_session_revoked"
                        ? "This sign-in session has ended. Start a new sign-in."
                        : response.status === 503
                          ? "Sign-in is temporarily unavailable. Try again shortly."
                          : "This sign-in could not be completed. Start a new sign-in.",
            );
            return;
          }
        }
      }
      announceSession();
      if (cancelled.current) return;
      finishJourney();
      if (!completeAuthReturn(authReturn()))
        setMessage("You’re signed in. Your profile is optional.");
    } catch (error) {
      if (failedRecoveryStart.current || recoveryIntent())
        replacementOutcome("recovery_failed");
      setMessage(
        error instanceof Error
          ? error.message
          : "Connection interrupted. Retry to check whether sign-in completed.",
      );
    } finally {
      completing.current = false;
      setExchanging(false);
    }
  }
  async function send() {
    await run(async () => {
      requireRecoveryStorage();
      if (failedRecoveryStart.current)
        throw new RecoveryStateError(
          "Recovery could not be started safely. Allow browser storage, then retry recovery from account settings or cancel it successfully before requesting a code. No code was sent.",
        );
      const recovery = recoveryIntent();
      if (recovery === "blocked")
        throw new RecoveryStateError(
          "Browser storage could not be checked safely. Allow storage and restart sign-in before requesting a code. No code was sent and no YapArena account was created.",
        );
      if (
        recovery &&
        recovery.status === "pending" &&
        recovery.expiresAt <= Date.now()
      )
        throw new RecoveryStateError(
          "Recovery expired or its browser state is unavailable. Cancel recovery first, or restart it from the correct account settings. No new account was created.",
        );
      if (authenticated || recovery) await logout();
      if (recovery?.status === "cancelled") {
        localStorage.removeItem(recoveryStorageKey);
        setRecovering(false);
        setRecoveryCancelled(false);
      }
      await sendCode({ email: email.trim() });
      if (cancelled.current) return;
      measure(step === "code" ? "code_resent" : "code_sent");
      setCode("");
      setStep("code");
      setResendAt(Date.now() + 30_000);
      setMessage(
        "Check your inbox and spam folder. Enter the newest code from Privy.",
      );
    }, "We couldn’t send a code. Check your email address and try again shortly.");
  }
  const seconds = Math.max(0, Math.ceil((resendAt - clock) / 1_000));
  return (
    <div className="auth-card" data-step={step} aria-busy={!ready || busy}>
      <div className="auth-card-top">
        <span className="auth-emblem" aria-hidden="true">
          <svg
            viewBox="0 0 40 40"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          >
            <ellipse
              cx="20"
              cy="20"
              rx="12"
              ry="15"
              transform="rotate(30 20 20)"
            />
            <path d="m10 33 20-26" />
          </svg>
        </span>
        <span className="auth-step">
          STEP {step === "email" ? "01" : "02"}
          <span> / 02</span>
        </span>
      </div>
      <div className="auth-step-track" aria-hidden="true">
        <span />
        <span />
      </div>
      <span className="eyebrow accent">WELCOME TO YAPARENA</span>
      <h2>
        {recoveryCancelled
          ? "Recovery cancelled."
          : recovering
            ? "Recover your sign-in."
            : step === "email"
              ? intent === "login"
                ? "Welcome back."
                : intent === "signup"
                  ? "Join YapArena."
                  : "Make yourself heard."
              : "Check your inbox."}
      </h2>
      <p className="auth-description">
        {step === "email" ? (
          recovering ? (
            "Verify a new email, then approve with your retained YapArena security passkey. Your account stays with you."
          ) : (
            "Your email is all you need to get started."
          )
        ) : (
          <>
            We sent a verification code to <strong>{email}</strong>.
          </>
        )}
      </p>
      <p
        className="auth-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {message}
      </p>
      {step === "email" ? (
        <form
          className="stack-form"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <label htmlFor="auth-email">Email address</label>
          <input
            ref={emailInput}
            id="auth-email"
            name="email"
            type="email"
            placeholder="you@example.com"
            autoComplete="email"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={254}
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={busy}
          />
          <button className="button" disabled={!ready || busy} type="submit">
            {busy
              ? "Sending code…"
              : recoveryCancelled
                ? "Start ordinary email sign-in →"
                : "Continue with email →"}
          </button>
        </form>
      ) : (
        <form
          className="stack-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await loginWithCode({ code });
            }, "That code is incorrect, expired or already used. Try the newest code, or request another.");
          }}
        >
          <label htmlFor="auth-code">Verification code</label>
          <input
            ref={codeInput}
            id="auth-code"
            name="code"
            type="text"
            placeholder="000000"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            value={code}
            onChange={(event) =>
              setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
            }
            disabled={busy}
            aria-describedby="auth-code-help"
          />
          <p id="auth-code-help" className="form-note">
            Paste the full six-digit code. Keep it private.
          </p>
          <button className="button" disabled={!ready || busy} type="submit">
            {busy ? "Verifying…" : "Verify and continue →"}
          </button>
          <div className="auth-actions">
            <button
              className="button-secondary"
              type="button"
              disabled={busy || seconds > 0}
              onClick={() => void send()}
            >
              {seconds > 0 ? `Resend in ${seconds}s` : "Resend code"}
            </button>
            <button
              className="button-secondary"
              type="button"
              disabled={busy}
              onClick={() => {
                cancelled.current = true;
                measure("cancelled");
                journeyStart.current = null;
                setCode("");
                setStep("email");
                setMessage("Enter your email to start again.");
                window.setTimeout(() => emailInput.current?.focus(), 0);
              }}
            >
              Change email
            </button>
          </div>
        </form>
      )}
      {!recovering && (google || passkeys) && (
        <div className="auth-divider">
          <span>or</span>
        </div>
      )}
      <div className="auth-alternatives">
        {google && !recovering && (
          <button
            className="button-secondary"
            type="button"
            disabled={!ready || busy}
            onClick={() =>
              void run(async () => {
                if (authenticated) await logout();
                if (root?.dataset.authSurface === "modal") {
                  rememberAuthReturn(root.dataset.authReturn ?? null);
                }
                try {
                  await initOAuth({ provider: "google" });
                } catch (error) {
                  clearAuthReturn();
                  throw error;
                }
              }, "Google sign-in was cancelled or unavailable. You can try email instead.")
            }
          >
            <span className="auth-provider-mark" aria-hidden="true">
              G
            </span>
            Continue with Google
          </button>
        )}
        {passkeys && !recovering && (
          <button
            className="button-secondary"
            type="button"
            disabled={!ready || busy}
            onClick={() =>
              void run(async () => {
                if (authenticated) await logout();
                await loginWithPasskey();
              }, "Passkey sign-in was cancelled or no matching passkey was found. Try email.")
            }
          >
            <svg
              className="auth-provider-icon"
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
            >
              <circle cx="8" cy="9" r="4" />
              <path d="m11 12 8 8m-4-4 3-3m-1 5 3-3" />
            </svg>
            Use a passkey
          </button>
        )}
      </div>
      {authenticated && (
        <button
          type="button"
          className="button-secondary"
          disabled={busy}
          onClick={() => void run(complete, "Unable to finish sign-in.")}
        >
          Retry account sign-in
        </button>
      )}
      {recovering && (
        <button
          type="button"
          className="button-secondary"
          disabled={busy}
          onClick={() => {
            cancelled.current = true;
            void run(
              async () => {
                cancelled.current = true;
                await logout();
                const active = recoveryIntent();
                if (active && active !== "blocked")
                  storeRecoveryIntent({ ...active, status: "cancelled" });
                else
                  storeRecoveryIntent({
                    id: crypto.randomUUID(),
                    accountId: "",
                    expiresAt: Date.now(),
                    status: "cancelled",
                  });
                failedRecoveryStart.current = false;
                setRecoveryCancelled(true);
                replacementOutcome("recovery_cancelled");
                replacementStart.current = null;
                setCode("");
                setEmail("");
                setStep("email");
                setMessage(
                  "Recovery cancelled. Continue with email to deliberately start a new ordinary sign-in. Your existing YapArena account was not changed.",
                );
              },
              "The candidate sign-in could not be signed out. Recovery remains paused; retry cancellation.",
              true,
            );
          }}
        >
          Cancel recovery
        </button>
      )}
      <p className="auth-intent-switch">
        {intent === "signup"
          ? "Already have an account? "
          : "New to YapArena? "}
        <button
          type="button"
          data-auth-open={intent === "signup" ? "login" : "signup"}
        >
          {intent === "signup" ? "Log in" : "Sign up"}
        </button>
      </p>
      <a
        className="auth-legacy-link"
        data-auth-fallback
        href={`/account?next=${encodeURIComponent(root?.dataset.authReturn ?? "/debates")}`}
      >
        Use a wallet or existing password account →
      </a>
      <p className="form-note">
        Just watching?{" "}
        <a
          onClick={(event) => {
            if (root?.dataset.authSurface === "modal") {
              event.preventDefault();
              root.closest<HTMLDialogElement>("dialog")?.close();
            }
          }}
          href={
            safeAuthReturn(
              new URLSearchParams(location.search).get("next"),
              location.origin,
            ) ?? "/debates"
          }
        >
          Keep exploring
        </a>
        . Signing in never approves a payment.
      </p>
      <Captcha />
      <Settings
        google={google}
        passkeys={passkeys}
        onReconcile={setReconciliationToken}
      />
      {reconciliationToken && (
        <Reconciliation
          key={reconciliationToken}
          token={reconciliationToken}
          onClose={() => setReconciliationToken(null)}
          onComplete={() => {
            setReconciliationToken(null);
            announceSession();
            if (!completeAuthReturn(authReturn()))
              setMessage(
                "Account access restored. Other sessions were signed out.",
              );
          }}
        />
      )}
    </div>
  );
}

type ProviderCredential = {
  type: "email" | "google_oauth" | "passkey";
  id: string;
};
const providerMethodNames = {
  email: "Email",
  google_oauth: "Google account",
  passkey: "Passkey",
};
const passkeySetupStorageKey = "yaparena-provider-passkey-setup";
function pendingPasskeySetup(): string | null {
  try {
    const id = sessionStorage.getItem(passkeySetupStorageKey);
    return id && /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
// A pending setup must remain reachable when protected profile reads are
// deliberately denied until the provider's exact key addition is accepted.
const passkeyResumeMount = document.querySelector("#provider-settings")
  ? document.createElement("div")
  : null;
if (passkeyResumeMount) {
  passkeyResumeMount.id = "passkey-setup-resume";
  document.querySelector("#account-notice")?.after(passkeyResumeMount);
}
function rememberPasskeySetup(id: string | null) {
  try {
    if (id) {
      sessionStorage.setItem(passkeySetupStorageKey, id);
      if (sessionStorage.getItem(passkeySetupStorageKey) !== id)
        throw new Error("Setup was not retained");
    } else sessionStorage.removeItem(passkeySetupStorageKey);
  } catch {
    throw new Error(
      "Allow browser storage before setting up a passkey. No new passkey was requested.",
    );
  }
}
type ProviderPasskeyIntent = {
  id: string;
  expiresAt: string;
  bootstrapAllowed: boolean;
  terms: ProviderPasskeyTerms;
};
type ProviderPasskeyActivation = ProviderPasskeyIntent & {
  authenticationOptions: PublicKeyCredentialRequestOptionsJSON;
};
type PasskeyActor = {
  epoch: number;
  accountId: string | null;
  subject: string;
  abort: AbortController;
};
type LinkedWallet = { id: string; address: string; chainId: string };
async function injectedWalletRequest(
  method: string,
  params?: string[],
): Promise<unknown> {
  const provider: unknown = Reflect.get(window, "ethereum");
  if (typeof provider !== "object" || provider === null)
    throw new Error("Open your retained wallet extension to continue.");
  const request: unknown = Reflect.get(provider, "request");
  if (typeof request !== "function")
    throw new Error("Your wallet extension cannot approve this request.");
  const result: unknown = await Reflect.apply(request, provider, [
    { method, ...(params ? { params } : {}) },
  ]);
  return result;
}
type RecoveryCandidate = {
  before: ProviderCredential[];
  after: ProviderCredential[];
  legacyPassword: boolean;
  passkeys: { id: string; createdAt: string }[];
  wallets: LinkedWallet[];
};
function Reconciliation({
  token,
  onClose,
  onComplete,
}: {
  token: string;
  onClose: () => void;
  onComplete: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    title = useRef<HTMLHeadingElement>(null),
    locked = useRef(false),
    recoveryStart = useRef(performance.now());
  function recoveryOutcome(event: string) {
    measure(
      event,
      Math.min(600, (performance.now() - recoveryStart.current) / 1000),
    );
  }
  function cancelRecovery() {
    recoveryOutcome("recovery_cancelled");
    setPassword("");
    onClose();
  }
  const [candidate, setCandidate] = useState<RecoveryCandidate | null>(null),
    [restartAvailable, setRestartAvailable] = useState(false),
    [restartRequiresLogin, setRestartRequiresLogin] = useState(false),
    [restartChecking, setRestartChecking] = useState(false),
    [restartNotice, setRestartNotice] = useState(false),
    [selected, setSelected] = useState(""),
    [password, setPassword] = useState(""),
    [message, setMessage] = useState("Checking sign-in changes…"),
    [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const operationAbort = useRef(new AbortController());
  const operationEpoch = useRef(0);
  const completedRecovery = useRef(false);
  const providerState = usePrivy();
  const liveActor = useRef({
    ready: providerState.ready,
    authenticated: providerState.authenticated,
    subject: providerState.user?.id ?? null,
  });
  liveActor.current = {
    ready: providerState.ready,
    authenticated: providerState.authenticated,
    subject: providerState.user?.id ?? null,
  };
  const priorActor = useRef(liveActor.current);
  function captureActor() {
    return {
      epoch: operationEpoch.current,
      accountId: window.yapCurrentSessionAccount?.() ?? null,
      ...liveActor.current,
      signal: operationAbort.current.signal,
    };
  }
  function sameActor(actor: ReturnType<typeof captureActor>) {
    const current = liveActor.current;
    return (
      mounted.current &&
      !actor.signal.aborted &&
      actor.epoch === operationEpoch.current &&
      actor.accountId === (window.yapCurrentSessionAccount?.() ?? null) &&
      actor.ready === current.ready &&
      actor.authenticated === current.authenticated &&
      actor.subject === current.subject
    );
  }
  function assertActor(actor: ReturnType<typeof captureActor>) {
    if (!sameActor(actor))
      throw new DOMException(
        "Verification cancelled after the account changed.",
        "AbortError",
      );
  }
  function invalidateActor() {
    if (completedRecovery.current) return;
    operationEpoch.current++;
    operationAbort.current.abort();
    mounted.current = false;
    setPassword("");
    WebAuthnAbortService.cancelCeremony();
    onClose();
  }
  useEffect(() => {
    const before = priorActor.current,
      after = liveActor.current;
    priorActor.current = after;
    if (
      before.ready !== after.ready ||
      before.authenticated !== after.authenticated ||
      before.subject !== after.subject
    )
      invalidateActor();
  }, [
    providerState.ready,
    providerState.authenticated,
    providerState.user?.id,
  ]);
  useEffect(() => {
    const prior =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    measure("recovery_started");
    dialog.current?.showModal();
    title.current?.focus();
    let cancelled = false;
    mounted.current = true;
    operationAbort.current = new AbortController();
    completedRecovery.current = false;
    operationEpoch.current++;
    const signal = operationAbort.current.signal;
    window.addEventListener("yap:account-changed", invalidateActor);
    window.addEventListener("yap:provider-logout", invalidateActor);
    setRestartAvailable(false);
    setRestartRequiresLogin(false);
    setRestartChecking(false);
    setRestartNotice(false);
    void securityJSON<RecoveryCandidate>(
      "access/reconciliation/candidate",
      {},
      token,
      signal,
    )
      .then(async (value) => {
        if (cancelled || !mounted.current) return;
        setCandidate(value);
        setSelected(
          value.passkeys[0]
            ? `passkey:${value.passkeys[0].id}`
            : value.legacyPassword
              ? "password"
              : value.wallets[0]
                ? `wallet:${value.wallets[0].id}`
                : "",
        );
        setMessage(
          "Review the exact sign-in methods below. Continue only if you recognize every change.",
        );
        if (
          !value.legacyPassword &&
          !value.passkeys.length &&
          !value.wallets.length &&
          !value.before.some((entry) => entry.type === "passkey") &&
          value.after.some((entry) => entry.type === "passkey")
        ) {
          setRestartChecking(true);
          const availability = await securityJSON<{ code: string }>(
            "provider/passkeys/bootstrap/candidate",
            {},
            token,
            signal,
          ).catch((error: unknown) => {
            if (
              !cancelled &&
              mounted.current &&
              error instanceof SecurityRequestError &&
              [
                "provider_session_revoked",
                "provider_reset_pending",
                "provider_reset_review_required",
              ].includes(error.code ?? "")
            ) {
              setRestartRequiresLogin(
                error.code === "provider_session_revoked",
              );
              setRestartNotice(true);
              setMessage(error.message);
            }
            return null;
          });
          if (!cancelled && mounted.current) setRestartChecking(false);
          if (
            !cancelled &&
            mounted.current &&
            availability?.code === "first_passkey_restart_available"
          ) {
            setRestartAvailable(true);
            setMessage(
              "Your first passkey setup was interrupted. Verify your current Privy passkey to finish setup.",
            );
          }
        }
      })
      .catch((error) => {
        if (!cancelled && mounted.current) {
          recoveryOutcome("recovery_failed");
          setMessage(
            error instanceof Error
              ? error.message
              : "Ownership review is required.",
          );
        }
      });
    return () => {
      cancelled = true;
      mounted.current = false;
      operationAbort.current.abort();
      operationEpoch.current++;
      window.removeEventListener("yap:account-changed", invalidateActor);
      window.removeEventListener("yap:provider-logout", invalidateActor);
      WebAuthnAbortService.cancelCeremony();
      dialog.current?.close();
      if (prior?.isConnected) prior.focus();
    };
  }, [token]);
  async function restartFirstPasskey() {
    if (locked.current || !candidate || !restartAvailable) return;
    locked.current = true;
    setBusy(true);
    const actor = captureActor();
    try {
      const operation = await securityJSON<{
        id: string;
        before: ProviderCredential[];
        after: ProviderCredential[];
        authenticationOptions: PublicKeyCredentialRequestOptionsJSON;
      }>("provider/passkeys/bootstrap/restart", {}, token, actor.signal);
      assertActor(actor);
      if (
        JSON.stringify(operation.before) !== JSON.stringify(candidate.before) ||
        JSON.stringify(operation.after) !== JSON.stringify(candidate.after)
      )
        throw new Error(
          "Sign-in methods changed again. Close and start verification again.",
        );
      setMessage("Verify your current Privy passkey to finish setup.");
      const authentication = await startAuthentication({
        optionsJSON: operation.authenticationOptions,
      });
      assertActor(actor);
      await securityRequest(
        `provider/passkeys/bootstrap/${encodeURIComponent(operation.id)}/complete`,
        { authentication },
        token,
        actor.signal,
      );
      assertActor(actor);
      rememberPasskeySetup(null);
      recoveryOutcome("recovery_completed");
      completedRecovery.current = true;
      onComplete();
    } catch (error) {
      if (sameActor(actor)) {
        recoveryOutcome("recovery_failed");
        setMessage(
          error instanceof Error
            ? error.message
            : "Passkey verification could not be completed.",
        );
      }
    } finally {
      if (sameActor(actor)) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  async function complete() {
    if (locked.current || !candidate || !selected) return;
    locked.current = true;
    setBusy(true);
    setMessage("Waiting for verification…");
    const actor = captureActor();
    try {
      const credential =
        selected === "password"
          ? { type: "password" }
          : selected.startsWith("passkey:")
            ? { type: "passkey", keyId: selected.slice(8) }
            : { type: "wallet", walletId: selected.slice(7) };
      const operation = await securityJSON<{
        id: string;
        before: ProviderCredential[];
        after: ProviderCredential[];
        authenticationOptions?: PublicKeyCredentialRequestOptionsJSON;
        authorizationMessage: string | null;
      }>("access/reconciliation", { credential }, token, actor.signal);
      assertActor(actor);
      if (
        JSON.stringify(operation.before) !== JSON.stringify(candidate.before) ||
        JSON.stringify(operation.after) !== JSON.stringify(candidate.after)
      )
        throw new Error(
          "Sign-in methods changed again. Close and start verification again.",
        );
      const approval: {
        id: string;
        password?: string;
        signature?: string;
        authentication?: AuthenticationResponseJSON;
      } = { id: operation.id };
      if (selected === "password") approval.password = password;
      else if (selected.startsWith("passkey:")) {
        if (!operation.authenticationOptions)
          throw new Error("Security passkey verification unavailable.");
        approval.authentication = await startAuthentication({
          optionsJSON: operation.authenticationOptions,
        });
        assertActor(actor);
      } else {
        const wallet = candidate.wallets.find(
          (value) => value.id === selected.slice(7),
        );
        if (!wallet || !operation.authorizationMessage)
          throw new Error("Open your retained wallet extension to continue.");
        const accounts = await injectedWalletRequest("eth_requestAccounts"),
          chainId = await injectedWalletRequest("eth_chainId");
        assertActor(actor);
        const address: unknown = Array.isArray(accounts) ? accounts[0] : null;
        if (
          typeof address !== "string" ||
          typeof chainId !== "string" ||
          address.toLowerCase() !== wallet.address.toLowerCase() ||
          Number.parseInt(chainId, 16) !== Number(wallet.chainId)
        )
          throw new Error(
            `Switch your wallet to ${wallet.address} on chain ${wallet.chainId}, then retry.`,
          );
        const hex = `0x${Array.from(new TextEncoder().encode(operation.authorizationMessage), (value) => value.toString(16).padStart(2, "0")).join("")}`;
        const signature = await injectedWalletRequest("personal_sign", [
          hex,
          wallet.address,
        ]);
        assertActor(actor);
        if (typeof signature !== "string")
          throw new Error("Your wallet did not return a signature.");
        approval.signature = signature;
      }
      setPassword("");
      await securityRequest(
        `access/reconciliation/${encodeURIComponent(operation.id)}/complete`,
        { approval },
        token,
        actor.signal,
      );
      assertActor(actor);
      recoveryOutcome("recovery_completed");
      completedRecovery.current = true;
      onComplete();
    } catch (error) {
      if (!sameActor(actor)) return;
      recoveryOutcome("recovery_failed");
      setPassword("");
      setMessage(
        error instanceof Error
          ? error.message
          : "Verification failed. If the result is uncertain, check account access before retrying.",
      );
    } finally {
      if (sameActor(actor)) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  return createSettingsPortal(
    <dialog
      ref={dialog}
      className="information-card account-operation-dialog"
      aria-labelledby="reconciliation-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) {
          cancelRecovery();
        }
      }}
    >
      <form
        className="stack-form"
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          void complete();
        }}
      >
        <h2 ref={title} tabIndex={-1} id="reconciliation-title">
          Review sign-in changes
        </h2>
        {candidate && (
          <>
            <h3>Previously accepted</h3>
            <ul>
              {candidate.before.map((value) => (
                <li key={`${value.type}:${value.id}`}>
                  {providerMethodNames[value.type]}: {value.id}
                </li>
              ))}
            </ul>
            <h3>Current verified provider methods</h3>
            <ul>
              {candidate.after.map((value) => (
                <li key={`${value.type}:${value.id}`}>
                  {providerMethodNames[value.type]}: {value.id}
                </li>
              ))}
            </ul>
            {(candidate.legacyPassword ||
              candidate.passkeys.length > 0 ||
              candidate.wallets.length > 0) && (
              <label>
                Verify with a retained method
                <select
                  value={selected}
                  disabled={busy}
                  onChange={(event) => {
                    setSelected(event.target.value);
                    setPassword("");
                  }}
                >
                  {candidate.passkeys.map((key) => (
                    <option key={key.id} value={`passkey:${key.id}`}>
                      Security passkey added{" "}
                      {new Date(key.createdAt).toLocaleString()}
                    </option>
                  ))}
                  {candidate.legacyPassword && (
                    <option value="password">Current password</option>
                  )}
                  {candidate.wallets.map((wallet) => (
                    <option key={wallet.id} value={`wallet:${wallet.id}`}>
                      {wallet.address} · chain {wallet.chainId}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {selected === "password" && (
              <label>
                Current password
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  disabled={busy}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
            )}
            {!selected &&
              !restartAvailable &&
              !restartRequiresLogin &&
              !restartChecking &&
              !restartNotice && (
                <p>
                  No retained security method is available. Ownership review is
                  required. Email sign-in cannot replace a lost security
                  passkey.
                </p>
              )}
          </>
        )}
        <p role="status" aria-live="polite" aria-atomic="true">
          {message}
        </p>
        <button className="button" type="submit" disabled={busy || !selected}>
          Accept these methods and restore access
        </button>
        {restartAvailable && (
          <button
            className="button"
            type="button"
            disabled={busy}
            onClick={() => void restartFirstPasskey()}
          >
            Verify my first passkey and finish setup
          </button>
        )}
        {restartRequiresLogin && (
          <button
            className="button-secondary"
            type="button"
            disabled={busy}
            onClick={() => {
              cancelRecovery();
              window.dispatchEvent(
                new CustomEvent("yap:request-auth", {
                  detail: {
                    mode: "login",
                    returnTo: "/account#account-security",
                  },
                }),
              );
            }}
          >
            Sign in again to restart setup
          </button>
        )}
        <button
          className="button-secondary"
          type="button"
          disabled={busy}
          onClick={() => {
            cancelRecovery();
          }}
        >
          Cancel
        </button>
        <p className="form-note">
          This restores one YapArena session and signs out other sessions. It
          never approves a payment. If these changes are unfamiliar, cancel and
          request ownership review.
        </p>
      </form>
    </dialog>,
    document.body,
  );
}

function Settings({
  google,
  passkeys,
  onReconcile,
}: {
  google: boolean;
  passkeys: boolean;
  onReconcile: (token: string) => void;
}) {
  const methodNames: Record<string, string> = {
    email: "Email",
    google_oauth: "Google",
    passkey: "Passkey",
    password: "Password",
  };
  const [userMethods, setMethods] = useState<string[]>([]);
  const [securityKeys, setSecurityKeys] = useState<
    { credentialId: string; provenance: "privy" | "yaparena" }[]
  >([]);
  const [pendingPasskey, setPendingPasskey] = useState(pendingPasskeySetup);
  const passkeyApproval = useRef<SecurityApproval | undefined>(undefined);
  const passkeyIntent = useRef(pendingPasskey);
  const passkeyEpoch = useRef(0);
  const activePasskeyActor = useRef<PasskeyActor | null>(null);
  const [provider, setProvider] = useState<{
    subject?: string;
    methods: string[];
    credentials: ProviderCredential[] | null;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [newEmail, setNewEmail] = useState(""),
    [emailCode, setEmailCode] = useState(""),
    [pendingEmail, setPendingEmail] = useState<{
      address: string;
      update: boolean;
    } | null>(null);
  const { ready, authenticated, user, getAccessToken } = usePrivy(),
    pending = useRef(false),
    refreshVersion = useRef(0);
  const liveProvider = useRef({
    ready,
    authenticated,
    subject: user?.id ?? null,
  });
  liveProvider.current = { ready, authenticated, subject: user?.id ?? null };
  const priorProvider = useRef(liveProvider.current);
  const { linkWithPasskey } = useLinkWithPasskey();
  function passkeyActor(resume = false): PasskeyActor {
    const current = liveProvider.current,
      accountId = window.yapCurrentSessionAccount?.() ?? null;
    if (
      !current.ready ||
      !current.authenticated ||
      !current.subject ||
      (!resume && (!accountId || current.subject !== provider?.subject))
    )
      throw new Error(
        "Verify your current account before setting up a passkey.",
      );
    return {
      epoch: passkeyEpoch.current,
      accountId,
      subject: current.subject,
      abort: new AbortController(),
    };
  }
  function samePasskeyActor(actor: PasskeyActor) {
    const current = liveProvider.current;
    return (
      activePasskeyActor.current === actor &&
      !actor.abort.signal.aborted &&
      actor.epoch === passkeyEpoch.current &&
      actor.accountId === (window.yapCurrentSessionAccount?.() ?? null) &&
      current.ready &&
      current.authenticated &&
      current.subject === actor.subject
    );
  }
  function assertPasskeyActor(actor: PasskeyActor) {
    if (!samePasskeyActor(actor))
      throw new DOMException(
        "Passkey setup cancelled after the account changed.",
        "AbortError",
      );
  }
  function cancelPasskeyActor() {
    passkeyEpoch.current++;
    const active = activePasskeyActor.current !== null;
    activePasskeyActor.current?.abort.abort();
    activePasskeyActor.current = null;
    passkeyApproval.current = undefined;
    if (active) {
      WebAuthnAbortService.cancelCeremony();
      pending.current = false;
      setBusy(false);
      setMessage("");
    }
    if (active || passkeyIntent.current) {
      passkeyIntent.current = null;
      setPendingPasskey(null);
      try {
        rememberPasskeySetup(null);
      } catch {
        /* No stale intent can authorize a different cookie. */
      }
    }
  }
  const updateEmail = useUpdateEmail(),
    linkEmail = useLinkEmail(),
    unlinkEmail = useUnlinkEmail(),
    unlinkOAuth = useUnlinkOAuth(),
    unlinkPasskey = useUnlinkPasskey();
  async function reconcile() {
    setEmailCode("");
    setPendingEmail(null);
    try {
      sessionStorage.removeItem("yaparena-provider-change");
    } catch {
      /* Navigation intent only. */
    }
    const token = await getAccessToken();
    if (!token)
      throw new Error("Verify your provider sign-in, then review the changes.");
    onReconcile(token);
    setMessage(
      "Review the exact provider changes and verify with your retained security credential to finish.",
    );
  }
  const links = useLinkAccount({
    onSuccess: ({ linkMethod }) => {
      if (linkMethod === "passkey") return;
      void reconcile().catch(() =>
        setMessage(
          "Verify your provider sign-in and retry ownership verification.",
        ),
      );
      setBusy(false);
      pending.current = false;
    },
    onError: (_error, details) => {
      if (details.linkMethod === "passkey") return;
      setMessage(
        passkeyIntent.current
          ? "Passkey setup was interrupted. If your device created the passkey, choose Finish passkey setup. Otherwise wait five minutes before starting again."
          : "Linking was cancelled or unavailable. Your accepted YapArena methods were not changed.",
      );
      setBusy(false);
      pending.current = false;
    },
  });
  function showPasskeyError(error: unknown) {
    setMessage(
      error instanceof Error
        ? error.message
        : "Passkey setup could not be confirmed. Choose Finish passkey setup to check its state.",
    );
  }
  async function finishPasskey(
    id: string,
    actor: PasskeyActor,
    returnFocus: HTMLElement | undefined,
  ) {
    assertPasskeyActor(actor);
    const token = await getAccessToken();
    assertPasskeyActor(actor);
    if (!token) throw new Error("Sign in with Privy to finish passkey setup.");
    const activation = await securityJSON<ProviderPasskeyActivation>(
      `provider/passkeys/${encodeURIComponent(id)}/activation`,
      {},
      token,
      actor.abort.signal,
    );
    assertPasskeyActor(actor);
    if (!activation.bootstrapAllowed && !passkeyApproval.current) {
      if (!window.yapPrepareProviderPasskey)
        throw new Error(
          "Reload Account settings to verify your retained method.",
        );
      const approval = await window.yapPrepareProviderPasskey(
        activation.terms,
        { intentId: id, token },
        returnFocus,
      );
      assertPasskeyActor(actor);
      passkeyApproval.current = approval;
    }
    setMessage("Verify this passkey to finish setup.");
    const authentication = await startAuthentication({
      optionsJSON: activation.authenticationOptions,
    });
    assertPasskeyActor(actor);
    await securityRequest(
      `provider/passkeys/${encodeURIComponent(id)}/complete`,
      { authentication, approval: passkeyApproval.current },
      token,
      actor.abort.signal,
    );
    assertPasskeyActor(actor);
    rememberPasskeySetup(null);
    passkeyIntent.current = null;
    passkeyApproval.current = undefined;
    setPendingPasskey(null);
    activePasskeyActor.current = null;
    pending.current = false;
    setBusy(false);
    setMessage(
      "Passkey ready for sign-in and account approvals. Other sessions were signed out.",
    );
    announceSession();
  }
  async function addPasskey(
    credentialId?: string,
    resumeId?: string,
    returnFocus?: HTMLElement,
  ) {
    if (pending.current) return;
    const opener =
      returnFocus ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined);
    pending.current = true;
    setBusy(true);
    let actor: PasskeyActor | undefined;
    try {
      actor = passkeyActor(Boolean(resumeId));
      activePasskeyActor.current = actor;
      if (resumeId) {
        await finishPasskey(resumeId, actor, opener);
        return;
      }
      if (!authenticated || user?.id !== provider?.subject)
        throw new Error(
          "Sign in with your current Privy account before adding a passkey.",
        );
      const intent = await securityJSON<ProviderPasskeyIntent>(
        "provider/passkeys",
        credentialId ? { credentialId } : {},
        undefined,
        actor.abort.signal,
      );
      assertPasskeyActor(actor);
      rememberPasskeySetup(intent.id);
      passkeyIntent.current = intent.id;
      setPendingPasskey(intent.id);
      passkeyApproval.current = undefined;
      if (!intent.bootstrapAllowed) {
        if (!window.yapPrepareProviderPasskey)
          throw new Error(
            "Load your account security settings before continuing.",
          );
        const approval = await window.yapPrepareProviderPasskey(
          intent.terms,
          undefined,
          opener,
        );
        assertPasskeyActor(actor);
        passkeyApproval.current = approval;
      }
      if (credentialId) await finishPasskey(intent.id, actor, opener);
      else {
        setMessage("Follow Privy’s prompt to add your passkey.");
        assertPasskeyActor(actor);
        await linkWithPasskey();
        assertPasskeyActor(actor);
        await finishPasskey(intent.id, actor, opener);
      }
    } catch (error) {
      if (!actor || samePasskeyActor(actor)) showPasskeyError(error);
    } finally {
      if (!actor || samePasskeyActor(actor)) {
        activePasskeyActor.current = null;
        pending.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    const cancel = () => cancelPasskeyActor();
    window.addEventListener("yap:account-changed", cancel);
    window.addEventListener("yap:provider-logout", cancel);
    return () => {
      window.removeEventListener("yap:account-changed", cancel);
      window.removeEventListener("yap:provider-logout", cancel);
      cancelPasskeyActor();
    };
  }, []);
  useEffect(() => {
    const previous = priorProvider.current,
      current = liveProvider.current;
    priorProvider.current = current;
    if (
      previous.ready &&
      (activePasskeyActor.current !== null || previous.authenticated) &&
      (!ready ||
        previous.authenticated !== authenticated ||
        previous.subject !== current.subject)
    )
      cancelPasskeyActor();
  }, [ready, authenticated, user?.id]);
  async function change(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The change could not be confirmed. Verify your provider sign-in to review its current state.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function approve(terms: ProviderChange) {
    if (!window.yapApproveProviderChange)
      throw new Error("Load your account security settings before continuing.");
    if (!authenticated || user?.id !== provider?.subject)
      throw new Error(
        "Sign in with the current provider account before changing its methods.",
      );
    await window.yapApproveProviderChange(terms);
  }
  useEffect(() => {
    if (!ready || !authenticated) return;
    let kind: string | null = null;
    try {
      kind = sessionStorage.getItem("yaparena-provider-change");
    } catch {
      /* Optional redirect recovery. */
    }
    if (kind && user?.linkedAccounts.some((account) => account.type === kind))
      void reconcile().catch(() =>
        setMessage(
          "Verify your provider sign-in and retry ownership verification.",
        ),
      );
  }, [ready, authenticated, user]);
  useEffect(() => {
    async function refresh() {
      const current = ++refreshVersion.current;
      setMethods([]);
      try {
        const response = await fetch("/api/auth/methods", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) return;
        const value: {
          provider: {
            subject?: string;
            methods: string[];
            credentials: ProviderCredential[] | null;
          } | null;
          legacyPassword: boolean;
        } = await response.json();
        const keyResponse = await fetch("/api/auth/security/passkeys", {
          credentials: "same-origin",
          cache: "no-store",
        });
        const keyData: { passkeys: typeof securityKeys } | null = keyResponse.ok
          ? await keyResponse.json()
          : null;
        if (current === refreshVersion.current) {
          setProvider(value.provider);
          setSecurityKeys(keyData?.passkeys ?? []);
          setMethods([
            ...(value.legacyPassword ? ["password"] : []),
            ...(value.provider?.methods ?? []),
          ]);
        }
      } catch {
        // The account remains controlled by its server session during outages.
      }
    }
    void refresh();
    window.addEventListener("yap:account-changed", refresh);
    return () => {
      refreshVersion.current++;
      window.removeEventListener("yap:account-changed", refresh);
    };
  }, []);
  const settingsRoot =
    document.querySelector<HTMLElement>("#provider-settings");
  // The settings are rendered into the signed-in account area by a separate
  // portal, preserving all existing profile and wallet controllers.
  return settingsRoot ? (
    <>
      {pendingPasskey &&
        passkeyResumeMount &&
        createSettingsPortal(
          <section className="information-card">
            <h3>Passkey setup</h3>
            <p>
              Finish verifying the passkey you added before continuing to your
              account.
            </p>
            <button
              className="button-secondary"
              type="button"
              disabled={busy || !ready || !authenticated}
              onClick={(event) =>
                void addPasskey(undefined, pendingPasskey, event.currentTarget)
              }
            >
              Finish passkey setup
            </button>
            <button
              className="button-secondary"
              type="button"
              disabled={busy}
              onClick={(event) =>
                window.dispatchEvent(
                  new CustomEvent("yap:request-auth", {
                    detail: {
                      mode: "login",
                      source: event.currentTarget,
                      returnTo: "/account#account-security",
                    },
                  }),
                )
              }
            >
              Sign in again to restart setup
            </button>
            <p role="status" aria-live="polite" aria-atomic="true">
              {message}
            </p>
          </section>,
          passkeyResumeMount,
        )}
      {createSettingsPortal(
        <>
          <h3>Sign-in methods</h3>
          <div className="auth-method-list">
            {userMethods.length ? (
              [...new Set(userMethods)].map((method) => (
                <span className="auth-method-chip" key={method}>
                  {methodNames[method] ?? "Sign-in method"}
                </span>
              ))
            ) : (
              <p>Sign-in methods are unavailable. Refresh to check again.</p>
            )}
          </div>
          <p>
            Your passkey works for sign-in and secure account approvals. Keep
            another sign-in method available in case you lose access to a
            device.
          </p>
          {provider ? (
            <>
              {(!authenticated || user?.id !== provider.subject) && (
                <p>
                  Sign in with your current email or passkey before changing
                  sign-in methods.
                </p>
              )}
              <form
                className="stack-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void change(async () => {
                    const address = newEmail.trim(),
                      update = provider.methods.includes("email");
                    await approve({
                      action: update ? "update" : "link",
                      method: "email",
                      target: address,
                    });
                    if (update)
                      await updateEmail.sendCode({ newEmailAddress: address });
                    else await linkEmail.sendCode({ email: address });
                    setPendingEmail({ address, update });
                    setEmailCode("");
                    setMessage(
                      "Privy sent a code to the new email. Enter its newest code below.",
                    );
                  });
                }}
              >
                <label>
                  New sign-in email
                  <input
                    type="email"
                    autoComplete="email"
                    required
                    value={newEmail}
                    disabled={busy || Boolean(pendingEmail)}
                    onChange={(event) => setNewEmail(event.target.value)}
                  />
                </label>
                <button
                  className="button-secondary"
                  type="submit"
                  disabled={
                    busy ||
                    Boolean(pendingEmail) ||
                    !authenticated ||
                    user?.id !== provider.subject
                  }
                >
                  {provider.methods.includes("email")
                    ? "Change email"
                    : "Add email"}
                </button>
              </form>
              {pendingEmail && (
                <form
                  className="stack-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void change(async () => {
                      if (pendingEmail.update)
                        await updateEmail.verifyCode({ code: emailCode });
                      else await linkEmail.linkWithCode({ code: emailCode });
                      await reconcile();
                    });
                  }}
                >
                  <label>
                    Code for {pendingEmail.address}
                    <input
                      autoComplete="one-time-code"
                      inputMode="numeric"
                      pattern="[0-9]{6}"
                      maxLength={6}
                      required
                      value={emailCode}
                      disabled={busy}
                      onChange={(event) =>
                        setEmailCode(
                          event.target.value.replace(/\D/g, "").slice(0, 6),
                        )
                      }
                    />
                  </label>
                  <button
                    className="button"
                    type="submit"
                    disabled={busy || emailCode.length !== 6}
                  >
                    Verify new email
                  </button>
                  <button
                    className="button-secondary"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void change(async () => {
                        if (pendingEmail.update)
                          await updateEmail.sendCode({
                            newEmailAddress: pendingEmail.address,
                          });
                        else
                          await linkEmail.sendCode({
                            email: pendingEmail.address,
                          });
                        setEmailCode("");
                        setMessage(
                          "Privy resent the code. Use the newest one.",
                        );
                      })
                    }
                  >
                    Resend new email code
                  </button>
                  <button
                    className="button-secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setPendingEmail(null);
                      setEmailCode("");
                    }}
                  >
                    Cancel email change
                  </button>
                </form>
              )}
              {google && !provider.methods.includes("google_oauth") && (
                <button
                  className="button-secondary"
                  type="button"
                  disabled={
                    busy || !authenticated || user?.id !== provider.subject
                  }
                  onClick={() =>
                    void change(async () => {
                      await approve({
                        action: "link",
                        method: "google_oauth",
                        target: "provider-verified-google-account",
                      });
                      try {
                        sessionStorage.setItem(
                          "yaparena-provider-change",
                          "google_oauth",
                        );
                      } catch {
                        /* Intent only. */
                      }
                      links.linkGoogle();
                    })
                  }
                >
                  Add Google sign-in
                </button>
              )}
              {passkeys && (
                <button
                  className="button-secondary"
                  type="button"
                  disabled={
                    busy || !authenticated || user?.id !== provider.subject
                  }
                  onClick={(event) =>
                    void addPasskey(undefined, undefined, event.currentTarget)
                  }
                >
                  Add a passkey
                </button>
              )}
              <ul className="account-list">
                {(provider.credentials ?? []).map((entry) => (
                  <li key={`${entry.type}:${entry.id}`}>
                    <p>
                      {entry.type === "passkey"
                        ? securityKeys.some(
                            (key) =>
                              key.provenance === "privy" &&
                              key.credentialId === entry.id,
                          )
                          ? "Passkey · Ready for sign-in and account approvals"
                          : "Passkey · Finish setup for account approvals"
                        : `${methodNames[entry.type]}: ${entry.id}`}
                    </p>
                    {entry.type === "passkey" &&
                      !securityKeys.some(
                        (key) =>
                          key.provenance === "privy" &&
                          key.credentialId === entry.id,
                      ) &&
                      !pendingPasskey && (
                        <button
                          className="button-secondary"
                          type="button"
                          disabled={
                            busy ||
                            !authenticated ||
                            user?.id !== provider.subject
                          }
                          onClick={(event) =>
                            void addPasskey(
                              entry.id,
                              undefined,
                              event.currentTarget,
                            )
                          }
                        >
                          Finish passkey setup
                        </button>
                      )}
                    <button
                      className="button-secondary"
                      type="button"
                      disabled={
                        busy ||
                        !authenticated ||
                        user?.id !== provider.subject ||
                        (provider.credentials?.length ?? 0) <= 1
                      }
                      onClick={() =>
                        void change(async () => {
                          await approve({
                            action: "remove",
                            method: entry.type,
                            target: entry.id,
                          });
                          if (entry.type === "email")
                            await unlinkEmail.unlink({ address: entry.id });
                          else if (entry.type === "google_oauth")
                            await unlinkOAuth.unlink({
                              provider: "google",
                              subject: entry.id,
                            });
                          else
                            await unlinkPasskey.unlink({
                              credentialId: entry.id,
                            });
                          await reconcile();
                        })
                      }
                    >
                      Remove {methodNames[entry.type]}
                    </button>
                  </li>
                ))}
              </ul>
              <button
                className="button-secondary"
                type="button"
                disabled={busy || !authenticated}
                onClick={() => void change(reconcile)}
              >
                Review provider changes or recover access
              </button>
            </>
          ) : (
            <button
              className="button-secondary"
              type="button"
              disabled={busy || !userMethods.length}
              onClick={() => {
                window.dispatchEvent(new Event("yap:link-provider"));
                window.dispatchEvent(
                  new CustomEvent("yap:request-auth", {
                    detail: { mode: "login" },
                  }),
                );
              }}
            >
              Link email, Google or provider passkey to this existing account
            </button>
          )}
          <p role="status" aria-live="polite" aria-atomic="true">
            {message}
          </p>
          <p className="form-note">
            Keep at least one provider sign-in method. Changes require a
            retained security credential. If all stronger methods are lost,
            ownership review is required; an email code cannot reset them.
          </p>
        </>,
        settingsRoot,
      )}
    </>
  ) : null;
}
import { createPortal as createSettingsPortal } from "react-dom";

if (root) {
  void (async () => {
    try {
      const response = await fetch("/api/auth/provider", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("provider unavailable");
      const config: Config = await response.json();
      if (!config.enabled || !config.appId) return;
      createRoot(root).render(
        <PrivyProvider
          appId={config.appId}
          clientId={config.clientId}
          config={{
            loginMethods: ["email", "google", "passkey"],
            appearance: {
              theme: "dark",
              accentColor: "#d9ff65",
              // This email island has no Privy wallet chooser or directory.
              walletList: [],
            },
            externalWallets: {
              disableAllExternalWallets: true,
              walletConnect: { enabled: false },
            },
            embeddedWallets: {
              ethereum: { createOnLogin: "off" },
              solana: { createOnLogin: "off" },
            },
          }}
        >
          <Auth
            google={Boolean(config.google)}
            passkeys={Boolean(config.passkeys)}
          />
        </PrivyProvider>,
      );
    } catch {
      root.textContent =
        "Email sign-in is temporarily unavailable. Reload when your connection returns.";
    }
  })();
}
