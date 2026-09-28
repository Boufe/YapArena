import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { createMessageRepository } from "../dist/features/messages/repository.js";

describe("message repository", () => {
  it("inserts and returns a message", async () => {
    const savedMessage = {
      id: "1",
      name: "Example User",
      message: "Hello, Example User!",
      createdAt: new Date("2026-08-04T17:00:00.000Z"),
    };
    const query = mock.fn(async () => ({ rows: [savedMessage] }));
    const repository = createMessageRepository({ query });

    const result = await repository.create(
      "7",
      "Example User",
      "Hello, Example User!",
    );

    assert.deepEqual(result, savedMessage);
    assert.equal(query.mock.callCount(), 1);
    assert.deepEqual(query.mock.calls[0].arguments[1], [
      "7",
      "Example User",
      "Hello, Example User!",
    ]);
  });

  it("checks database readiness", async () => {
    const query = mock.fn(async () => ({ rows: [] }));
    const repository = createMessageRepository({ query });

    await repository.isReady();

    assert.equal(query.mock.callCount(), 1);
    assert.equal(query.mock.calls[0].arguments[0], "SELECT 1");
  });

  it("lists messages with parameterized pagination", async () => {
    const savedMessages = [{ id: "2" }, { id: "1" }];
    const query = mock.fn(async () => ({ rows: savedMessages }));
    const repository = createMessageRepository({ query });

    const result = await repository.list({
      userId: "7",
      limit: 20,
      offset: 40,
    });

    assert.deepEqual(result, savedMessages);
    assert.equal(query.mock.callCount(), 1);
    assert.deepEqual(query.mock.calls[0].arguments[1], ["7", 20, 40]);
    assert.match(query.mock.calls[0].arguments[0], /WHERE user_id = \$1/);
    assert.match(
      query.mock.calls[0].arguments[0],
      /ORDER BY created_at DESC, id DESC/,
    );
  });
});
