/* global document, window */
import { Room, RoomEvent } from "livekit-client";
import { mediaPresentation } from "./media-presentation.js";
import { speakerButtonState, stopMediaSession } from "./media-session.js";
import { joinSpeaker } from "./media-speaker.js";
import { createMediaTracks } from "./media-tracks.js";

const root = document.querySelector("[data-media-event]");
if (root) {
  const id = root.dataset.mediaEvent;
  const status = root.querySelector("[data-media-status]");
  const clock = root.querySelector("[data-media-clock]");
  const microphoneStatus = root.querySelector("[data-media-microphone]");
  const videos = root.querySelector("[data-media-videos]");
  const mediaTracks = createMediaTracks(videos);
  const viewerButton = root.querySelector("[data-media-viewer]");
  const speakerButton = root.querySelector("[data-media-speaker]");
  const replay = root.querySelector("[data-media-replay]");
  const video = root.querySelector("[data-media-replay-video]");
  const operator = root.querySelector("[data-media-operator]");
  let speakerMemoryKey;
  let room;
  let side;
  let seatSide;
  let eventStatus;
  let speakerConnected = false;
  let joiningSpeaker = false;
  let reconnectAttempts = 0;
  let reconnectTimer;
  let microphoneChange;
  let serverOffset = 0;
  let currentState;
  const say = (message) => {
    status.textContent = message;
  };
  const showMicrophoneStatus = (message) => {
    microphoneStatus.textContent = message;
    microphoneStatus.hidden = !message;
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
  const remembersSpeaker = () => {
    if (!speakerMemoryKey) return false;
    try {
      return window.sessionStorage.getItem(speakerMemoryKey) === "1";
    } catch {
      return false;
    }
  };
  const rememberSpeaker = (remember) => {
    if (!speakerMemoryKey) return;
    try {
      if (remember) window.sessionStorage.setItem(speakerMemoryKey, "1");
      else window.sessionStorage.removeItem(speakerMemoryKey);
    } catch {
      /* storage may be disabled in a private browsing context */
    }
  };
  const canJoinAsSpeaker = () =>
    seatSide && ["scheduled", "ready", "live"].includes(eventStatus);
  function updateSpeakerButton() {
    const state = speakerButtonState({
      side: seatSide,
      status: eventStatus,
      connected: speakerConnected,
      joining: joiningSpeaker,
    });
    speakerButton.hidden = state.hidden;
    speakerButton.disabled = state.disabled;
    speakerButton.textContent = state.text;
  }
  function cancelReconnect() {
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  async function disconnectRoom() {
    const previousRoom = room;
    room = undefined;
    side = undefined;
    speakerConnected = false;
    updateSpeakerButton();
    showMicrophoneStatus("");
    await stopMediaSession(previousRoom, mediaTracks);
  }
  function scheduleReconnect() {
    if (
      reconnectTimer ||
      joiningSpeaker ||
      speakerConnected ||
      !remembersSpeaker() ||
      !canJoinAsSpeaker()
    )
      return;
    const delays = [500, 1500, 3000, 5000];
    if (reconnectAttempts >= delays.length) {
      say("Automatic reconnect failed. Use Connect or reconnect as speaker.");
      return;
    }
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      void connectAsSpeaker(true);
    }, delays[reconnectAttempts++]);
  }
  async function connect(token, url) {
    const previousRoom = room;
    room = undefined;
    await stopMediaSession(previousRoom, mediaTracks);
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
    nextRoom.on(RoomEvent.Reconnected, () => {
      if (room !== nextRoom) return;
      say("Connection restored.");
      void refresh();
    });
    nextRoom.on(
      RoomEvent.ParticipantPermissionsChanged,
      (_prior, participant) => {
        if (room === nextRoom && participant === nextRoom.localParticipant)
          void refresh();
      },
    );
    nextRoom.on(RoomEvent.Disconnected, () => {
      if (room !== nextRoom) return;
      mediaTracks.clear();
      side = undefined;
      speakerConnected = false;
      updateSpeakerButton();
      say(
        remembersSpeaker() && canJoinAsSpeaker()
          ? "Disconnected. Reconnecting…"
          : "Disconnected. Use Join to reconnect.",
      );
      scheduleReconnect();
    });
    await nextRoom.connect(url, token);
    for (const participant of nextRoom.remoteParticipants.values())
      for (const publication of participant.trackPublications.values())
        if (publication.track)
          mediaTracks.attach(publication.track, participant.identity);
    return nextRoom;
  }
  viewerButton.addEventListener("click", async () => {
    viewerButton.disabled = true;
    try {
      const grant = await request("/viewer-token", { method: "POST" });
      await connect(grant.token, grant.url);
      say("Watching live debate.");
    } catch (error) {
      say(error.message);
    } finally {
      viewerButton.disabled = false;
    }
  });
  async function connectAsSpeaker(automatic = false) {
    if (joiningSpeaker || !canJoinAsSpeaker() || speakerConnected) return;
    joiningSpeaker = true;
    updateSpeakerButton();
    try {
      const message = await joinSpeaker({
        button: speakerButton,
        mediaDevices: navigator.mediaDevices,
        request,
        connect,
        tracks: mediaTracks,
        setSide(value) {
          side = value;
        },
        async markReady() {
          const ready = await fetch(`/api/matching/events/${id}/ready`, {
            method: "POST",
            credentials: "same-origin",
          });
          if (!ready.ok) {
            const data = await ready.json().catch(() => ({}));
            throw new Error(data.error || "Could not record speaker readiness");
          }
        },
        refresh,
      });
      if (!canJoinAsSpeaker() || !room)
        throw new Error("Debate is no longer available for speakers");
      speakerConnected = true;
      viewerButton.hidden = true;
      reconnectAttempts = 0;
      rememberSpeaker(true);
      cancelReconnect();
      say(message);
    } catch (error) {
      await disconnectRoom();
      say(error.message);
      if (
        automatic &&
        ["NotAllowedError", "SecurityError"].includes(error.name)
      )
        rememberSpeaker(false);
    } finally {
      joiningSpeaker = false;
      updateSpeakerButton();
      if (automatic && !speakerConnected) scheduleReconnect();
    }
  }
  speakerButton.addEventListener("click", () => {
    cancelReconnect();
    reconnectAttempts = 0;
    void connectAsSpeaker();
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
      eventStatus = result.eventStatus;
      serverOffset = new Date(result.serverNow).getTime() - Date.now();
      const live = result.eventStatus === "live";
      const presentation = mediaPresentation(result.eventStatus, result.state);
      viewerButton.hidden = !live || speakerConnected;
      updateSpeakerButton();
      replay.hidden = !presentation.replayVisible;
      say(presentation.message);
      for (const button of operator.querySelectorAll("[data-media-action]"))
        button.hidden = !presentation.actions[button.dataset.mediaAction];
      if (["ended", "replay", "finalized", "cancelled"].includes(eventStatus)) {
        cancelReconnect();
        rememberSpeaker(false);
        if (room) await disconnectRoom();
        return;
      }
      if (room && side) {
        const shouldSpeak =
          live &&
          result.state?.state === "running" &&
          result.state.activeSide === side;
        if (microphoneChange) await microphoneChange.catch(() => {});
        if (room && room.localParticipant.isMicrophoneEnabled !== shouldSpeak) {
          showMicrophoneStatus(
            shouldSpeak ? "Opening microphone…" : "Microphone off",
          );
          microphoneChange =
            room.localParticipant.setMicrophoneEnabled(shouldSpeak);
          try {
            await microphoneChange;
          } catch (error) {
            showMicrophoneStatus(
              "Microphone could not start. Check permission and reconnect.",
            );
            throw error;
          } finally {
            microphoneChange = undefined;
          }
        }
        if (room)
          showMicrophoneStatus(
            room.localParticipant.isMicrophoneEnabled
              ? "Microphone enabled"
              : shouldSpeak
                ? "Microphone still unavailable. Refresh to retry."
                : "Microphone off",
          );
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
    if (!document.hidden) {
      void refresh();
      if (!speakerConnected) scheduleReconnect();
    }
  });
  window.addEventListener("online", () => {
    if (!speakerConnected) scheduleReconnect();
  });
  fetch("/api/me/roles", { credentials: "same-origin" })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      if (data?.roles?.includes("operator")) operator.hidden = false;
    })
    .catch(() => {});
  void (async () => {
    try {
      const seat = await request("/speaker-seat");
      seatSide = seat.side;
      speakerMemoryKey = `media-speaker:${id}:${seat.userId}`;
    } catch {
      seatSide = undefined;
    }
    await refresh();
    if (remembersSpeaker() && canJoinAsSpeaker()) void connectAsSpeaker(true);
  })();
  setInterval(() => {
    void refresh();
  }, 3000);
  setInterval(paintClock, 250);
}
