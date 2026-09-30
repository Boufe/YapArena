export async function joinSpeaker({
  button,
  mediaDevices,
  request,
  connect,
  tracks,
  setSide,
  markReady,
  refresh,
}) {
  button.disabled = true;
  let preview;
  try {
    preview = await mediaDevices.getUserMedia({ audio: true, video: true });
    await request("/device-check", {
      method: "POST",
      body: JSON.stringify({
        cameraOk: preview.getVideoTracks().length > 0,
        microphoneOk: preview.getAudioTracks().length > 0,
      }),
    });
    preview.getTracks().forEach((track) => track.stop());
    preview = undefined;

    const grant = await request("/speaker-token", { method: "POST" });
    const connectedRoom = await connect(grant.token, grant.url);
    const participant = connectedRoom.localParticipant;
    const camera = await participant.setCameraEnabled(true);
    if (!camera?.track) throw new Error("Could not open camera");
    tracks.attach(camera.track, participant.identity);
    setSide(grant.side);

    const joined = await request("");
    if (["scheduled", "ready"].includes(joined.eventStatus)) await markReady();
    await refresh();
    return joined.state?.state === "paused"
      ? `Reconnected as speaker ${grant.side}. The operator can resume once both speakers are connected.`
      : `Connected as speaker ${grant.side}. Your microphone opens on your turn.`;
  } finally {
    preview?.getTracks().forEach((track) => track.stop());
    button.disabled = false;
  }
}
