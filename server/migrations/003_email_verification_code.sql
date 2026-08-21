-- ============================================================================
-- 003_email_verification_code.sql — email activation via 6-digit secret code
--
-- Adds (idempotent, safe to re-run):
--   * "user".verification_code_hash    VARCHAR(128)  NULL
--   * "user".verification_code_expires TIMESTAMPTZ   NULL
--
-- The columns back app/verification.py: a SHA-256-hashed 6-digit code with a
-- 10-minute expiry. Accounts stay locked (no JWT login) until the code is
-- confirmed, which flips is_verified and clears both columns.
--
-- Usage — ECS (cluster on 5432):
--   sudo -u postgres psql -v ON_ERROR_STOP=1 -d drone_navigation \
--        -f 003_email_verification_code.sql
-- ============================================================================

ALTER TABLE "user" ADD COLUMN IF NOT EXISTS verification_code_hash VARCHAR(128);
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS verification_code_expires TIMESTAMP WITH TIME ZONE;
