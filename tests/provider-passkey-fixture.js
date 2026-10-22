import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";

// Synthetic provider GET evidence and real WebAuthn signatures. This fixture
// does not enroll a credential with Privy or claim provider acceptance.
export function providerPasskeyFixture(origin = "http://localhost:53024") {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = publicKey.export({ format: "jwk" });
  const cose = Buffer.from(
    isoCBOR.encode(
      new Map([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, new Uint8Array(Buffer.from(jwk.x, "base64url"))],
        [-3, new Uint8Array(Buffer.from(jwk.y, "base64url"))],
      ]),
    ),
  );
  const credentialId = randomBytes(32).toString("base64url");
  const hash = (value) => createHash("sha256").update(value).digest();
  return {
    credentialId,
    publicKey: cose,
    evidence: { credentialId, publicKey: cose.toString("base64") },
    authentication(options, overrides = {}) {
      const {
        flags = 0x05,
        counter = 1,
        rpId = new URL(origin).hostname,
        userHandle = randomBytes(32).toString("base64url"),
        ...clientOverrides
      } = overrides;
      const clientData = Buffer.from(
        JSON.stringify({
          type: "webauthn.get",
          challenge: options.challenge,
          origin,
          ...clientOverrides,
        }),
      );
      const count = Buffer.alloc(4);
      count.writeUInt32BE(counter);
      const authenticatorData = Buffer.concat([
        hash(rpId),
        Buffer.from([flags]),
        count,
      ]);
      return {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          userHandle,
          clientDataJSON: clientData.toString("base64url"),
          authenticatorData: authenticatorData.toString("base64url"),
          signature: sign(
            "sha256",
            Buffer.concat([authenticatorData, hash(clientData)]),
            privateKey,
          ).toString("base64url"),
        },
      };
    },
  };
}
