-- ============================================================================
-- 004_user_avatar.sql — profile picture (data-URI) on the user table
--
-- Adds (idempotent, safe to re-run):
--   * "user".avatar  TEXT  NULL
--
-- The SPA downscales the chosen image to 128x128 JPEG and stores it as a
-- data-URI (~10-20 KB). NULL means "no avatar uploaded; use default icon".
--
-- Usage — ECS (cluster on 5432):
--   sudo -u postgres psql -v ON_ERROR_STOP=1 -d drone_navigation \
--        -f 004_user_avatar.sql
-- ============================================================================

ALTER TABLE "user" ADD COLUMN IF NOT EXISTS avatar TEXT;
