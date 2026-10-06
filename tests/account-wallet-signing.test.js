import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, it } from "node:test";
import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createChallengeMessage,
  verifyChallengeSignature,
} from "../dist/platform/auth/siwe.js";

const source = await readFile(
  new URL("../public/account.js", import.meta.url),
  "utf8",
);
const signer = privateKeyToAccount(`0x${"51".repeat(32)}`);
const otherWallet = privateKeyToAccount(`0x${"52".repeat(32)}`);
const origin = "https://staging.example.test";
const chainId = 8453;

function page({
  address = signer.address,
  chain = chainId,
  reject = false,
} = {}) {
  const elements = new Map();
  function element(selector) {
    if (!elements.has(selector))
      elements.set(selector, {
        textContent: "",
        addEventListener() {},
        elements: { credential: { addEventListener() {} } },
      });
    return elements.get(selector);
  }
  const issued = createChallengeMessage({
    address: signer.address,
    chainId,
    origin,
    purpose: "login",
  });
  const challenge = {
    ...issued,
    address: signer.address.toLowerCase(),
    chainId: String(chainId),
  };
  const signedMessages = [];
  const completedLogins = [];
  const context = vm.createContext({
    document: { querySelector: element },
    TextEncoder,
    URL,
    window: {
      location: { search: "", origin },
      ethereum: {
        async request({ method, params }) {
          if (method === "eth_requestAccounts") return [address];
          if (method === "eth_chainId") return `0x${chain.toString(16)}`;
          assert.equal(method, "personal_sign");
          assert.match(params[0], /^0x(?:[0-9a-f]{2})+$/i);
          assert.equal(params[1].toLowerCase(), address.toLowerCase());
          if (reject) throw new Error("Signature rejected");
          signedMessages.push(params[0]);
          return signer.signMessage({ message: { raw: params[0] } });
        },
      },
    },
    async fetch(path, options = {}) {
      let ok = true;
      let data;
      if (path === "/api/auth/me") {
        ok = false;
        data = { error: "authentication required" };
      } else if (path === "/api/auth/wallet/login/challenge") {
        data = { id: "synthetic-login-challenge", message: issued.message };
      } else {
        assert.equal(path, "/api/auth/wallet/login/verify");
        const proof = JSON.parse(options.body);
        assert.equal(
          await verifyChallengeSignature({
            challenge,
            signature: proof.signature,
            origin,
            rpcUrls: {},
          }),
          true,
        );
        completedLogins.push(proof.challengeId);
        data = {};
      }
      return {
        ok,
        headers: { get: () => "application/json" },
        json: async () => data,
      };
    },
  });
  vm.runInContext(source, context);
  return { context, signedMessages, completedLogins, issued, elements };
}

describe("account wallet signing", () => {
  it("signs login as hex bytes accepted by the real server verifier", async () => {
    const fixture = page();
    await fixture.context.walletAction("login");
    assert.deepEqual(fixture.completedLogins, ["synthetic-login-challenge"]);
    assert.equal(
      Buffer.from(fixture.signedMessages[0].slice(2), "hex").toString("utf8"),
      fixture.issued.message,
    );
  });

  it("preserves each new-wallet and retained-wallet server message", async () => {
    for (const purpose of ["link", "approve-link", "approve-unlink"]) {
      const fixture = page();
      const issued = createChallengeMessage({
        address: signer.address,
        chainId,
        origin,
        purpose,
        operationId: "11111111-1111-4111-8111-111111111111",
        target: { address: otherWallet.address.toLowerCase(), chainId },
      });
      const signature = await fixture.context.signForWallet(
        issued.message,
        signer.address,
        chainId,
      );
      assert.equal(
        Buffer.from(fixture.signedMessages[0].slice(2), "hex").toString("utf8"),
        issued.message,
      );
      assert.equal(
        await verifyChallengeSignature({
          challenge: {
            ...issued,
            address: signer.address.toLowerCase(),
            chainId: String(chainId),
          },
          signature,
          origin,
          rpcUrls: {},
        }),
        true,
      );
    }
  });

  it("preserves UTF-8 bytes, including multibyte text and line breaks", async () => {
    const fixture = page();
    const message = "Authorize wallet change\nCafé 🗣️\n";
    const signature = await fixture.context.signForWallet(
      message,
      signer.address,
      chainId,
    );
    assert.equal(
      fixture.signedMessages[0],
      `0x${Buffer.from(message, "utf8").toString("hex")}`,
    );
    assert.equal(
      await verifyMessage({ address: signer.address, message, signature }),
      true,
    );
  });

  it("does not request a signature from a different account or chain", async () => {
    for (const options of [{ address: otherWallet.address }, { chain: 1 }]) {
      const fixture = page(options);
      await assert.rejects(
        fixture.context.signForWallet(
          fixture.issued.message,
          signer.address,
          chainId,
        ),
        /Switch your wallet/,
      );
      assert.deepEqual(fixture.signedMessages, []);
    }
  });

  it("does not complete login when the wallet rejects signing", async () => {
    const fixture = page({ reject: true });
    await fixture.context.walletAction("login");
    assert.deepEqual(fixture.completedLogins, []);
    assert.equal(
      fixture.elements.get("#account-notice").textContent,
      "Signature rejected",
    );
  });
});
