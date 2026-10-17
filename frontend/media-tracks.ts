import type { Track } from "livekit-client";

type AttachedTrack = Track;
type Observer = (
  node: HTMLMediaElement,
  track: AttachedTrack,
  identity: string,
) => void | (() => void);

export function createMediaTracks(
  container: HTMLElement,
  observe: Observer = () => {},
) {
  const attached = new Map<
    AttachedTrack,
    { node: HTMLMediaElement; identity: string; cleanup: void | (() => void) }
  >();

  function detach(track: AttachedTrack) {
    const entry = attached.get(track);
    if (!entry) return;
    entry.cleanup?.();
    track.detach(entry.node);
    entry.node.remove();
    attached.delete(track);
  }

  return {
    attach(track: AttachedTrack, identity: string) {
      if (
        (track.kind !== "video" && track.kind !== "audio") ||
        attached.has(track)
      )
        return;
      for (const [previous, entry] of attached)
        if (entry.identity === identity && previous.kind === track.kind)
          detach(previous);
      const node = track.attach();
      node.dataset.participant = identity;
      node.autoplay = true;
      if (track.kind === "video") node.setAttribute("playsinline", "");
      attached.set(track, {
        node,
        identity,
        cleanup: observe(node, track, identity),
      });
      container.append(node);
    },
    detach,
    removeParticipant(identity: string) {
      for (const [track, entry] of attached)
        if (entry.identity === identity) detach(track);
    },
    clear() {
      for (const track of attached.keys()) detach(track);
      container.replaceChildren();
    },
  };
}
