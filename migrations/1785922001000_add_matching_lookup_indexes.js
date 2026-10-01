export const shorthands = undefined;

export const up = (pgm) => {
  pgm.createIndex("match_requests", ["initiator_user_id", "created_at"]);
  pgm.createIndex("event_participants", ["user_id", "created_at"]);
};

export const down = (pgm) => {
  pgm.dropIndex("event_participants", ["user_id", "created_at"]);
  pgm.dropIndex("match_requests", ["initiator_user_id", "created_at"]);
};
