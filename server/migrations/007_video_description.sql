-- 007_video_description.sql
-- Adds the owner-editable description text to published videos (the
-- Content -> Route -> Video dialog edits it alongside the title).
-- Production: apply as the postgres superuser (the app role only needs
-- DML, which it already holds on the video table — new columns inherit
-- the table grants).

ALTER TABLE video ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
