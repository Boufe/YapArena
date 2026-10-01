/* global document, window */
const reasons = ["harassment", "hate", "threat", "spam", "privacy", "other"];

function element(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
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

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { credentials: "same-origin", ...options });
  } catch {
    throw new Error("Network unavailable. Try again.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401)
      throw new Error("Sign in to continue from the Account page.");
    throw new Error(data.error || `Request failed (${response.status}).`);
  }
  return data;
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
  let latestId = "0";
  let initialized = false;
  let syncing = false;
  let loadingOlder = false;
  let retryDelay = 2000;
  let timer;
  let unseenCount = 0;
  const rendered = new Map();
  const tracked = new Set();

  async function refreshSummary() {
    const summary = await api(`/api/community/events/${id}`);
    count.textContent = `${summary.likes} ${summary.likes === 1 ? "like" : "likes"}`;
    chatForm.hidden = !summary.chatWritable;
    chatState.textContent =
      summary.chatState === "paused"
        ? "Chat is paused by moderation. Existing messages remain visible."
        : summary.chatWritable
          ? "Chat is open during this live event."
          : "Chat is read-only outside the live event.";
    if (signedIn) {
      const mine = await api(`/api/community/events/${id}/my-like`);
      currentLiked = mine.liked;
      like.setAttribute("aria-pressed", String(currentLiked));
      like.textContent = currentLiked ? "Remove like" : "Like this event";
    }
  }

  function messageNode(item) {
    const line = element("li", undefined, "community-message");
    line.dataset.messageId = item.id;
    const header = element("div", undefined, "community-message-heading");
    header.append(
      element("strong", item.authorName),
      element("time", date(item.createdAt)),
    );
    const body = element("p", item.body);
    const reportButton = element("button", "Report message");
    reportButton.type = "button";
    reportButton.setAttribute("aria-expanded", "false");
    reportButton.addEventListener("click", () => {
      const open = reportButton.getAttribute("aria-expanded") === "true";
      reportButton.setAttribute("aria-expanded", String(!open));
      if (open) {
        line.querySelector("form")?.remove();
      } else {
        line.append(
          reportForm("chat", item.id, status, () => {
            line.querySelector("form")?.remove();
            reportButton.setAttribute("aria-expanded", "false");
          }),
        );
      }
    });
    line.append(header, body, reportButton);
    return line;
  }

  function nearBottom() {
    return (
      messages.scrollHeight - messages.scrollTop - messages.clientHeight < 64
    );
  }

  function showNewCount() {
    newMessages.hidden = unseenCount === 0;
    newMessages.textContent = `${unseenCount} new ${unseenCount === 1 ? "message" : "messages"} · Jump to latest`;
  }

  function insertMessage(item) {
    if (rendered.has(item.id)) return false;
    messages.querySelector("[data-community-empty]")?.remove();
    const node = messageNode(item);
    const next = Array.from(messages.children).find(
      (child) =>
        child.dataset.messageId &&
        BigInt(child.dataset.messageId) > BigInt(item.id),
    );
    messages.insertBefore(node, next || null);
    rendered.set(item.id, node);
    tracked.add(item.id);
    return true;
  }

  function updateEmpty() {
    if (rendered.size || messages.querySelector("[data-community-empty]"))
      return;
    const empty = element("li", "No chat messages yet.");
    empty.dataset.communityEmpty = "";
    messages.append(empty);
  }

  function trimFeed() {
    while (rendered.size > 200) {
      const first = messages.querySelector("[data-message-id]");
      if (!first) break;
      rendered.delete(first.dataset.messageId);
      tracked.delete(first.dataset.messageId);
      first.remove();
      older.hidden = false;
    }
    oldest =
      messages.querySelector("[data-message-id]")?.dataset.messageId ?? null;
  }

  async function loadInitialChat() {
    const page = await api(`/api/community/events/${id}/chat`);
    for (const item of page.items) insertMessage(item);
    oldest = page.items[0]?.id ?? null;
    latestId = page.items.at(-1)?.id ?? "0";
    older.hidden = !page.hasMore;
    updateEmpty();
    messages.scrollTop = messages.scrollHeight;
    initialized = true;
  }

  async function loadOlderChat() {
    if (!oldest || loadingOlder) return;
    loadingOlder = true;
    older.disabled = true;
    const height = messages.scrollHeight;
    const top = messages.scrollTop;
    try {
      const page = await api(
        `/api/community/events/${id}/chat?before=${encodeURIComponent(oldest)}`,
      );
      for (const item of page.items) insertMessage(item);
      oldest = page.items[0]?.id ?? oldest;
      older.hidden = !page.hasMore;
      messages.scrollTop = top + messages.scrollHeight - height;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      older.disabled = false;
      loadingOlder = false;
    }
  }

  async function syncChat() {
    const shouldFollow = nearBottom();
    let received = 0;
    let hasMore = false;
    for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
      const watchedIds =
        pageNumber === 0
          ? Array.from(tracked)
              .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
              .slice(-200)
          : [];
      const query = new URLSearchParams({ after: latestId });
      if (watchedIds.length) query.set("watch", watchedIds.join(","));
      const page = await api(`/api/community/events/${id}/chat/sync?${query}`);
      if (watchedIds.length) {
        const visible = new Set(page.watched.map((item) => item.id));
        for (const watchedId of watchedIds) {
          if (!visible.has(watchedId) && rendered.has(watchedId)) {
            rendered.get(watchedId).remove();
            rendered.delete(watchedId);
          }
        }
        for (const item of page.watched) insertMessage(item);
      }
      for (const item of page.items) {
        if (insertMessage(item)) received += 1;
      }
      if (page.items.length) latestId = page.items.at(-1).id;
      hasMore = page.hasMore;
      if (!hasMore) break;
    }
    trimFeed();
    updateEmpty();
    if (shouldFollow) {
      messages.scrollTop = messages.scrollHeight;
      unseenCount = 0;
    } else {
      unseenCount += received;
    }
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
      connection.textContent = "Live updates on";
      if (status.textContent === "Loading community activity…")
        status.textContent = "Community activity ready.";
      retryDelay = 2000;
      schedule(hasMore ? 0 : 2000);
    } catch {
      connection.textContent = "Connection interrupted. Reconnecting…";
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
      connection.textContent = "Checking for messages…";
      schedule(0);
    });
  older.addEventListener("click", () => void loadOlderChat());
  newMessages.addEventListener("click", () => {
    messages.scrollTop = messages.scrollHeight;
    unseenCount = 0;
    showNewCount();
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
  chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const button = chatForm.querySelector('button[type="submit"]');
    button.disabled = true;
    sendStatus.textContent = "Sending message…";
    void (async () => {
      try {
        const body = chatForm.elements.body.value.trim();
        await api(`/api/community/events/${id}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        });
        chatForm.reset();
        sendStatus.textContent = "Message sent.";
        schedule(0);
      } catch (error) {
        sendStatus.textContent = `Message not confirmed: ${error.message} Your draft is still here.`;
      } finally {
        button.disabled = false;
      }
    })();
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
