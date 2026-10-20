import {
  startAuthentication,
  WebAuthnAbortService,
} from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import type { WalletChangeTarget } from "./account-types.js";
import type {
  ProviderChange,
  ProviderPasskeyTerms,
  SecurityApproval,
} from "./auth-events.js";
declare global {
  interface Window {
    yapSecurityWalletChange?: (target: WalletChangeTarget) => Promise<void>;
    yapLinkProviderIdentity?: (token: string) => Promise<void>;
    yapApproveCoinWithdrawal?: (
      requestId: string,
      terms: Record<string, string>,
      sessionId: string,
    ) => Promise<SecurityApproval>;
    yapApproveRecoveryCost?: (
      reportId: string,
      quoteId: string,
      terms: Record<string, string>,
      sessionId: string,
    ) => Promise<SecurityApproval>;
  }
}

type SecurityKey = {
  id: string;
  createdAt: string;
  deviceType: string;
  backedUp: boolean;
  credentialId: string;
  provenance: "privy" | "yaparena";
};
type Wallet = { id: string; address: string; chainId: string };
type ApprovalChoices = {
  legacyPassword: boolean;
  passkeys: {
    id: string;
    createdAt: string;
    credentialId?: string;
    provenance?: "privy" | "yaparena";
  }[];
  wallets: Wallet[];
};
type Operation = {
  id: string;
  authorizationMessage: string | null;
  authenticationOptions?: PublicKeyCredentialRequestOptionsJSON;
};
type SecurityCredential =
  | { type: "password" }
  | { type: "wallet"; walletId: string }
  | { type: "passkey"; keyId: string };
class SecurityResponseError extends Error {}
function displayUsdc(atomic: string | undefined) {
  if (!atomic || !/^(0|[1-9][0-9]{0,35})$/.test(atomic))
    throw new Error("Sandbox quote amount is invalid. Refresh the quote.");
  const amount = BigInt(atomic),
    fraction = String(amount % 1000000n)
      .padStart(6, "0")
      .replace(/0+$/, "");
  return `${amount / 1000000n}${fraction ? `.${fraction}` : ""} USDC`;
}

const mount = document.querySelector<HTMLElement>("#account-security-passkeys");
if (mount) {
  const root = mount;
  root.hidden = true;
  const heading = document.createElement("h3");
  heading.textContent = "Existing security keys";
  heading.tabIndex = -1;
  const help = document.createElement("p");
  help.textContent =
    "Your existing security keys remain available for account approvals.";
  const list = document.createElement("ul");
  list.className = "account-list";
  const notice = document.createElement("p");
  notice.role = "status";
  notice.setAttribute("aria-live", "polite");
  notice.setAttribute("aria-atomic", "true");
  root.append(heading, help, list, notice);
  let keys: SecurityKey[] = [],
    busy = false,
    version = 0,
    logoutGeneration = 0;
  let lastLoadError: string | null = null;
  let cancelApproval: (() => void) | undefined;
  function focusSection() {
    const target = root.hidden
      ? (document.querySelector<HTMLElement>("#account-security h2") ??
        document.querySelector<HTMLElement>("main h1"))
      : heading;
    if (target) {
      target.tabIndex = -1;
      target.focus();
    }
  }
  function assertGeneration(generation: number) {
    if (generation !== logoutGeneration)
      throw new DOMException("Security change cancelled", "AbortError");
  }
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    providerToken?: string,
  ): Promise<Response> {
    const send = method === "GET" ? fetch : window.yapSessionFetch;
    if (!send)
      throw new Error(
        "Secure account controls are unavailable. Reload and try again.",
      );
    const response = await send(`/api/auth${path}`, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(providerToken ? { Authorization: `Bearer ${providerToken}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      const data: { error?: string } = await response.json().catch(() => ({}));
      throw new SecurityResponseError(
        data.error ||
          (response.status === 401
            ? "Sign in again to continue."
            : "Security settings are temporarily unavailable. Try again."),
      );
    }
    return response;
  }
  async function api<T>(
    path: string,
    method = "GET",
    body?: unknown,
    providerToken?: string,
  ): Promise<T> {
    const response = await request(path, method, body, providerToken);
    return response.json();
  }
  function setBusy(value: boolean) {
    busy = value;
    for (const button of list.querySelectorAll("button"))
      button.disabled = value;
    const walletLink =
      document.querySelector<HTMLButtonElement>("#wallet-link");
    if (walletLink) walletLink.disabled = value;
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      "#wallet-list button",
    ))
      button.disabled = value;
  }
  function changed() {
    window.dispatchEvent(new Event("yap:account-changed"));
    if ("BroadcastChannel" in window) {
      const channel = new BroadcastChannel("yaparena-account");
      channel.postMessage("changed");
      channel.close();
    }
  }
  async function load() {
    const current = ++version;
    try {
      const data = await api<{ passkeys: SecurityKey[] }>("/security/passkeys");
      if (current !== version) return;
      if (lastLoadError !== null && notice.textContent === lastLoadError)
        notice.textContent = "";
      lastLoadError = null;
      window.yapSecurityWalletChange = changeWallet;
      window.yapLinkProviderIdentity = linkProviderIdentity;
      window.yapRecoverProviderIdentity = recoverProviderIdentity;
      window.yapApproveProviderChange = approveProviderChange;
      window.yapPrepareProviderPasskey = prepareProviderPasskey;
      window.yapApproveCoinWithdrawal = approveCoinWithdrawal;
      window.yapApproveRecoveryCost = approveRecoveryCost;
      keys = data.passkeys;
      const legacyKeys = keys.filter((key) => key.provenance === "yaparena");
      root.hidden = legacyKeys.length === 0;
      list.replaceChildren();
      for (const key of legacyKeys) {
        const item = document.createElement("li"),
          description = document.createElement("p"),
          remove = document.createElement("button");
        const created = new Date(key.createdAt).toLocaleString();
        description.textContent = `Existing security key · Added ${created}`;
        remove.type = "button";
        remove.className = "button-secondary";
        remove.textContent = "Remove existing security key";
        remove.setAttribute(
          "aria-label",
          `Remove existing security key added ${created}`,
        );
        remove.disabled = busy;
        remove.addEventListener("click", () => void removeKey(key));
        item.append(description, remove);
        list.append(item);
      }
    } catch (error) {
      if (current === version) {
        lastLoadError =
          error instanceof Error
            ? error.message
            : "Security settings are unavailable.";
        notice.textContent = lastLoadError;
      }
    }
  }
  async function walletSignature(
    message: string,
    wallet: Pick<Wallet, "address" | "chainId">,
  ) {
    const provider = window.ethereum;
    if (!provider?.request)
      throw new Error(
        "Open your linked wallet extension to approve this change.",
      );
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    const chain = Number.parseInt(
      await provider.request({ method: "eth_chainId" }),
      16,
    );
    if (
      accounts[0]?.toLowerCase() !== wallet.address.toLowerCase() ||
      chain !== Number(wallet.chainId)
    )
      throw new Error(
        `Switch your wallet to ${wallet.address} on chain ${wallet.chainId}, then try again.`,
      );
    const bytes = new TextEncoder().encode(message);
    const hex = `0x${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
    return provider.request({
      method: "personal_sign",
      params: [hex, wallet.address],
    });
  }
  async function approval(
    purpose: string,
    terms: Record<string, string>,
    excludedKey?: string,
    issue?: (credential: SecurityCredential) => Promise<Operation>,
    excludedWallet?: string,
    loadChoices?: () => Promise<ApprovalChoices>,
    restoreTarget?: HTMLElement,
  ): Promise<SecurityApproval> {
    const generation = logoutGeneration;
    const approvalAccount = window.yapCurrentSessionAccount?.() ?? null;
    const choices = loadChoices
      ? await loadChoices()
      : await Promise.all([
          api<{ legacyPassword: boolean }>("/methods"),
          api<{ wallets: Wallet[] }>("/wallets"),
          api<{ passkeys: SecurityKey[] }>("/security/passkeys"),
        ]).then(([methods, walletData, securityData]) => ({
          ...methods,
          ...walletData,
          ...securityData,
        }));
    assertGeneration(generation);
    const dialog = document.createElement("dialog");
    dialog.className = "information-card account-operation-dialog";
    const form = document.createElement("form"),
      title = document.createElement("h2"),
      description = document.createElement("p"),
      label = document.createElement("label"),
      select = document.createElement("select"),
      passwordLabel = document.createElement("label"),
      password = document.createElement("input"),
      message = document.createElement("p"),
      submit = document.createElement("button"),
      cancel = document.createElement("button");
    form.className = "stack-form";
    const titleId = `security-approval-${crypto.randomUUID()}`;
    title.id = titleId;
    title.textContent =
      purpose === "security.passkey.remove"
        ? "Remove existing security key"
        : purpose === "wallet.link"
          ? "Link wallet"
          : purpose === "wallet.unlink"
            ? "Unlink wallet"
            : purpose === "provider.identity.recover"
              ? "Replace lost sign-in"
              : purpose === "provider.identity.link"
                ? "Link sign-in method"
                : purpose === "provider.credentials.change"
                  ? "Change sign-in methods"
                  : purpose === "withdrawal.request"
                    ? "Approve sandbox withdrawal"
                    : purpose === "provider.passkey.link"
                      ? "Approve Privy passkey"
                      : purpose === "recovery.cost.consent"
                        ? "Approve recovery cost consent"
                        : "Approve account change";
    dialog.setAttribute("aria-labelledby", titleId);
    description.textContent =
      "Approve this change with a trusted method that stays on your account. Approval expires in five minutes.";
    if (purpose.startsWith("wallet."))
      description.textContent = `${title.textContent} ${terms.address} on chain ${terms.chainId}. Approve with a trusted method that stays on your account. This does not authorize a transaction.`;
    if (purpose === "provider.identity.recover")
      description.textContent = `Permanently retire ${terms.oldMethod === "google_oauth" ? "your previous Google sign-in" : `the old email sign-in ${terms.oldIdentifier}`} and replace it with the Privy-verified email ${terms.newEmail}. Your YapArena account, profile and balances stay with you. All other YapArena sessions will end. Only your retained passkey can approve this exact replacement. This does not authorize a payment.`;
    if (purpose === "provider.identity.link")
      description.textContent = `Add sign-in for ${terms.email}. Your existing account and credentials stay with you. Approve this change with a trusted method.`;
    if (purpose === "provider.credentials.change")
      description.textContent = `Approve ${terms.action} for ${terms.method}: ${terms.target}. Privy will verify the new method. You will then review the exact changes and verify again before YapArena accepts them.`;
    if (purpose === "provider.passkey.link")
      description.textContent =
        "Approve this exact Privy passkey setup with a trusted method already on your account. Then use Privy to add or verify your passkey. This does not authorize a payment.";
    if (purpose === "withdrawal.request")
      description.textContent = `Sandbox only — ${terms.rail === "simulation" ? "deterministic simulation" : "Base Sepolia test USDC"}. Deduct ${displayUsdc(terms.gross)} from your sandbox balance, including a ${displayUsdc(terms.fee)} network fee. The destination receives ${displayUsdc(terms.net)}. Destination: ${terms.destination}. Network: ${terms.network}. This approves this exact request and does not sign a live transaction.`;
    if (purpose === "recovery.cost.consent") {
      const expiry = new Date(terms.expiresAt ?? "");
      if (
        terms.environment !== "sandbox" ||
        terms.asset !== "USDC" ||
        terms.precision !== "6" ||
        terms.authorization !== "consent_only_no_charge" ||
        !Number.isFinite(expiry.getTime())
      )
        throw new Error("Recovery quote is invalid. Refresh the quote.");
      description.textContent = `Sandbox only — ${terms.rail === "simulation" ? "deterministic simulation" : "Base Sepolia test USDC"}. Record consent to the exact quoted recovery cost of ${displayUsdc(terms.amount)} on network ${terms.network}. Quote expires ${expiry.toLocaleString(undefined, { timeZoneName: "short" })}. This records consent only. No charge is taken and no recovery transaction is executed.`;
    }
    label.textContent = "Approve with ";
    label.append(select);
    passwordLabel.textContent = "Current password ";
    password.type = "password";
    password.autocomplete = "current-password";
    passwordLabel.append(password);
    for (const key of choices.passkeys.filter(
      (key) =>
        key.id !== excludedKey &&
        !(
          purpose === "provider.credentials.change" &&
          terms.action === "remove" &&
          terms.method === "passkey" &&
          key.credentialId === terms.target
        ),
    )) {
      const option = document.createElement("option");
      option.value = `passkey:${key.id}`;
      const label =
        key.provenance === "privy"
          ? "Passkey"
          : key.provenance === "yaparena"
            ? "Existing security key"
            : "Retained passkey";
      option.textContent = `${label} added ${new Date(key.createdAt).toLocaleString()}`;
      select.append(option);
    }
    if (choices.legacyPassword && purpose !== "provider.identity.recover") {
      const option = document.createElement("option");
      option.value = "password";
      option.textContent = "Current password";
      select.append(option);
    }
    for (const wallet of choices.wallets.filter(
      (wallet) =>
        wallet.id !== excludedWallet && purpose !== "provider.identity.recover",
    )) {
      const option = document.createElement("option");
      option.value = `wallet:${wallet.id}`;
      option.textContent = `Linked wallet ${wallet.address} · chain ${wallet.chainId}`;
      select.append(option);
    }
    function choice() {
      passwordLabel.hidden = select.value !== "password";
      password.required = !passwordLabel.hidden;
      password.value = "";
    }
    select.addEventListener("change", choice);
    choice();
    message.role = "status";
    message.setAttribute("aria-live", "polite");
    message.setAttribute("aria-atomic", "true");
    submit.type = "submit";
    submit.className = "button";
    submit.textContent =
      purpose === "recovery.cost.consent" ? "Record consent" : "Approve change";
    cancel.type = "button";
    cancel.className = "button-secondary";
    cancel.textContent = "Cancel";
    submit.disabled = !select.options.length;
    if (!select.options.length)
      message.textContent =
        "An existing trusted credential is required. Recover your retained passkey or linked wallet before changing account security.";
    form.append(
      title,
      description,
      label,
      passwordLabel,
      message,
      submit,
      cancel,
    );
    dialog.append(form);
    document.body.append(dialog);
    const prior =
      restoreTarget ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    return new Promise((resolve, reject) => {
      let finished = false,
        submitting = false;
      const close = (restoreFocus = true) => {
        if (cancelApproval === cancelForLogout) cancelApproval = undefined;
        password.value = "";
        dialog.close();
        dialog.remove();
        if (restoreFocus) {
          const restore = (remainingFrames: number) => {
            if (
              generation !== logoutGeneration ||
              approvalAccount !== (window.yapCurrentSessionAccount?.() ?? null)
            )
              return;
            const active = document.activeElement;
            if (
              active &&
              active !== document.body &&
              active !== document.documentElement &&
              active !== prior
            )
              return;
            if (
              prior?.isConnected &&
              prior !== document.body &&
              prior !== document.documentElement &&
              !prior.matches(":disabled") &&
              prior.getClientRects().length > 0
            ) {
              prior.focus();
            } else if (remainingFrames > 0) {
              requestAnimationFrame(() => restore(remainingFrames - 1));
            } else {
              focusSection();
            }
          };
          // The React opener is still disabled until its rejected/returned
          // approval promise commits the busy-state render. Wait at most two
          // frames, preserving any newer user focus or account transition.
          requestAnimationFrame(() => restore(1));
        }
      };
      const cancelForLogout = () => {
        if (finished) return;
        finished = true;
        WebAuthnAbortService.cancelCeremony();
        close(false);
        reject(new DOMException("Security change cancelled", "AbortError"));
      };
      cancelApproval = cancelForLogout;
      const abort = () => {
        if (finished || submitting) return;
        finished = true;
        close();
        reject(
          new DOMException("Security change cancelled", "NotAllowedError"),
        );
      };
      cancel.addEventListener("click", abort);
      dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        abort();
      });
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (submitting || !select.value) return;
        submitting = true;
        submit.disabled = true;
        cancel.disabled = true;
        select.disabled = true;
        password.disabled = true;
        message.textContent = "Waiting for your approval…";
        try {
          const selected = select.value,
            credential: SecurityCredential =
              selected === "password"
                ? { type: "password" }
                : selected.startsWith("passkey:")
                  ? { type: "passkey", keyId: selected.slice(8) }
                  : { type: "wallet", walletId: selected.slice(7) };
          const operation = issue
            ? await issue(credential)
            : await api<Operation>("/security/operations", "POST", {
                purpose,
                terms,
                credential,
              });
          if (finished || generation !== logoutGeneration) return;
          const proof: SecurityApproval = { id: operation.id };
          if (selected === "password") proof.password = password.value;
          else if (selected.startsWith("passkey:")) {
            if (!operation.authenticationOptions)
              throw new Error("Passkey approval is unavailable.");
            proof.authentication = await startAuthentication({
              optionsJSON: operation.authenticationOptions,
            });
          } else {
            const wallet = choices.wallets.find(
              (wallet) => wallet.id === selected.slice(7),
            );
            if (!wallet || !operation.authorizationMessage)
              throw new Error("Linked wallet approval is unavailable.");
            proof.signature = await walletSignature(
              operation.authorizationMessage,
              wallet,
            );
          }
          if (finished || generation !== logoutGeneration) return;
          finished = true;
          password.value = "";
          close();
          resolve(proof);
        } catch (error) {
          if (finished) return;
          message.textContent =
            error instanceof Error
              ? error.message
              : "Approval failed. Try again.";
        } finally {
          submitting = false;
          if (!finished) {
            submit.disabled = false;
            cancel.disabled = false;
            select.disabled = false;
            password.disabled = false;
          }
        }
      });
      dialog.showModal();
      select.focus();
    });
  }
  async function removeKey(key: SecurityKey) {
    if (busy) return;
    const generation = logoutGeneration;
    setBusy(true);
    let completionSent = false;
    try {
      const proof = await approval(
        "security.passkey.remove",
        { keyId: key.id },
        key.id,
      );
      assertGeneration(generation);
      completionSent = true;
      await request(
        `/security/passkeys/${encodeURIComponent(key.id)}`,
        "DELETE",
        {
          approval: proof,
        },
      );
      assertGeneration(generation);
      await load();
      assertGeneration(generation);
      notice.textContent =
        "Existing security key removed. Other sessions were signed out.";
      setBusy(false);
      focusSection();
      changed();
    } catch (error) {
      if (generation !== logoutGeneration) return;
      notice.textContent =
        completionSent && !(error instanceof SecurityResponseError)
          ? "Removal could not be confirmed. Refresh your passkey list before trying again."
          : error instanceof Error && error.name === "NotAllowedError"
            ? "Passkey removal cancelled."
            : error instanceof Error
              ? error.message
              : "Passkey removal is unavailable.";
    } finally {
      if (generation === logoutGeneration) {
        setBusy(false);
        focusSection();
      }
    }
  }
  async function changeWallet(target: WalletChangeTarget) {
    if (busy) return;
    const generation = logoutGeneration;
    setBusy(true);
    const prior =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    let completionSent = false;
    try {
      const issued: {
        operation?: Operation & { proposedMessage: string | null };
      } = {};
      const terms = {
        address: target.address,
        chainId: String(target.chainId),
        ...(target.targetWalletId
          ? { targetWalletId: target.targetWalletId }
          : {}),
      };
      const proof = await approval(
        `wallet.${target.purpose}`,
        terms,
        undefined,
        async (credential) => {
          const operation = await api<
            Operation & { proposedMessage: string | null }
          >("/security/wallet/operations", "POST", { ...target, credential });
          issued.operation = operation;
          return operation;
        },
        target.purpose === "unlink" ? target.targetWalletId : undefined,
      );
      assertGeneration(generation);
      let proposedSignature: string | undefined;
      if (target.purpose === "link") {
        if (!issued.operation?.proposedMessage)
          throw new Error("New wallet proof is unavailable. Start again.");
        notice.textContent =
          "Prove control of the new wallet in your wallet’s prompt.";
        proposedSignature = await walletSignature(
          issued.operation.proposedMessage,
          { address: target.address, chainId: String(target.chainId) },
        );
        assertGeneration(generation);
      }
      completionSent = true;
      await api(
        `/security/wallet/operations/${encodeURIComponent(proof.id)}/complete`,
        "POST",
        { ...target, approval: proof, proposedSignature },
      );
      assertGeneration(generation);
      await load();
      assertGeneration(generation);
      notice.textContent =
        target.purpose === "link"
          ? "Wallet linked. Your session was renewed."
          : "Wallet unlinked. Other sessions were signed out.";
      setBusy(false);
      if (prior?.isConnected) prior.focus();
      else focusSection();
      changed();
    } catch (error) {
      if (generation !== logoutGeneration) return;
      notice.textContent =
        completionSent && !(error instanceof SecurityResponseError)
          ? "The wallet change could not be confirmed. Refresh linked wallets before trying again."
          : error instanceof Error && error.name === "NotAllowedError"
            ? "Wallet change cancelled."
            : error instanceof Error
              ? error.message
              : "Wallet change is unavailable.";
    } finally {
      if (generation === logoutGeneration) {
        setBusy(false);
        if (prior?.isConnected) prior.focus();
        else focusSection();
      }
    }
  }
  async function linkProviderIdentity(token: string) {
    if (busy) throw new Error("Finish the current security change first.");
    const generation = logoutGeneration;
    setBusy(true);
    let completionSent = false;
    try {
      const candidate = await api<{ email: string | null; methods: string[] }>(
        "/security/provider/candidate",
        "POST",
        {},
        token,
      );
      assertGeneration(generation);
      const proof = await approval(
        "provider.identity.link",
        { email: candidate.email ?? "the verified account" },
        undefined,
        async (credential) => {
          const operation = await api<
            Operation & { email: string | null; methods: string[] }
          >("/security/provider/link", "POST", { credential }, token);
          if (
            operation.email !== candidate.email ||
            JSON.stringify(operation.methods) !==
              JSON.stringify(candidate.methods)
          )
            throw new Error("Sign-in details changed. Start again.");
          return operation;
        },
      );
      assertGeneration(generation);
      completionSent = true;
      await request(
        `/security/provider/link/${encodeURIComponent(proof.id)}/complete`,
        "POST",
        { approval: proof },
        token,
      );
      assertGeneration(generation);
      await load();
      assertGeneration(generation);
      notice.textContent =
        "Sign-in method linked to your existing account. Other sessions were signed out.";
      setBusy(false);
      focusSection();
      changed();
    } catch (error) {
      if (generation !== logoutGeneration) throw error;
      notice.textContent =
        completionSent && !(error instanceof SecurityResponseError)
          ? "The link result could not be confirmed. Refresh account settings before trying again."
          : error instanceof Error && error.name === "NotAllowedError"
            ? "Linking cancelled."
            : error instanceof Error
              ? error.message
              : "Sign-in linking is unavailable.";
      throw error;
    } finally {
      if (generation === logoutGeneration) {
        setBusy(false);
        focusSection();
      }
    }
  }
  async function recoverProviderIdentity(token: string) {
    if (busy) throw new Error("Finish the current security change first.");
    const generation = logoutGeneration;
    setBusy(true);
    let completionSent = false;
    try {
      const candidate = await api<{
        oldMethod: string;
        oldIdentifier: string;
        newEmail: string;
        terms: Record<string, string>;
      }>("/security/provider/recovery/candidate", "POST", {}, token);
      assertGeneration(generation);
      const proof = await approval(
        "provider.identity.recover",
        candidate.terms,
        undefined,
        async (credential) => {
          if (credential.type !== "passkey")
            throw new Error("Use your retained passkey.");
          const operation = await api<Operation & typeof candidate>(
            "/security/provider/recovery",
            "POST",
            { credential },
            token,
          );
          const canonical = (terms: Record<string, string>) =>
            JSON.stringify(
              Object.entries(terms).sort(([a], [b]) => a.localeCompare(b)),
            );
          if (
            operation.oldMethod !== candidate.oldMethod ||
            operation.oldIdentifier !== candidate.oldIdentifier ||
            operation.newEmail !== candidate.newEmail ||
            canonical(operation.terms) !== canonical(candidate.terms)
          )
            throw new Error("Recovery details changed. Start again.");
          return operation;
        },
      );
      assertGeneration(generation);
      completionSent = true;
      await request(
        `/security/provider/recovery/${encodeURIComponent(proof.id)}/complete`,
        "POST",
        { approval: proof },
        token,
      );
      assertGeneration(generation);
      notice.textContent =
        "Lost sign-in replaced. Your account and balances were preserved; the old sign-in is permanently retired.";
    } catch (error) {
      if (generation === logoutGeneration)
        notice.textContent =
          completionSent && !(error instanceof SecurityResponseError)
            ? "The recovery result could not be confirmed. Refresh your account before retrying; no accounts will be merged."
            : error instanceof Error
              ? error.message
              : "Sign-in recovery is unavailable.";
      throw error;
    } finally {
      if (generation === logoutGeneration) setBusy(false);
    }
  }
  async function approveProviderChange(change: ProviderChange) {
    if (busy) throw new Error("Finish the current security change first.");
    const generation = logoutGeneration;
    setBusy(true);
    try {
      const terms = { ...change },
        proof = await approval("provider.credentials.change", terms);
      assertGeneration(generation);
      await request("/security/provider/change", "POST", {
        terms,
        approval: proof,
      });
    } finally {
      if (generation === logoutGeneration) setBusy(false);
    }
  }
  async function prepareProviderPasskey(
    terms: ProviderPasskeyTerms,
    resume?: { intentId: string; token: string },
    returnFocus?: HTMLElement,
  ) {
    if (busy) throw new Error("Finish the current security change first.");
    if (resume && resume.intentId !== terms.intentId)
      throw new Error("Passkey setup changed. Refresh Account settings.");
    const generation = logoutGeneration;
    setBusy(true);
    try {
      // The bridge consumes this proof only after Privy verifies the new key.
      // Returning it here must not authorize or consume a separate operation.
      const proof = await approval(
        "provider.passkey.link",
        { ...terms },
        undefined,
        resume
          ? async (credential) => {
              const operation = await api<
                Operation & { terms: ProviderPasskeyTerms }
              >(
                `/security/provider/passkeys/${encodeURIComponent(resume.intentId)}/operations`,
                "POST",
                { credential },
                resume.token,
              );
              if (
                operation.terms.intentId !== terms.intentId ||
                operation.terms.subject !== terms.subject ||
                operation.terms.beforeDigest !== terms.beforeDigest
              )
                throw new Error(
                  "Passkey setup changed. Refresh Account settings.",
                );
              return operation;
            }
          : undefined,
        undefined,
        resume
          ? () =>
              api<ApprovalChoices>(
                "/security/access/reconciliation/candidate",
                "POST",
                {},
                resume.token,
              )
          : undefined,
        returnFocus,
      );
      assertGeneration(generation);
      return proof;
    } finally {
      if (generation === logoutGeneration) setBusy(false);
    }
  }
  async function approveCoinWithdrawal(
    requestId: string,
    terms: Record<string, string>,
    sessionId: string,
  ) {
    return approveSandboxOperation(
      "withdrawal.request",
      terms,
      sessionId,
      `/withdrawals/${encodeURIComponent(requestId)}/operations`,
      {},
    );
  }
  async function approveRecoveryCost(
    reportId: string,
    quoteId: string,
    terms: Record<string, string>,
    sessionId: string,
  ) {
    return approveSandboxOperation(
      "recovery.cost.consent",
      terms,
      sessionId,
      `/reports/${encodeURIComponent(reportId)}/recovery-consents/authorization`,
      { quoteId },
    );
  }
  async function approveSandboxOperation(
    purpose: "withdrawal.request" | "recovery.cost.consent",
    terms: Record<string, string>,
    sessionId: string,
    path: string,
    additionalBody: Readonly<Record<string, string>>,
  ) {
    if (busy) throw new Error("Finish the current security change first.");
    const generation = logoutGeneration;
    setBusy(true);
    try {
      return await approval(purpose, terms, undefined, async (credential) => {
        const response = await fetch(`/api/coin-sandbox${path}`, {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: {
            "Content-Type": "application/json",
            "X-YapArena-Session": sessionId,
          },
          body: JSON.stringify({ ...additionalBody, credential }),
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) {
          const value: { error?: string } = await response
            .json()
            .catch(() => ({}));
          throw new SecurityResponseError(
            value.error ?? "Sandbox approval unavailable.",
          );
        }
        const operation: Operation & { terms: Record<string, string> } =
          await response.json();
        const normalize = (record: Record<string, string>) =>
          JSON.stringify(
            Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
          );
        if (normalize(operation.terms) !== normalize(terms))
          throw new Error(
            "Sandbox terms changed. Refresh the quote and review it again.",
          );
        return operation;
      });
    } finally {
      if (generation === logoutGeneration) setBusy(false);
    }
  }
  function cancelSecurityChange() {
    ++logoutGeneration;
    cancelApproval?.();
    WebAuthnAbortService.cancelCeremony();
    setBusy(false);
  }
  window.addEventListener("yap:account-changed", () => {
    cancelSecurityChange();
    root.hidden = true;
    list.replaceChildren();
    void load();
  });
  window.addEventListener("yap:provider-logout", () => {
    cancelSecurityChange();
    delete window.yapSecurityWalletChange;
    delete window.yapLinkProviderIdentity;
    delete window.yapRecoverProviderIdentity;
    delete window.yapApproveProviderChange;
    delete window.yapPrepareProviderPasskey;
    delete window.yapApproveCoinWithdrawal;
    delete window.yapApproveRecoveryCost;
    ++version;
    keys = [];
    list.replaceChildren();
    root.hidden = true;
    notice.textContent = "";
    lastLoadError = null;
  });
  // A refresh after the SDK linked a key can deliberately fence normal reads.
  // Keep this scoped helper available so its exact pending intent can resume.
  window.yapPrepareProviderPasskey = prepareProviderPasskey;
  void load();
}
