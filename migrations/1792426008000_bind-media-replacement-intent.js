export const shorthands = undefined;
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE yaparena.media_account_grants
      ADD COLUMN intended_session_id bigint CHECK(intended_session_id>0),
      ADD COLUMN intent_expires_at timestamptz,
      ADD CONSTRAINT media_replacement_pair CHECK((intended_session_id IS NULL)=(intent_expires_at IS NULL));
    CREATE OR REPLACE FUNCTION yaparena.media_account_grant_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog,yaparena,pg_temp AS $$
    DECLARE intent_changed boolean;
    BEGIN
      IF TG_OP='DELETE' THEN
        RAISE EXCEPTION 'media grant history is immutable' USING ERRCODE='23514';
      END IF;
      IF TG_OP='INSERT' THEN
        IF NEW.state<>'active' OR NEW.intended_session_id IS NOT NULL
          OR NOT EXISTS(SELECT 1 FROM yaparena.sessions s JOIN yaparena.users u ON u.id=s.user_id
          WHERE s.id=NEW.session_id AND u.id=NEW.user_id AND u.account_status='active'
          AND s.auth_generation=u.auth_generation AND NEW.auth_generation=u.auth_generation
          AND s.expires_at>clock_timestamp()) THEN
          RAISE EXCEPTION 'media grant session is unavailable' USING ERRCODE='23514';
        END IF;
      ELSE
        intent_changed:=NEW.intended_session_id IS DISTINCT FROM OLD.intended_session_id
          OR NEW.intent_expires_at IS DISTINCT FROM OLD.intent_expires_at;
        IF (to_jsonb(NEW)-ARRAY['state','issued_at','expires_at','revoked_at','intended_session_id','intent_expires_at']) IS DISTINCT FROM
          (to_jsonb(OLD)-ARRAY['state','issued_at','expires_at','revoked_at','intended_session_id','intent_expires_at'])
          OR OLD.state='revoked' OR (OLD.state='revoking' AND NEW.state NOT IN ('revoking','revoked'))
          OR (OLD.state='active' AND NEW.state NOT IN ('active','revoking'))
          OR NEW.issued_at<OLD.issued_at OR NEW.expires_at<OLD.expires_at
          OR ((NEW.state<>OLD.state OR OLD.state<>'active') AND
            (NEW.issued_at<>OLD.issued_at OR NEW.expires_at<>OLD.expires_at)) THEN
          RAISE EXCEPTION 'media grant identity or retirement is immutable' USING ERRCODE='23514';
        END IF;
        IF intent_changed AND (NEW.state<>'revoking' OR NEW.intended_session_id IS NULL
          OR NEW.intent_expires_at<=clock_timestamp() OR NEW.intent_expires_at>clock_timestamp()+INTERVAL '5 minutes'
          OR NOT EXISTS(SELECT 1 FROM yaparena.sessions s JOIN yaparena.users u ON u.id=s.user_id
            WHERE s.id=NEW.intended_session_id AND u.id=NEW.user_id AND u.account_status='active'
              AND s.auth_generation=u.auth_generation AND s.expires_at>clock_timestamp())) THEN
          RAISE EXCEPTION 'media replacement session or intent is unavailable' USING ERRCODE='23514';
        END IF;
        IF NEW.state='active' AND NOT EXISTS(SELECT 1 FROM yaparena.sessions s JOIN yaparena.users u ON u.id=s.user_id
          WHERE s.id=NEW.session_id AND u.id=NEW.user_id AND u.account_status='active'
          AND s.auth_generation=u.auth_generation AND s.expires_at>clock_timestamp()) THEN
          RAISE EXCEPTION 'media grant session is unavailable' USING ERRCODE='23514';
        END IF;
      END IF;
      RETURN NEW;
    END $$;
    GRANT UPDATE(intended_session_id,intent_expires_at) ON yaparena.media_account_grants TO yaparena_runtime;
  `);
};
export const down = () => {
  throw new Error("Media replacement history requires a reviewed forward fix");
};
