export const shorthands = undefined;
export const replayJobTables = ["media_replay_jobs", "media_replay_attempts"];

export const up = (pgm) => {
  pgm.sql(`
    -- No parent FK: cleanup tombstones survive removal of the event/media row.
    CREATE TABLE yaparena.media_replay_jobs (
      id uuid PRIMARY KEY, debate_id uuid NOT NULL, source_key varchar(500) NOT NULL,
      caption_hash char(64) NOT NULL CHECK (caption_hash ~ '^[0-9a-f]{64}$'),
      state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','processing','ready','failed','cancelled')),
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
      next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      lease_id uuid, lease_expires_at timestamptz, package_key varchar(500),
      source_etag varchar(200), manifest_digest char(64), failure_code varchar(40),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CHECK (source_key ~ '^debates/[0-9a-f-]{36}/[a-zA-Z0-9-]+[.]mp4$'
        AND split_part(source_key,'/',2)=debate_id::text),
      CHECK (package_key IS NULL OR package_key='debates/'||debate_id::text||'/package-'||lease_id::text||'.mp4'),
      CHECK (state <> 'processing' OR (lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)),
      CHECK (state <> 'ready' OR (lease_id IS NOT NULL AND package_key IS NOT NULL AND manifest_digest IS NOT NULL))
    );
    CREATE UNIQUE INDEX media_replay_current_input ON yaparena.media_replay_jobs
      (debate_id,source_key,caption_hash) WHERE state <> 'cancelled';
    CREATE INDEX media_replay_due ON yaparena.media_replay_jobs (next_attempt_at,id) WHERE state='queued';
    CREATE INDEX media_replay_expired_lease ON yaparena.media_replay_jobs (lease_expires_at,id) WHERE state='processing';
    CREATE INDEX media_replay_room ON yaparena.media_replay_jobs (debate_id,id);
    CREATE TABLE yaparena.media_replay_attempts (
      id uuid PRIMARY KEY,
      job_id uuid NOT NULL REFERENCES yaparena.media_replay_jobs(id) ON DELETE RESTRICT,
      package_key varchar(500) NOT NULL UNIQUE,
      state text NOT NULL DEFAULT 'writing' CHECK (state IN ('writing','ready','cleanup','cleaning','cleaned')),
      protect_until timestamptz NOT NULL,
      cleanup_after timestamptz NOT NULL DEFAULT clock_timestamp(),
      cleanup_token uuid, cleanup_lease_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CHECK (package_key ~ '^debates/[0-9a-f-]{36}/package-[0-9a-f-]{36}[.]mp4$')
    );
    CREATE INDEX media_replay_attempt_cleanup ON yaparena.media_replay_attempts (cleanup_after,id)
      WHERE state IN ('cleanup','cleaning');
    CREATE INDEX media_replay_attempt_job ON yaparena.media_replay_attempts (job_id,id);
  `);
  for (const table of replayJobTables)
    pgm.sql(`ALTER TABLE yaparena.${table} ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON yaparena.${table} FROM PUBLIC;
      GRANT SELECT, INSERT ON yaparena.${table} TO yaparena_runtime;
      CREATE POLICY backend_runtime ON yaparena.${table} TO yaparena_runtime
        USING (true) WITH CHECK (true);`);
  pgm.sql(`
    GRANT UPDATE (state,attempts,next_attempt_at,lease_id,lease_expires_at,package_key,
      source_etag,manifest_digest,failure_code,updated_at) ON yaparena.media_replay_jobs TO yaparena_runtime;
    GRANT UPDATE (state,protect_until,cleanup_after,cleanup_token,cleanup_lease_at)
      ON yaparena.media_replay_attempts TO yaparena_runtime;
    GRANT DELETE ON yaparena.media_replay_jobs,yaparena.media_replay_attempts TO yaparena_runtime;
    -- Domain writers acquire their domain/community locks first; queue locks
    -- come last in UUID order. Final publication takes topic -> debate -> media
    -- -> community room -> job -> attempt; ordinary claims lock queue rows only.
    CREATE FUNCTION yaparena.invalidate_replay_jobs() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER
      SET search_path=pg_catalog,yaparena,pg_temp AS $$
    DECLARE room uuid; affected uuid; keep_input boolean:=false;
      latest_source text; latest_caption text;
    BEGIN
      IF TG_TABLE_NAME='topics' THEN
        IF NEW.publication_state='published' THEN RETURN NEW; END IF;
        FOR affected IN SELECT j.id FROM media_replay_jobs j JOIN debates d ON d.id=j.debate_id
          WHERE d.topic_id=OLD.id AND j.state <> 'cancelled' ORDER BY j.id LOOP
          UPDATE media_replay_jobs SET state='cancelled',lease_expires_at=NULL,
            updated_at=clock_timestamp() WHERE id=affected;
        END LOOP;
      ELSIF TG_TABLE_NAME='debates' THEN
        IF TG_OP='UPDATE' THEN
          IF NEW.publication_state='published' AND NOT NEW.is_demo
            AND NEW.status IN ('ended','replay','finalized')
            AND EXISTS (SELECT 1 FROM topics WHERE id=NEW.topic_id AND publication_state='published')
            THEN RETURN NEW; END IF;
        END IF;
        room:=OLD.id;
        FOR affected IN SELECT id FROM media_replay_jobs WHERE debate_id=room
          AND state <> 'cancelled' ORDER BY id LOOP
          UPDATE media_replay_jobs SET state='cancelled',lease_expires_at=NULL,
            updated_at=clock_timestamp() WHERE id=affected;
        END LOOP;
      ELSE
        room:=OLD.debate_id;
        IF TG_OP='UPDATE' THEN
          keep_input:=NEW.state='ended' AND NEW.recording_status='ready';
          latest_source:=NEW.recording_key;
          latest_caption:=encode(sha256(convert_to(COALESCE(NEW.captions_vtt,''),'UTF8')),'hex');
        END IF;
        FOR affected IN SELECT id FROM media_replay_jobs WHERE debate_id=room AND state <> 'cancelled'
          AND (NOT keep_input OR source_key IS DISTINCT FROM latest_source OR caption_hash <> latest_caption)
          ORDER BY id LOOP
          UPDATE media_replay_jobs SET state='cancelled',lease_expires_at=NULL,
            updated_at=clock_timestamp() WHERE id=affected;
        END LOOP;
      END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $$;
    REVOKE ALL ON FUNCTION yaparena.invalidate_replay_jobs() FROM PUBLIC,yaparena_runtime;
    CREATE TRIGGER replay_invalidate_media AFTER UPDATE OF state,recording_status,recording_key,captions_vtt OR DELETE
      ON yaparena.debate_media FOR EACH ROW EXECUTE FUNCTION yaparena.invalidate_replay_jobs();
    CREATE TRIGGER replay_invalidate_event_delete BEFORE DELETE
      ON yaparena.debates FOR EACH ROW EXECUTE FUNCTION yaparena.invalidate_replay_jobs();
    CREATE TRIGGER replay_invalidate_event AFTER UPDATE OF publication_state,status,is_demo,topic_id
      ON yaparena.debates FOR EACH ROW EXECUTE FUNCTION yaparena.invalidate_replay_jobs();
    CREATE TRIGGER replay_invalidate_topic AFTER UPDATE OF publication_state
      ON yaparena.topics FOR EACH ROW EXECUTE FUNCTION yaparena.invalidate_replay_jobs();
    DO $$ DECLARE role_name text; BEGIN
      FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
        EXECUTE format('REVOKE ALL ON TABLE yaparena.media_replay_jobs,yaparena.media_replay_attempts FROM %I',role_name);
        EXECUTE format('REVOKE ALL ON FUNCTION yaparena.invalidate_replay_jobs() FROM %I',role_name);
      END LOOP;
    END $$;
  `);
};

export const down = () => {
  throw new Error(
    "Keep replay cleanup tombstones on rollback; use a forward fix",
  );
};
