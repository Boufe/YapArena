export async function joinSpeaker({
  button,
  mediaDevices,
  request,
  connect,
  tracks,
  setSide,
  setPreparedMicrophone,
  markReady,
  refresh,
}) {
  button.disabled = true;
  let preview;
  let preparedMicrophone;
  try {
    preview = await mediaDevices.getUserMedia({ audio: true, video: true });
    await request("/device-check", {
      method: "POST",
      body: JSON.stringify({
        cameraOk: preview.getVideoTracks().length > 0,
        microphoneOk: preview.getAudioTracks().length > 0,
      }),
    });
    preparedMicrophone = setPreparedMicrophone
      ? preview.getAudioTracks()[0]
      : undefined;
    if (preparedMicrophone) preparedMicrophone.enabled = false;
    preview
      .getTracks()
      .filter((track) => track !== preparedMicrophone)
      .forEach((track) => track.stop());
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
    if (preparedMicrophone) {
      setPreparedMicrophone(preparedMicrophone);
      preparedMicrophone = undefined;
    }
    await refresh();
    return joined.state?.state === "paused"
      ? `Reconnected as speaker ${grant.side}. The operator can resume once both speakers are connected.`
      : `Connected as speaker ${grant.side}. Your microphone opens on your turn.`;
  } finally {
    preview?.getTracks().forEach((track) => track.stop());
    preparedMicrophone?.stop();
    button.disabled = false;
  }
}
