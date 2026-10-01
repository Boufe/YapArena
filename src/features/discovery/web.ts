import { randomUUID } from "node:crypto";
import type {
  PublicDebate,
  PublicList,
  PublicProfile,
  PublicTopic,
} from "./repository.ts";

const assetRevision = /^[0-9a-f]{40}$/i.test(
  process.env.RENDER_GIT_COMMIT ?? "",
)
  ? process.env.RENDER_GIT_COMMIT!.slice(0, 12)
  : randomUUID().replaceAll("-", "").slice(0, 12);
const asset = (name: string) => `/assets/${name}?v=${assetRevision}`;

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );

const path = (value: string) => encodeURIComponent(value);
const date = (value: Date | null) =>
  value
    ? new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(new Date(value)) + " UTC"
    : "To be announced";

const labels: Record<PublicDebate["status"], string> = {
  draft: "Draft",
  accepted: "Accepted",
  scheduled: "Upcoming",
  ready: "Ready",
  live: "Live",
  ended: "Ended",
  replay: "Replay",
  void_review: "Under review",
  finalized: "Finalized",
  cancelled: "Cancelled",
};

function layout(
  title: string,
  description: string,
  canonical: string,
  content: string,
  metadata = "",
) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>${escape(title)} · YAP Arena</title><meta name="description" content="${escape(description)}"><link rel="canonical" href="${escape(canonical)}">${metadata}<link rel="stylesheet" href="${asset("site.css")}"><script defer src="${asset("site.js")}"></script></head><body><a class="skip-link" href="#main">Skip to content</a><header class="site-header"><div class="container nav"><a class="brand" href="/" aria-label="YAP Arena home"><span class="brand-mark">Y</span><span>YAP<span class="brand-light">ARENA</span></span></a><nav aria-label="Main navigation"><a href="/debates">Debates</a><a href="/topics">Topics</a><a href="/match">Match</a><a href="/about">About</a><a href="/account">Account</a></nav><span class="preview-pill">PUBLIC PREVIEW</span></div></header><main id="main">${content}</main><footer class="site-footer"><div class="container footer-inner"><span>YAP ARENA <span class="muted">/ Ideas under pressure.</span></span><span>Public preview · No financial activity</span></div></footer></body></html>`;
}

function badge(debate: PublicDebate) {
  return `<span class="status status-${debate.status}">${labels[debate.status]}</span>${debate.isDemo ? '<span class="demo-label">DEMO</span>' : ""}`;
}

function debateCard(debate: PublicDebate) {
  return `<article class="debate-card"><div class="card-top">${badge(debate)}<span class="card-topic">${escape(debate.topic.title)}</span></div><h3><a href="/debates/${path(debate.slug)}">${escape(debate.proposition)}</a></h3><div class="card-sides"><span>${escape(debate.topic.sideALabel)}</span><span class="versus">VS</span><span>${escape(debate.topic.sideBLabel)}</span></div><div class="card-bottom"><span>${debate.status === "scheduled" ? date(debate.scheduledAt) : debate.status === "live" ? "Happening now" : "Debate archive"}</span><a class="text-link" href="/debates/${path(debate.slug)}">View debate <span aria-hidden="true">↗</span></a></div></article>`;
}

function topicCard(topic: PublicTopic) {
  return `<article class="topic-card"><span class="eyebrow">TOPIC ${topic.isDemo ? "· DEMO" : ""}</span><h3><a href="/topics/${path(topic.slug)}">${escape(topic.title)}</a></h3><p>${escape(topic.summary)}</p><div class="topic-sides"><span>${escape(topic.sideALabel)}</span><span>${escape(topic.sideBLabel)}</span></div></article>`;
}

function pagination(base: string, list: PublicList<unknown>) {
  const previous = list.pagination.offset > 0;
  const next = list.pagination.hasMore;
  if (!previous && !next) return "";
  const link = (offset: number, label: string) =>
    `<a class="page-link" href="${escape(listPath(base, list, offset))}">${label}</a>`;
  return `<nav class="pagination" aria-label="Pagination">${previous ? link(Math.max(0, list.pagination.offset - list.pagination.limit), "← Previous") : "<span></span>"}<span>Page ${Math.floor(list.pagination.offset / list.pagination.limit) + 1}</span>${next ? link(list.pagination.offset + list.pagination.limit, "Next →") : "<span></span>"}</nav>`;
}

function listPath(
  base: string,
  list: PublicList<unknown>,
  offset = list.pagination.offset,
) {
  const parameters = new URLSearchParams();
  if (list.pagination.limit !== 12)
    parameters.set("limit", String(list.pagination.limit));
  if (offset > 0) parameters.set("offset", String(offset));
  if (!parameters.size) return base;
  return `${base}${base.includes("?") ? "&" : "?"}${parameters}`;
}

export function renderHome(
  origin: string,
  debates: PublicList<PublicDebate>,
  topics: PublicList<PublicTopic>,
) {
  const content = `<section class="hero"><div class="container hero-grid"><div><span class="eyebrow accent">THE ARENA IS TAKING SHAPE</span><h1>Better arguments.<br><em>Out in the open.</em></h1><p>Discover debates, explore the ideas behind them, and follow the people who bring them to life.</p><div class="hero-actions"><a class="button" href="/debates">Explore debates <span aria-hidden="true">↗</span></a><a class="button-secondary" href="/topics">Browse topics <span aria-hidden="true">→</span></a></div></div><div class="hero-art" aria-hidden="true"><span class="orbit orbit-one"></span><span class="orbit orbit-two"></span><span class="art-a">A</span><span class="art-vs">VS</span><span class="art-b">B</span><span class="art-caption">EVERY IDEA HAS<br>ANOTHER SIDE</span></div></div></section><section class="container section"><div class="section-heading"><div><span class="eyebrow">01 / THE CONVERSATION</span><h2>Debates to watch</h2></div><a class="text-link" href="/debates">All debates <span aria-hidden="true">↗</span></a></div>${debates.items.length ? `<div class="card-grid">${debates.items.map(debateCard).join("")}</div>` : `<div class="empty-state"><h3>No public debates yet.</h3><p>Published debates will appear here when they are ready.</p></div>`}</section><section class="container section"><div class="section-heading"><div><span class="eyebrow">02 / EXPLORE IDEAS</span><h2>Topics in play</h2></div><a class="text-link" href="/topics">All topics <span aria-hidden="true">↗</span></a></div>${topics.items.length ? `<div class="card-grid">${topics.items.map(topicCard).join("")}</div>` : `<div class="empty-state"><h3>No public topics yet.</h3><p>Published topics will appear here when they are ready.</p></div>`}</section><section class="container note-band"><span class="eyebrow">ABOUT THIS PREVIEW</span><p>YAP Arena is under development. Demo listings are examples, not real events. Profiles, wallet sign-in, and follows are available. Live debate and replay are in a configured local prototype; financial participation is unavailable.</p></section>`;
  return layout(
    "Ideas under pressure",
    "Discover public debates and topics on YAP Arena.",
    `${origin}/`,
    content,
  );
}

export function renderDebates(
  origin: string,
  list: PublicList<PublicDebate>,
  query: string,
  status: string,
) {
  const filters = [
    "all",
    "scheduled",
    "ready",
    "live",
    "ended",
    "replay",
    "void_review",
    "finalized",
    "cancelled",
  ]
    .map(
      (option) =>
        `<a class="filter ${status === option ? "active" : ""}" ${status === option ? 'aria-current="page"' : ""} href="/debates${option === "all" ? "" : `?status=${option}`}${query ? `${option === "all" ? "?" : "&"}q=${encodeURIComponent(query)}` : ""}">${option === "all" ? "All" : labels[option as PublicDebate["status"]]}</a>`,
    )
    .join("");
  const base = `/debates${query || status !== "all" ? `?${new URLSearchParams({ ...(query ? { q: query } : {}), ...(status !== "all" ? { status } : {}) })}` : ""}`;
  const content = `<section class="container page-intro"><span class="eyebrow accent">THE DEBATE FLOOR</span><h1>Find your next<br><em>good argument.</em></h1><p>Upcoming conversations and public debate archives, all in one place.</p></section><section class="container section compact"><form class="search-form" action="/debates" method="get" role="search"><label for="debate-search">Search debates</label><div><input id="debate-search" name="q" maxlength="80" value="${escape(query)}" placeholder="Search propositions or topics"><button type="submit">Search ↗</button></div></form><nav class="filters" aria-label="Debate status">${filters}</nav>${list.items.length ? `<div class="card-grid">${list.items.map(debateCard).join("")}</div>` : `<div class="empty-state"><h2>No debates found.</h2><p>Try another search or status filter. Only published debates appear here.</p></div>`}${pagination(base, list)}</section>`;
  return layout(
    "Debates",
    "Browse public debates by status and search term.",
    `${origin}${listPath(base, list)}`,
    content,
  );
}

export function renderTopics(
  origin: string,
  list: PublicList<PublicTopic>,
  query: string,
) {
  const base = `/topics${query ? `?q=${encodeURIComponent(query)}` : ""}`;
  const content = `<section class="container page-intro"><span class="eyebrow accent">THE IDEA INDEX</span><h1>Find the question<br><em>worth asking.</em></h1><p>Each topic frames two sides of an ongoing conversation.</p></section><section class="container section compact"><form class="search-form" action="/topics" method="get" role="search"><label for="topic-search">Search topics</label><div><input id="topic-search" name="q" maxlength="80" value="${escape(query)}" placeholder="Search an idea"><button type="submit">Search ↗</button></div></form>${list.items.length ? `<div class="card-grid">${list.items.map(topicCard).join("")}</div>` : `<div class="empty-state"><h2>No topics found.</h2><p>Try another search. Published topics will appear here.</p></div>`}${pagination(base, list)}</section>`;
  return layout(
    "Topics",
    "Explore public topics on YAP Arena.",
    `${origin}${listPath(base, list)}`,
    content,
  );
}

export function renderTopic(
  origin: string,
  topic: PublicTopic,
  debates: PublicList<PublicDebate>,
) {
  const content = `<section class="container detail-intro"><a class="back-link" href="/topics">← All topics</a><span class="eyebrow accent">TOPIC ${topic.isDemo ? "· DEMO" : ""}</span><h1>${escape(topic.title)}</h1><p class="lead">${escape(topic.summary)}</p><div class="side-panel"><div><span class="eyebrow">SIDE A</span><strong>${escape(topic.sideALabel)}</strong></div><span class="versus">VS</span><div><span class="eyebrow">SIDE B</span><strong>${escape(topic.sideBLabel)}</strong></div></div></section><section class="container section"><div class="section-heading"><div><span class="eyebrow">ON THIS TOPIC</span><h2>Debates</h2></div></div>${debates.items.length ? `<div class="card-grid">${debates.items.map(debateCard).join("")}</div>` : `<div class="empty-state"><h3>No public debates on this topic yet.</h3></div>`}${pagination(`/topics/${path(topic.slug)}`, debates)}</section>`;
  const withFollow = content.replace(
    '<p class="lead">',
    `<button class="follow-button" type="button" data-follow-type="topics" data-follow-slug="${escape(topic.slug)}" aria-pressed="false">Follow topic</button><span class="follow-message" role="status" aria-live="polite"></span><p class="lead">`,
  );
  return layout(
    topic.title,
    topic.summary,
    `${origin}${listPath(`/topics/${path(topic.slug)}`, debates)}`,
    withFollow,
  );
}

function speaker(profile: PublicDebate["speakerA"], side: string) {
  return `<div class="speaker"><span class="eyebrow">${escape(side)}</span>${profile ? `<a href="/people/${path(profile.handle)}">${escape(profile.displayName)} <span aria-hidden="true">↗</span></a>` : "<strong>Speaker to be announced</strong>"}</div>`;
}

export function renderDebate(origin: string, debate: PublicDebate) {
  const content = `<section class="container detail-intro"><a class="back-link" href="/debates">← All debates</a><div class="detail-tags">${badge(debate)}<a href="/topics/${path(debate.topic.slug)}">${escape(debate.topic.title)} ↗</a></div><h1>${escape(debate.proposition)}</h1><p class="lead">A public debate on ${escape(debate.topic.title)}.</p><div class="speakers">${speaker(debate.speakerA, debate.topic.sideALabel)}<span class="versus">VS</span>${speaker(debate.speakerB, debate.topic.sideBLabel)}</div></section>
    <section class="container detail-grid"><div class="information-card"><span class="eyebrow">EVENT DETAILS</span><dl><div><dt>Status</dt><dd>${labels[debate.status]}</dd></div><div><dt>Scheduled</dt><dd>${date(debate.scheduledAt)}</dd></div><div><dt>Rules version</dt><dd>${escape(debate.rulesVersion)}</dd></div></dl></div>
    <div class="information-card media-card" data-media-event="${escape(debate.id)}"><span class="eyebrow">LIVE DEBATE & REPLAY</span><h2>Watch the debate</h2><div class="media-status-row"><p data-media-status role="status" aria-live="polite">Checking media availability…</p><p data-media-microphone role="status" aria-live="polite" hidden></p></div><strong data-media-clock aria-live="off"></strong><div class="media-videos" data-media-videos aria-label="Live debate video"></div><div class="media-actions"><button type="button" data-media-viewer hidden>Join as viewer</button><button type="button" data-media-speaker hidden>Check camera and join as speaker</button><button type="button" data-media-replay hidden>Play replay</button></div><video data-media-replay-video controls playsinline preload="none" hidden><track kind="captions" src="/api/media/events/${escape(debate.id)}/captions.vtt" srclang="en" label="English captions"></video>
    <section class="media-operator" data-media-operator hidden><h3>Operator controls</h3><label>Reason for action<input data-media-reason maxlength="500" minlength="5" placeholder="Describe the action or incident"></label><div class="media-actions"><button type="button" data-media-action="start">Start</button><button type="button" data-media-action="pause">Pause</button><button type="button" data-media-action="resume">Resume</button><button type="button" data-media-action="end">End</button><button type="button" data-media-action="replay">Publish replay</button></div><label>Reviewed WebVTT captions<textarea data-media-captions rows="5" maxlength="200000" placeholder="WEBVTT"></textarea></label><button type="button" data-media-captions-submit>Publish captions</button></section>
    <p class="media-note">Prototype timing. Extensions are disabled. Replay availability does not indicate a final result or financial participation.</p></div></section>
    <section class="container section community-section" data-community-event="${escape(debate.id)}"><div class="section-heading"><div><span class="eyebrow">COMMUNITY</span><h2>Join the conversation</h2></div></div><p>Likes and chat show interest only. They are not votes or official event support.</p><p role="status" aria-live="polite" data-community-status>Loading community activity…</p><div class="community-toolbar"><button type="button" data-community-like aria-pressed="false">Like this event</button><span data-community-likes aria-live="off">0 likes</span><button type="button" data-community-share>Copy event link</button><a href="/debates/${path(debate.slug)}/qr.svg" target="_blank" rel="noopener">Event QR code</a><a href="/overlay/${path(debate.slug)}" target="_blank" rel="noopener">Broadcast overlay</a><button type="button" data-community-refresh>Refresh</button></div><div class="community-grid"><section aria-labelledby="community-chat-title"><h3 id="community-chat-title">Event chat</h3><p data-community-chat-state role="status" aria-live="polite"></p><ol class="community-messages" data-community-messages aria-label="Event chat messages"></ol><button type="button" data-community-older hidden>Load earlier messages</button><form data-community-chat-form><label for="community-chat-body">Message</label><textarea id="community-chat-body" name="body" maxlength="500" rows="3" required></textarea><button type="submit">Post message</button><p class="form-help">Live events only. One message per 10 seconds, up to 30 per hour. A published profile is required.</p></form></section><section aria-labelledby="community-report-title"><h3 id="community-report-title">Report this event</h3><form data-community-report-form><label for="community-report-reason">Reason</label><select id="community-report-reason" name="reasonCode" required><option value="">Choose a reason</option><option value="harassment">Harassment</option><option value="hate">Hate</option><option value="threat">Threat</option><option value="spam">Spam</option><option value="privacy">Privacy</option><option value="other">Other</option></select><label for="community-report-detail">What happened?</label><textarea id="community-report-detail" name="detail" minlength="10" maxlength="500" rows="4" required></textarea><button type="submit">Submit private report</button></form><p><a href="/account/moderation">My reports and appeals</a></p></section></div></section><script defer src="${asset("media.bundle.js")}"></script><script defer src="${asset("community.js")}"></script>`;
  const canonical = `${origin}/debates/${path(debate.slug)}`;
  const metadata = `<meta property="og:type" content="article"><meta property="og:title" content="${escape(debate.proposition)} · YAP Arena"><meta property="og:description" content="${escape(`Debate on ${debate.topic.title}. Event information only.`)}"><meta property="og:url" content="${escape(canonical)}"><meta name="twitter:card" content="summary">`;
  return layout(
    debate.proposition,
    `Debate on ${debate.topic.title}.`,
    canonical,
    content,
    metadata,
  );
}

export function renderProfile(
  origin: string,
  profile: PublicProfile,
  debates: PublicList<PublicDebate>,
) {
  const content = `<section class="container detail-intro"><a class="back-link" href="/debates">← All debates</a><span class="eyebrow accent">PARTICIPANT ${profile.isDemo ? "· DEMO" : ""}</span><h1>${escape(profile.displayName)}</h1><p class="handle">@${escape(profile.handle)}</p><p class="lead">${profile.bio ? escape(profile.bio) : "No public bio yet."}</p></section><section class="container section"><div class="section-heading"><div><span class="eyebrow">PUBLIC APPEARANCES</span><h2>Debates</h2></div></div>${debates.items.length ? `<div class="card-grid">${debates.items.map(debateCard).join("")}</div>` : `<div class="empty-state"><h3>No public debates yet.</h3></div>`}${pagination(`/people/${path(profile.handle)}`, debates)}</section>`;
  const withFollow = content.replace(
    '<p class="lead">',
    `<button class="follow-button" type="button" data-follow-type="people" data-follow-slug="${escape(profile.handle)}" aria-pressed="false">Follow person</button><span class="follow-message" role="status" aria-live="polite"></span><p class="lead">`,
  );
  return layout(
    profile.displayName,
    profile.bio ?? `Public profile for ${profile.displayName}.`,
    `${origin}${listPath(`/people/${path(profile.handle)}`, debates)}`,
    withFollow,
  );
}

export function renderAbout(origin: string) {
  const content = `<section class="container page-intro"><span class="eyebrow accent">ABOUT YAP ARENA</span><h1>Make room for<br><em>the other side.</em></h1><p>YAP Arena is building a home for live debates and the ideas that connect them.</p></section><section class="container about-copy"><h2>What you can explore now</h2><p>This public preview shows published topics, debate listings, and participant profiles. You can sign in with an EVM wallet, create a profile, and follow people or topics. Listings marked Demo are fictional examples used to develop and test the product.</p><p>Live video and replay are available in a configured local prototype. A listing’s status does not prove that video is available or that a result has been determined. Financial participation remains unavailable.</p><a class="button" href="/debates">Explore debates ↗</a></section>`;
  return layout(
    "About",
    "About YAP Arena's public preview.",
    `${origin}/about`,
    content,
  );
}

export function renderAccount(origin: string) {
  const content = `<section class="container page-intro"><span class="eyebrow accent">YOUR CORNER OF THE ARENA</span><h1>Make it<br><em>your own.</em></h1><p>Sign in to manage your profile and follow ideas or people. Signing in never approves a financial transaction.</p></section><section class="container account-layout"><div id="account-notice" class="notice" role="status" aria-live="polite">Checking your account…</div><div id="signed-out" hidden><div class="information-card"><span class="eyebrow">WALLET SIGN-IN</span><h2>Connect and sign</h2><p>Review a one-time Sign-In with Ethereum message in your wallet. No transaction or gas fee is requested.</p><button class="button" id="wallet-login" type="button">Connect wallet ↗</button></div><details class="information-card account-details"><summary>Use an existing email account</summary><form id="email-login" class="stack-form"><label>Email<input name="email" type="email" autocomplete="email" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button class="button" type="submit">Sign in</button></form><h3>New to this preview?</h3><form id="email-register" class="stack-form"><label>Email<input name="email" type="email" autocomplete="email" required></label><label>Password<input name="password" type="password" autocomplete="new-password" minlength="12" required></label><button class="button-secondary" type="submit">Create email account →</button></form></details></div><div id="signed-in" hidden><div class="account-heading"><div><span class="eyebrow">SIGNED IN</span><h2 id="account-name">Your account</h2></div><button class="button-secondary" id="sign-out" type="button">Sign out →</button></div><div class="account-columns"><div class="information-card"><span class="eyebrow">YOUR PROFILE</span><p id="profile-state"></p><form id="profile-form" class="stack-form"><label>Handle<input name="handle" maxlength="40" minlength="3" pattern="[a-z0-9][a-z0-9-]{2,39}" required></label><label>Display name<input name="displayName" maxlength="80" required></label><label>Bio<textarea name="bio" maxlength="500" rows="4"></textarea></label><label>Visibility<select name="publicationState"><option value="draft">Private draft</option><option value="published">Public</option></select></label><button class="button" type="submit">Save profile ↗</button></form><p class="form-note">Your handle is permanent after creation so shared links remain stable.</p></div><div class="account-side"><div class="information-card"><span class="eyebrow">LINKED WALLETS</span><p>A linked wallet can sign you in. Linking does not authorize purchases.</p><ul id="wallet-list" class="account-list"></ul><button class="button-secondary" id="wallet-link" type="button">Link another wallet →</button></div><div class="information-card"><span class="eyebrow">FOLLOWING</span><ul id="follow-list" class="account-list"></ul><p class="form-note">Follow people and topics from their public pages.</p></div><div class="information-card"><span class="eyebrow">ACCOUNT ACTIVITY</span><p><a href="/account/moderation">My reports and appeals</a></p><ul id="activity-list" class="account-list"></ul></div></div></div></div></section><script defer src="/assets/account.js"></script>`;
  return layout(
    "Account",
    "Manage your YAP Arena profile and follows.",
    `${origin}/account`,
    content,
  );
}

export function renderMatchmaking(origin: string) {
  const content = `<section class="container page-intro"><span class="eyebrow accent">DEBATE MATCHING</span><h1>Find the<br><em>other side.</em></h1><p>Create a topic, challenge a person, or join an open match request. A request becomes an event when two speakers agree to its proposition, sides, and start time.</p></section><section class="container section compact match-page"><p id="match-notice" class="notice" role="status" aria-live="polite">Checking your account…</p><div id="match-signed-out" hidden class="information-card"><p>Sign in and publish a profile before opening or joining a debate.</p><a class="button" href="/account?next=%2Fmatch">Sign in ↗</a></div><div id="match-signed-in" hidden><div class="match-grid"><section class="information-card"><span class="eyebrow">01 / START A TOPIC</span><h2>Define both sides</h2><form id="topic-create" class="stack-form"><label>URL slug<input name="slug" pattern="[a-z0-9][a-z0-9-]{2,79}" maxlength="80" required></label><label>Title<input name="title" minlength="5" maxlength="140" required></label><label>Summary<textarea name="summary" minlength="10" maxlength="600" required></textarea></label><label>Side A label<input name="sideALabel" minlength="2" maxlength="80" required></label><label>Side B label<input name="sideBLabel" minlength="2" maxlength="80" required></label><button class="button" type="submit">Create private draft ↗</button></form><ul id="my-topics" class="account-list"></ul></section><section class="information-card"><span class="eyebrow">02 / OPEN A REQUEST</span><h2>Set the proposition</h2><form id="request-create" class="stack-form"><label>Type<select name="kind"><option value="queue">Open matchmaking</option><option value="direct">Direct challenge</option></select></label><label>Published topic slug<input name="topicSlug" pattern="[a-z0-9][a-z0-9-]{2,79}" required></label><label>Proposition<input name="proposition" minlength="10" maxlength="240" required></label><label>Your side<select name="requestedSide"><option value="A">Side A</option><option value="B">Side B</option></select></label><label>Opponent handle for direct challenges<input name="targetHandle" pattern="[a-z0-9][a-z0-9-]{2,39}"></label><label>Proposed start, your local time<input name="scheduledAt" type="datetime-local" required></label><button class="button" type="submit">Open request ↗</button></form><p class="form-note">The same platform rules apply to every event. Start times must be 1 hour to 90 days ahead.</p></section></div><div class="match-grid"><section class="information-card"><span class="eyebrow">OPEN QUEUE</span><h2>Join a debate</h2><ul id="open-queue" class="account-list"></ul></section><section class="information-card"><span class="eyebrow">YOUR REQUESTS</span><h2>Challenges and queue</h2><ul id="my-requests" class="account-list"></ul></section><section class="information-card"><span class="eyebrow">YOUR EVENTS</span><h2>Debate lifecycle</h2><ul id="my-events" class="account-list"></ul></section><section class="information-card"><span class="eyebrow">NOTIFICATIONS</span><h2>Updates</h2><ul id="match-notifications" class="account-list"></ul></section></div></div></section><script defer src="/assets/matching.js"></script>`;
  return layout(
    "Match",
    "Create topics and arrange debates on YAP Arena.",
    `${origin}/match`,
    content,
  );
}

export function renderNotFound(origin: string) {
  return layout(
    "Page not found",
    "This page could not be found.",
    `${origin}/`,
    `<section class="container page-intro"><span class="eyebrow accent">404 / NO SUCH PAGE</span><h1>Nothing here<br><em>yet.</em></h1><p>The page may have moved or is not public.</p><a class="button" href="/debates">Browse debates ↗</a></section>`,
  );
}

export function renderUnavailable() {
  return layout(
    "Temporarily unavailable",
    "YAP Arena is temporarily unavailable.",
    "/",
    `<section class="container page-intro"><span class="eyebrow accent">TEMPORARILY UNAVAILABLE</span><h1>We lost the thread<br><em>for a moment.</em></h1><p>Please try again shortly.</p><a class="button" href="/">Try again ↗</a></section>`,
  );
}
