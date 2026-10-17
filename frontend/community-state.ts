import type {
  CommunityMessage,
  SubmissionRecord,
  DeliveryError,
} from "./community-types.js";
// Transport-independent state. Submission text/keys never follow composer edits.
export const compareIds = (a: string, b: string) =>
  BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;

export function createChatState() {
  const submissions = new Map<string, SubmissionRecord>();
  const server = new Map<
    string,
    {
      item: CommunityMessage;
      record: SubmissionRecord | undefined;
      missing: boolean;
    }
  >();
  let cursor = "0";
  let activeRequests = 0;
  const deferredEvictions = new Set<string>();

  function begin(body: string, clientMessageId: string, createdAt: string) {
    const text = body.trim();
    if (
      !text ||
      text.length > 500 ||
      [...submissions.values()].filter(
        (record) => !["confirmed", "removed"].includes(record.state),
      ).length >= 100
    )
      return null;
    const record: SubmissionRecord = {
      submission: Object.freeze({ body: text, clientMessageId, createdAt }),
      state: "sending",
      attempt: 1,
      serverId: null,
      error: "",
      settled: false,
    };
    submissions.set(clientMessageId, record);
    return record;
  }

  function retry(record: SubmissionRecord) {
    if (["sending", "confirmed", "removed"].includes(record.state)) return null;
    record.state = "sending";
    record.settled = false;
    record.error = "";
    return ++record.attempt;
  }

  function fail(
    record: SubmissionRecord,
    attempt: number,
    error: DeliveryError,
  ) {
    if (record.attempt !== attempt || record.state !== "sending") return false;
    // A received application 4xx is a rejection. 408 and all 5xx are ambiguous.
    record.state =
      error.status === 429
        ? "cooldown"
        : error.status! >= 400 && error.status! < 500 && error.status !== 408
          ? "rejected"
          : "unconfirmed";
    record.error = error.message;
    return true;
  }

  function receive(item: CommunityMessage, source = "feed") {
    if (
      typeof item?.id !== "string" ||
      !/^[1-9]\d*$/.test(item.id) ||
      typeof item.revision !== "string" ||
      !/^\d+$/.test(item.revision) ||
      !["visible", "removed"].includes(item.state) ||
      (item.state === "visible" && typeof item.body !== "string")
    )
      throw new Error(
        "Invalid message acknowledgment; delivery is unconfirmed.",
      );
    deferredEvictions.delete(item.id);
    const previous = server.get(item.id);
    const local = submissions.get(item.clientMessageId!) || previous?.record;
    if (
      previous &&
      ((source === "post" && previous.missing) ||
        (item.streamRevision &&
          previous.item.streamRevision &&
          compareIds(item.streamRevision, previous.item.streamRevision) < 0) ||
        compareIds(item.revision, previous.item.revision) < 0 ||
        (item.revision === previous.item.revision &&
          previous.item.state === "removed" &&
          item.state === "visible" &&
          !(source === "recovery" && previous.missing)))
    ) {
      const newlyBound = !!local && previous.record !== local;
      const confirmedNow =
        newlyBound && !["confirmed", "removed"].includes(local.state);
      if (newlyBound) {
        local.serverId = item.id;
        local.state =
          previous.item.state === "removed" ? "removed" : "confirmed";
        local.error = "";
        previous.record = local;
      }
      return {
        record: local,
        item: previous.item,
        changed: newlyBound,
        inserted: false,
        confirmedNow,
      };
    }
    if (
      previous &&
      previous.record === local &&
      previous.item.revision === item.revision &&
      previous.item.state === item.state &&
      previous.item.body === item.body &&
      previous.item.authorName === item.authorName &&
      previous.item.createdAt === item.createdAt
    ) {
      return {
        record: local,
        item: previous.item,
        changed: false,
        inserted: false,
        confirmedNow: false,
      };
    }
    const confirmedNow =
      !!local && !["confirmed", "removed"].includes(local.state);
    if (local) {
      local.serverId = item.id;
      local.state = item.state === "removed" ? "removed" : "confirmed";
      local.error = "";
    }
    // Never retain a removed response's body, even if a transport supplies one.
    const safe = { ...item, body: item.state === "removed" ? null : item.body };
    server.set(item.id, { item: safe, record: local, missing: false });
    return {
      record: local,
      item: safe,
      changed: true,
      inserted: !previous && !local,
      confirmedNow,
    };
  }

  function missing(id: string) {
    const previous = server.get(id);
    if (!previous) return;
    previous.item = { ...previous.item, state: "removed", body: null };
    previous.missing = true;
    if (previous.record) previous.record.state = "removed";
  }

  function advance(items: CommunityMessage[]) {
    for (const item of items)
      if (compareIds(item.id, cursor) > 0) cursor = item.id;
  }

  function forget(id: string) {
    if (activeRequests && server.get(id)?.item.state === "removed") {
      deferredEvictions.add(id);
      return;
    }
    const record = server.get(id)?.record;
    if (
      record &&
      (!record.settled || !["confirmed", "removed"].includes(record.state))
    )
      return;
    server.delete(id);
    if (record) submissions.delete(record.submission.clientMessageId);
  }

  function beginRequest() {
    activeRequests++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--activeRequests === 0) {
        for (const id of deferredEvictions) forget(id);
        deferredEvictions.clear();
      }
    };
  }

  return {
    submissions,
    server,
    begin,
    beginRequest,
    retry,
    fail,
    receive,
    missing,
    advance,
    forget,
    get cursor() {
      return cursor;
    },
  };
}

export function recoverDraft(draft: string, record: SubmissionRecord) {
  // Appending preserves any draft typed since submission and requires explicit send.
  return draft ? `${draft}\n${record.submission.body}` : record.submission.body;
}

export function shouldSendOnEnter(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "isComposing" | "keyCode">,
  composing: boolean,
) {
  return (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing &&
    !composing &&
    event.keyCode !== 229
  );
}
