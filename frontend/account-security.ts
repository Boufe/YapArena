import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

type SecurityKey = {
  id: string;
  createdAt: string;
  deviceType: string;
  backedUp: boolean;
};
type Wallet = { id: string; address: string; chainId: string };
type Approval = {
  id: string;
  password?: string;
  signature?: string;
  authentication?: AuthenticationResponseJSON;
};
type Operation = {
  id: string;
  authorizationMessage: string | null;
  authenticationOptions?: PublicKeyCredentialRequestOptionsJSON;
};

const mount = document.querySelector<HTMLElement>("#account-security-passkeys");
if (mount) {
  const root = mount;
  const heading = document.createElement("h2");
  heading.textContent = "Security passkeys";
  const help = document.createElement("p");
  help.textContent =
    "Approve account changes and withdrawals with your device or security key. Keep your existing sign-in method available.";
  const list = document.createElement("ul");
  list.className = "account-list";
  const notice = document.createElement("p");
  notice.role = "status";
  notice.setAttribute("aria-live", "polite");
  notice.setAttribute("aria-atomic", "true");
  const add = document.createElement("button");
  add.type = "button";
  add.className = "button-secondary";
  add.textContent = "Add security passkey";
  root.append(heading, help, list, add, notice);
  let keys: SecurityKey[] = [],
    busy = false,
    version = 0;
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<Response> {
    const response = await fetch(`/api/auth${path}`, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      const data: { error?: string } = await response.json().catch(() => ({}));
      throw new Error(
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
  ): Promise<T> {
    const response = await request(path, method, body);
    return response.json();
  }
  function setBusy(value: boolean) {
    busy = value;
    add.disabled = value;
    for (const button of list.querySelectorAll("button"))
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
      keys = data.passkeys;
      list.replaceChildren();
      for (const key of keys) {
        const item = document.createElement("li"),
          description = document.createElement("p"),
          remove = document.createElement("button");
        const created = new Date(key.createdAt).toLocaleString();
        description.textContent = `Security passkey · Added ${created}`;
        remove.type = "button";
        remove.className = "button-secondary";
        remove.textContent = "Remove passkey";
        remove.setAttribute(
          "aria-label",
          `Remove security passkey added ${created}`,
        );
        remove.disabled = busy;
        remove.addEventListener("click", () => void removeKey(key));
        item.append(description, remove);
        list.append(item);
      }
      if (!keys.length) {
        const item = document.createElement("li");
        item.textContent = "No security passkey added yet.";
        list.append(item);
      }
    } catch (error) {
      if (current === version)
        notice.textContent =
          error instanceof Error
            ? error.message
            : "Security settings are unavailable.";
    }
  }
  async function walletSignature(message: string, wallet: Wallet) {
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
  ): Promise<Approval> {
    const [methods, walletData] = await Promise.all([
      api<{ legacyPassword: boolean }>("/methods"),
      api<{ wallets: Wallet[] }>("/wallets"),
    ]);
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
        ? "Remove security passkey"
        : "Add security passkey";
    dialog.setAttribute("aria-labelledby", titleId);
    description.textContent =
      "Approve this change with a trusted method that stays on your account. Approval expires in five minutes.";
    label.textContent = "Approve with ";
    label.append(select);
    passwordLabel.textContent = "Current password ";
    password.type = "password";
    password.autocomplete = "current-password";
    passwordLabel.append(password);
    for (const key of keys.filter((key) => key.id !== excludedKey)) {
      const option = document.createElement("option");
      option.value = `passkey:${key.id}`;
      option.textContent = `Security passkey added ${new Date(key.createdAt).toLocaleString()}`;
      select.append(option);
    }
    if (methods.legacyPassword) {
      const option = document.createElement("option");
      option.value = "password";
      option.textContent = "Current password";
      select.append(option);
    }
    for (const wallet of walletData.wallets) {
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
    submit.textContent = "Approve change";
    cancel.type = "button";
    cancel.className = "button-secondary";
    cancel.textContent = "Cancel";
    submit.disabled = !select.options.length;
    if (!select.options.length)
      message.textContent =
        "An existing trusted credential is required. Recover your security passkey or linked wallet before changing account security.";
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
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    return new Promise((resolve, reject) => {
      let finished = false,
        submitting = false;
      const close = () => {
        dialog.close();
        dialog.remove();
        (prior?.isConnected ? prior : add).focus();
      };
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
            credential =
              selected === "password"
                ? { type: "password" }
                : selected.startsWith("passkey:")
                  ? { type: "passkey", keyId: selected.slice(8) }
                  : { type: "wallet", walletId: selected.slice(7) };
          const operation = await api<Operation>(
            "/security/operations",
            "POST",
            { purpose, terms, credential },
          );
          const proof: Approval = { id: operation.id };
          if (selected === "password") proof.password = password.value;
          else if (selected.startsWith("passkey:")) {
            if (!operation.authenticationOptions)
              throw new Error("Security passkey approval is unavailable.");
            proof.authentication = await startAuthentication({
              optionsJSON: operation.authenticationOptions,
            });
          } else {
            const wallet = walletData.wallets.find(
              (wallet) => wallet.id === selected.slice(7),
            );
            if (!wallet || !operation.authorizationMessage)
              throw new Error("Linked wallet approval is unavailable.");
            proof.signature = await walletSignature(
              operation.authorizationMessage,
              wallet,
            );
          }
          finished = true;
          password.value = "";
          close();
          resolve(proof);
        } catch (error) {
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
  async function enroll() {
    if (busy) return;
    setBusy(true);
    notice.textContent = "Preparing security passkey setup…";
    let completionSent = false;
    try {
      const challenge = await api<{
        id: string;
        options: PublicKeyCredentialCreationOptionsJSON;
        bootstrapAllowed: boolean;
      }>("/security/passkeys/enrollment", "POST", {});
      const proof = challenge.bootstrapAllowed
        ? undefined
        : await approval("security.passkey.enroll", {
            challengeId: challenge.id,
          });
      notice.textContent =
        "Follow your device’s prompt to create your security passkey.";
      const response = await startRegistration({
        optionsJSON: challenge.options,
      });
      completionSent = true;
      await api(
        `/security/passkeys/enrollment/${encodeURIComponent(challenge.id)}/complete`,
        "POST",
        { response, approval: proof },
      );
      changed();
      await load();
      notice.textContent =
        "Security passkey added. Other sessions were signed out.";
    } catch (error) {
      notice.textContent = completionSent
        ? "The setup result could not be confirmed. Refresh your passkey list before trying again."
        : error instanceof Error && error.name === "NotAllowedError"
          ? "Security passkey setup cancelled."
          : error instanceof Error
            ? error.message
            : "Security passkey setup is unavailable.";
    } finally {
      setBusy(false);
      add.focus();
    }
  }
  async function removeKey(key: SecurityKey) {
    if (busy) return;
    setBusy(true);
    let completionSent = false;
    try {
      const proof = await approval(
        "security.passkey.remove",
        { keyId: key.id },
        key.id,
      );
      completionSent = true;
      await request(
        `/security/passkeys/${encodeURIComponent(key.id)}`,
        "DELETE",
        {
          approval: proof,
        },
      );
      changed();
      await load();
      notice.textContent =
        "Security passkey removed. Other sessions were signed out.";
    } catch (error) {
      notice.textContent = completionSent
        ? "Removal could not be confirmed. Refresh your passkey list before trying again."
        : error instanceof Error && error.name === "NotAllowedError"
          ? "Passkey removal cancelled."
          : error instanceof Error
            ? error.message
            : "Passkey removal is unavailable.";
    } finally {
      setBusy(false);
      add.focus();
    }
  }
  add.addEventListener("click", () => void enroll());
  window.addEventListener("yap:account-changed", () => void load());
  window.addEventListener("yap:provider-logout", () => {
    ++version;
    keys = [];
    list.replaceChildren();
    notice.textContent = "";
  });
  void load();
}
