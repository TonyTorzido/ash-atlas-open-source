CREATE INDEX IF NOT EXISTS kingdom_invitations_pending_expiry_idx
  ON kingdom_invitations (expires_at, id)
  WHERE status = 'pending';

-- The database catalog is authoritative. Reassert the 1.0 definitions without
-- changing stable type identifiers or rewriting existing decoration history.
INSERT INTO kingdom_decoration_definitions (
  type_id, display_name, footprint_radius_m, ownership_type, required_kingdom_level,
  capacity_cost, future_material_cost, intended_construction_seconds,
  members_may_place, officers_only, active, rules_version
) VALUES
  ('banner', 'Banner', 2, 'choice', 1, 1, '[{"resourceType":"wood","quantity":5}]', 30, true, false, true, 1),
  ('campfire', 'Campfire', 3, 'choice', 1, 2, '[{"resourceType":"wood","quantity":8},{"resourceType":"stone","quantity":4}]', 45, true, false, true, 1),
  ('table', 'Table', 2.5, 'personal', 1, 2, '[{"resourceType":"wood","quantity":10}]', 60, true, false, true, 1),
  ('crate', 'Supply Crate', 2, 'choice', 1, 1, '[{"resourceType":"wood","quantity":6}]', 30, true, false, true, 1),
  ('training_post', 'Training Post', 3, 'kingdom', 3, 3, '[{"resourceType":"wood","quantity":12},{"resourceType":"stone","quantity":6}]', 90, false, true, true, 1)
ON CONFLICT (type_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  footprint_radius_m = EXCLUDED.footprint_radius_m,
  ownership_type = EXCLUDED.ownership_type,
  required_kingdom_level = EXCLUDED.required_kingdom_level,
  capacity_cost = EXCLUDED.capacity_cost,
  future_material_cost = EXCLUDED.future_material_cost,
  intended_construction_seconds = EXCLUDED.intended_construction_seconds,
  members_may_place = EXCLUDED.members_may_place,
  officers_only = EXCLUDED.officers_only,
  active = EXCLUDED.active,
  rules_version = EXCLUDED.rules_version;
