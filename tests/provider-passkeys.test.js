import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import {
  inspectProviderPasskeyAddition,
  parseProviderPasskeyPublicKey,
} from "../dist/platform/auth/provider-passkeys.js";
import { providerCredentialsDigest } from "../dist/platform/auth/provider-credentials.js";
import { providerPasskeyFixture } from "./provider-passkey-fixture.js";

describe("trusted Privy passkey public-key and exact-addition parsing", () => {
  it("accepts complete standard/base64url COSE bytes without inventing missing key evidence", () => {
    const key = providerPasskeyFixture();
    for (const encoding of ["base64", "base64url"]) {
      const parsed = parseProviderPasskeyPublicKey(
        key.publicKey.toString(encoding),
      );
      assert.deepEqual(parsed.publicKey, key.publicKey);
      assert.equal(
        parsed.publicKeyDigest,
        createHash("sha256").update(key.publicKey).digest("hex"),
      );
    }
    for (const value of [
      null,
      undefined,
      "",
      "not a key",
      "===",
      "a".repeat(6000),
    ])
      assert.throws(() => parseProviderPasskeyPublicKey(value), {
        status: 503,
      });
  });

  it("rejects trailing data, duplicate COSE labels, private values and unsupported or incomplete keys", () => {
    const key = providerPasskeyFixture();
    for (const bytes of [
      Buffer.concat([key.publicKey, Buffer.from([0])]),
      Buffer.from([0xa2, 0x01, 0x02, 0x01, 0x02]),
      isoCBOR.encode(
        new Map([
          [1, 2],
          [3, -7],
          [-1, 1],
        ]),
      ),
      isoCBOR.encode(
        new Map([
          [1, 4],
          [3, -7],
          [-1, new Uint8Array(32)],
        ]),
      ),
      isoCBOR.encode([1, 2, 3]),
      isoCBOR.encode(
        new Map([
          ...isoCBOR.decodeFirst(key.publicKey),
          [-4, new Uint8Array(32)],
        ]),
      ),
    ])
      assert.throws(
        () =>
          parseProviderPasskeyPublicKey(Buffer.from(bytes).toString("base64")),
        { status: 503 },
      );
  });

  it("parses supported public Ed25519 and RSA keys while rejecting curve/algorithm confusion", () => {
    const ed = generateKeyPairSync("ed25519").publicKey.export({
      format: "jwk",
    });
    const rsa = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    }).publicKey.export({ format: "jwk" });
    for (const values of [
      new Map([
        [1, 1],
        [3, -8],
        [-1, 6],
        [-2, new Uint8Array(Buffer.from(ed.x, "base64url"))],
      ]),
      new Map([
        [1, 3],
        [3, -257],
        [-1, new Uint8Array(Buffer.from(rsa.n, "base64url"))],
        [-2, new Uint8Array(Buffer.from(rsa.e, "base64url"))],
      ]),
    ]) {
      const encoded = Buffer.from(isoCBOR.encode(values)).toString("base64");
      assert.ok(parseProviderPasskeyPublicKey(encoded).publicKey.length >= 16);
      values.set(3, -7);
      assert.throws(
        () =>
          parseProviderPasskeyPublicKey(
            Buffer.from(isoCBOR.encode(values)).toString("base64"),
          ),
        { status: 503 },
      );
    }
  });

  it("accepts only the exact old credential set plus one trusted new passkey", () => {
    const key = providerPasskeyFixture();
    const before = [{ type: "email", id: "fixture@example.invalid" }];
    const credentials = [...before, { type: "passkey", id: key.credentialId }];
    const state = {
      credentials,
      credentialsDigest: providerCredentialsDigest(credentials),
      passkeys: [key.evidence],
    };
    assert.equal(
      inspectProviderPasskeyAddition(before, state).credentialId,
      key.credentialId,
    );
    for (const after of [
      before,
      credentials.slice(1),
      [...credentials, credentials[0]],
      [...credentials, { type: "google_oauth", id: "other" }],
      [...before, { type: "google_oauth", id: "google" }],
    ]) {
      assert.equal(
        inspectProviderPasskeyAddition(before, {
          ...state,
          credentials: after,
          credentialsDigest: providerCredentialsDigest(after),
        }),
        null,
      );
    }
    assert.equal(
      inspectProviderPasskeyAddition(before, {
        ...state,
        credentialsDigest: "0".repeat(64),
      }),
      null,
    );
    assert.equal(
      inspectProviderPasskeyAddition(before, { ...state, passkeys: [] }),
      null,
    );
    assert.equal(
      inspectProviderPasskeyAddition(before, {
        ...state,
        passkeys: [key.evidence, key.evidence],
      }),
      null,
    );
    assert.throws(
      () =>
        inspectProviderPasskeyAddition(before, {
          ...state,
          passkeys: [{ ...key.evidence, publicKey: null }],
        }),
      { status: 503 },
    );
  });
});
