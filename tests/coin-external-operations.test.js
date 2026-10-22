import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  atomicAmount,
  operationTermsDigest,
  observeExternalOperation,
} from "../dist/features/account-wallet/external-operations.js";

const terms = {
  environment: "sandbox",
  accountId: "72",
  kind: "withdrawal",
  provider: "deterministic-simulation",
  network: "simulation:usdc",
  asset: "USDC",
  precision: 6,
  amount: "5000000",
  networkFee: "123",
  destination: "synthetic-destination",
  quoteId: "synthetic-quote",
};
const digest = operationTermsDigest(terms);
const pending = {
  termsDigest: digest,
  externalId: null,
  status: "pending",
  transactionId: null,
};
const event = (overrides = {}) => ({
  id: "event-1",
  externalId: "original-operation",
  termsDigest: digest,
  source: "webhook",
  status: "pending",
  finalNoTransfer: false,
  transactionId: null,
  ...overrides,
});

describe("external financial operation contracts", () => {
  it("keeps exact positive 36-digit atomic values and validates fee zero", () => {
    assert.equal(atomicAmount("9".repeat(36)), BigInt("9".repeat(36)));
    assert.equal(atomicAmount("0", true), 0n);
    for (const value of ["0", "01", "-1", "1.1", "1e6", "9".repeat(37), ""])
      assert.throws(() => atomicAmount(value));
  });
  it("binds every financial term and isolates owner/environment/precision", () => {
    assert.equal(operationTermsDigest({ ...terms }), digest);
    for (const [key, value] of Object.entries({
      environment: "live",
      accountId: "73",
      kind: "refund",
      provider: "other",
      network: "other",
      amount: "5000001",
      networkFee: "124",
      destination: "different",
      quoteId: "second",
    }))
      assert.notEqual(operationTermsDigest({ ...terms, [key]: value }), digest);
    for (const override of [
      { environment: "historical" },
      { accountId: "0" },
      { kind: "transfer" },
      { asset: "YAP" },
      { precision: 18 },
      { provider: "" },
      { network: "" },
      { amount: "1.0" },
      { networkFee: "-1" },
      { destination: "" },
      { quoteId: "" },
    ])
      assert.throws(() => operationTermsDigest({ ...terms, ...override }));
  });
  it("never releases reserves for failure webhooks, timeouts or uncertain retries", () => {
    const uncertain = observeExternalOperation(
      pending,
      event({ status: "failed" }),
    );
    assert.equal(uncertain.state.status, "uncertain");
    assert.equal(uncertain.disposition, "retain");
    assert.equal(
      observeExternalOperation(uncertain.state, event()).state.status,
      "uncertain",
    );
    assert.equal(
      observeExternalOperation(pending, event({ status: "uncertain" }))
        .disposition,
      "retain",
    );
    assert.equal(
      observeExternalOperation(
        pending,
        event({ status: "failed", source: "reconciliation" }),
      ).disposition,
      "retain",
    );
  });
  it("releases once only after authoritative no-transfer reconciliation", () => {
    const result = observeExternalOperation(
      pending,
      event({
        status: "failed",
        source: "reconciliation",
        finalNoTransfer: true,
      }),
    );
    assert.equal(result.disposition, "release");
    assert.equal(result.state.status, "failed");
    assert.equal(
      observeExternalOperation(result.state, event({ status: "failed" }))
        .disposition,
      "retain",
    );
    assert.throws(
      () =>
        observeExternalOperation(result.state, event({ status: "completed" })),
      /manual reconciliation/,
    );
  });
  it("settles once with final reconciled evidence and ignores delayed pending events", () => {
    for (const source of ["webhook", "submission"])
      assert.throws(() =>
        observeExternalOperation(
          pending,
          event({ status: "completed", source, transactionId: "tx-1" }),
        ),
      );
    assert.throws(() =>
      observeExternalOperation(
        pending,
        event({ status: "completed", source: "reconciliation" }),
      ),
    );
    const complete = event({
      status: "completed",
      source: "reconciliation",
      transactionId: "tx-1",
    });
    const result = observeExternalOperation(pending, complete);
    assert.equal(result.disposition, "settle");
    assert.equal(
      observeExternalOperation(result.state, complete).disposition,
      "retain",
    );
    assert.equal(
      observeExternalOperation(result.state, event()).state.status,
      "completed",
    );
    for (const change of [{ status: "failed" }, { transactionId: "tx-2" }])
      assert.throws(
        () =>
          observeExternalOperation(result.state, { ...complete, ...change }),
        /manual reconciliation/,
      );
  });
  it("rejects cross-operation evidence and invalid external identifiers", () => {
    const known = { ...pending, externalId: "original-operation" };
    for (const change of [
      { id: "" },
      { id: "x".repeat(201) },
      { externalId: "different" },
      { externalId: "" },
      { termsDigest: "0".repeat(64) },
      { source: "client" },
      { status: "reversed" },
      { transactionId: "" },
      { transactionId: "x".repeat(201) },
      { finalNoTransfer: "false" },
      { finalNoTransfer: 1 },
      { id: 1 },
      { externalId: 1 },
      { transactionId: 1 },
    ])
      assert.throws(() => observeExternalOperation(known, event(change)));
  });
});
