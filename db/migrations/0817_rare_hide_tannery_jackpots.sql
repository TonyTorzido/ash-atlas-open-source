-- Rare hides remain optional collectible/player-market items. This forward
-- constraint widens only the durable Tannery output bound for the jackpot
-- recipes; existing jobs and their collected quantities are unchanged.
ALTER TABLE tannery_jobs
  DROP CONSTRAINT IF EXISTS tannery_jobs_output_quantity_check;

ALTER TABLE tannery_jobs
  ADD CONSTRAINT tannery_jobs_output_quantity_check
  CHECK (output_quantity BETWEEN 1 AND 30000);
