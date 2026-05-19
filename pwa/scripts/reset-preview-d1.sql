-- Wipe the preview D1 between CI runs so PR-A's seeded test data isn't
-- visible to PR-B. Tables are recreated on first request to /api/community/*
-- via ensureCommunitySchema() in functions/api/community/_shared.ts (it uses
-- CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS, so dropping is
-- safe — there's no migration to re-run). If you add a new table to that
-- helper, drop it here too.
--
-- See pwa/wrangler.jsonc env.preview block and the "Reset preview D1" step
-- in .github/workflows/deploy.yml.
DROP TABLE IF EXISTS community_sites;
DROP TABLE IF EXISTS area_incident_cache;
