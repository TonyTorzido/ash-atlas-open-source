-- Hollin Huts: durable hut placements and per-player standing (trade bans / anger).
-- Hut combat bodies, guards and farmers are projected from these rows at startup; orchard
-- trees are ordinary developer_spawned_plants rows with plant_key 'hollin_orchard_tree'.
CREATE TABLE hollin_huts (
  hut_id text PRIMARY KEY,
  creator_player_id text NULL REFERENCES players(id) ON DELETE SET NULL,
  request_id text NOT NULL,
  region_code text NOT NULL,
  zone_id text NOT NULL,
  lat double precision NOT NULL CHECK (lat >= -90 AND lat <= 90),
  lon double precision NOT NULL CHECK (lon >= -180 AND lon <= 180),
  state text NOT NULL DEFAULT 'standing' CHECK (state IN ('standing', 'destroyed')),
  life integer NOT NULL DEFAULT 0 CHECK (life >= 0),
  respawn_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (creator_player_id, request_id),
  CHECK ((state = 'destroyed') = (respawn_at IS NOT NULL))
);

CREATE TABLE hollin_hut_player_standing (
  hut_id text NOT NULL REFERENCES hollin_huts(hut_id) ON DELETE CASCADE,
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  trade_banned_until timestamptz NULL,
  ban_reason text NULL CHECK (ban_reason IN ('orchard', 'raid')),
  angry_until timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hut_id, player_id),
  CHECK ((trade_banned_until IS NULL) = (ban_reason IS NULL))
);
