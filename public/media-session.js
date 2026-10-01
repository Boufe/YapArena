export function speakerButtonState({ side, status, connected, joining }) {
  const joinable =
    Boolean(side) && ["scheduled", "ready", "live"].includes(status);
  return {
    hidden: !joinable || connected,
    disabled: joining,
    text: joining
      ? "Connecting as speaker…"
      : status === "live"
        ? "Connect or reconnect as speaker"
        : "Check camera and join as speaker",
  };
}

export async function stopMediaSession(room, tracks) {
  tracks.clear();
  if (room) await room.disconnect(true);
}
