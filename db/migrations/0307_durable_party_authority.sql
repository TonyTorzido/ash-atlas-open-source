-- Durable explicit party membership. Parties are never inferred from kingdom,
-- region, proximity, or combat participation.

CREATE TABLE IF NOT EXISTS parties (
  party_id text PRIMARY KEY CHECK (length(party_id) BETWEEN 1 AND 200),
  leader_player_id text NOT NULL CHECK (length(leader_player_id) BETWEEN 1 AND 160),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS party_members (
  party_id text NOT NULL REFERENCES parties(party_id) ON DELETE CASCADE,
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT party_members_party_player_key PRIMARY KEY (party_id, player_id),
  CONSTRAINT party_members_one_party_per_player_key UNIQUE (player_id)
);

ALTER TABLE parties
  DROP CONSTRAINT IF EXISTS party_leader_membership_fk;
ALTER TABLE parties
  ADD CONSTRAINT party_leader_membership_fk
  FOREIGN KEY (party_id, leader_player_id)
  REFERENCES party_members(party_id, player_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION maintain_party_after_member_delete() RETURNS trigger AS $$
DECLARE
  current_leader text;
  successor text;
BEGIN
  SELECT leader_player_id INTO current_leader
  FROM parties
  WHERE party_id = OLD.party_id
  FOR UPDATE;

  -- Parent-party cascades have already made the party nonexistent here.
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
      SET leader_player_id = successor, revision = revision + 1
      WHERE party_id = OLD.party_id;
    END IF;
  ELSE
    UPDATE parties
    SET revision = revision + 1
    WHERE party_id = OLD.party_id;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS party_members_maintain_party_after_delete ON party_members;
CREATE TRIGGER party_members_maintain_party_after_delete
AFTER DELETE ON party_members
FOR EACH ROW EXECUTE FUNCTION maintain_party_after_member_delete();

DROP TRIGGER IF EXISTS parties_set_updated_at ON parties;
CREATE TRIGGER parties_set_updated_at
BEFORE UPDATE ON parties
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS party_members_party_idx ON party_members (party_id, player_id);

COMMENT ON TABLE parties IS
  'Persistent explicit party authority; never derive membership from kingdom, region, proximity, or combat state.';
COMMENT ON TABLE party_members IS
  'One authoritative party membership per player, shared by realtime commands and combat targeting.';
