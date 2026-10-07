/* global document, window */
import { createReplayLibraryLoader } from "./media-replay-library.js";
import {
  createPlaybackReporter,
  playbackDimensions,
} from "./media-telemetry.js";
import { createMediaRecovery, mayRecoverDisconnect } from "./media-recovery.js";
import {
  createMediaDiagnostics,
  observePlayback,
} from "./media-diagnostics.js";
import { createReplayPlayer } from "./media-replay.js";
import { Room, RoomEvent, Track } from "livekit-client";
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
  const diagnostics = createMediaDiagnostics();
  window.yapMediaDiagnostics = diagnostics;
  const mediaTracks = createMediaTracks(videos, (node, track, identity) => {
    if (identity === room?.localParticipant.identity) return;
    return observePlayback(node, {
      kind: track.kind,
      diagnostics,
      expected: () =>
        !document.hidden && !track.isMuted && eventStatus === "live",
    });
  });
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
  let preparedRoom;
  let preparationComplete = false;
  let preparationStarted = false;
  let viewerJoining = false;
  let microphoneWanted = true;
  let deviceChoices = {};
  let disposed = false;
  const sound = root.querySelector("[data-media-sound]");
  const leave = root.querySelector("[data-media-leave]");
  const mute = root.querySelector("[data-media-mute]");
  let microphoneChange;
  let preparedMicrophone;
  let serverOffset = 0;
  let currentState;
  let watchSession;
  let watchStarting = false;
  const activeLiveVideo = () =>
    Array.from(videos.querySelectorAll("video")).some(
      (item) => !item.paused && item.readyState >= 2,
    );
  const watchMode = () => {
    if (document.hidden || !window.yapMeasurement?.consented) return null;
    if (!video.hidden && !video.paused && video.readyState >= 2)
      return "replay";
    if (room && !side && eventStatus === "live" && activeLiveVideo())
      return "live";
    return null;
  };
  function endWatch() {
    const previous = watchSession;
    watchSession = undefined;
    if (previous)
      void window.yapMeasurement?.progressWatch(
        id,
        previous.mode,
        previous.id,
        "end",
      );
  }
  async function tickWatch() {
    const mode = watchMode();
    if (!mode) {
      endWatch();
      return;
    }
    if (watchSession?.mode === mode) {
      void window.yapMeasurement.progressWatch(id, mode, watchSession.id);
      return;
    }
    if (watchStarting) return;
    endWatch();
    watchStarting = true;
    const sessionId = window.crypto.randomUUID();
    try {
      if (
        (await window.yapMeasurement.startWatch(id, mode, sessionId)) &&
        watchMode() === mode
      )
        watchSession = { id: sessionId, mode };
    } finally {
      watchStarting = false;
    }
  }
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
    if (!response.ok)
      throw Object.assign(new Error(result.error || "Media request failed"), {
        status: response.status,
      });
    return result;
  };
  const reporter = createPlaybackReporter({
    send: (reports) =>
      request("/playback", {
        method: "POST",
        body: JSON.stringify({ reports }),
        keepalive: true,
      }),
    dimensions: playbackDimensions(navigator.userAgent),
    schedule: (fn, ms) => window.setTimeout(fn, ms),
    cancel: (timer) => window.clearTimeout(timer),
  });
  diagnostics.subscribe((row) => reporter.record(row));
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
  const recovery = createMediaRecovery({
    join: (role, isCurrent) =>
      role === "speaker"
        ? connectAsSpeaker(true, isCurrent)
        : connectAsViewer(true, isCurrent),
    available: (role) =>
      role === "speaker" ? canJoinAsSpeaker() : eventStatus === "live",
    online: () => navigator.onLine && !document.hidden && !disposed,
    schedule: (fn, ms) => window.setTimeout(fn, ms),
    cancel: (timer) => window.clearTimeout(timer),
    exhausted: () => {
      diagnostics.finish("technical_failure");
      say("Automatic reconnect failed. Use Join to try again.");
    },
  });
  const loadReplayLibrary = createReplayLibraryLoader({
    document,
    source: root.dataset.mediaReplayPlayer,
    getLibrary: () => window.yapReplayHls,
  });
  const replayPlayer = createReplayPlayer({
    video,
    loadHls: loadReplayLibrary,
    request,
    diagnostics,
    say,
    soundRequired: (required) => {
      sound.hidden = !required;
    },
  });
  const captionsTrack = video.querySelector("track");
  if (captionsTrack) captionsTrack.dataset.originalSrc = captionsTrack.src;
  const replayObservers = ["video", "audio"].map((kind) =>
    observePlayback(video, {
      kind,
      diagnostics,
      expected: () => !document.hidden && !video.hidden,
    }),
  );
  function cancelReconnect() {
    recovery.stop();
  }
  function scheduleReconnect() {
    recovery.retry();
  }
  function stopPreparedMicrophone() {
    preparedMicrophone?.stop();
    preparedMicrophone = undefined;
  }
  async function disconnectRoom() {
    const previousRoom = room;
    room = undefined;
    side = undefined;
    leave.hidden = true;
    mute.hidden = true;
    speakerConnected = false;
    updateSpeakerButton();
    showMicrophoneStatus("");
    stopPreparedMicrophone();
    await stopMediaSession(previousRoom, mediaTracks);
  }
  async function connect(token, url) {
    const epoch = recovery.generation;
    const previousRoom = room;
    room = undefined;
    stopPreparedMicrophone();
    await stopMediaSession(previousRoom, mediaTracks);
    if (epoch !== recovery.generation || !recovery.intent || disposed)
      throw Object.assign(new Error("Join cancelled"), { name: "AbortError" });
    const nextRoom =
      preparedRoom || new Room({ adaptiveStream: true, dynacast: true });
    preparedRoom = undefined;
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
    nextRoom.on(RoomEvent.Reconnecting, () => {
      if (room === nextRoom) {
        recovery.transportRecovering();
        diagnostics.record("transport_interruption");
        say("Connection interrupted. Reconnecting…");
      }
    });
    nextRoom.on(RoomEvent.Reconnected, () => {
      if (room !== nextRoom) return;
      recovery.connected();
      diagnostics.record("transport_reconnected");
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
    nextRoom.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      if (room === nextRoom) {
        sound.hidden = nextRoom.canPlaybackAudio;
        if (!nextRoom.canPlaybackAudio)
          diagnostics.record("sound_activation_required");
      }
    });
    nextRoom.on(RoomEvent.Disconnected, (reason) => {
      if (room !== nextRoom) return;
      endWatch();
      room = undefined;
      leave.hidden = true;
      mute.hidden = true;
      diagnostics.record("disconnected", { reason });
      mediaTracks.clear();
      stopPreparedMicrophone();
      side = undefined;
      speakerConnected = false;
      updateSpeakerButton();
      const recoverable = mayRecoverDisconnect(reason);
      if (!recoverable) {
        rememberSpeaker(false);
        diagnostics.finish("stopped");
      }
      say(
        recoverable && recovery.intent
          ? "Disconnected. Reconnecting…"
          : "Disconnected. Use Join to reconnect.",
      );
      recovery.disconnected(recoverable);
    });
    await nextRoom.connect(url, token);
    if (
      room !== nextRoom ||
      disposed ||
      !recovery.intent ||
      epoch !== recovery.generation
    ) {
      await nextRoom.disconnect(true);
      throw Object.assign(new Error("Join cancelled"), { name: "AbortError" });
    }
    recovery.connected();
    leave.hidden = false;
    sound.hidden = nextRoom.canPlaybackAudio;
    for (const participant of nextRoom.remoteParticipants.values())
      for (const publication of participant.trackPublications.values())
        if (publication.track)
          mediaTracks.attach(publication.track, participant.identity);
    return nextRoom;
  }
  async function connectAsViewer(automatic = false, isCurrent = () => true) {
    if (viewerJoining || joiningSpeaker || disposed) return;
    const epoch = recovery.generation;
    const current = () => isCurrent() && epoch === recovery.generation;
    viewerJoining = true;
    viewerButton.disabled = true;
    try {
      const grant = await request("/viewer-token", { method: "POST" });
      diagnostics.record("authorization", { outcome: "allowed" });
      if (!current() || recovery.intent !== "viewer") return;
      await connect(grant.token, grant.url);
      if (!current()) {
        await disconnectRoom();
        return;
      }
      say("Watching live debate.");
      void tickWatch();
    } catch (error) {
      diagnostics.record("authorization", {
        outcome: [401, 403, 404].includes(error.status)
          ? "denied"
          : "technical_error",
      });
      say(error.message);
      if (automatic) throw error;
      if ([401, 403, 404].includes(error.status)) {
        recovery.stop();
        diagnostics.finish("authorization_denied");
      } else recovery.disconnected(true);
    } finally {
      viewerJoining = false;
      viewerButton.disabled = false;
    }
  }
  viewerButton.addEventListener("click", () => {
    if (viewerJoining || joiningSpeaker) return;
    recovery.start("viewer");
    diagnostics.start("live", preparationComplete);
    leave.hidden = false;
    preparedRoom ||= new Room({ adaptiveStream: true, dynacast: true });
    void preparedRoom.startAudio().catch(() => {
      sound.hidden = false;
    });
    void connectAsViewer();
  });
  async function connectAsSpeaker(automatic = false, isCurrent = () => true) {
    if (
      joiningSpeaker ||
      viewerJoining ||
      !canJoinAsSpeaker() ||
      speakerConnected
    )
      return;
    const epoch = recovery.generation;
    const current = () =>
      isCurrent() &&
      epoch === recovery.generation &&
      recovery.intent === "speaker";
    joiningSpeaker = true;
    updateSpeakerButton();
    try {
      const message = await joinSpeaker({
        button: speakerButton,
        mediaDevices: navigator.mediaDevices,
        isCurrent: current,
        devices: deviceChoices,
        microphoneWanted,
        rememberDevices(choices) {
          for (const [kind, value] of Object.entries(choices))
            if (value) deviceChoices[kind] = value;
          try {
            window.sessionStorage.setItem(
              `${speakerMemoryKey}:devices`,
              JSON.stringify(deviceChoices),
            );
          } catch {
            /* optional storage */
          }
        },
        request,
        connect,
        tracks: mediaTracks,
        setSide(value) {
          side = value;
        },
        setPreparedMicrophone(track) {
          stopPreparedMicrophone();
          preparedMicrophone = track;
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
      rememberSpeaker(true);
      recovery.connected();
      mute.hidden = false;
      say(message);
    } catch (error) {
      await disconnectRoom();
      say(error.message);
      if (
        [401, 403, 404, 409].includes(error.status) ||
        ["NotAllowedError", "SecurityError"].includes(error.name)
      ) {
        rememberSpeaker(false);
        recovery.stop();
        diagnostics.finish("authorization_denied");
      }
      if (automatic) throw error;
    } finally {
      joiningSpeaker = false;
      updateSpeakerButton();
      if (!automatic && !speakerConnected) recovery.disconnected(true);
    }
  }
  speakerButton.addEventListener("click", () => {
    if (viewerJoining || joiningSpeaker) return;
    cancelReconnect();
    recovery.start("speaker");
    diagnostics.start("speaker", preparationComplete);
    leave.hidden = false;
    void connectAsSpeaker();
  });
  replay.addEventListener("click", async () => {
    replay.disabled = true;
    try {
      await replayPlayer.start();
      void tickWatch();
    } catch (error) {
      say(error.message);
    } finally {
      replay.disabled = false;
    }
  });
  sound.addEventListener("click", async () => {
    diagnostics.record("sound_activation_tap");
    try {
      if (room) {
        await room.startAudio();
        sound.hidden = room.canPlaybackAudio;
      } else await replayPlayer.activateSound();
    } catch {
      say("Sound could not start. Try Enable sound again.");
    }
  });
  leave.addEventListener("click", () => {
    recovery.stop();
    rememberSpeaker(false);
    diagnostics.finish("voluntary_leave");
    endWatch();
    leave.hidden = true;
    mute.hidden = true;
    void disconnectRoom();
    say("You left the live debate.");
  });
  mute.addEventListener("click", () => {
    microphoneWanted = !microphoneWanted;
    mute.setAttribute("aria-pressed", String(!microphoneWanted));
    mute.textContent = microphoneWanted
      ? "Mute microphone"
      : "Allow microphone on my turn";
    try {
      window.sessionStorage.setItem(
        `${speakerMemoryKey}:muted`,
        microphoneWanted ? "0" : "1",
      );
    } catch {
      /* optional storage */
    }
    diagnostics.record("microphone_intent", { enabled: microphoneWanted });
    if (!microphoneWanted) {
      if (preparedMicrophone) preparedMicrophone.enabled = false;
      void room?.localParticipant.setMicrophoneEnabled(false);
    }
    void refresh();
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
      if (disposed) return;
      if (
        currentState &&
        result.state &&
        result.state.revision < currentState.revision
      )
        return;
      currentState = result.state;
      eventStatus = result.eventStatus;
      serverOffset = new Date(result.serverNow).getTime() - Date.now();
      const live = result.eventStatus === "live";
      const presentation = mediaPresentation(result.eventStatus, result.state);
      viewerButton.hidden = !live || speakerConnected || Boolean(room);
      updateSpeakerButton();
      replay.hidden = !presentation.replayVisible;
      if (!room && !recovery.intent && video.hidden) say(presentation.message);
      if (live && !preparationStarted) {
        preparationStarted = true;
        preparedRoom ||= new Room({ adaptiveStream: true, dynacast: true });
        void preparedRoom
          .prepareConnection(result.preparationUrl)
          .then(() => {
            preparationComplete = true;
            diagnostics.record("connection_prepared");
          })
          .catch(() => diagnostics.record("preparation_failed"));
      }
      if (
        presentation.replayVisible &&
        !navigator.connection?.saveData &&
        !document.hidden
      )
        void replayPlayer.prepare().catch(() => {});
      for (const button of operator.querySelectorAll("[data-media-action]"))
        button.hidden = !presentation.actions[button.dataset.mediaAction];
      if (["ended", "replay", "finalized", "cancelled"].includes(eventStatus)) {
        endWatch();
        cancelReconnect();
        rememberSpeaker(false);
        if (room) diagnostics.finish("debate_ended");
        if (room) await disconnectRoom();
        return;
      }
      if (room && side) {
        const shouldSpeak =
          microphoneWanted &&
          recovery.intent === "speaker" &&
          live &&
          result.state?.state === "running" &&
          result.state.activeSide === side;
        if (microphoneChange) await microphoneChange.catch(() => {});
        if (preparedMicrophone?.readyState === "ended")
          stopPreparedMicrophone();
        const mayPublishMicrophone =
          room?.localParticipant.permissions?.canPublishSources?.includes(
            Track.sourceToProto(Track.Source.Microphone),
          );
        if (room && shouldSpeak && !mayPublishMicrophone) {
          showMicrophoneStatus("Waiting for microphone access…");
          return;
        }
        if (room && room.localParticipant.isMicrophoneEnabled !== shouldSpeak) {
          showMicrophoneStatus(
            shouldSpeak ? "Opening microphone…" : "Microphone off",
          );
          if (shouldSpeak && preparedMicrophone) {
            const track = preparedMicrophone;
            preparedMicrophone = undefined;
            microphoneChange = room.localParticipant.publishTrack(track, {
              source: Track.Source.Microphone,
            });
            const publishingRoom = room;
            microphoneChange = microphoneChange.then((publication) => {
              track.enabled =
                room === publishingRoom &&
                microphoneWanted &&
                currentState?.state === "running" &&
                currentState?.activeSide === side &&
                Boolean(
                  publishingRoom.localParticipant.permissions?.canPublishSources?.includes(
                    Track.sourceToProto(Track.Source.Microphone),
                  ),
                );
              return publication;
            });
            microphoneChange.catch(() => track.stop());
          } else {
            microphoneChange = room.localParticipant.setMicrophoneEnabled(
              shouldSpeak,
              deviceChoices.audioinput
                ? { deviceId: { exact: deviceChoices.audioinput } }
                : undefined,
            );
          }
          try {
            const changingRoom = room;
            await microphoneChange;
            if (
              changingRoom &&
              (room !== changingRoom ||
                !microphoneWanted ||
                recovery.intent !== "speaker" ||
                currentState?.state !== "running" ||
                currentState?.activeSide !== side ||
                !changingRoom.localParticipant.permissions?.canPublishSources?.includes(
                  Track.sourceToProto(Track.Source.Microphone),
                ))
            )
              await changingRoom.localParticipant.setMicrophoneEnabled(false);
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
                : preparedMicrophone
                  ? "Microphone ready · muted"
                  : "Microphone off",
          );
      }
    } catch (error) {
      if ([401, 403, 404].includes(error.status)) {
        recovery.stop();
        rememberSpeaker(false);
        replayPlayer.stop();
        video.hidden = true;
        if (room) await disconnectRoom();
        diagnostics.finish("authorization_denied");
      }
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
    void tickWatch();
    diagnostics.record(document.hidden ? "background" : "foreground");
    if (!document.hidden) {
      replayPlayer.online();
      void refresh();
      if (!speakerConnected) scheduleReconnect();
    }
  });
  window.addEventListener("offline", () => {
    recovery.offline();
    replayPlayer.offline();
    diagnostics.record("offline");
  });
  window.addEventListener("online", () => {
    diagnostics.record("network_restored");
    replayPlayer.online();
    if (!speakerConnected) scheduleReconnect();
  });
  window.addEventListener("yap-measurement-changed", () => void tickWatch());
  video.addEventListener("playing", () => void tickWatch());
  video.addEventListener("pause", endWatch);
  video.addEventListener("ended", () => {
    endWatch();
    diagnostics.finish("completed");
  });
  const watchTimer = window.setInterval(() => void tickWatch(), 10_000);
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
      try {
        microphoneWanted =
          window.sessionStorage.getItem(`${speakerMemoryKey}:muted`) !== "1";
        deviceChoices = JSON.parse(
          window.sessionStorage.getItem(`${speakerMemoryKey}:devices`) || "{}",
        );
      } catch {
        /* optional storage */
      }
      mute.setAttribute("aria-pressed", String(!microphoneWanted));
      mute.textContent = microphoneWanted
        ? "Mute microphone"
        : "Allow microphone on my turn";
    } catch {
      seatSide = undefined;
    }
    await refresh();
    if (remembersSpeaker() && canJoinAsSpeaker()) {
      recovery.start("speaker");
      diagnostics.start("speaker", preparationComplete);
      scheduleReconnect();
    }
  })();
  let pollTimer;
  function pollStatus() {
    if (disposed) return;
    pollTimer = window.setTimeout(
      async () => {
        await refresh();
        pollStatus();
      },
      speakerConnected ? 1000 : 3000,
    );
  }
  pollStatus();
  const clockTimer = window.setInterval(paintClock, 250);
  const statsTimer = window.setInterval(async () => {
    if (!room || document.hidden) return;
    const activeRoom = room;
    for (const person of activeRoom.remoteParticipants.values())
      for (const publication of person.trackPublications.values()) {
        const track = publication.track;
        if (!track || track.isMuted) continue;
        try {
          const report = await track.getRTCStatsReport();
          if (room !== activeRoom) return;
          report?.forEach((row) => {
            if (row.type === "inbound-rtp")
              diagnostics.record("webrtc_stats", {
                kind: track.kind,
                packetsLost: row.packetsLost,
                packetsReceived: row.packetsReceived,
                framesDecoded: row.framesDecoded,
                freezeCount: row.freezeCount,
                totalFreezesDuration: row.totalFreezesDuration,
                concealedSamples: row.concealedSamples,
                totalSamplesReceived: row.totalSamplesReceived,
                jitterBufferDelay: row.jitterBufferDelay,
                jitterBufferEmittedCount: row.jitterBufferEmittedCount,
              });
          });
        } catch {
          diagnostics.record("stats_unavailable");
        }
      }
  }, 5000);
  window.addEventListener("pagehide", () => {
    disposed = true;
    recovery.stop();
    diagnostics.finish("abandoned");
    endWatch();
    reporter.stop();
    replayPlayer.destroy();
    replayObservers.forEach((stop) => stop());
    window.clearTimeout(pollTimer);
    window.clearInterval(watchTimer);
    window.clearInterval(clockTimer);
    window.clearInterval(statsTimer);
    void disconnectRoom();
    void preparedRoom?.disconnect(true);
  });
}
