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
  const status = root.querySelector("[data-community-status]");
  const chatState = root.querySelector("[data-community-chat-state]");
  const messages = root.querySelector("[data-community-messages]");
  const older = root.querySelector("[data-community-older]");
  const like = root.querySelector("[data-community-like]");
  const count = root.querySelector("[data-community-likes]");
  const chatForm = root.querySelector("[data-community-chat-form]");
  const report = root.querySelector("[data-community-report-form]");
  let currentLiked = false;
  let oldest = null;
  let showingOlder = false;
  let signedIn = false;

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

  async function refreshChat(loadOlder = false) {
    const url = `/api/community/events/${id}/chat${loadOlder && oldest ? `?before=${encodeURIComponent(oldest)}` : ""}`;
    const page = await api(url);
    const nodes = page.items.map(messageNode);
    if (loadOlder) {
      messages.prepend(...nodes);
      showingOlder = true;
    } else {
      messages.replaceChildren(...nodes);
    }
    if (page.items.length)
      oldest = loadOlder ? page.items[0].id : page.items[0].id;
    older.hidden = !page.hasMore;
    if (!messages.children.length)
      messages.append(element("li", "No chat messages yet."));
  }

  async function refresh() {
    try {
      await Promise.all([refreshSummary(), refreshChat()]);
      status.textContent = "Community activity is up to date.";
    } catch (error) {
      status.textContent = error.message;
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
  void refresh();
  root
    .querySelector("[data-community-refresh]")
    .addEventListener("click", () => {
      showingOlder = false;
      void refresh();
    });
  older.addEventListener("click", () => {
    void refreshChat(true).catch((error) => {
      status.textContent = error.message;
    });
  });
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
    void submit(
      chatForm,
      async () => {
        const body = chatForm.elements.body.value;
        await api(`/api/community/events/${id}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        });
        chatForm.reset();
        status.textContent = "Message posted.";
        await refreshChat();
      },
      status,
    );
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
  window.setInterval(() => {
    if (document.visibilityState !== "visible" || showingOlder) return;
    void Promise.all([refreshSummary(), refreshChat()]).catch((error) => {
      status.textContent = error.message;
    });
  }, 5000);
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
