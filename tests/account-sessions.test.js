import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, it } from "node:test";
const source = await readFile(
  new URL("../public/account-sessions.js", import.meta.url),
  "utf8",
);
function page({ confirm = true, response = { ok: true }, failure } = {}) {
  const elements = Object.fromEntries(
    [
      "sign-out-all",
      "sign-out-others",
      "account-notice",
      "signed-in",
      "signed-out",
    ].map((id) => [
      id,
      {
        disabled: false,
        hidden: id === "signed-out",
        textContent: "",
        addEventListener(event, callback) {
          this[event] = callback;
        },
      },
    ]),
  );
  const calls = [];
  const prompts = [];
  vm.runInNewContext(source, {
    document: {
      querySelector(selector) {
        return elements[selector.slice(1)];
      },
    },
    window: {
      confirm(message) {
        prompts.push(message);
        return confirm;
      },
    },
    async fetch(path, options) {
      calls.push({ path, options });
      if (failure) throw failure;
      return response;
    },
  });
  return {
    elements,
    calls,
    prompts,
    click: (id) => elements[id].click({ currentTarget: elements[id] }),
  };
}
describe("account session controls", () => {
  it("explains the current-device boundary and keeps it signed in after logout-others", async () => {
    const fixture = page();
    await fixture.click("sign-out-others");
    assert.match(fixture.prompts[0], /This device will stay signed in/);
    assert.equal(fixture.calls[0].path, "/api/auth/logout-other-sessions");
    assert.equal(fixture.calls[0].options.method, "POST");
    assert.equal(fixture.calls[0].options.credentials, "same-origin");
    assert.equal(fixture.elements["signed-in"].hidden, false);
    assert.match(
      fixture.elements["account-notice"].textContent,
      /still signed in/,
    );
    assert.equal(fixture.elements["sign-out-others"].disabled, false);
  });
  it("returns to sign-in after all-session logout", async () => {
    const fixture = page();
    await fixture.click("sign-out-all");
    assert.match(fixture.prompts[0], /including this device/);
    assert.equal(fixture.calls[0].path, "/api/auth/logout-all");
    assert.equal(fixture.elements["signed-in"].hidden, true);
    assert.equal(fixture.elements["signed-out"].hidden, false);
    assert.match(
      fixture.elements["account-notice"].textContent,
      /All sessions signed out/,
    );
  });
  it("does not revoke when the owner cancels", async () => {
    const fixture = page({ confirm: false });
    await fixture.click("sign-out-all");
    assert.equal(fixture.calls.length, 0);
  });
  it("reports denial or network failure without falsely reporting logout", async () => {
    for (const options of [
      {
        response: {
          ok: false,
          json: async () => ({ error: "authentication required" }),
        },
      },
      { response: { ok: false, json: async () => ({}) } },
      { failure: new Error("Network unavailable") },
    ]) {
      const fixture = page(options);
      await fixture.click("sign-out-all");
      assert.equal(fixture.elements["signed-in"].hidden, false);
      assert.equal(fixture.elements["sign-out-all"].disabled, false);
      assert.match(
        fixture.elements["account-notice"].textContent,
        /authentication required|Sign-out failed|Network unavailable/,
      );
    }
  });
  it("works when session controls are absent from the current page", () => {
    vm.runInNewContext(source, { document: { querySelector: () => null } });
  });
});
