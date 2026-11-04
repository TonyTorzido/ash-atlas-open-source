-- Replace flag-bound Travel Invites with server-authoritative gameplay-layer anchors.

ALTER TABLE travel_invites
  ADD COLUMN IF NOT EXISTS layer_scope_id text,
  ADD COLUMN IF NOT EXISTS layer_id text,
  ADD COLUMN IF NOT EXISTS layer_relocation_revision bigint,
  ADD COLUMN IF NOT EXISTS layer_generation bigint,
  ADD COLUMN IF NOT EXISTS source_type text,
  ADD COLUMN IF NOT EXISTS source_id text;

UPDATE travel_invites
SET layer_scope_id = COALESCE(layer_scope_id, 'world'),
    layer_id = COALESCE(layer_id, 'flag:' || source_flag_id::text),
    layer_relocation_revision = COALESCE(layer_relocation_revision, 0),
    layer_generation = COALESCE(layer_generation, 0),
    source_type = COALESCE(source_type, 'flag'),
    source_id = COALESCE(source_id, source_flag_id::text);

UPDATE travel_invites
SET status = 'invalidated',
    invalidation_reason = 'The inviter gameplay layer must be reconfirmed.',
    responded_at = now()
WHERE status IN ('pending', 'accepting')
  AND layer_relocation_revision = 0
  AND layer_generation = 0;

ALTER TABLE travel_invites
  ALTER COLUMN source_flag_id DROP NOT NULL,
  ALTER COLUMN layer_scope_id SET NOT NULL,
  ALTER COLUMN layer_id SET NOT NULL,
  ALTER COLUMN layer_relocation_revision SET NOT NULL,
  ALTER COLUMN layer_generation SET NOT NULL,
  ALTER COLUMN source_type SET NOT NULL,
  ADD CONSTRAINT travel_invites_layer_scope_check
    CHECK (length(layer_scope_id) BETWEEN 1 AND 64),
  ADD CONSTRAINT travel_invites_layer_id_check
    CHECK (length(layer_id) BETWEEN 1 AND 200),
  ADD CONSTRAINT travel_invites_layer_revision_check
    CHECK (layer_relocation_revision >= 0 AND layer_generation >= 0),
  ADD CONSTRAINT travel_invites_source_type_check
    CHECK (length(source_type) BETWEEN 1 AND 32),
  ADD CONSTRAINT travel_invites_source_id_check
    CHECK (source_id IS NULL OR length(source_id) BETWEEN 1 AND 160);

DROP INDEX IF EXISTS travel_invites_inviter_session_pending_idx;
CREATE INDEX IF NOT EXISTS travel_invites_inviter_anchor_pending_idx
  ON travel_invites (
    inviter_player_id, inviter_session_id, layer_scope_id, layer_id,
    layer_relocation_revision, layer_generation, id
  )
  WHERE status IN ('pending', 'accepting');

COMMENT ON TABLE travel_invites IS
  'Single-recipient, single-use, session-bound permission to travel to a server-authoritative gameplay-layer anchor.';
COMMENT ON COLUMN travel_invites.source_flag_id IS
  'Legacy optional flag diagnostic retained for compatibility; travel authority uses the layer anchor columns.';
