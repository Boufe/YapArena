import pg from "pg";

if (process.env.NODE_ENV === "production") {
  throw new Error("demo discovery data cannot be seeded in production");
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const client = new pg.Client({ connectionString: databaseUrl });

const profiles = [
  [
    "alex-rivera",
    "Alex Rivera",
    "Curious about how technology changes everyday life.",
  ],
  [
    "morgan-lee",
    "Morgan Lee",
    "Interested in cities, culture, and public policy.",
  ],
  [
    "sam-patel",
    "Sam Patel",
    "Asking difficult questions about work and learning.",
  ],
];

const topics = [
  [
    "ai-and-human-creativity",
    "AI and human creativity",
    "Can generative tools expand human expression without diminishing the value of original work?",
    "AI expands creativity",
    "AI weakens creativity",
  ],
  [
    "cities-and-public-space",
    "Cities and public space",
    "What should cities prioritize when shared space is limited?",
    "More room for people",
    "More room for cars",
  ],
  [
    "future-of-work",
    "The future of work",
    "How should changing technology reshape the working week?",
    "Shorter workweek",
    "Traditional workweek",
  ],
];

const debates = [
  [
    "can-ai-make-us-more-creative",
    "ai-and-human-creativity",
    "Can AI make us more creative?",
    "scheduled",
    "alex-rivera",
    "sam-patel",
    8,
  ],
  [
    "should-cities-prioritize-walkability",
    "cities-and-public-space",
    "Should cities prioritize walkability over cars?",
    "scheduled",
    "morgan-lee",
    "alex-rivera",
    15,
  ],
  [
    "should-we-work-four-days",
    "future-of-work",
    "Should the four-day workweek become standard?",
    "replay",
    "sam-patel",
    "morgan-lee",
    -7,
  ],
];

await client.connect();
try {
  await client.query("BEGIN");
  for (const [handle, displayName, bio] of profiles) {
    await client.query(
      `INSERT INTO public_profiles (handle, display_name, bio, publication_state, is_demo)
       VALUES ($1, $2, $3, 'published', true) ON CONFLICT (handle) DO NOTHING`,
      [handle, displayName, bio],
    );
  }
  for (const [slug, title, summary, sideA, sideB] of topics) {
    await client.query(
      `INSERT INTO topics (slug, title, summary, side_a_label, side_b_label, publication_state, is_demo)
       VALUES ($1, $2, $3, $4, $5, 'published', true) ON CONFLICT (slug) DO NOTHING`,
      [slug, title, summary, sideA, sideB],
    );
  }
  for (const [
    slug,
    topicSlug,
    proposition,
    status,
    speakerA,
    speakerB,
    days,
  ] of debates) {
    const scheduledAt = new Date(Date.now() + days * 24 * 60 * 60 * 1_000);
    await client.query(
      `INSERT INTO debates (slug, topic_id, proposition, speaker_a_profile_id,
        speaker_b_profile_id, status, publication_state, rules_version, rules_snapshot, scheduled_at, is_demo)
       SELECT $1, t.id, $3, a.id, b.id, $6, 'published', r.version, r.rules, $7, true
       FROM topics t, public_profiles a, public_profiles b, event_rule_versions r
       WHERE t.slug = $2 AND a.handle = $4 AND b.handle = $5
         AND r.version = 'preview-1'
       ON CONFLICT (slug) DO NOTHING`,
      [slug, topicSlug, proposition, speakerA, speakerB, status, scheduledAt],
    );
  }
  await client.query("COMMIT");
  console.log("Demo public discovery records are ready.");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
