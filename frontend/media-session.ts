import type { Room } from "livekit-client";
import type { Side } from "./media-types.js";

export function speakerButtonState({
  side,
  status,
  connected,
  joining,
}: {
  side?: Side;
  status?: string;
  connected: boolean;
  joining: boolean;
}) {
  const joinable =
    Boolean(side) &&
    (
      ["scheduled", "ready", "live"] as readonly (string | undefined)[]
    ).includes(status);
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

export async function stopMediaSession(
  room: Room | undefined,
  tracks: { clear(): void },
) {
  tracks.clear();
  if (room) await room.disconnect(true);
}
