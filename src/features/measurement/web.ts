import type { createMeasurementRepository } from "./repository.ts";

type Summary = Awaited<
  ReturnType<ReturnType<typeof createMeasurementRepository>["summary"]>
>;
type Affiliations = Awaited<
  ReturnType<ReturnType<typeof createMeasurementRepository>["listAffiliations"]>
>;

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] ?? character,
  );

const labels: Record<string, string> = {
  discovery_view: "Discovery views",
  match_requested: "Match requests opened",
  match_accepted: "Matches accepted",
  debate_completed: "Debates completed",
  replay_started: "Replay starts",
  follow_created: "Follows created",
  report_submitted: "Reports submitted",
  return_visit: "Different debate or topic returns",
};
const affiliations = ["independent", "founder", "unclassified"] as const;
const eventTypes = Object.keys(labels);

export function renderMeasurementDashboard(
  summary: Summary,
  assignments: Affiliations,
) {
  const count = (eventType: string, affiliation: string) =>
    summary.events.find(
      (row) => row.eventType === eventType && row.affiliation === affiliation,
    )?.count ?? 0;
  const watch = (mode: string, affiliation: string) =>
    summary.watch.find(
      (row) => row.mode === mode && row.affiliation === affiliation,
    )?.watchedSeconds ?? 0;
  const rows = eventTypes
    .map(
      (type) =>
        `<tr><th scope="row">${labels[type]}</th>${affiliations
          .map((affiliation) => `<td>${count(type, affiliation)}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  const watchRows = ["live", "replay"]
    .map(
      (mode) =>
        `<tr><th scope="row">${mode === "live" ? "Live" : "Replay"} watch minutes</th>${affiliations
          .map(
            (affiliation) =>
              `<td>${Math.floor(watch(mode, affiliation) / 60)}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("");
  const assignmentRows = assignments
    .map(
      (item) =>
        `<tr><th scope="row">@${escape(item.handle)}</th><td>${escape(item.affiliation)}</td><td>${escape(item.reason)}</td><td>${escape(new Date(item.updatedAt).toISOString())}</td></tr>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Product measurement · YAP Arena</title><link rel="stylesheet" href="/assets/site.css"><script defer src="/assets/measurement-dashboard.js"></script></head><body><a class="skip-link" href="#main">Skip to content</a><header class="site-header"><div class="container nav"><a class="brand" href="/">YAP ARENA</a><nav aria-label="Main navigation"><a href="/debates">Debates</a><a href="/account">Account</a></nav></div></header><main id="main" class="container section"><div class="section-heading"><div><span class="eyebrow">OPERATIONS</span><h1>Product measurement</h1></div></div><p>Last ${summary.windowDays} days, UTC. These are consented browser or account events except debate completion, which comes from the authoritative event transition. Unclassified activity is never treated as independent. Demo events are excluded.</p><p>Counts are actions or browser sessions, not unique people. A wallet is not a person. The proposed 28-day returning participant rate and 30% hypothesis are not approved success or launch gates.</p><div class="information-card"><h2>Discover, match, finish, return</h2><div class="table-scroll"><table><caption>Product events by reviewed affiliation</caption><thead><tr><th scope="col">Measure</th><th scope="col">Independent</th><th scope="col">Founder-affiliated</th><th scope="col">Unclassified</th></tr></thead><tbody>${rows}${watchRows}</tbody></table></div></div><div class="information-card"><h2>Review account affiliation</h2><p>Classify only accounts whose relationship to the founder has been checked. Unknown accounts stay unclassified. Every change keeps an internal audit entry.</p><form id="affiliation-form" class="stack-form"><label>Published profile handle<input name="handle" minlength="3" maxlength="40" required></label><label>Classification<select name="affiliation" required><option value="">Select classification</option><option value="founder">Founder-affiliated</option><option value="independent">Independent</option><option value="unclassified">Remove classification</option></select></label><label>Review reason<textarea name="reason" minlength="10" maxlength="500" rows="3" required></textarea></label><button type="submit">Save review</button><p id="affiliation-status" role="status" aria-live="polite"></p></form><div class="table-scroll"><table><caption>Recent reviewed classifications</caption><thead><tr><th scope="col">Profile</th><th scope="col">Classification</th><th scope="col">Reason</th><th scope="col">Updated UTC</th></tr></thead><tbody>${assignmentRows || '<tr><td colspan="4">No accounts classified yet.</td></tr>'}</tbody></table></div></div><p><a href="/api/measurement/dashboard">Download dashboard data as JSON</a> · <a href="/">Back to home</a></p></main><footer class="site-footer"><div class="container footer-inner">Measurement preview · No financial activity</div></footer></body></html>`;
}
