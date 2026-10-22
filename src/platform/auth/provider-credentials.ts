import { createHash } from "node:crypto";

export type ProviderCredential = {
  type: "email" | "google_oauth" | "passkey";
  id: string;
};

export function providerCredentialsDigest(credentials: ProviderCredential[]) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        credentials.map(({ type, id }) => JSON.stringify([type, id])).sort(),
      ),
    )
    .digest("hex");
}

export function verifiedStoredCredentials(mapping: {
  email: string | null;
  methods: string[];
  credentialsDigest: string;
  credentialsSnapshot: ProviderCredential[] | null;
}): ProviderCredential[] | null {
  if (
    mapping.credentialsSnapshot &&
    providerCredentialsDigest(mapping.credentialsSnapshot) ===
      mapping.credentialsDigest
  )
    return mapping.credentialsSnapshot;
  // Older email-only mappings contain enough verified data to reconstruct the
  // exact old digest. Never infer a Google subject or passkey ID from an email.
  const email =
    mapping.email &&
    mapping.methods.length === 1 &&
    mapping.methods[0] === "email"
      ? [{ type: "email" as const, id: mapping.email }]
      : null;
  return email && providerCredentialsDigest(email) === mapping.credentialsDigest
    ? email
    : null;
}
