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
  isCurrent = () => true,
  devices = {},
  microphoneWanted = true,
  rememberDevices = () => {},
}) {
  const assertCurrent = () => {
    if (!isCurrent())
      throw Object.assign(new Error("Join cancelled"), { name: "AbortError" });
  };
  button.disabled = true;
  let preview;
  let preparedMicrophone;
  try {
    preview = await mediaDevices.getUserMedia({
      audio: !microphoneWanted
        ? false
        : devices.audioinput
          ? { deviceId: { exact: devices.audioinput } }
          : true,
      video: devices.videoinput
        ? { deviceId: { exact: devices.videoinput } }
        : true,
    });
    assertCurrent();
    rememberDevices({
      audioinput: preview.getAudioTracks()[0]?.getSettings?.().deviceId,
      videoinput: preview.getVideoTracks()[0]?.getSettings?.().deviceId,
    });
    if (microphoneWanted)
      await request("/device-check", {
        method: "POST",
        body: JSON.stringify({
          cameraOk: preview.getVideoTracks().length > 0,
          microphoneOk: preview.getAudioTracks().length > 0,
        }),
      });
    assertCurrent();
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
    assertCurrent();
    const connectedRoom = await connect(grant.token, grant.url);
    assertCurrent();
    const participant = connectedRoom.localParticipant;
    const camera = await participant.setCameraEnabled(
      true,
      devices.videoinput
        ? { deviceId: { exact: devices.videoinput } }
        : undefined,
    );
    if (!camera?.track) throw new Error("Could not open camera");
    assertCurrent();
    tracks.attach(camera.track, participant.identity);
    setSide(grant.side);

    const joined = await request("");
    assertCurrent();
    if (["scheduled", "ready"].includes(joined.eventStatus)) await markReady();
    assertCurrent();
    if (preparedMicrophone) {
      setPreparedMicrophone(preparedMicrophone);
      preparedMicrophone = undefined;
    }
    await refresh();
    return joined.state?.state === "paused"
      ? `Reconnected as speaker ${grant.side}. The operator can resume once both speakers are connected.`
      : `Connected as speaker ${grant.side}. ${microphoneWanted ? "Your microphone opens on your turn." : "Your microphone remains muted."}`;
  } finally {
    preview?.getTracks().forEach((track) => track.stop());
    preparedMicrophone?.stop();
    button.disabled = false;
  }
}
