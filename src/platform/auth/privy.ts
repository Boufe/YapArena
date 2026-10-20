import { PrivyClient, NotFoundError } from "@privy-io/node";
import {
  providerCredentialsDigest,
  type ProviderCredential,
} from "./provider-credentials.ts";

export type ProviderIdentity = {
  subject: string;
  sessionId: string;
  email: string | null;
  methods: string[];
  issuedAt: number;
  credentialsDigest: string;
  credentials?: ProviderCredential[];
};
export type IdentityVerifier = {
  verify(token: string): Promise<ProviderIdentity>;
  inspect(
    subject: string,
  ): Promise<
    Pick<
      ProviderIdentity,
      "subject" | "email" | "methods" | "credentialsDigest" | "credentials"
    >
  >;
  configuration(): Promise<{ google: boolean; passkeys: boolean }>;
};
export class ProviderUnavailableError extends Error {}
export class ProviderCredentialChangedError extends Error {}

export function createPrivyVerifier(config: {
  appId: string;
  appSecret: string;
  verificationKey?: string;
  fetch?: typeof globalThis.fetch;
}): IdentityVerifier {
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
      (user.frozen_at !== undefined && user.frozen_at !== null)
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
    return {
      subject,
      email: email?.type === "email" ? email.address : null,
      methods: [
        ...new Set(user.linked_accounts.map((entry) => entry.type)),
      ].sort(),
      credentialsDigest: providerCredentialsDigest(credentials),
      credentials,
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
}): ProviderSessionControl {
  const client = new PrivyClient({
    appId: config.appId,
    appSecret: config.appSecret,
    timeout: 5_000,
    maxRetries: 0,
  });
  return {
    async state(subject, options) {
      const user = await client.users()._get(subject, options);
      return { frozenAt: user.frozen_at ?? null };
    },
    async freeze(subject, options) {
      const result = await client.users().freeze(subject, options);
      if (!result.success) throw new Error("provider freeze failed");
    },
    async unfreeze(subject, options) {
      const result = await client.users().unfreeze(subject, options);
      if (!result.success) throw new Error("provider unfreeze failed");
    },
  };
}
