-- 008_route_description.sql
-- Adds the owner-editable description text to saved routes (the
-- Route Planning -> Route panel edits it alongside the title).
-- Production: apply as the postgres superuser (the app role only needs
-- DML, which it already holds on the route table — new columns inherit
-- the table grants).

ALTER TABLE route ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
