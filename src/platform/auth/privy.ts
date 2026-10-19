import { PrivyClient } from "@privy-io/node";
import { createHash } from "node:crypto";

export type ProviderIdentity = {
  subject: string;
  sessionId: string;
  email: string | null;
  methods: string[];
  issuedAt: number;
  credentialsDigest: string;
};
export type IdentityVerifier = {
  verify(token: string): Promise<ProviderIdentity>;
  configuration(): Promise<{ google: boolean; passkeys: boolean }>;
};
export class ProviderUnavailableError extends Error {}

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
  return {
    configuration,
    async verify(token) {
      const claims = await client.utils().auth().verifyAccessToken(token);
      await configuration();
      // The supported verifier checks signature, issuer, audience and expiry.
      // Fetch linked accounts server-side; never accept browser ownership claims.
      const user = await client
        .users()
        ._get(claims.user_id)
        .catch(() => {
          throw new ProviderUnavailableError("provider identity unavailable");
        });
      if (
        user.id !== claims.user_id ||
        user.is_guest ||
        user.frozen_at ||
        !claims.session_id
      )
        throw new Error("provider identity unavailable");
      const email = user.linked_accounts.find(
        (entry) => entry.type === "email",
      );
      const credentials = user.linked_accounts
        .map((entry) => {
          if (entry.type === "email") return ["email", entry.address];
          if (entry.type === "google_oauth")
            return ["google_oauth", entry.subject];
          if (entry.type === "passkey") return ["passkey", entry.credential_id];
          throw new Error("unsupported authentication method");
        })
        .map((value) => JSON.stringify(value))
        .sort();
      if (!credentials.length)
        throw new Error("authentication method required");
      return {
        subject: claims.user_id,
        sessionId: claims.session_id,
        email: email?.type === "email" ? email.address : null,
        methods: [
          ...new Set(user.linked_accounts.map((entry) => entry.type)),
        ].sort(),
        issuedAt: claims.issued_at,
        credentialsDigest: createHash("sha256")
          .update(JSON.stringify(credentials))
          .digest("hex"),
      };
    },
  };
}

export type ProviderSessionControl = {
  state(subject: string): Promise<{ frozenAt: number | null }>;
  freeze(subject: string): Promise<void>;
  unfreeze(subject: string): Promise<void>;
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
    async state(subject) {
      const user = await client.users()._get(subject);
      return { frozenAt: user.frozen_at ?? null };
    },
    async freeze(subject) {
      const result = await client.users().freeze(subject);
      if (!result.success) throw new Error("provider freeze failed");
    },
    async unfreeze(subject) {
      const result = await client.users().unfreeze(subject);
      if (!result.success) throw new Error("provider unfreeze failed");
    },
  };
}
