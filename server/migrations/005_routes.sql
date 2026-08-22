-- 005_routes.sql
-- Per-user saved flight routes (Content -> Route): editable title plus an
-- ordered waypoint JSON document (lat/lng/alt/speed/camera angles).
--
-- NOTE: the app's lifespan also runs Base.metadata.create_all, so this
-- table is created automatically on first boot; keep this script as the
-- documented production DDL (PostgreSQL dialect).

CREATE TABLE IF NOT EXISTS route (
    id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    title VARCHAR(200) NOT NULL,
    waypoints JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    FOREIGN KEY (user_id) REFERENCES "user" (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_route_user_id ON route (user_id);
