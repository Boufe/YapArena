import type { RemoteTrack, RemoteTrackPublication } from "livekit-client";
import type { MediaRequest } from "./media-types.js";

/* global document */
import { Room, RoomEvent, Track, VideoQuality } from "livekit-client";

export function createHeroLive({
  container,
  request,
  playing,
  unavailable,
  RoomClass = Room,
}: {
  container: HTMLElement;
  request: MediaRequest;
  playing: () => void;
  unavailable: () => void;
  RoomClass?: typeof Room;
}) {
  // Subscribe only to small camera video layers. No audio subscription or capture.
  const room = new RoomClass({ adaptiveStream: false });
  const attached = new Map<RemoteTrack, HTMLVideoElement>();
  let stopped = false;
  function detach(track: RemoteTrack) {
    const node = attached.get(track);
    if (!node) return;
    track.detach(node);
    node.remove();
    attached.delete(track);
  }
  function subscribe(publication: RemoteTrackPublication) {
    if (stopped) return;
    const camera =
      publication.kind === Track.Kind.Video &&
      publication.source === Track.Source.Camera;
    publication.setSubscribed(camera);
    if (camera) publication.setVideoQuality(VideoQuality.LOW);
  }
  room.on(RoomEvent.TrackPublished, subscribe);
  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (stopped || track.kind !== Track.Kind.Video || attached.size >= 2)
      return;
    const node = document.createElement("video");
    node.muted = true;
    node.autoplay = true;
    node.playsInline = true;
    node.setAttribute("aria-hidden", "true");
    node.addEventListener("playing", playing);
    track.attach(node);
    attached.set(track, node);
    container.append(node);
    void node.play().catch(unavailable);
  });
  room.on(RoomEvent.TrackUnsubscribed, detach);
  room.on(RoomEvent.Disconnected, () => {
    if (!stopped) unavailable();
  });
  return {
    async start() {
      const grant = await request("/viewer-token", { method: "POST" });
      if (stopped) return;
      await room.connect(grant.url, grant.token, { autoSubscribe: false });
      if (stopped) {
        await room.disconnect(true);
        return;
      }
      for (const participant of room.remoteParticipants.values())
        for (const publication of participant.trackPublications.values())
          subscribe(publication);
    },
    stop() {
      stopped = true;
      for (const track of attached.keys()) detach(track);
      void room.disconnect(true);
    },
  };
}
