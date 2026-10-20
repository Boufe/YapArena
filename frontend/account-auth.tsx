import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Captcha,
  PrivyProvider,
  usePrivy,
  useLoginWithEmail,
  useLoginWithOAuth,
  useLoginWithPasskey,
} from "@privy-io/react-auth";
import { safeAuthReturn } from "./auth-return.js";
import type { AuthMode } from "./auth-events.js";

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

function Auth({ google, passkeys }: { google: boolean; passkeys: boolean }) {
  const [intent, setIntent] = useState<AuthMode | null>(
    root?.dataset.authMode === "signup"
      ? "signup"
      : root?.dataset.authMode === "login"
        ? "login"
        : null,
  );
  const { ready, authenticated, getAccessToken, logout } = usePrivy();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [message, setMessage] = useState("Preparing secure sign-in…");
  const [requestBusy, setBusy] = useState(false);
  const [exchanging, setExchanging] = useState(false);
  const busy = requestBusy || exchanging;
  const journeyStart = useRef<number | null>(null);
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
      void logout().catch(() => {});
    };
    window.addEventListener("yap:provider-logout", end);
    return () => window.removeEventListener("yap:provider-logout", end);
  }, [logout]);
  useEffect(() => {
    const mode = (event: CustomEvent<AuthMode | null>) =>
      setIntent(event.detail);
    const dismiss = () => {
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
    window.addEventListener("yap:auth-mode", mode);
    window.addEventListener("yap:auth-dismissed", dismiss);
    return () => {
      window.removeEventListener("yap:auth-mode", mode);
      window.removeEventListener("yap:auth-dismissed", dismiss);
    };
  }, []);
  useEffect(() => {
    if (ready && intent && root?.closest<HTMLDialogElement>("dialog")?.open)
      emailInput.current?.focus();
  }, [ready, intent]);

  async function run(action: () => Promise<void>, failure: string) {
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
    } catch {
      measure("provider_error");
      setMessage(
        navigator.onLine
          ? failure
          : "You’re offline. Reconnect, then try again.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const completing = useRef(false);
  async function complete() {
    if (completing.current || cancelled.current) return;
    completing.current = true;
    setExchanging(true);
    setMessage("Verified. Opening your YapArena account…");
    try {
      const current = await fetch("/api/auth/me", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (current.status !== 200) {
        if (cancelled.current) return;
        const token = await getAccessToken();
        if (cancelled.current) return;
        if (!token) throw new Error("no provider token");
        const response = await fetch("/api/auth/privy/exchange", {
          method: "POST",
          credentials: "same-origin",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) {
          // Concurrent tabs may have completed the single-use exchange. Trust
          // the server cookie only, never provider state as application access.
          const check = await fetch("/api/auth/me", {
            cache: "no-store",
            credentials: "same-origin",
          });
          if (!check.ok) {
            setMessage(
              response.status === 403
                ? "Account access changed. Ownership verification is required before signing in again."
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
      if (journeyStart.current !== null) {
        measure(
          "completed",
          Math.min(600, (performance.now() - journeyStart.current) / 1000),
        );
        journeyStart.current = null;
      }
      const target = safeAuthReturn(
        root?.dataset.authReturn ??
          new URLSearchParams(location.search).get("next"),
        location.origin,
      );
      try {
        sessionStorage.removeItem("yaparena-auth-return");
      } catch {
        /* Optional navigation state only. */
      }
      window.dispatchEvent(new Event("yap:auth-complete"));
      if (target) location.assign(target);
      else setMessage("You’re signed in. Your profile is optional.");
    } catch {
      setMessage(
        "Connection interrupted. Retry to check whether sign-in completed.",
      );
    } finally {
      completing.current = false;
      setExchanging(false);
    }
  }
  async function send() {
    await run(async () => {
      if (authenticated) await logout();
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
        {step === "email"
          ? intent === "login"
            ? "Welcome back."
            : intent === "signup"
              ? "Join YapArena."
              : "Make yourself heard."
          : "Check your inbox."}
      </h2>
      <p className="auth-description">
        {step === "email" ? (
          "Your email is all you need to get started."
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
            {busy ? "Sending code…" : "Continue with email →"}
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
      {(google || passkeys) && (
        <div className="auth-divider">
          <span>or</span>
        </div>
      )}
      <div className="auth-alternatives">
        {google && (
          <button
            className="button-secondary"
            type="button"
            disabled={!ready || busy}
            onClick={() =>
              void run(async () => {
                if (authenticated) await logout();
                if (root?.dataset.authSurface === "modal") {
                  const next = safeAuthReturn(
                    root.dataset.authReturn ?? null,
                    location.origin,
                  );
                  if (next)
                    try {
                      sessionStorage.setItem(
                        "yaparena-auth-return",
                        JSON.stringify({ next }),
                      );
                    } catch {
                      /* Email does not need navigation storage. */
                    }
                }
                try {
                  await initOAuth({ provider: "google" });
                } catch (error) {
                  try {
                    sessionStorage.removeItem("yaparena-auth-return");
                  } catch {
                    /* Optional navigation state only. */
                  }
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
        {passkeys && (
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
      <Settings />
    </div>
  );
}

function Settings() {
  const methodNames: Record<string, string> = {
    email: "Email",
    google_oauth: "Google",
    passkey: "Passkey",
    password: "Password",
  };
  const [userMethods, setMethods] = useState<string[]>([]);
  useEffect(() => {
    let version = 0;
    async function refresh() {
      const current = ++version;
      setMethods([]);
      try {
        const response = await fetch("/api/auth/methods", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) return;
        const value: {
          provider: { methods: string[] } | null;
          legacyPassword: boolean;
        } = await response.json();
        if (current === version)
          setMethods([
            ...(value.legacyPassword ? ["password"] : []),
            ...(value.provider?.methods ?? []),
          ]);
      } catch {
        // The account remains controlled by its server session during outages.
      }
    }
    void refresh();
    window.addEventListener("yap:account-changed", refresh);
    return () => {
      version++;
      window.removeEventListener("yap:account-changed", refresh);
    };
  }, []);
  const settingsRoot =
    document.querySelector<HTMLElement>("#provider-settings");
  // The settings are rendered into the signed-in account area by a separate
  // portal, preserving all existing profile and wallet controllers.
  return settingsRoot
    ? createSettingsPortal(
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
            Keep access to your verified email. Changes to financial
            authorization require separate ownership verification.
          </p>
          <p>Adding or removing sign-in methods is not available yet.</p>
        </>,
        settingsRoot,
      )
    : null;
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
