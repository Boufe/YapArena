import type { PublicDebate } from "./repository.ts";

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );

export function renderVideoDebateCard(debate: PublicDebate, revision: string) {
  const live = debate.status === "live";
  const speakers = [debate.speakerA?.displayName, debate.speakerB?.displayName]
    .filter(Boolean)
    .join(" · ");
  return `<article class="debate-card arena-video-card" data-card-preview data-debate-preview data-event="${escape(debate.id)}" data-mode="${live ? "live" : "replay"}" data-live-source="/assets/hero-live.bundle.js?v=${revision}" data-hls-source="/assets/replay.bundle.js?v=${revision}">
    <img class="arena-featured-thumbnail" data-preview-thumbnail src="/api/media/events/${escape(debate.id)}/thumbnail" alt="" aria-hidden="true" loading="lazy" decoding="async">
    <div class="arena-featured-media" data-preview-media aria-hidden="true"><video data-preview-video muted autoplay playsinline loop preload="none" tabindex="-1" disablepictureinpicture></video><div class="arena-featured-live" data-preview-live></div></div>
    <a class="arena-featured-open" data-preview-open href="/debates/${encodeURIComponent(debate.slug)}" aria-label="Watch debate: ${escape(debate.proposition)}"></a>
    <div class="arena-video-card-top"><span class="status status-${live ? "live" : "replay"}">${live ? "● LIVE" : "REPLAY"}</span><span class="arena-video-card-topic">${escape(debate.topic.title)}</span></div>
    <div class="arena-video-card-copy"><h3>${escape(debate.proposition)}</h3>${speakers ? `<p>${escape(speakers)}</p>` : ""}<span class="arena-video-card-entry" aria-hidden="true">Step into the debate ↗</span></div>
    <div class="arena-video-card-controls"><span class="sr-only" data-preview-status>Preview paused</span><button type="button" class="arena-featured-toggle" data-preview-toggle aria-label="Play video preview" aria-pressed="true"><svg viewBox="0 0 24 24" aria-hidden="true"><path data-preview-toggle-icon d="m8 5 11 7-11 7Z"/></svg></button></div>
  </article>`;
}
