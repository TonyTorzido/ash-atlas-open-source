-- Make public.flags restorable by pg_restore.
--
-- pg_dump / pg_restore run with an empty search_path. pg_dump writes the
-- flags_health_valid CHECK as public.flag_warfare_maximum_health(...), but it
-- cannot rewrite SQL function bodies, and the flag_warfare_maximum_health
-- overloads called one another unqualified (9 args -> 8 -> 7, 6 -> 7). Every
-- COPY row into flags evaluated the CHECK, the inner call failed to resolve,
-- the whole flags table was skipped, and every foreign key to flags failed
-- after it. That broke the careful deploy's populated-clone rehearsal and any
-- restore of a production backup.
--
-- The overloads that call another overload are re-created with the call
-- schema-qualified; logic, volatility and results are unchanged. The
-- seven-argument overload calls only built-ins and stays as 0921 wrote it.
-- No table is altered, so no lock is taken on flags.
--
-- The bodies are qualified rather than given SET search_path: a SET clause
-- stops PostgreSQL inlining these SQL functions, which measured ~400x slower
-- per call (about 40 us vs 0.1 us), paid by every flags insert and update
-- through flags_health_valid and the health trigger.
--
-- The other user functions behind CHECK constraints, generated columns and
-- index expressions (city_structure_warfare_maximum_health,
-- population_permanent_mine_kind_v1, auth_canonical_email) call only
-- pg_catalog built-ins, which resolve under an empty search_path.

-- The phase-1 six-argument form stays callable and means "not upgraded".
CREATE OR REPLACE FUNCTION public.flag_warfare_maximum_health(
  p_anchor_kind text,
  p_control_type text,
  p_system_controlled boolean,
  p_city_id uuid,
  p_kingdom_id uuid,
  p_reinforcement_level smallint
) RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT public.flag_warfare_maximum_health(
    p_anchor_kind, p_control_type, p_system_controlled,
    p_city_id, p_kingdom_id, p_reinforcement_level, NULL::smallint
  )
$$;

CREATE OR REPLACE FUNCTION public.flag_warfare_maximum_health(
  p_anchor_kind text,
  p_control_type text,
  p_system_controlled boolean,
  p_city_id uuid,
  p_kingdom_id uuid,
  p_reinforcement_level smallint,
  p_tower_level smallint,
  p_obelisk_level smallint
) RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_obelisk_level IS NULL THEN public.flag_warfare_maximum_health(
      p_anchor_kind, p_control_type, p_system_controlled,
      p_city_id, p_kingdom_id, p_reinforcement_level, p_tower_level
    )
    WHEN p_anchor_kind IS DISTINCT FROM 'flag' OR p_system_controlled THEN NULL
    WHEN p_control_type = 'kingdom' AND p_kingdom_id IS NOT NULL AND p_city_id IS NULL
      AND p_tower_level IS NULL AND p_obelisk_level BETWEEN 1 AND 5
      THEN 2300 * p_obelisk_level
    ELSE NULL
  END
$$;

CREATE OR REPLACE FUNCTION public.flag_warfare_maximum_health(
  p_anchor_kind text,
  p_control_type text,
  p_system_controlled boolean,
  p_city_id uuid,
  p_kingdom_id uuid,
  p_reinforcement_level smallint,
  p_tower_level smallint,
  p_obelisk_level smallint,
  p_war_structure_kind text
) RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_war_structure_kind IS NULL THEN public.flag_warfare_maximum_health(
      p_anchor_kind, p_control_type, p_system_controlled,
      p_city_id, p_kingdom_id, p_reinforcement_level, p_tower_level, p_obelisk_level
    )
    WHEN p_anchor_kind IS DISTINCT FROM 'flag' OR p_system_controlled
      OR p_control_type IS DISTINCT FROM 'kingdom' OR p_kingdom_id IS NULL
      OR p_city_id IS NOT NULL OR p_obelisk_level IS NOT NULL THEN NULL
    WHEN p_war_structure_kind = 'war_tower' AND p_tower_level = 1 THEN 11500
    WHEN p_war_structure_kind = 'war_outpost' AND p_tower_level IS NULL THEN 2200
    ELSE NULL
  END
$$;
