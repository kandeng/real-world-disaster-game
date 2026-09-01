-- 010_meshes.sql
-- 3D mesh assets (Content -> 3D Asset).
--
-- Content-addressed storage: the GLB bytes live once on disk under
-- server/workspace/meshes/<sha256[:2]>/<sha256>.glb; this table is the
-- per-user catalog row referencing that hash. UNIQUE(user_id, sha256)
-- dedups a user's own re-uploads; the sha256 index powers the cross-user
-- blob-existence check and the delete-time refcount GC (the blob file is
-- unlinked only when no remaining row references its hash).
--
-- NOTE: the app's lifespan also runs Base.metadata.create_all, so this
-- table is created automatically on first boot in local dev; keep this
-- script as the documented production DDL (PostgreSQL dialect). On
-- production the app's DB role lacks CREATE privilege — apply this as the
-- postgres superuser and GRANT DML to the app role (see below).

CREATE TABLE IF NOT EXISTS mesh (
    id VARCHAR(16) NOT NULL,
    user_id UUID NOT NULL,
    sha256 VARCHAR(64) NOT NULL,
    name VARCHAR(200) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    animation_script TEXT NOT NULL DEFAULT '',
    visibility VARCHAR(16) NOT NULL DEFAULT 'private',
    size_bytes BIGINT NOT NULL DEFAULT 0,
    original_filename TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    CONSTRAINT uq_mesh_user_sha256 UNIQUE (user_id, sha256),
    FOREIGN KEY (user_id) REFERENCES "user" (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_mesh_user_id ON mesh (user_id);
CREATE INDEX IF NOT EXISTS ix_mesh_sha256 ON mesh (sha256);

-- Production hardening note (applied manually, matching the route/video tables):
--   GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mesh TO drone_api;
