/* global document, window */
import { Room, RoomEvent } from "livekit-client";
import { mediaPresentation } from "./media-presentation.js";
import { createMediaTracks } from "./media-tracks.js";

const root = document.querySelector("[data-media-event]");
if (root) {
  const id = root.dataset.mediaEvent;
  const status = root.querySelector("[data-media-status]");
  const clock = root.querySelector("[data-media-clock]");
  const videos = root.querySelector("[data-media-videos]");
  const mediaTracks = createMediaTracks(videos);
  const viewerButton = root.querySelector("[data-media-viewer]");
  const speakerButton = root.querySelector("[data-media-speaker]");
  const replay = root.querySelector("[data-media-replay]");
  const video = root.querySelector("[data-media-replay-video]");
  const operator = root.querySelector("[data-media-operator]");
  let room;
  let side;
  let serverOffset = 0;
  let currentState;
  const say = (message) => {
    status.textContent = message;
  };
  const request = async (path, options = {}) => {
    const response = await fetch(`/api/media/events/${id}${path}`, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Media request failed");
    return result;
  };
  async function connect(token, url) {
    const previousRoom = room;
    room = undefined;
    mediaTracks.clear();
    if (previousRoom) await previousRoom.disconnect();
    const nextRoom = new Room({ adaptiveStream: true, dynacast: true });
    room = nextRoom;
    nextRoom.on(
      RoomEvent.TrackSubscribed,
      (track, _publication, participant) =>
        room === nextRoom && mediaTracks.attach(track, participant.identity),
    );
    nextRoom.on(
      RoomEvent.TrackUnsubscribed,
      (track) => room === nextRoom && mediaTracks.detach(track),
    );
    nextRoom.on(
      RoomEvent.ParticipantDisconnected,
      (participant) =>
        room === nextRoom &&
        mediaTracks.removeParticipant(participant.identity),
    );
    nextRoom.on(
      RoomEvent.Reconnecting,
      () => room === nextRoom && say("Connection interrupted. Reconnecting…"),
    );
    nextRoom.on(
      RoomEvent.Reconnected,
      () => room === nextRoom && say("Connection restored."),
    );
    nextRoom.on(RoomEvent.Disconnected, () => {
      if (room !== nextRoom) return;
      mediaTracks.clear();
      say("Disconnected. Use Join to reconnect.");
    });
    await nextRoom.connect(url, token);
    for (const participant of nextRoom.remoteParticipants.values())
      for (const publication of participant.trackPublications.values())
        if (publication.track)
          mediaTracks.attach(publication.track, participant.identity);
  }
  viewerButton.addEventListener("click", async () => {
    viewerButton.disabled = true;
    try {
      const grant = await request("/viewer-token", { method: "POST" });
      await connect(grant.token, grant.url);
      say("Watching live debate.");
    } catch (error) {
      say(error.message);
      viewerButton.disabled = false;
    }
  });
  speakerButton.addEventListener("click", async () => {
    speakerButton.disabled = true;
    let preview;
    try {
      preview = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true,
      });
      await request("/device-check", {
        method: "POST",
        body: JSON.stringify({
          cameraOk: preview.getVideoTracks().length > 0,
          microphoneOk: preview.getAudioTracks().length > 0,
        }),
      });
      const grant = await request("/speaker-token", { method: "POST" });
      side = grant.side;
      await connect(grant.token, grant.url);
      await room.localParticipant.setCameraEnabled(true);
      await room.localParticipant.setMicrophoneEnabled(false);
      const joined = await request("");
      if (["scheduled", "ready"].includes(joined.eventStatus)) {
        const ready = await fetch(`/api/matching/events/${id}/ready`, {
          method: "POST",
          credentials: "same-origin",
        });
        if (!ready.ok) {
          const data = await ready.json().catch(() => ({}));
          throw new Error(data.error || "Could not record speaker readiness");
        }
      }
      await refresh();
      say(
        joined.state?.state === "paused"
          ? `Reconnected as speaker ${side}. The operator can resume once both speakers are connected.`
          : `Connected as speaker ${side}. Your microphone opens on your turn.`,
      );
    } catch (error) {
      say(error.message);
      speakerButton.disabled = false;
    } finally {
      preview?.getTracks().forEach((track) => track.stop());
    }
  });
  replay.addEventListener("click", async () => {
    try {
      const result = await request("/replay");
      video.src = result.url;
      video.hidden = false;
      replay.hidden = true;
      await video.play();
    } catch (error) {
      say(error.message);
    }
  });
  for (const button of operator.querySelectorAll("[data-media-action]")) {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const action = button.dataset.mediaAction;
        if (
          action === "end" &&
          !window.confirm("End this debate now? This cannot be undone.")
        )
          return;
        const reason = operator
          .querySelector("[data-media-reason]")
          .value.trim();
        const body =
          action === "resume"
            ? { revision: currentState?.revision }
            : { reason };
        await request(`/${action}`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        say(`Operator action ${action} recorded.`);
        await refresh();
      } catch (error) {
        say(error.message);
      } finally {
        button.disabled = false;
      }
    });
  }
  operator
    .querySelector("[data-media-captions-submit]")
    .addEventListener("click", async (event) => {
      event.currentTarget.disabled = true;
      try {
        await request("/captions", {
          method: "PUT",
          body: JSON.stringify({
            vtt: operator.querySelector("[data-media-captions]").value,
          }),
        });
        say("Captions published for replay.");
      } catch (error) {
        say(error.message);
      } finally {
        event.currentTarget.disabled = false;
      }
    });
  async function refresh() {
    try {
      const result = await request("");
      currentState = result.state;
      serverOffset = new Date(result.serverNow).getTime() - Date.now();
      const live = result.eventStatus === "live";
      const presentation = mediaPresentation(result.eventStatus, result.state);
      viewerButton.hidden = !live;
      speakerButton.hidden = !["scheduled", "ready", "live"].includes(
        result.eventStatus,
      );
      speakerButton.textContent = live
        ? "Connect or reconnect as speaker"
        : "Check camera and join as speaker";
      replay.hidden = !presentation.replayVisible;
      say(presentation.message);
      for (const button of operator.querySelectorAll("[data-media-action]"))
        button.hidden = !presentation.actions[button.dataset.mediaAction];
      if (room && side) {
        const shouldSpeak =
          live &&
          result.state?.state === "running" &&
          result.state.activeSide === side;
        if (room.localParticipant.isMicrophoneEnabled !== shouldSpeak)
          await room.localParticipant.setMicrophoneEnabled(shouldSpeak);
      }
    } catch (error) {
      say(
        error.message === "resource not found"
          ? "Live media is not configured for this deployment."
          : error.message,
      );
    }
  }
  function paintClock() {
    if (
      !currentState ||
      currentState.state !== "running" ||
      !currentState.turnDeadlineAt
    ) {
      clock.textContent = "";
      return;
    }
    const remaining = Math.max(
      0,
      new Date(currentState.turnDeadlineAt).getTime() -
        Date.now() -
        serverOffset,
    );
    clock.textContent = `${currentState.activeSide} · ${Math.ceil(remaining / 1000)}s`;
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refresh();
  });
  fetch("/api/me/roles", { credentials: "same-origin" })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      if (data?.roles?.includes("operator")) operator.hidden = false;
    })
    .catch(() => {});
  void refresh();
  setInterval(() => {
    if (!document.hidden) void refresh();
  }, 3000);
  setInterval(paintClock, 250);
}
