/* global document, window */
const notice = document.querySelector("#match-notice");
const requestForm = document.querySelector("#request-create");
const topicSlugInput = requestForm.elements.topicSlug;
const sideSelect = requestForm.elements.requestedSide;
const sideMap = document.createElement("p");
sideMap.className = "form-note";
sideMap.setAttribute("role", "status");
sideMap.textContent = "Choose a published topic to see its side mapping.";
topicSlugInput.closest("label").after(sideMap);
let currentUser = null;

function say(message) {
  notice.textContent = message;
}
async function api(path, method = "GET", body) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || "Request failed. Please try again.");
  return data;
}

function row(label, href) {
  const item = document.createElement("li");
  const content = document.createElement(href ? "a" : "span");
  content.textContent = label;
  if (href) content.href = href;
  item.append(content);
  return item;
}
function action(item, label, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "small-button";
  button.textContent = label;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await handler();
      await refresh();
    } catch (error) {
      say(error.message);
    } finally {
      button.disabled = false;
    }
  });
  item.append(button);
}
function fill(selector, entries, render) {
  const list = document.querySelector(selector);
  list.replaceChildren();
  if (!entries.length) list.append(row("Nothing here yet."));
  for (const entry of entries) list.append(render(entry));
}
function date(value) {
  return new Date(value).toLocaleString();
}
async function loadTopic() {
  const slug = topicSlugInput.value.trim();
  if (!slug) throw new Error("Choose a published topic first.");
  const topic = await api(`/api/public/topics/${encodeURIComponent(slug)}`);
  sideSelect.options[0].textContent = `Side A — ${topic.sideALabel}`;
  sideSelect.options[1].textContent = `Side B — ${topic.sideBLabel}`;
  sideMap.textContent = `A: ${topic.sideALabel} · B: ${topic.sideBLabel}`;
  return topic;
}
topicSlugInput.addEventListener("change", () =>
  loadTopic().catch((error) => {
    sideMap.textContent = "Choose a published topic to see its side mapping.";
    say(error.message);
  }),
);

async function refresh() {
  const [topics, requests, queue, events, notifications] = await Promise.all([
    api("/api/matching/topics/mine"),
    api("/api/matching/requests"),
    api("/api/matching/queue"),
    api("/api/matching/events"),
    api("/api/matching/notifications"),
  ]);
  fill("#my-topics", topics.topics, (topic) => {
    const item = row(
      `${topic.title} · ${topic.publicationState}`,
      topic.publicationState === "published"
        ? `/topics/${encodeURIComponent(topic.slug)}`
        : null,
    );
    if (topic.publicationState === "draft")
      action(item, "Publish", async () => {
        await api(
          `/api/matching/topics/${encodeURIComponent(topic.slug)}/publish`,
          "POST",
        );
        say("Topic published.");
      });
    return item;
  });
  fill("#my-requests", requests.requests, (request) => {
    const mySide =
      request.initiatorUserId === currentUser.id
        ? request.requestedSide
        : request.requestedSide === "A"
          ? "B"
          : "A";
    const myLabel = mySide === "A" ? request.sideALabel : request.sideBLabel;
    const item = row(
      `${request.kind === "direct" ? "Challenge" : "Queue"}: ${request.proposition} · your side ${mySide} (${myLabel}) · ${request.status} · ${date(request.scheduledAt)}`,
      request.debateSlug
        ? `/debates/${encodeURIComponent(request.debateSlug)}`
        : null,
    );
    if (request.status === "open" && request.targetUserId === currentUser.id)
      action(item, "Accept", async () => {
        if (
          !window.confirm(
            `Accept “${request.proposition}” on side ${mySide} (${myLabel}) at ${date(request.scheduledAt)}?`,
          )
        )
          return;
        await api(`/api/matching/requests/${request.id}/accept`, "POST");
        say("Challenge accepted. Your event is scheduled.");
      });
    if (request.status === "open" && request.targetUserId === currentUser.id)
      action(item, "Decline", async () => {
        await api(`/api/matching/requests/${request.id}/declined`, "POST");
        say("Challenge declined.");
      });
    if (request.status === "open" && request.initiatorUserId === currentUser.id)
      action(item, "Withdraw", async () => {
        await api(`/api/matching/requests/${request.id}/withdrawn`, "POST");
        say("Request withdrawn.");
      });
    return item;
  });
  fill(
    "#open-queue",
    queue.requests.filter(
      (request) => request.initiatorUserId !== currentUser.id,
    ),
    (request) => {
      const opposite = request.requestedSide === "A" ? "B" : "A";
      const oppositeLabel =
        opposite === "A" ? request.sideALabel : request.sideBLabel;
      const item = row(
        `${request.proposition} · ${request.topicSlug} · take side ${opposite} (${oppositeLabel}) · ${date(request.scheduledAt)}`,
      );
      action(item, "Join", async () => {
        if (
          !window.confirm(
            `Join on side ${opposite} (${oppositeLabel}) for “${request.proposition}” at ${date(request.scheduledAt)}?`,
          )
        )
          return;
        await api(`/api/matching/queue/${request.id}/join`, "POST");
        say("Joined. Your event is scheduled.");
      });
      return item;
    },
  );
  fill("#my-events", events.events, (event) => {
    const item = row(
      `${event.proposition} · ${event.status} · ${date(event.scheduledAt)}`,
      `/debates/${encodeURIComponent(event.slug)}`,
    );
    if (event.status === "scheduled" || event.status === "ready")
      item.append(
        document.createTextNode(" · Open event to check camera and join"),
      );
    return item;
  });
  fill("#match-notifications", notifications.notifications, (entry) => {
    const item = row(`${entry.message} · ${date(entry.createdAt)}`);
    if (!entry.readAt)
      action(item, "Mark read", async () => {
        await api(`/api/matching/notifications/${entry.id}/read`, "POST");
      });
    return item;
  });
}

document
  .querySelector("#topic-create")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await api("/api/matching/topics", "POST", Object.fromEntries(data));
      form.reset();
      say("Topic created as a private draft. Publish it when ready.");
      await refresh();
    } catch (error) {
      say(error.message);
    }
  });

requestForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  try {
    await loadTopic();
    const scheduledAt = new Date(data.scheduledAt);
    if (!Number.isFinite(scheduledAt.getTime()))
      throw new Error("Choose a valid start time.");
    const body = {
      kind: data.kind,
      topicSlug: data.topicSlug,
      proposition: data.proposition,
      requestedSide: data.requestedSide,
      scheduledAt: scheduledAt.toISOString(),
      ...(data.kind === "direct" ? { targetHandle: data.targetHandle } : {}),
    };
    await api("/api/matching/requests", "POST", body);
    form.reset();
    sideSelect.options[0].textContent = "Side A";
    sideSelect.options[1].textContent = "Side B";
    sideMap.textContent = "Choose a published topic to see its side mapping.";
    say(
      "Request opened. It expires after 24 hours or 30 minutes before the proposed start.",
    );
    await refresh();
  } catch (error) {
    say(error.message);
  }
});

async function initialize() {
  try {
    currentUser = (await api("/api/auth/me")).user;
    document.querySelector("#match-signed-in").hidden = false;
    await refresh();
    say("Matching ready.");
  } catch (error) {
    if (error.message === "authentication required") {
      document.querySelector("#match-signed-out").hidden = false;
      say("Sign in to create topics and arrange debates.");
    } else say(error.message);
  }
}

initialize();
