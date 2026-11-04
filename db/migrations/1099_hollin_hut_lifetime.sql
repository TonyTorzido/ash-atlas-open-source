-- Hollin Huts are rare, week-long landmarks (owner decision 2026-10-05). A population hut stands
-- until expires_at (6-8 days after it was adopted, chosen by the server per hut id), even after its
-- Population V2 generation is cleaned up; then it despawns. Developer huts never expire (NULL).
ALTER TABLE hollin_huts ADD COLUMN IF NOT EXISTS expires_at timestamptz NULL;

-- Existing population huts get a deterministic lifetime of 6 days plus 0-48 hours from created_at.
UPDATE hollin_huts
   SET expires_at = created_at + interval '6 days'
       + ((('x' || substr(md5(hut_id), 1, 8))::bit(32)::bigint % 2881) * interval '1 minute')
 WHERE source = 'population' AND expires_at IS NULL;

ALTER TABLE hollin_huts DROP CONSTRAINT IF EXISTS hollin_huts_expiry_source_check;
ALTER TABLE hollin_huts ADD CONSTRAINT hollin_huts_expiry_source_check
  CHECK ((source = 'population') = (expires_at IS NOT NULL));
