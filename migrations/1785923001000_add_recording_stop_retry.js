export const shorthands = undefined;

export const up = (pgm) => {
  pgm.addColumns("debate_media", {
    stop_requested_at: { type: "timestamptz" },
    stop_retry_at: { type: "timestamptz" },
  });
  pgm.createIndex("debate_media", [
    "state",
    "recording_status",
    "stop_retry_at",
  ]);
};

export const down = (pgm) => {
  pgm.dropIndex("debate_media", ["state", "recording_status", "stop_retry_at"]);
  pgm.dropColumns("debate_media", ["stop_requested_at", "stop_retry_at"]);
};
