import type { PublicDebate } from "./repository.ts";

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );

export function renderFeaturedDebate(
  debate: PublicDebate | null,
  revision: string,
) {
  if (!debate)
    return `<section class="arena-featured arena-featured-empty" aria-labelledby="featured-title"><div class="arena-featured-backdrop" aria-hidden="true"><span>YAP</span><span>ARENA</span></div><div class="container arena-featured-copy"><span class="eyebrow accent">IDEAS UNDER PRESSURE</span><h1 id="featured-title">Every idea has<br>another side.</h1><p>The next conversation is taking shape. Discover the debates and the people behind them.</p><a class="text-link" href="/debates">Explore the arena <span aria-hidden="true">↗</span></a></div></section>`;
  const live = debate.status === "live";
  const speakers = [debate.speakerA?.displayName, debate.speakerB?.displayName]
    .filter(Boolean)
    .join(" · ");
  return `<section class="arena-featured" data-featured-preview data-event="${escape(debate.id)}" data-mode="${live ? "live" : "replay"}" data-live-source="/assets/hero-live.bundle.js?v=${revision}" data-hls-source="/assets/replay.bundle.js?v=${revision}" aria-labelledby="featured-title">
    <img class="arena-featured-thumbnail" data-featured-thumbnail src="/api/media/events/${escape(debate.id)}/thumbnail" alt="" aria-hidden="true" decoding="async">
    <div class="arena-featured-media" data-featured-media aria-hidden="true"><video data-featured-video muted autoplay playsinline loop preload="none" tabindex="-1" disablepictureinpicture></video><div class="arena-featured-live" data-featured-live></div></div>
    <a class="arena-featured-open" data-featured-open href="/debates/${encodeURIComponent(debate.slug)}" aria-label="Open debate: ${escape(debate.proposition)}" aria-describedby="featured-instruction"></a>
    <div class="container arena-featured-copy"><div class="arena-featured-eyebrow"><span class="status status-${live ? "live" : "replay"}">${live ? "● LIVE NOW" : "FEATURED REPLAY"}</span><span>${escape(debate.topic.title)}</span></div><h1 id="featured-title">${escape(debate.proposition)}</h1>${speakers ? `<p class="arena-featured-speakers">${escape(speakers)}</p>` : ""}<p class="arena-featured-sides"><span>${escape(debate.topic.sideALabel)}</span><span>vs.</span><span>${escape(debate.topic.sideBLabel)}</span></p><p id="featured-instruction" class="arena-featured-instruction"><span class="arena-featured-desktop-hint">Stay here to step into the debate, or click to enter.</span><span class="arena-featured-touch-hint">Tap to step into the debate.</span></p></div>
    <div class="arena-featured-controls"><span class="arena-featured-state" data-featured-status>Muted preview</span><button type="button" class="arena-featured-toggle" data-featured-toggle aria-label="Pause video preview" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path data-featured-toggle-icon d="M8 5v14M16 5v14"/></svg></button></div>
    <div class="arena-featured-intent" data-featured-intent aria-hidden="true"><span>Entering the arena</span><span class="arena-featured-intent-track"><span></span></span><small>Move away or press Esc to stay here</small></div>
  </section><script type="module" src="/assets/hero-preview.js?v=${revision}"></script>`;
}
