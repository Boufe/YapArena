export function createMediaTracks(container) {
  const attached = new Map();

  function detach(track) {
    const entry = attached.get(track);
    if (!entry) return;
    track.detach(entry.node);
    entry.node.remove();
    attached.delete(track);
  }

  return {
    attach(track, identity) {
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
      attached.set(track, { node, identity });
      container.append(node);
    },
    detach,
    removeParticipant(identity) {
      for (const [track, entry] of attached)
        if (entry.identity === identity) detach(track);
    },
    clear() {
      for (const track of attached.keys()) detach(track);
      container.replaceChildren();
    },
  };
}
