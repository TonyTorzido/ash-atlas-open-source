CREATE TABLE IF NOT EXISTS developer_spawned_dungeon_entrances (
  entrance_id TEXT PRIMARY KEY,
  creator_player_id TEXT NULL REFERENCES players(id) ON DELETE SET NULL,
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  template_id TEXT NOT NULL,
  template_revision TEXT NOT NULL,
  template_portal_revision TEXT NOT NULL,
  dungeon_revision TEXT NOT NULL,
  catalog_revision INTEGER NOT NULL CHECK (catalog_revision >= 1),
  placement_revision INTEGER NOT NULL DEFAULT 1 CHECK (placement_revision >= 1),
  region_code TEXT NOT NULL,
  spawn_lat DOUBLE PRECISION NOT NULL CHECK (spawn_lat BETWEEN -90 AND 90),
  spawn_lon DOUBLE PRECISION NOT NULL CHECK (spawn_lon BETWEEN -180 AND 180),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ NULL,
  UNIQUE (creator_player_id, request_id),
  CHECK (length(entrance_id) > 0),
  CHECK (length(template_id) > 0),
  CHECK (length(template_revision) > 0),
  CHECK (length(template_portal_revision) > 0),
  CHECK (length(dungeon_revision) > 0),
  CHECK (length(region_code) > 0)
);

CREATE INDEX IF NOT EXISTS developer_spawned_dungeon_entrances_active_idx
  ON developer_spawned_dungeon_entrances (created_at, entrance_id)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS developer_spawned_dungeon_entrance_deletions (
  actor_player_id TEXT NOT NULL,
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  entrance_id TEXT NOT NULL REFERENCES developer_spawned_dungeon_entrances(entrance_id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_player_id, request_id)
);

CREATE INDEX IF NOT EXISTS developer_spawned_dungeon_entrance_deletions_entrance_idx
  ON developer_spawned_dungeon_entrance_deletions (entrance_id, created_at);
