-- 006_videos.sql
-- Published flight videos (Content -> Video) + their playback URLs.
-- video is minted from a route: title/waypoints copied once (frozen
-- snapshot), route_id is provenance only (SET NULL on route deletion);
-- the author cascade matches route. video_source holds one playback URL
-- per provider (position 0 = primary, e.g. YouTube before Bilibili).
--
-- NOTE: the app's lifespan also runs Base.metadata.create_all, so these
-- tables are created automatically on first boot; keep this script as the
-- documented production DDL (PostgreSQL dialect). On production the app's
-- DB role lacks CREATE privilege — apply this as the postgres superuser
-- and GRANT DML to the app role (see below).

CREATE TABLE IF NOT EXISTS video (
    id UUID NOT NULL,
    user_id UUID NOT NULL,
    route_id UUID,
    title VARCHAR(200) NOT NULL,
    waypoints JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    FOREIGN KEY (user_id) REFERENCES "user" (id) ON DELETE CASCADE,
    FOREIGN KEY (route_id) REFERENCES route (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS ix_video_user_id ON video (user_id);

CREATE TABLE IF NOT EXISTS video_source (
    id UUID NOT NULL,
    video_id UUID NOT NULL,
    provider VARCHAR(32) NOT NULL,
    url TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT uq_video_source_provider UNIQUE (video_id, provider),
    FOREIGN KEY (video_id) REFERENCES video (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_video_source_video_id ON video_source (video_id);

-- Production hardening note (applied manually, matching the route table):
--   GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE video TO drone_api;
--   GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE video_source TO drone_api;
