ALTER TABLE player_inventory_capacities
  ADD COLUMN inventory_revision bigint NOT NULL DEFAULT 0
    CHECK (inventory_revision >= 0);

CREATE OR REPLACE FUNCTION advance_player_inventory_revision(target_player_id text)
RETURNS void AS $$
BEGIN
  INSERT INTO player_inventory_capacities (
    player_id,
    unlocked_slots,
    inventory_revision
  )
  VALUES (target_player_id, 16, 1)
  ON CONFLICT (player_id) DO UPDATE
  SET inventory_revision =
        player_inventory_capacities.inventory_revision + 1,
      updated_at = now();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION advance_resource_inventory_revision()
RETURNS trigger AS $$
BEGIN
  PERFORM advance_player_inventory_revision(
    CASE WHEN TG_OP = 'DELETE' THEN OLD.player_id ELSE NEW.player_id END
  );
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER player_inventory_slots_advance_revision
AFTER INSERT OR UPDATE OR DELETE ON player_inventory_slots
FOR EACH ROW
EXECUTE FUNCTION advance_resource_inventory_revision();

CREATE OR REPLACE FUNCTION advance_equipment_inventory_revision()
RETURNS trigger AS $$
DECLARE
  previous_player_id text;
  next_player_id text;
BEGIN
  previous_player_id := CASE
    WHEN TG_OP = 'INSERT' THEN NULL
    ELSE OLD.owner_player_id
  END;
  next_player_id := CASE
    WHEN TG_OP = 'DELETE' THEN NULL
    ELSE NEW.owner_player_id
  END;

  IF previous_player_id IS NOT NULL THEN
    PERFORM advance_player_inventory_revision(previous_player_id);
  END IF;
  IF next_player_id IS NOT NULL
     AND next_player_id IS DISTINCT FROM previous_player_id THEN
    PERFORM advance_player_inventory_revision(next_player_id);
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER equipment_instances_advance_inventory_revision
AFTER INSERT OR UPDATE OR DELETE ON equipment_instances
FOR EACH ROW
EXECUTE FUNCTION advance_equipment_inventory_revision();

CREATE OR REPLACE FUNCTION advance_inventory_capacity_revision()
RETURNS trigger AS $$
BEGIN
  IF NEW.unlocked_slots IS DISTINCT FROM OLD.unlocked_slots
     AND NEW.inventory_revision = OLD.inventory_revision THEN
    NEW.inventory_revision := OLD.inventory_revision + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER player_inventory_capacity_advance_revision
BEFORE UPDATE ON player_inventory_capacities
FOR EACH ROW
EXECUTE FUNCTION advance_inventory_capacity_revision();
