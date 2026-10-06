/* global document, window */
import { api } from "./community-transport.js";
import {
  createChatState,
  compareIds,
  recoverDraft,
  shouldSendOnEnter,
} from "./community-state.js";
const reasons = ["harassment", "hate", "threat", "spam", "privacy", "other"];

function element(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}

function setText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}

function labelField(label, input) {
  const wrapper = element("label", label);
  wrapper.append(input);
  return wrapper;
}

function selectField(values, label) {
  const select = element("select");
  select.required = true;
  select.append(element("option", label));
  select.firstChild.value = "";
  for (const value of values) {
    const option = element("option", value.replaceAll("_", " "));
    option.value = value;
    select.append(option);
  }
  return select;
}

function noteField() {
  const textarea = element("textarea");
  textarea.minLength = 10;
  textarea.maxLength = 500;
  textarea.rows = 3;
  textarea.required = true;
  return textarea;
}

function date(value) {
  return value ? new Date(value).toLocaleString() : "";
}

async function submit(form, action, status) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await action();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function reportForm(targetType, targetId, status, onDone) {
  const form = element("form", undefined, "community-inline-form");
  const reason = selectField(reasons, "Choose a reason");
  const detail = noteField();
  form.append(
    labelField("Reason", reason),
    labelField("What happened?", detail),
    element("button", "Submit private report"),
  );
  form.lastChild.type = "submit";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit(
      form,
      async () => {
        await api("/api/community/reports", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetType,
            targetId,
            reasonCode: reason.value,
            detail: detail.value,
          }),
        });
        status.textContent = "Report submitted privately for review.";
        onDone();
      },
      status,
    );
  });
  return form;
}

function initEvent(root) {
  const id = root.dataset.communityEvent;
  const chatRoot =
    document.querySelector("[data-community-chat-panel]") || root;
  const status = root.querySelector("[data-community-status]");
  const connection = chatRoot.querySelector("[data-community-connection]");
  const chatState = chatRoot.querySelector("[data-community-chat-state]");
  const messages = chatRoot.querySelector("[data-community-messages]");
  const older = chatRoot.querySelector("[data-community-older]");
  const newMessages = chatRoot.querySelector("[data-community-new]");
  const sendStatus = chatRoot.querySelector("[data-community-send-status]");
  const like = root.querySelector("[data-community-like]");
  const count = root.querySelector("[data-community-likes]");
  const chatForm = chatRoot.querySelector("[data-community-chat-form]");
  const report = root.querySelector("[data-community-report-form]");
  let currentLiked = false;
  let oldest = null;
  let signedIn = false;
  const state = createChatState();
  const localNodes = new Map();
  let cooldownUntil = 0;
  let cooldownTimer;
  let composing = false;
  let recoveredSubmission = null;
  let initialized = false;
  let syncing = false;
  let loadingOlder = false;
  let retryDelay = 2000;
  let timer;
  let unseenCount = 0;
  const unseenIds = new Set();
  let latestEvicted = false;
  const rendered = new Map();
  const tracked = new Set();

  async function refreshSummary() {
    const summary = await api(`/api/community/events/${id}`);
    count.textContent = `${summary.likes} ${summary.likes === 1 ? "like" : "likes"}`;
    // Keep drafts and recovery available when chat becomes read-only.
    chatForm.dataset.writable = String(summary.chatWritable);
    updateComposer();
    const summaryLabel =
      summary.chatState === "paused"
        ? "Chat is paused by moderation. Existing messages remain visible."
        : summary.chatWritable
          ? "Chat is open during this live event."
          : "Chat is read-only outside the live event.";
    setText(chatState, summaryLabel);
    if (signedIn) {
      const mine = await api(`/api/community/events/${id}/my-like`);
      currentLiked = mine.liked;
      like.setAttribute("aria-pressed", String(currentLiked));
      like.textContent = currentLiked ? "Remove like" : "Like this event";
    }
  }

  function readChatPath(path) {
    return signedIn ? `${path}${path.includes("?") ? "&" : "?"}own=1` : path;
  }

  function saveAnchor() {
    const top = messages.getBoundingClientRect().top;
    const node = Array.from(messages.children).find(
      (child) => child.getBoundingClientRect().bottom > top,
    );
    return {
      node,
      offset: node?.getBoundingClientRect().top - top,
      scrollTop: messages.scrollTop,
    };
  }

  function restoreAnchor(anchor) {
    if (anchor.node?.isConnected)
      messages.scrollTop +=
        anchor.node.getBoundingClientRect().top -
        messages.getBoundingClientRect().top -
        anchor.offset;
    else messages.scrollTop = anchor.scrollTop;
  }

  function messageNode(item, record) {
    const line = element("li", undefined, "community-message");
    const author = element(
      "strong",
      item.authorName || "You",
      "community-message-author",
    );
    const timestamp = element("time");
    const body = element("span", item.body, "community-message-body");
    const content = element("p", undefined, "community-message-content");
    content.append(author, document.createTextNode(" "), body);
    const meta = element("div", undefined, "community-message-meta");
    const delivery = element("span", undefined, "community-message-delivery");
    const actions = element("div", undefined, "community-message-actions");
    meta.append(timestamp, delivery, actions);
    line.append(content, meta);
    if (record) line.dataset.submissionId = record.submission.clientMessageId;
    return line;
  }

  function updateMessageNode(line, item, record) {
    if (item.id) line.dataset.messageId = item.id;
    const removed = item.state === "removed" || record?.state === "removed";
    line.querySelector(".community-message-author").textContent =
      item.authorName || "You";
    line.querySelector(".community-message-body").textContent = removed
      ? "Removed by moderation."
      : item.body;
    const timestamp = line.querySelector("time");
    const time = item.createdAt || record?.submission.createdAt;
    timestamp.dateTime = time;
    timestamp.textContent = new Date(time).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    timestamp.title = date(time);
    const delivery = line.querySelector(".community-message-delivery");
    const labels = {
      sending: "Sending…",
      confirmed: "Sent",
      unconfirmed: "Delivery unconfirmed",
      rejected: "Rejected",
      cooldown:
        cooldownUntil > Date.now()
          ? "Waiting for posting allowance"
          : "Ready to retry",
      removed: "Removed",
    };
    delivery.textContent = record
      ? `${labels[record.state]}${record.error ? ` · ${record.error}` : ""}`
      : "";
    line.dataset.delivery = record?.state || "confirmed";
    const actions = line.querySelector(".community-message-actions");
    const mode = removed
      ? "removed"
      : record && !["sending", "confirmed"].includes(record.state)
        ? "recovery"
        : item.id
          ? "report"
          : "pending";
    if (
      actions.dataset.mode !== mode &&
      !actions.contains(document.activeElement)
    ) {
      actions.replaceChildren();
      actions.dataset.mode = mode;
      if (mode === "recovery") {
        const retry = element("button", "Retry unchanged");
        retry.type = "button";
        retry.dataset.communityRetry = "";
        retry.addEventListener("click", () => {
          const attempt = state.retry(record);
          if (attempt) {
            updateLocal(record);
            void deliver(record, attempt);
          }
        });
        const recover = element("button", "Recover to draft");
        recover.type = "button";
        recover.addEventListener("click", () => {
          chatForm.elements.body.value = recoverDraft(
            chatForm.elements.body.value,
            record,
          );
          recoveredSubmission = record;
          // Retire this action until another failure, to prevent accidental duplicate recovery.
          recover.disabled = true;
          sendStatus.textContent =
            "Text added to your draft. Sending unchanged recovered text retries its original submission. Editing creates a new submission.";
          chatForm.elements.body.focus();
        });
        actions.append(retry, recover);
      }
      if (mode === "report") {
        const reportButton = element("button", "Report message");
        reportButton.type = "button";
        reportButton.setAttribute("aria-expanded", "false");
        reportButton.addEventListener("click", () => {
          const open = reportButton.getAttribute("aria-expanded") === "true";
          reportButton.setAttribute("aria-expanded", String(!open));
          if (open) line.querySelector("form")?.remove();
          else
            line.append(
              reportForm("chat", item.id, status, () => {
                line.querySelector("form")?.remove();
                reportButton.setAttribute("aria-expanded", "false");
                reportButton.focus();
              }),
            );
        });
        actions.append(reportButton);
      }
    }
    actions
      .querySelector("[data-community-retry]")
      ?.toggleAttribute(
        "disabled",
        cooldownUntil > Date.now() ||
          ["sending", "confirmed", "removed"].includes(record?.state),
      );
  }

  function updateLocal(record) {
    const line = localNodes.get(record.submission.clientMessageId);
    const item = record.serverId
      ? state.server.get(record.serverId)?.item
      : null;
    const follow = nearBottom();
    const anchor = saveAnchor();
    if (line?.isConnected)
      updateMessageNode(line, item || record.submission, record);
    if (follow) messages.scrollTop = messages.scrollHeight;
    else restoreAnchor(anchor);
  }

  function updateComposer() {
    const remaining = Math.max(
      0,
      Math.ceil((cooldownUntil - Date.now()) / 1000),
    );
    chatForm.querySelector('button[type="submit"]').disabled =
      remaining > 0 || chatForm.dataset.writable === "false";
    chatRoot.querySelector("[data-community-cooldown]").textContent = remaining
      ? `Posting allowance resets in ${remaining}s. Your draft stays editable.`
      : "";
    for (const record of state.submissions.values()) {
      if (record.state === "cooldown") updateLocal(record);
    }
    window.clearTimeout(cooldownTimer);
    if (remaining) cooldownTimer = window.setTimeout(updateComposer, 1000);
  }

  async function deliver(record, attempt) {
    const finishRequest = state.beginRequest();
    try {
      const item = await api(`/api/community/events/${id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: record.submission.body,
          clientMessageId: record.submission.clientMessageId,
        }),
      });
      if (item.clientMessageId !== record.submission.clientMessageId)
        throw new Error("Invalid acknowledgment; delivery is unconfirmed.");
      insertMessage(item, "post");
      schedule(0);
    } catch (error) {
      if (state.fail(record, attempt, error)) {
        if (error.status === 429 && Number.isFinite(error.retryAfterSeconds)) {
          cooldownUntil = Math.max(
            cooldownUntil,
            Date.now() + error.retryAfterSeconds * 1000,
          );
          updateComposer();
        }
        updateLocal(record);
        sendStatus.textContent = `${record.state === "unconfirmed" ? "Delivery unconfirmed. The message may have arrived." : record.state === "cooldown" ? "Posting allowance reached." : "Message rejected."} ${error.message} Use the message’s retry or draft recovery actions.`;
      }
    } finally {
      record.settled = true;
      finishRequest();
    }
  }

  function nearBottom() {
    return (
      messages.scrollHeight - messages.scrollTop - messages.clientHeight < 64
    );
  }

  let followResize = true;
  let resizeAnchor;
  let resizeWidth = messages.clientWidth;
  let resizeHeight = messages.clientHeight;
  messages.addEventListener(
    "scroll",
    () => {
      // Native scroll events during a resize are not a change in reader intent.
      if (
        messages.clientWidth !== resizeWidth ||
        messages.clientHeight !== resizeHeight
      )
        return;
      followResize = nearBottom();
      resizeAnchor = saveAnchor();
    },
    { passive: true },
  );
  if (window.ResizeObserver) {
    new window.ResizeObserver(() => {
      if (followResize) messages.scrollTop = messages.scrollHeight;
      else if (resizeAnchor) restoreAnchor(resizeAnchor);
      resizeWidth = messages.clientWidth;
      resizeHeight = messages.clientHeight;
      resizeAnchor = saveAnchor();
    }).observe(messages);
  }

  function showNewCount() {
    newMessages.hidden = unseenCount === 0 && !latestEvicted;
    newMessages.textContent = unseenCount
      ? `${unseenCount} new ${unseenCount === 1 ? "message" : "messages"} · Jump to latest`
      : "Jump to latest";
  }

  function insertMessage(item, source = "feed") {
    const result = state.receive(item, source);
    const record = result.record;
    const current = result.item;
    tracked.add(current.id);
    if (!result.changed) return false;
    const anchor = saveAnchor();
    const pendingNode =
      record && localNodes.get(record.submission.clientMessageId);
    const serverNode = rendered.get(current.id);
    let node = pendingNode || serverNode;
    if (pendingNode && serverNode && pendingNode !== serverNode)
      serverNode.remove();
    if (record && unseenIds.delete(current.id)) {
      unseenCount = unseenIds.size;
      showNewCount();
    }
    if (current.state === "removed" && !record) {
      node?.remove();
      rendered.delete(current.id);
    } else {
      // A delayed POST cannot bring a row evicted by bounded retention back into view.
      if (!node && source === "post" && !result.confirmedNow) return false;
      messages.querySelector("[data-community-empty]")?.remove();
      if (!node) {
        node = messageNode(current, record);
        const next = Array.from(messages.children).find(
          (child) =>
            !child.dataset.messageId ||
            compareIds(child.dataset.messageId, current.id) > 0,
        );
        messages.insertBefore(node, next || null);
      }
      updateMessageNode(node, current, record);
      if (current.state === "visible") {
        const next = Array.from(messages.children).find(
          (child) =>
            child !== node &&
            (!child.dataset.messageId ||
              compareIds(child.dataset.messageId, current.id) > 0),
        );
        if (node.nextElementSibling !== (next || null))
          messages.insertBefore(node, next || null);
      }
      if (current.state === "visible") rendered.set(current.id, node);
      else rendered.delete(current.id);
    }
    restoreAnchor(anchor);
    if (result.confirmedNow && !record.announced) {
      record.announced = true;
      sendStatus.textContent =
        current.state === "removed"
          ? "Message accepted earlier and removed by moderation."
          : "Message sent.";
    }
    return result.inserted;
  }

  function updateEmpty() {
    if (
      messages.querySelector(".community-message") ||
      messages.querySelector("[data-community-empty]")
    )
      return;
    const empty = element("li", "No chat messages yet.");
    empty.dataset.communityEmpty = "";
    messages.append(empty);
  }

  function trimFeed(shouldFollow) {
    const anchor = saveAnchor();
    while (rendered.size > 500) {
      const candidates = Array.from(messages.children).filter((node) =>
        rendered.has(node.dataset.messageId),
      );
      const head = candidates[0];
      const first =
        shouldFollow ||
        (head !== anchor.node &&
          head.getBoundingClientRect().bottom <=
            messages.getBoundingClientRect().top)
          ? head
          : candidates.at(-1);
      if (!first) break;
      if (first === head) older.hidden = false;
      else latestEvicted = true;
      rendered.delete(first.dataset.messageId);
      tracked.delete(first.dataset.messageId);
      state.forget(first.dataset.messageId);
      if (first.dataset.submissionId)
        localNodes.delete(first.dataset.submissionId);
      first.remove();
    }
    if (!shouldFollow) restoreAnchor(anchor);
    oldest =
      Array.from(messages.children).find((node) =>
        rendered.has(node.dataset.messageId),
      )?.dataset.messageId ?? null;
  }

  async function loadInitialChat() {
    const finishRequest = state.beginRequest();
    try {
      const page = await api(readChatPath(`/api/community/events/${id}/chat`));
      for (const item of page.items) insertMessage(item, "history");
      oldest = page.items[0]?.id ?? null;
      state.advance(page.items);
      older.hidden = !page.hasMore;
      updateEmpty();
      messages.scrollTop = messages.scrollHeight;
      initialized = true;
    } finally {
      finishRequest();
    }
  }

  async function loadOlderChat() {
    if (!oldest || loadingOlder) return;
    loadingOlder = true;
    older.disabled = true;
    const finishRequest = state.beginRequest();
    try {
      const page = await api(
        readChatPath(
          `/api/community/events/${id}/chat?before=${encodeURIComponent(oldest)}`,
        ),
      );
      const anchor = saveAnchor();
      for (const item of page.items) insertMessage(item, "history");
      oldest = page.items[0]?.id ?? oldest;
      older.hidden = !page.hasMore;
      restoreAnchor(anchor);
      trimFeed(false);
      showNewCount();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      finishRequest();
      older.disabled = false;
      loadingOlder = false;
    }
  }

  async function syncChat() {
    let received = 0;
    let hasMore = false;
    const visibleIds = Array.from(rendered.keys());
    const hiddenIds = Array.from(tracked)
      .filter((id) => !rendered.has(id))
      .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    const hiddenBudget = Math.max(0, 1000 - visibleIds.length);
    for (const staleId of hiddenIds.slice(
      0,
      Math.max(0, hiddenIds.length - hiddenBudget),
    )) {
      tracked.delete(staleId);
      const record = state.server.get(staleId)?.record;
      if (record?.state === "removed" && record.settled) {
        localNodes.get(record.submission.clientMessageId)?.remove();
        localNodes.delete(record.submission.clientMessageId);
      }
      state.forget(staleId);
    }
    const watched = [
      ...visibleIds,
      ...(hiddenBudget ? hiddenIds.slice(-hiddenBudget) : []),
    ].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    const watchPages = [];
    for (let index = 0; index < watched.length; index += 200)
      watchPages.push(watched.slice(index, index + 200));
    for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
      const watchedIds = watchPages[pageNumber] ?? [];
      const query = new URLSearchParams({ after: state.cursor });
      if (watchedIds.length) query.set("watch", watchedIds.join(","));
      const page = await api(
        readChatPath(`/api/community/events/${id}/chat/sync?${query}`),
      );
      const shouldFollowPage = nearBottom();
      if (watchedIds.length) {
        const present = new Set(
          [...page.watched, ...(page.removed || [])].map((item) => item.id),
        );
        const anchor = saveAnchor();
        for (const watchedId of watchedIds) {
          if (!present.has(watchedId)) {
            state.missing(watchedId);
            const node = rendered.get(watchedId);
            if (node?.dataset.submissionId)
              updateLocal(state.server.get(watchedId).record);
            else node?.remove();
            rendered.delete(watchedId);
          }
        }
        for (const item of [...(page.removed || []), ...page.watched])
          insertMessage(item);
        restoreAnchor(anchor);
      }
      let added = 0;
      for (const item of page.items)
        if (insertMessage(item)) {
          added += 1;
          if (!shouldFollowPage) unseenIds.add(item.id);
        }
      received += added;
      // Confirmation alone must neither scroll nor add an unread message.
      if (added && shouldFollowPage) messages.scrollTop = messages.scrollHeight;
      else if (added) unseenCount = unseenIds.size;
      state.advance(page.items);
      hasMore = page.hasMore;
      if (!hasMore && pageNumber + 1 >= watchPages.length) break;
    }
    const shouldFollow = nearBottom();
    trimFeed(shouldFollow);
    updateEmpty();
    if (shouldFollow) {
      messages.scrollTop = messages.scrollHeight;
      unseenCount = 0;
      unseenIds.clear();
    }
    if (received)
      chatRoot.querySelector("[data-community-announcement]").textContent =
        `${received} new chat ${received === 1 ? "message" : "messages"}.`;
    showNewCount();
    return hasMore;
  }

  function schedule(delay) {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void poll(), delay);
  }

  async function poll() {
    if (syncing) return;
    if (document.visibilityState === "hidden") {
      schedule(2000);
      return;
    }
    syncing = true;
    try {
      if (!initialized) await loadInitialChat();
      const hasMore = await syncChat();
      await refreshSummary();
      setText(connection, "Live updates on");
      if (status.textContent === "Loading community activity…")
        status.textContent = "Community activity ready.";
      retryDelay = 2000;
      schedule(hasMore ? 0 : 2000);
    } catch (error) {
      if (error.status === 401) signedIn = false;
      setText(connection, "Connection interrupted. Reconnecting…");
      schedule(retryDelay);
      retryDelay = Math.min(retryDelay * 2, 15000);
    } finally {
      syncing = false;
    }
  }

  void api("/api/auth/me")
    .then(() => {
      signedIn = true;
      return refreshSummary();
    })
    .catch(() => {
      signedIn = false;
      like.title = "Sign in to like this event";
    });
  void poll();
  root
    .querySelector("[data-community-refresh]")
    .addEventListener("click", () => {
      setText(connection, "Checking for messages…");
      schedule(0);
    });
  older.addEventListener("click", () => void loadOlderChat());
  newMessages.addEventListener("click", () => {
    void (async () => {
      const finishRequest = state.beginRequest();
      try {
        if (latestEvicted) {
          const page = await api(
            readChatPath(`/api/community/events/${id}/chat`),
          );
          for (const [serverId, node] of rendered) {
            node.remove();
            tracked.delete(serverId);
            state.forget(serverId);
            if (node.dataset.submissionId)
              localNodes.delete(node.dataset.submissionId);
          }
          rendered.clear();
          for (const item of page.items) insertMessage(item, "history");
          oldest = page.items[0]?.id ?? null;
          older.hidden = !page.hasMore;
          latestEvicted = false;
        }
        messages.scrollTop = messages.scrollHeight;
        unseenCount = 0;
        unseenIds.clear();
        showNewCount();
        messages.focus({ preventScroll: true });
      } catch (error) {
        status.textContent = error.message;
      } finally {
        finishRequest();
      }
    })();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") schedule(0);
  });
  window.addEventListener("online", () => schedule(0));
  like.addEventListener("click", () => {
    like.disabled = true;
    void api(`/api/community/events/${id}/like`, {
      method: currentLiked ? "DELETE" : "PUT",
    })
      .then((result) => {
        currentLiked = result.liked;
        like.setAttribute("aria-pressed", String(currentLiked));
        like.textContent = currentLiked ? "Remove like" : "Like this event";
        count.textContent = `${result.likes} ${result.likes === 1 ? "like" : "likes"}`;
        status.textContent = currentLiked ? "Event liked." : "Like removed.";
      })
      .catch((error) => {
        status.textContent = error.message;
      })
      .finally(() => {
        like.disabled = false;
      });
  });
  root.querySelector("[data-community-share]").addEventListener("click", () => {
    const url = window.location.origin + window.location.pathname;
    if (!navigator.clipboard?.writeText) {
      status.textContent = `Copy this event link: ${url}`;
      return;
    }
    void navigator.clipboard
      .writeText(url)
      .then(() => {
        status.textContent = "Event link copied.";
      })
      .catch(() => {
        status.textContent = `Copy this event link: ${url}`;
      });
  });
  const composer = chatForm.elements.body;
  composer.addEventListener("compositionstart", () => {
    composing = true;
  });
  composer.addEventListener("compositionend", () => {
    composing = false;
  });
  composer.addEventListener("keydown", (event) => {
    if (shouldSendOnEnter(event, composing)) {
      event.preventDefault();
      chatForm.requestSubmit();
    }
  });
  function clearSubmittedDraft() {
    composer.value = "";
    recoveredSubmission = null;
    sendStatus.textContent = "";
    if (
      document.activeElement === composer ||
      document.activeElement === chatForm.querySelector('button[type="submit"]')
    )
      composer.focus({ preventScroll: true });
  }
  chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (cooldownUntil > Date.now() || chatForm.dataset.writable === "false")
      return;
    // This reference comes only from explicit recovery; it is never feed text matching.
    if (
      recoveredSubmission &&
      composer.value.trim() === recoveredSubmission.submission.body
    ) {
      const attempt = state.retry(recoveredSubmission);
      if (!attempt) {
        sendStatus.textContent =
          recoveredSubmission.state === "sending"
            ? "This submission is still sending."
            : recoveredSubmission.state === "removed"
              ? "This submission was accepted and removed. Edit your draft to create a new submission."
              : "This submission is already sent. Edit your draft to create a new submission.";
        return;
      }
      const record = recoveredSubmission;
      clearSubmittedDraft();
      updateLocal(record);
      void deliver(record, attempt);
      return;
    }
    const record = state.begin(
      composer.value,
      window.crypto.randomUUID(),
      new Date().toISOString(),
    );
    if (!record) {
      sendStatus.textContent = "Enter a message of 1–500 characters.";
      return;
    }
    const follow = nearBottom();
    const anchor = saveAnchor();
    const line = messageNode(record.submission, record);
    updateMessageNode(line, record.submission, record);
    messages.querySelector("[data-community-empty]")?.remove();
    messages.append(line);
    localNodes.set(record.submission.clientMessageId, line);
    // Clear only the immutable captured draft, synchronously before network work.
    clearSubmittedDraft();
    if (follow) messages.scrollTop = messages.scrollHeight;
    else restoreAnchor(anchor);
    void deliver(record, record.attempt);
  });
  report.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit(
      report,
      async () => {
        await api("/api/community/reports", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetType: "event",
            targetId: id,
            reasonCode: report.elements.reasonCode.value,
            detail: report.elements.detail.value,
          }),
        });
        report.reset();
        status.textContent = "Report submitted privately for review.";
      },
      status,
    );
  });
}

function initMine(root) {
  const status = root.querySelector("[data-community-status]");
  const list = root.querySelector("[data-community-list]");
  async function refresh() {
    try {
      const cases = await api("/api/community/me/cases");
      list.replaceChildren();
      if (!cases.length)
        list.append(element("p", "No reports or moderation actions yet."));
      for (const item of cases) {
        const card = element("article", undefined, "community-case");
        card.append(
          element("h2", `${item.targetType} report · ${item.status}`),
        );
        card.append(
          element(
            "p",
            `Reason: ${item.reasonCode}. Action: ${item.action || "none"}. ${date(item.createdAt)}`,
          ),
        );
        if (item.detail) card.append(element("p", item.detail));
        if (item.appealStatus)
          card.append(element("p", `Appeal: ${item.appealStatus}`));
        if (item.canAppeal) {
          const form = element("form", undefined, "community-inline-form");
          const reason = noteField();
          form.append(
            labelField("Why should this action be reconsidered?", reason),
            element("button", "Submit appeal"),
          );
          form.lastChild.type = "submit";
          form.addEventListener("submit", (event) => {
            event.preventDefault();
            void submit(
              form,
              async () => {
                await api(`/api/community/cases/${item.id}/appeal`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ reason: reason.value }),
                });
                status.textContent = "Appeal submitted for review.";
                await refresh();
              },
              status,
            );
          });
          card.append(form);
        }
        list.append(card);
      }
      status.textContent = `${cases.length} case${cases.length === 1 ? "" : "s"} shown.`;
    } catch (error) {
      status.textContent = error.message;
    }
  }
  root
    .querySelector("[data-community-refresh]")
    .addEventListener("click", () => {
      void refresh();
    });
  void refresh();
}

function initModeration(root) {
  const status = root.querySelector("[data-community-status]");
  const casesList = root.querySelector("[data-community-cases]");
  const appealsList = root.querySelector("[data-community-appeals]");
  const filter = root.querySelector("[data-community-case-filter]");
  async function refresh() {
    try {
      const [cases, appeals] = await Promise.all([
        api(`/api/community/moderation/cases?status=${filter.value}`),
        api("/api/community/moderation/appeals"),
      ]);
      casesList.replaceChildren();
      appealsList.replaceChildren();
      if (!cases.length)
        casesList.append(element("p", "No cases in this state."));
      if (!appeals.length) appealsList.append(element("p", "No open appeals."));
      for (const item of cases) casesList.append(caseCard(item));
      for (const item of appeals) appealsList.append(appealCard(item));
      status.textContent = `${cases.length} cases and ${appeals.length} open appeals shown.`;
    } catch (error) {
      status.textContent = error.message;
    }
  }

  function caseCard(item) {
    const card = element("article", undefined, "community-case");
    card.append(element("h3", `${item.targetType} · ${item.status}`));
    card.append(
      element("p", `Reported ${date(item.createdAt)} · ${item.reasonCode}`),
    );
    card.append(element("p", item.detail));
    if (item.chatBody) card.append(element("blockquote", item.chatBody));
    if (item.action)
      card.append(
        element("p", `Action: ${item.action}. ${item.decisionNote || ""}`),
      );
    const history = element("button", "Show audit history");
    history.type = "button";
    const historyList = element("ol");
    historyList.hidden = true;
    history.addEventListener("click", () => {
      void api(`/api/community/moderation/cases/${item.id}`)
        .then((detail) => {
          historyList.replaceChildren(
            ...detail.history.map((entry) =>
              element(
                "li",
                `${date(entry.occurredAt)} · ${entry.action}${entry.note ? ` · ${entry.note}` : ""}`,
              ),
            ),
          );
          historyList.hidden = false;
        })
        .catch((error) => {
          status.textContent = error.message;
        });
    });
    card.append(history, historyList);
    if (item.status === "open") {
      const form = element("form", undefined, "community-inline-form");
      const choices =
        item.targetType === "chat"
          ? ["dismiss", "remove_chat", "restrict_account"]
          : ["dismiss", "pause_chat"];
      const action = selectField(choices, "Choose an action");
      const reason = selectField(reasons, "Choose a reason");
      const note = noteField();
      form.append(
        labelField("Action", action),
        labelField("Reason", reason),
        labelField("Review note", note),
        element("button", "Save decision"),
      );
      form.lastChild.type = "submit";
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        void submit(
          form,
          async () => {
            await api(`/api/community/moderation/cases/${item.id}/decision`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: action.value,
                reasonCode: reason.value,
                note: note.value,
              }),
            });
            status.textContent = "Case decision saved.";
            await refresh();
          },
          status,
        );
      });
      card.append(form);
    }
    if (item.action === "pause_chat" && item.chatState === "paused") {
      const resume = element("form", undefined, "community-inline-form");
      const note = noteField();
      resume.append(
        labelField("Reason to resume chat", note),
        element("button", "Resume event chat"),
      );
      resume.lastChild.type = "submit";
      resume.addEventListener("submit", (event) => {
        event.preventDefault();
        void submit(
          resume,
          async () => {
            await api(
              `/api/community/moderation/cases/${item.id}/resume-chat`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ note: note.value }),
              },
            );
            status.textContent = "Event chat resumed.";
            await refresh();
          },
          status,
        );
      });
      card.append(resume);
    }
    return card;
  }

  function appealCard(item) {
    const card = element("article", undefined, "community-case");
    card.append(
      element("h3", "Appeal"),
      element("p", `Case ${item.caseId} · ${date(item.createdAt)}`),
      element("blockquote", item.reason),
    );
    const form = element("form", undefined, "community-inline-form");
    const decision = selectField(["upheld", "overturned"], "Choose a decision");
    const note = noteField();
    form.append(
      labelField("Decision", decision),
      labelField("Review note", note),
      element("button", "Save appeal decision"),
    );
    form.lastChild.type = "submit";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submit(
        form,
        async () => {
          await api(`/api/community/moderation/appeals/${item.id}/decision`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              decision: decision.value,
              note: note.value,
            }),
          });
          status.textContent = "Appeal decision saved.";
          await refresh();
        },
        status,
      );
    });
    card.append(form);
    return card;
  }
  root
    .querySelector("[data-community-refresh]")
    .addEventListener("click", () => {
      void refresh();
    });
  filter.addEventListener("change", () => {
    void refresh();
  });
  void refresh();
}

const eventRoot = document.querySelector("[data-community-event]");
if (eventRoot) initEvent(eventRoot);
const mineRoot = document.querySelector("[data-community-mine]");
if (mineRoot) initMine(mineRoot);
const moderatorRoot = document.querySelector("[data-community-moderation]");
if (moderatorRoot) initModeration(moderatorRoot);
