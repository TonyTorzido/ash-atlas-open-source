CREATE TABLE IF NOT EXISTS flag_resource_visions (
  flag_id uuid PRIMARY KEY REFERENCES flags(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending', 'generating', 'ready', 'failed')),
  radius_m double precision NOT NULL,
  node_count integer NOT NULL DEFAULT 0,
  water_highlight_count integer NOT NULL DEFAULT 0,
  requested_at timestamptz NOT NULL DEFAULT now(),
  generated_at timestamptz NULL,
  last_error text NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS flag_resource_visions_status_idx
  ON flag_resource_visions (status);

DROP TRIGGER IF EXISTS flag_resource_visions_set_updated_at ON flag_resource_visions;
CREATE TRIGGER flag_resource_visions_set_updated_at
BEFORE UPDATE ON flag_resource_visions
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
