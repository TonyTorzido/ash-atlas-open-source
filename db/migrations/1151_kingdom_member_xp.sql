-- Kingdom XP from member activity: every XP point a member earns adds one kingdom
-- XP, at most 23,000 per kingdom per UTC day. The level rises when lifetime
-- XP crosses a threshold and never falls. Advancement projects are retired.
--
-- kingdom_member_xp_days is the per-kingdom, per-UTC-day counter that
-- enforces the cap. The server credits it with one atomic upsert per XP
-- grant (inside the grant's own transaction, after the grant's replay
-- check), so a replayed grant never credits twice and concurrent members
-- can never push credited_xp past the cap. earned_xp keeps the uncapped
-- total for the day. kingdom_xp_ledger gets one 'member_xp' row only when
-- member XP raises the kingdom's level, so the append-only ledger stays small.

CREATE TABLE IF NOT EXISTS kingdom_member_xp_days (
  kingdom_id uuid NOT NULL REFERENCES kingdoms(id) ON DELETE RESTRICT,
  xp_day date NOT NULL,
  earned_xp bigint NOT NULL,
  credited_xp integer NOT NULL,
  -- What the latest upsert added to credited_xp (read back by that grant).
  last_credited_xp integer NOT NULL,
  grant_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kingdom_id, xp_day),
  CONSTRAINT kingdom_member_xp_days_amounts_valid CHECK (
    earned_xp >= 0
    AND credited_xp BETWEEN 0 AND 23000
    AND credited_xp <= earned_xp
    AND last_credited_xp BETWEEN 0 AND credited_xp
    AND grant_count > 0
  )
);

ALTER TABLE kingdom_xp_ledger DROP CONSTRAINT IF EXISTS kingdom_xp_ledger_source_valid;
ALTER TABLE kingdom_xp_ledger
  ADD CONSTRAINT kingdom_xp_ledger_source_valid CHECK (
    source_type IN ('donation', 'construction', 'development', 'advancement_project', 'member_xp')
  );

-- Retire advancement projects: refund every pending project in full to the
-- treasury, exactly like a leader's cancel (kingdom_treasury_expenditures
-- 'refund' / 'project_cancel' rows), then mark it cancelled. Idempotent: a
-- second run finds no pending project.
SELECT id FROM kingdom_projects
WHERE project_type = 'advancement' AND status = 'pending'
ORDER BY id
FOR UPDATE;

CREATE TEMP TABLE kingdom_project_retirement_1111 ON COMMIT DROP AS
SELECT p.id AS project_id,
       p.kingdom_id,
       p.actor_player_id,
       p.target_level,
       line->>'resourceType' AS resource_type,
       COALESCE(line->>'variant', 'default') AS variant,
       (line->>'quantity')::bigint AS quantity,
       NULL::bigint AS balance_before
FROM kingdom_projects p
CROSS JOIN LATERAL jsonb_array_elements(p.cost_snapshot) AS line
WHERE p.project_type = 'advancement' AND p.status = 'pending'
  AND (line->>'quantity')::bigint > 0;

INSERT INTO kingdom_treasury_balances (kingdom_id, resource_type, variant, quantity)
SELECT DISTINCT kingdom_id, resource_type, variant, 0 FROM kingdom_project_retirement_1111
ON CONFLICT (kingdom_id, resource_type, variant) DO NOTHING;

SELECT b.kingdom_id FROM kingdom_treasury_balances b
JOIN kingdom_project_retirement_1111 r
  ON r.kingdom_id = b.kingdom_id AND r.resource_type = b.resource_type AND r.variant = b.variant
ORDER BY b.kingdom_id, b.resource_type, b.variant
FOR UPDATE OF b;

UPDATE kingdom_project_retirement_1111 r
SET balance_before = b.quantity
FROM kingdom_treasury_balances b
WHERE b.kingdom_id = r.kingdom_id AND b.resource_type = r.resource_type AND b.variant = r.variant;

UPDATE kingdom_treasury_balances b
SET quantity = b.quantity + r.quantity, updated_at = now()
FROM kingdom_project_retirement_1111 r
WHERE b.kingdom_id = r.kingdom_id AND b.resource_type = r.resource_type AND b.variant = r.variant;

INSERT INTO kingdom_treasury_expenditures (
  id, kingdom_id, project_id, actor_player_id, resource_type, variant,
  direction, quantity, balance_before, balance_after, source_type, request_id, metadata
)
SELECT gen_random_uuid(), r.kingdom_id, r.project_id, r.actor_player_id, r.resource_type, r.variant,
       'refund', r.quantity, r.balance_before, r.balance_before + r.quantity, 'project_cancel',
       'kingdom-advancement-retired-1151:' || r.project_id::text,
       jsonb_build_object('projectName', CASE r.target_level WHEN 2 THEN 'Raise the Standard' WHEN 3 THEN 'Fortify the Seat' WHEN 4 THEN 'Build the Great Hall' WHEN 5 THEN 'Crown the Realm' WHEN 6 THEN 'Raise the Banner of Ages' ELSE 'Advancement project' END,
                          'targetLevel', r.target_level, 'reason', 'advancement_retired')
FROM kingdom_project_retirement_1111 r;

INSERT INTO kingdom_audit_events (
  id, kingdom_id, actor_player_id, target_player_id, event_type, entity_type, entity_id, metadata
)
SELECT gen_random_uuid(), p.kingdom_id, NULL, NULL, 'advancement_project_cancelled', 'project', p.id,
       jsonb_build_object('projectName', CASE p.target_level WHEN 2 THEN 'Raise the Standard' WHEN 3 THEN 'Fortify the Seat' WHEN 4 THEN 'Build the Great Hall' WHEN 5 THEN 'Crown the Realm' WHEN 6 THEN 'Raise the Banner of Ages' ELSE 'Advancement project' END,
                          'targetLevel', p.target_level, 'reason', 'advancement_retired')
FROM kingdom_projects p
WHERE p.project_type = 'advancement' AND p.status = 'pending';

UPDATE kingdom_projects
SET status = 'cancelled', cancelled_at = now()
WHERE project_type = 'advancement' AND status = 'pending';

COMMENT ON TABLE kingdom_member_xp_days IS
  'Member XP credited to each kingdom per UTC day (capped at 23,000); one atomic upsert per XP grant.';
