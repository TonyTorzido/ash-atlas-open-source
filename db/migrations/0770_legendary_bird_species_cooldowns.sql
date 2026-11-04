CREATE TABLE IF NOT EXISTS legendary_bird_species_cooldowns (
  bird_species text PRIMARY KEY CHECK (bird_species IN ('fire', 'lightning', 'ice')),
  last_activated_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL,
  CHECK (available_at = last_activated_at + interval '24 hours')
);

INSERT INTO legendary_bird_species_cooldowns (
  bird_species,last_activated_at,available_at
)
SELECT bird_species,max(activated_at),max(activated_at) + interval '24 hours'
FROM legendary_bird_events
WHERE activated_at IS NOT NULL
GROUP BY bird_species
ON CONFLICT (bird_species) DO UPDATE SET
  last_activated_at=GREATEST(
    legendary_bird_species_cooldowns.last_activated_at,
    EXCLUDED.last_activated_at
  ),
  available_at=GREATEST(
    legendary_bird_species_cooldowns.available_at,
    EXCLUDED.available_at
  );

COMMENT ON TABLE legendary_bird_species_cooldowns IS
  'Durable per-species activation cooldown authority, independent of flag and event retention.';
