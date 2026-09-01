-- 011_mesh_category.sql
-- Public Component shelf for published 3D assets (Content -> 3D Asset).
--
-- mesh.category is one of the twelve fixed Public Component category ids
-- (vehicle/ship/plane/architecture/sculpture/human/animal/vegetation/
-- equipment/water/fire/cloud). It is auto-suggested by the LLM classifier
-- (chat_engine.classify_asset) when the owner publishes an asset
-- (visibility -> 'public') and stays manually overridable; NULL means
-- "not classified".
--
-- NOTE: the app's lifespan also runs Base.metadata.create_all, but
-- create_all never ALTERs an existing table — on a database that already
-- has `mesh` (010_meshes.sql) this ALTER must be applied by hand. On
-- production the app's DB role lacks CREATE privilege — apply this as the
-- postgres superuser (same procedure as 010_meshes.sql).

ALTER TABLE mesh ADD COLUMN IF NOT EXISTS category VARCHAR(16);
