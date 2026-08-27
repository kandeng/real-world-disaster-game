-- 009_short_ids.sql
-- Replace the 36-char UUID ids of route / video / video_source with 16-hex-
-- char (64-bit) ids: the id itself is the unlisted secret in share links
-- (/play?r=<id>), so URLs stay short. user.id remains a UUID (fastapi-users
-- owns that table).
--
-- Single transaction, generic for any row count: mint a new_id per row,
-- remap the cross-table references, then swap the columns and rebuild the
-- primary keys, foreign keys and the (video_id, provider) uniqueness.
--
-- NOTE: production's app DB role lacks ALTER privilege — apply this as the
-- postgres superuser (psql -v ON_ERROR_STOP=1 -f 009_short_ids.sql), then
-- restart drone-fastapi immediately afterwards: the old code cannot read
-- the migrated columns.

BEGIN;

-- 1. Drop the constraints that reference the id columns being replaced.
ALTER TABLE video DROP CONSTRAINT video_route_id_fkey;
ALTER TABLE video_source DROP CONSTRAINT video_source_video_id_fkey;
ALTER TABLE video_source DROP CONSTRAINT uq_video_source_provider;

-- 2. Mint fresh 16-hex-char ids and remap the foreign keys.
ALTER TABLE route ADD COLUMN new_id VARCHAR(16);
ALTER TABLE video ADD COLUMN new_id VARCHAR(16), ADD COLUMN new_route_id VARCHAR(16);
ALTER TABLE video_source ADD COLUMN new_id VARCHAR(16), ADD COLUMN new_video_id VARCHAR(16);

UPDATE route SET new_id = substr(md5(random()::text || random()::text), 1, 16);
UPDATE video SET new_id = substr(md5(random()::text || random()::text), 1, 16);
UPDATE video_source SET new_id = substr(md5(random()::text || random()::text), 1, 16);
UPDATE video v SET new_route_id = r.new_id FROM route r WHERE v.route_id = r.id;
UPDATE video_source s SET new_video_id = v.new_id FROM video v WHERE s.video_id = v.id;

-- 3. Swap old id columns for the new ones (route).
ALTER TABLE route DROP CONSTRAINT route_pkey, DROP COLUMN id;
ALTER TABLE route RENAME COLUMN new_id TO id;
ALTER TABLE route ALTER COLUMN id SET NOT NULL, ADD PRIMARY KEY (id);

-- Swap old id columns for the new ones (video).
ALTER TABLE video DROP CONSTRAINT video_pkey, DROP COLUMN id;
ALTER TABLE video RENAME COLUMN new_id TO id;
ALTER TABLE video ALTER COLUMN id SET NOT NULL, ADD PRIMARY KEY (id);
ALTER TABLE video DROP COLUMN route_id;
ALTER TABLE video RENAME COLUMN new_route_id TO route_id;

-- Swap old id columns for the new ones (video_source).
ALTER TABLE video_source DROP CONSTRAINT video_source_pkey, DROP COLUMN id;
ALTER TABLE video_source RENAME COLUMN new_id TO id;
ALTER TABLE video_source ALTER COLUMN id SET NOT NULL, ADD PRIMARY KEY (id);
ALTER TABLE video_source DROP COLUMN video_id;
ALTER TABLE video_source RENAME COLUMN new_video_id TO video_id;
ALTER TABLE video_source ALTER COLUMN video_id SET NOT NULL;
CREATE INDEX ix_video_source_video_id ON video_source (video_id);

-- 4. Rebuild the foreign keys and the (video_id, provider) uniqueness.
ALTER TABLE video ADD CONSTRAINT video_route_id_fkey
  FOREIGN KEY (route_id) REFERENCES route (id) ON DELETE SET NULL;
ALTER TABLE video_source ADD CONSTRAINT video_source_video_id_fkey
  FOREIGN KEY (video_id) REFERENCES video (id) ON DELETE CASCADE;
ALTER TABLE video_source ADD CONSTRAINT uq_video_source_provider UNIQUE (video_id, provider);

COMMIT;
