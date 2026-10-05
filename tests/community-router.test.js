import assert from "node:assert/strict";
import { describe, it } from "node:test";
import request from "../scripts/test-http-request.js";

import { createApp } from "../dist/app.js";
import {
  CommunityConflictError,
  CommunityForbiddenError,
  CommunityNotFoundError,
  CommunityRateError,
} from "../dist/features/community/repository.js";
import { createLogger } from "../dist/platform/logger.js";

const eventId = "11111111-1111-4111-8111-111111111111";
const caseId = "22222222-2222-4222-8222-222222222222";
const appealId = "33333333-3333-4333-8333-333333333333";
const event = {
  id: eventId,
  slug: "debate-community-test",
  status: "live",
  proposition: "Should public debates have chat?",
  topicTitle: "Public debate",
  sideALabel: "For",
  sideBLabel: "Against",
  speakerA: "Alice",
  speakerB: "Bob",
  scheduledAt: new Date("2026-10-01"),
};

function fixture({
  signedIn = true,
  roles = ["participant"],
  failure,
  hidden = false,
  apiRateLimit,
} = {}) {
  const calls = [];
  const community = {
    publicEvent: async () => (hidden ? null : event),
    publicEventBySlug: async (slug) =>
      hidden || slug !== event.slug ? null : event,
    summary: async (id, userId) => {
      calls.push(["summary", id, userId]);
      if (failure) throw failure;
      return {
        eventId: id,
        likes: 2,
        liked: !!userId,
        chatState: "open",
        chatWritable: true,
      };
    },
    listChat: async (id, before) => {
      calls.push(["listChat", id, before]);
      if (failure) throw failure;
      return { items: [{ id: "1", body: "Hello" }], hasMore: false };
    },
    syncChat: async (id, after, watchedIds) => {
      calls.push(["syncChat", id, after, watchedIds]);
      if (failure) throw failure;
      return {
        items: [{ id: "2", body: "New message" }],
        hasMore: false,
        watched: [{ id: "1", body: "Hello" }],
      };
    },
    postChat: async (...args) => {
      calls.push(["postChat", ...args]);
      if (failure) throw failure;
      return { id: "2", body: args[2] };
    },
    setLike: async (...args) => {
      calls.push(["setLike", ...args]);
      if (failure) throw failure;
      return { liked: args[2], likes: args[2] ? 3 : 2 };
    },
    report: async (...args) => {
      calls.push(["report", ...args]);
      if (failure) throw failure;
      return { id: caseId, status: "open" };
    },
    listMyCases: async (userId) => {
      calls.push(["listMyCases", userId]);
      return [];
    },
    appeal: async (...args) => {
      calls.push(["appeal", ...args]);
      if (failure) throw failure;
      return { id: appealId, status: "open" };
    },
    listCases: async (status) => {
      calls.push(["listCases", status]);
      return [];
    },
    getCase: async (id) => ({ id, history: [] }),
    decideCase: async (...args) => {
      calls.push(["decideCase", ...args]);
      if (failure) throw failure;
      return { id: args[0], status: "actioned" };
    },
    resumeChat: async (...args) => {
      calls.push(["resumeChat", ...args]);
      if (failure) throw failure;
      return { chatState: "open" };
    },
    listAppeals: async () => [],
    decideAppeal: async (...args) => {
      calls.push(["decideAppeal", ...args]);
      if (failure) throw failure;
      return { id: args[0], status: args[2] };
    },
  };
  const app = createApp({
    community,
    identity: { getRoles: async () => roles },
    sessions: {
      findUserByTokenHash: async () =>
        signedIn ? { id: "7", email: null, createdAt: new Date() } : null,
    },
    users: {},
    messages: { isReady: async () => {} },
    logger: createLogger({ enabled: false }),
    applicationOrigin: "https://arena.example",
    apiRateLimit,
  });
  const agent = () => request(app);
  const auth = (method, path) =>
    agent()[method](path).set("Cookie", "session=test");
  return { app, calls, auth };
}

describe("community API and share surfaces", () => {
  it("lets guests read chat and engagement but keeps mutations and case data private", async () => {
    const { app } = fixture({ signedIn: false });
    assert.equal(
      (await request(app).get(`/api/community/events/${eventId}`)).status,
      200,
    );
    assert.equal(
      (await request(app).get(`/api/community/events/${eventId}/chat`)).body
        .items[0].body,
      "Hello",
    );
    for (const [method, path] of [
      ["post", `/api/community/events/${eventId}/chat`],
      ["put", `/api/community/events/${eventId}/like`],
      ["post", "/api/community/reports"],
      ["get", "/api/community/me/cases"],
      ["get", "/api/community/moderation/cases"],
    ])
      assert.equal((await request(app)[method](path)).status, 401);
  });

  it("validates event and cursor IDs and uses stable public share URLs", async () => {
    const { app } = fixture();
    assert.equal(
      (await request(app).get("/api/community/events/nope")).status,
      404,
    );
    assert.equal(
      (
        await request(app).get(
          `/api/community/events/${eventId}/chat?before=-1`,
        )
      ).status,
      400,
    );
    const qr = await request(app).get(`/debates/${event.slug}/qr.svg`);
    assert.equal(qr.status, 200);
    assert.match(qr.body.toString(), /<svg/);
    const overlay = await request(app).get(`/overlay/${event.slug}`);
    assert.equal(overlay.status, 200);
    assert.match(overlay.text, /Should public debates have chat/);
    assert.doesNotMatch(overlay.text, /score|tally|sponsor|billing/i);
    assert.equal((await request(app).get("/overlay/not-found")).status, 404);
    assert.equal(
      (await request(app).get("/debates/not-found/qr.svg")).status,
      404,
    );
  });

  it("serves bounded guest chat sync with ordered cursors and no cache", async () => {
    const { app, calls } = fixture({ signedIn: false });
    const path = `/api/community/events/${eventId}/chat/sync`;
    const result = await request(app).get(`${path}?after=1&watch=2,1,2`);
    assert.equal(result.status, 200);
    assert.equal(result.body.items[0].body, "New message");
    assert.equal(result.headers["cache-control"], "no-store");
    assert.deepEqual(calls.at(-1), ["syncChat", eventId, "1", ["2", "1"]]);
    for (const query of [
      "after=-1",
      "after=abc",
      "watch=1,wat",
      `watch=${Array.from({ length: 201 }, (_, index) => index + 1).join(",")}`,
    ])
      assert.equal((await request(app).get(`${path}?${query}`)).status, 400);
  });

  it("keeps live reads on a separate bounded limit from ordinary API actions", async () => {
    const { app } = fixture({ signedIn: false, apiRateLimit: 1 });
    for (let index = 0; index < 3; index += 1)
      assert.equal(
        (
          await request(app).get(
            `/api/community/events/${eventId}/chat/sync?after=0`,
          )
        ).status,
        200,
      );
    assert.equal((await request(app).get("/health")).status, 200);
    assert.equal((await request(app).get("/health")).status, 429);
  });

  it("posts chat and uses idempotent like methods with server-bound account identity", async () => {
    const { auth, calls } = fixture();
    assert.equal(
      (
        await auth("post", `/api/community/events/${eventId}/chat`).send({
          body: " Hello ",
        })
      ).status,
      201,
    );
    assert.deepEqual(calls.at(-1), ["postChat", eventId, "7", "Hello"]);
    assert.equal(
      (await auth("put", `/api/community/events/${eventId}/like`)).body.liked,
      true,
    );
    assert.equal(
      (await auth("delete", `/api/community/events/${eventId}/like`)).body
        .liked,
      false,
    );
    assert.equal(
      (await auth("get", `/api/community/events/${eventId}/my-like`)).body
        .liked,
      true,
    );
    assert.equal(
      (
        await auth("post", `/api/community/events/${eventId}/chat`).send({
          body: " ",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await auth("post", `/api/community/events/${eventId}/chat`).send({
          body: "x".repeat(501),
        })
      ).status,
      400,
    );
  });

  it("validates reports, returns rate failures, and exposes a personal case page", async () => {
    const { auth, calls } = fixture();
    const good = {
      targetType: "event",
      targetId: eventId,
      reasonCode: "spam",
      detail: "Repeated promotion",
    };
    assert.equal(
      (await auth("post", "/api/community/reports").send(good)).status,
      201,
    );
    assert.deepEqual(calls.at(-1), [
      "report",
      "7",
      "event",
      eventId,
      "spam",
      "Repeated promotion",
    ]);
    assert.equal(
      (
        await auth("post", "/api/community/reports").send({
          ...good,
          reasonCode: "bad",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await auth("post", "/api/community/reports").send({
          ...good,
          targetId: "bad",
        })
      ).status,
      400,
    );
    assert.equal((await auth("get", "/account/moderation")).status, 200);
    assert.equal((await auth("get", "/api/community/me/cases")).status, 200);
    const limited = fixture({
      failure: new CommunityRateError("report limit reached"),
    });
    assert.equal(
      (await limited.auth("post", "/api/community/reports").send(good)).status,
      429,
    );
  });

  it("requires moderator role for case evidence and decisions", async () => {
    const { auth } = fixture();
    for (const path of [
      "/moderation",
      "/api/community/moderation/cases",
      `/api/community/moderation/cases/${caseId}`,
      "/api/community/moderation/appeals",
    ])
      assert.equal((await auth("get", path)).status, 403);
    assert.equal(
      (
        await auth(
          "post",
          `/api/community/moderation/cases/${caseId}/decision`,
        ).send({
          action: "remove_chat",
          reasonCode: "spam",
          note: "Repeated unsafe posts",
        })
      ).status,
      403,
    );
    const mod = fixture({ roles: ["moderator"] });
    assert.equal((await mod.auth("get", "/moderation")).status, 200);
    assert.equal(
      (await mod.auth("get", "/api/community/moderation/cases")).status,
      200,
    );
    assert.equal(
      (await mod.auth("get", `/api/community/moderation/cases/${caseId}`)).body
        .id,
      caseId,
    );
    assert.equal(
      (
        await mod
          .auth("post", `/api/community/moderation/cases/${caseId}/decision`)
          .send({
            action: "remove_chat",
            reasonCode: "spam",
            note: "Repeated unsafe posts",
          })
      ).status,
      200,
    );
    assert.equal(
      (
        await mod
          .auth("post", `/api/community/moderation/cases/${caseId}/decision`)
          .send({
            action: "win",
            reasonCode: "spam",
            note: "Repeated unsafe posts",
          })
      ).status,
      400,
    );
    assert.equal(
      (
        await mod
          .auth("post", `/api/community/moderation/cases/${caseId}/resume-chat`)
          .send({ note: "Issue has been handled" })
      ).status,
      200,
    );
  });

  it("requires a valid appeal and a different moderator decision", async () => {
    const participant = fixture();
    assert.equal(
      (
        await participant
          .auth("post", `/api/community/cases/${caseId}/appeal`)
          .send({ reason: "Please reconsider this action" })
      ).status,
      201,
    );
    assert.equal(
      (
        await participant
          .auth("post", `/api/community/cases/${caseId}/appeal`)
          .send({ reason: "short" })
      ).status,
      400,
    );
    const mod = fixture({ roles: ["moderator"] });
    assert.equal(
      (await mod.auth("get", "/api/community/moderation/appeals")).status,
      200,
    );
    assert.equal(
      (
        await mod
          .auth(
            "post",
            `/api/community/moderation/appeals/${appealId}/decision`,
          )
          .send({
            decision: "overturned",
            note: "Original removal was mistaken",
          })
      ).status,
      200,
    );
    assert.equal(
      (
        await mod
          .auth(
            "post",
            `/api/community/moderation/appeals/${appealId}/decision`,
          )
          .send({
            decision: "published_winner",
            note: "Original removal was mistaken",
          })
      ).status,
      400,
    );
  });

  it("maps missing, conflict, and forbidden repository outcomes without leaking details", async () => {
    for (const [failure, status] of [
      [new CommunityNotFoundError("event not found"), 404],
      [new CommunityConflictError("chat paused"), 409],
      [new CommunityForbiddenError("community activity is restricted"), 403],
    ]) {
      const { auth } = fixture({ failure });
      assert.equal(
        (
          await auth("post", `/api/community/events/${eventId}/chat`).send({
            body: "Hello",
          })
        ).status,
        status,
      );
    }
  });

  it("rejects malformed targets and decisions before calling the repository", async () => {
    const { auth, calls } = fixture({ roles: ["participant", "moderator"] });
    const invalid = [
      [
        "get",
        `/api/community/events/${eventId}/chat?before=999999999999999999999999`,
      ],
      ["get", "/api/community/events/bad/my-like"],
      ["post", "/api/community/events/bad/chat"],
      ["put", "/api/community/events/bad/like"],
      ["delete", "/api/community/events/bad/like"],
      ["post", "/api/community/cases/bad/appeal"],
      ["get", "/api/community/moderation/cases/bad"],
      ["post", "/api/community/moderation/cases/bad/decision"],
      ["post", "/api/community/moderation/cases/bad/resume-chat"],
      ["post", "/api/community/moderation/appeals/bad/decision"],
    ];
    for (const [method, path] of invalid) {
      const response = await auth(method, path);
      assert.ok([400, 404].includes(response.status), path);
    }
    const report = {
      targetType: "chat",
      targetId: "10",
      reasonCode: "privacy",
      detail: "Private information",
    };
    assert.equal(
      (await auth("post", "/api/community/reports").send(report)).status,
      201,
    );
    assert.equal(
      (
        await auth("post", "/api/community/reports").send({
          ...report,
          targetType: "profile",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await auth("post", "/api/community/reports").send({
          ...report,
          detail: "short",
        })
      ).status,
      400,
    );
    assert.equal(
      (await auth("get", "/api/community/moderation/cases?status=invalid"))
        .status,
      400,
    );
    assert.equal(
      (await auth("get", "/api/community/moderation/cases?status=actioned"))
        .status,
      200,
    );
    assert.equal(
      (
        await auth(
          "post",
          `/api/community/moderation/cases/${caseId}/decision`,
        ).send({
          action: "pause_chat",
          reasonCode: "invalid",
          note: "A sufficiently long note",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await auth(
          "post",
          `/api/community/moderation/cases/${caseId}/resume-chat`,
        ).send({ note: "short" })
      ).status,
      400,
    );
    assert.equal(
      (
        await auth(
          "post",
          `/api/community/moderation/appeals/${appealId}/decision`,
        ).send({
          decision: "upheld",
          note: "short",
        })
      ).status,
      400,
    );
    assert.equal(calls.filter(([name]) => name === "report").length, 1);
  });

  it("hides unpublished share resources and maps duplicate reports to conflict", async () => {
    const { app } = fixture({ hidden: true });
    assert.equal(
      (await request(app).get(`/debates/${event.slug}/qr.svg`)).status,
      404,
    );
    assert.equal(
      (await request(app).get(`/overlay/${event.slug}`)).status,
      404,
    );
    assert.equal(
      (await request(app).get("/debates/INVALID/qr.svg")).status,
      404,
    );
    const duplicate = fixture({ failure: { code: "23505" } });
    assert.equal(
      (
        await duplicate.auth("post", "/api/community/reports").send({
          targetType: "event",
          targetId: eventId,
          reasonCode: "spam",
          detail: "Repeated promotion",
        })
      ).status,
      409,
    );
    const moderatorOnly = fixture({ roles: ["moderator"] });
    assert.equal(
      (
        await moderatorOnly
          .auth("post", `/api/community/events/${eventId}/chat`)
          .send({ body: "Hello" })
      ).status,
      403,
    );
    assert.equal(
      (await moderatorOnly.auth("put", `/api/community/events/${eventId}/like`))
        .status,
      403,
    );
    assert.equal(
      (
        await moderatorOnly.auth("post", "/api/community/reports").send({
          targetType: "event",
          targetId: eventId,
          reasonCode: "spam",
          detail: "Repeated promotion",
        })
      ).status,
      403,
    );
  });
});
