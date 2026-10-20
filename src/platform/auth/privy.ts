import { PrivyClient, NotFoundError } from "@privy-io/node";
import {
  providerCredentialsDigest,
  type ProviderCredential,
} from "./provider-credentials.ts";

export type ProviderPasskeyEvidence = {
  credentialId: string;
  publicKey: string | null;
};
export type ProviderIdentity = {
  subject: string;
  sessionId: string;
  email: string | null;
  methods: string[];
  issuedAt: number;
  credentialsDigest: string;
  credentials?: ProviderCredential[];
  passkeys?: ProviderPasskeyEvidence[];
};
export type IdentityVerifier = {
  verify(token: string): Promise<ProviderIdentity>;
  inspect(
    subject: string,
  ): Promise<
    Pick<
      ProviderIdentity,
      | "subject"
      | "email"
      | "methods"
      | "credentialsDigest"
      | "credentials"
      | "passkeys"
    >
  >;
  configuration(): Promise<{ google: boolean; passkeys: boolean }>;
};
export class ProviderUnavailableError extends Error {}
export class ProviderCredentialChangedError extends Error {}

type PrivyVerifierConfiguration = {
  appId: string;
  appSecret: string;
  verificationKey?: string;
  fetch?: typeof globalThis.fetch;
};
export function createPrivyVerifier(
  config: PrivyVerifierConfiguration,
): IdentityVerifier {
  return privyVerifier(config, false);
}
// This read-only view is for a separately owner-guarded reconciliation process.
// It is deliberately not an authentication verifier and exposes no token API.
export function createPrivyOperatorInspector(
  config: PrivyVerifierConfiguration,
): Pick<IdentityVerifier, "inspect"> {
  return { inspect: privyVerifier(config, true).inspect };
}
function privyVerifier(
  config: PrivyVerifierConfiguration,
  operatorFrozenView: boolean,
): IdentityVerifier {
  const client = new PrivyClient({
    appId: config.appId,
    appSecret: config.appSecret,
    jwtVerificationKey: config.verificationKey?.replace(/\\n/g, "\n"),
    timeout: 5_000,
    maxRetries: 0,
    fetch: config.fetch,
  });
  async function configuration() {
    try {
      const settings = await client.apps().getSettings();
      // Provider-side automatic merging can change the owner behind a DID.
      // Recheck at exchange time rather than caching an ownership decision.
      if (!settings.email_auth || settings.merge_accounts_by_email !== false)
        throw new Error("unsafe provider account configuration");
      return {
        google: settings.google_oauth,
        passkeys: settings.passkey_auth,
      };
    } catch {
      throw new ProviderUnavailableError("provider configuration unavailable");
    }
  }
  async function inspect(subject: string) {
    const user = await client
      .users()
      ._get(subject)
      .catch((error: unknown) => {
        if (error instanceof NotFoundError)
          throw new ProviderCredentialChangedError(
            "provider account unavailable",
          );
        throw new ProviderUnavailableError("provider identity unavailable");
      });
    if (
      user.id !== subject ||
      user.is_guest ||
      (!operatorFrozenView &&
        user.frozen_at !== undefined &&
        user.frozen_at !== null)
    )
      throw new ProviderCredentialChangedError("provider account unavailable");
    const email = user.linked_accounts.find((entry) => entry.type === "email");
    const credentials: ProviderCredential[] = user.linked_accounts
      .map((entry): ProviderCredential => {
        if (entry.type === "email") return { type: "email", id: entry.address };
        if (entry.type === "google_oauth")
          return { type: "google_oauth", id: entry.subject };
        if (entry.type === "passkey")
          return { type: "passkey", id: entry.credential_id };
        throw new ProviderCredentialChangedError(
          "unsupported authentication method",
        );
      })
      .sort((a, b) =>
        JSON.stringify([a.type, a.id]).localeCompare(
          JSON.stringify([b.type, b.id]),
        ),
      );
    if (!credentials.length)
      throw new ProviderCredentialChangedError(
        "authentication method required",
      );
    const passkeys: ProviderPasskeyEvidence[] = user.linked_accounts.flatMap(
      (entry) =>
        entry.type === "passkey"
          ? [
              {
                credentialId: entry.credential_id,
                publicKey: entry.public_key ?? null,
              },
            ]
          : [],
    );
    return {
      subject,
      email: email?.type === "email" ? email.address : null,
      methods: [
        ...new Set(user.linked_accounts.map((entry) => entry.type)),
      ].sort(),
      credentialsDigest: providerCredentialsDigest(credentials),
      credentials,
      ...(passkeys.length ? { passkeys } : {}),
    };
  }
  return {
    configuration,
    inspect,
    async verify(token) {
      const claims = await client.utils().auth().verifyAccessToken(token);
      await configuration();
      // The supported verifier checks signature, issuer, audience and expiry.
      // Fetch linked accounts server-side; never accept browser ownership claims.
      const identity = await inspect(claims.user_id);
      if (!claims.session_id) throw new Error("provider identity unavailable");
      return {
        ...identity,
        sessionId: claims.session_id,
        issuedAt: claims.issued_at,
      };
    },
  };
}

export type ProviderSessionControl = {
  state(
    subject: string,
    options?: { signal: AbortSignal },
  ): Promise<{ frozenAt: number | null }>;
  freeze(subject: string, options?: { signal: AbortSignal }): Promise<void>;
  unfreeze(subject: string, options?: { signal: AbortSignal }): Promise<void>;
};
export function createPrivySessionControl(config: {
  appId: string;
  appSecret: string;
  fetch?: typeof globalThis.fetch;
}): ProviderSessionControl {
  const client = new PrivyClient({
    appId: config.appId,
    appSecret: config.appSecret,
    timeout: 5_000,
    maxRetries: 0,
    fetch: config.fetch,
  });
  return {
    async state(subject, options) {
      const user = await client.users()._get(subject, options);
      if (
        user.id !== subject ||
        !Object.hasOwn(user, "frozen_at") ||
        (user.frozen_at !== null &&
          (typeof user.frozen_at !== "number" ||
            !Number.isSafeInteger(user.frozen_at) ||
            user.frozen_at <= 0))
      )
        throw new ProviderUnavailableError("provider freeze state unavailable");
      return { frozenAt: user.frozen_at };
    },
    async freeze(subject, options) {
      const result = await client.users().freeze(subject, {
        ...options,
        body: {},
      });
      if (!result.success) throw new Error("provider freeze failed");
    },
    async unfreeze(subject, options) {
      const result = await client.users().unfreeze(subject, {
        ...options,
        body: {},
      });
      if (!result.success) throw new Error("provider unfreeze failed");
    },
  };
}
