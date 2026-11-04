-- Stable party roster identity for the combat HUD. Slots change only when
-- membership changes; ordinary party settings continue to use revision.

ALTER TABLE parties
  ADD COLUMN IF NOT EXISTS membership_revision bigint;

UPDATE parties
SET membership_revision = revision
WHERE membership_revision IS NULL;

ALTER TABLE parties
  ALTER COLUMN membership_revision SET DEFAULT 1,
  ALTER COLUMN membership_revision SET NOT NULL;

ALTER TABLE parties
  DROP CONSTRAINT IF EXISTS parties_membership_revision_check;
ALTER TABLE parties
  ADD CONSTRAINT parties_membership_revision_check
  CHECK (membership_revision >= 1);

ALTER TABLE party_members
  ADD COLUMN IF NOT EXISTS slot_index smallint;

WITH ranked_members AS (
  SELECT
    party_id,
    player_id,
    (row_number() OVER (
      PARTITION BY party_id
      ORDER BY joined_at, player_id
    ) - 1)::smallint AS slot_index
  FROM party_members
)
UPDATE party_members member
SET slot_index = ranked.slot_index
FROM ranked_members ranked
WHERE member.party_id = ranked.party_id
  AND member.player_id = ranked.player_id
  AND member.slot_index IS NULL;

ALTER TABLE party_members
  ALTER COLUMN slot_index SET NOT NULL;

ALTER TABLE party_members
  DROP CONSTRAINT IF EXISTS party_members_slot_index_check;
ALTER TABLE party_members
  ADD CONSTRAINT party_members_slot_index_check
  CHECK (slot_index BETWEEN 0 AND 4);

CREATE UNIQUE INDEX IF NOT EXISTS party_members_party_slot_key
  ON party_members (party_id, slot_index);

CREATE OR REPLACE FUNCTION maintain_party_after_member_delete() RETURNS trigger AS $$
DECLARE
  current_leader text;
  successor text;
BEGIN
  SELECT leader_player_id INTO current_leader
  FROM parties
  WHERE party_id = OLD.party_id
  FOR UPDATE;

  IF current_leader IS NULL THEN
    RETURN OLD;
  END IF;

  IF current_leader = OLD.player_id THEN
    SELECT min(player_id) INTO successor
    FROM party_members
    WHERE party_id = OLD.party_id;

    IF successor IS NULL THEN
      DELETE FROM parties WHERE party_id = OLD.party_id;
    ELSE
      UPDATE parties
      SET leader_player_id = successor,
          revision = revision + 1,
          membership_revision = membership_revision + 1
      WHERE party_id = OLD.party_id;
    END IF;
  ELSE
    UPDATE parties
    SET revision = revision + 1,
        membership_revision = membership_revision + 1
    WHERE party_id = OLD.party_id;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
