import assert from "node:assert/strict";
import { it } from "node:test";
import {
  renderHome,
  renderLive,
  renderAbout,
  renderAccount,
  renderCoins,
  renderMatchmaking,
} from "../dist/features/discovery/web.js";
import {
  renderMyModeration,
  renderModeration,
  renderOverlay,
} from "../dist/features/community/web.js";
import { renderMeasurementDashboard } from "../dist/features/measurement/web.js";

it("uses one navigation and session-aware account header across normal pages", () => {
  const origin = "https://arena.example";
  const pages = [
    renderHome(origin),
    renderLive(origin, [], { items: [] }),
    renderAbout(origin),
    renderAccount(origin, true),
    renderCoins(origin),
    renderMatchmaking(origin),
    renderMyModeration(true),
    renderModeration(true),
    renderMeasurementDashboard(
      { windowDays: 28, events: [], watch: [] },
      [],
      true,
    ),
  ];
  for (const html of pages) {
    assert.equal((html.match(/data-site-header/g) ?? []).length, 1);
    assert.match(
      html,
      /href="\/live">Live<\/a><a href="\/debates">Explore<\/a><a href="\/match">Create<\/a>/,
    );
    assert.match(html, /data-header-member hidden/);
    assert.match(html, /data-auth-open="login">Log in/);
    assert.match(html, /data-auth-open="signup">Sign up/);
    assert.match(html, /data-deposit-open/);
    assert.match(html, /site-header\.js/);
    assert.doesNotMatch(html, /class="ya-top"/);
  }
  const home = pages[0];
  assert.match(home, /data-nav="following"/);
  assert.match(home, /id="ya-search"/);
  assert.doesNotMatch(home, /<script[^>]+account-auth[.]bundle/);
});

it("keeps the broadcast overlay free of navigation and account controls", () => {
  const html = renderOverlay({
    proposition: "A public fixture",
    status: "live",
    topicTitle: "Topic",
    sideALabel: "For",
    sideBLabel: "Against",
  });
  assert.match(html, /broadcast-overlay/);
  assert.doesNotMatch(html, /data-site-header|data-auth-open/);
});

it("versions every server-rendered asset reference with the process revision", () => {
  const origin = "https://arena.example";
  const pages = [
    renderHome(origin),
    renderAccount(origin, true),
    renderAccount(origin, false),
    renderCoins(origin),
    renderMatchmaking(origin),
    renderMyModeration(false),
    renderModeration(true),
    renderMeasurementDashboard(
      { windowDays: 28, events: [], watch: [] },
      [],
      false,
    ),
    renderOverlay({
      proposition: "A public fixture",
      status: "live",
      topicTitle: "Topic",
      sideALabel: "For",
      sideBLabel: "Against",
    }),
  ];
  const revisions = new Set();
  for (const html of pages) {
    const references = [...html.matchAll(/="(\/assets\/[^"]*)"/g)].map(
      ([, url]) => url,
    );
    assert.ok(references.length > 0);
    for (const url of references) {
      const match = /^\/assets\/[^?"]+\?v=([0-9a-f]{12})$/.exec(url);
      assert.ok(match, `unversioned asset reference ${url}`);
      revisions.add(match[1]);
    }
  }
  assert.equal(revisions.size, 1);
});
