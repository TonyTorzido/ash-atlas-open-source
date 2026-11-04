-- Persist the player's last fishing control intent so each server step can
-- integrate the action that was actually held during the preceding interval.
-- New and existing encounters start neutral until the first control arrives.
ALTER TABLE fishing_encounters
  ADD COLUMN IF NOT EXISTS control_direction text NOT NULL DEFAULT 'neutral'
    CHECK (control_direction IN ('left','right','neutral')),
  ADD COLUMN IF NOT EXISTS control_reeling boolean NOT NULL DEFAULT false;
