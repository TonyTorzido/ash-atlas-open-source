-- Read-only Resin Crawler anchor planning/materialization audit.
-- Run with psql against the intended database.

WITH selected AS (
  SELECT cutover.zone_id, plan.plan_id, plan.spawn_rules_version,
         plan.habitat_snapshot, plan.habitat_summary,
         plan.nonstone_template_slots
  FROM population_zone_cutovers_v2 AS cutover
  JOIN population_zones_v2 AS plan
    ON plan.plan_id=cutover.selected_plan_id
   AND plan.zone_id=cutover.zone_id
  WHERE cutover.serving_version='v2'
    AND cutover.status='stable'
), planned AS (
  SELECT selected.*,
         COALESCE(
           (selected.habitat_snapshot->>'eligibleLandKm2')::numeric,
           0
         ) AS eligible_land_km2,
         COALESCE((
           selected.habitat_summary #>>
             '{sapCrawlerPlanning,desiredAnchorGroups}'
         )::int, round(
           COALESCE(
             (selected.habitat_snapshot->>'eligibleLandKm2')::numeric,
             0
           ) / 8
         )::int) AS desired_anchor_groups,
         COALESCE((
           selected.habitat_summary #>>
             '{sapCrawlerPlanning,noValidAnchorCandidates}'
         )::int, 0) AS no_valid_anchor_count,
         COALESCE((
           selected.habitat_summary #>>
             '{sapCrawlerPlanning,anchorPlacementShortfallGroups}'
         )::int, 0) AS anchor_placement_shortfall,
         count(DISTINCT slot->>'candidateId') FILTER (
           WHERE slot->>'entityKind'='sap_crawler'
         ) AS template_group_count
  FROM selected
  LEFT JOIN LATERAL jsonb_array_elements(
    selected.nonstone_template_slots
  ) AS slot ON true
  GROUP BY selected.zone_id, selected.plan_id,
           selected.spawn_rules_version, selected.habitat_snapshot,
           selected.habitat_summary, selected.nonstone_template_slots
), generated AS (
  SELECT planned.*, generation.generation_id,
         generation.current_reference_count,
         generation.materialization_revision,
         count(DISTINCT slot.pack_id) FILTER (
           WHERE slot.entity_kind='sap_crawler'
         ) AS generated_group_count,
         count(*) FILTER (
           WHERE slot.entity_kind='sap_crawler'
         ) AS generated_body_count,
         count(*) FILTER (
           WHERE slot.entity_kind='sap_crawler' AND state.state='ready'
         ) AS ready_body_count,
         count(*) FILTER (
           WHERE slot.entity_kind='sap_crawler'
             AND state.state='ready'
             AND lease.lease_expires_at > clock_timestamp()
         ) AS leased_body_count,
         count(*) FILTER (
           WHERE slot.entity_kind='ogre'
         ) AS generated_ogre_count
  FROM planned
  LEFT JOIN population_zone_generations_v2 AS generation
    ON generation.zone_id=planned.zone_id
   AND generation.plan_id=planned.plan_id
   AND generation.is_current
  LEFT JOIN population_spawn_slots_v2 AS slot
    ON slot.generation_id=generation.generation_id
  LEFT JOIN population_entity_state_v2 AS state
    ON state.entity_id=slot.entity_id
  LEFT JOIN population_runtime_entity_leases_v2 AS lease
    ON lease.entity_id=slot.entity_id
  GROUP BY planned.zone_id, planned.plan_id,
           planned.spawn_rules_version, planned.habitat_snapshot,
           planned.habitat_summary, planned.nonstone_template_slots,
           planned.eligible_land_km2, planned.desired_anchor_groups,
           planned.no_valid_anchor_count,
           planned.anchor_placement_shortfall,
           planned.template_group_count, generation.generation_id,
           generation.current_reference_count,
           generation.materialization_revision
)
SELECT spawn_rules_version,
       count(*) AS selected_zones,
       round(sum(eligible_land_km2), 2) AS eligible_land_km2,
       round(sum(eligible_land_km2) / 8, 2) AS target_sap_groups,
       sum(desired_anchor_groups) AS desired_anchor_groups,
       sum(no_valid_anchor_count) AS no_valid_anchor_count,
       sum(anchor_placement_shortfall) AS anchor_placement_shortfall,
       sum(template_group_count) AS template_group_count,
       sum(generated_group_count) AS generated_group_count,
       sum(generated_body_count) AS generated_body_count,
       sum(ready_body_count) AS ready_body_count,
       sum(leased_body_count) AS leased_body_count,
       count(*) FILTER (
         WHERE current_reference_count > 0 AND generated_group_count > 0
       ) AS referenced_zones_with_sap,
       round(
         sum(generated_ogre_count)::numeric
           / NULLIF(sum(generated_group_count), 0),
         2
       ) AS ogre_to_sap_ratio,
       string_agg(
         DISTINCT COALESCE(materialization_revision, 'legacy-unverified'),
         ', ' ORDER BY COALESCE(
           materialization_revision,
           'legacy-unverified'
         )
       ) AS materialization_revisions
FROM generated
GROUP BY spawn_rules_version
ORDER BY spawn_rules_version;

WITH current_sap AS (
  SELECT generation.zone_id, generation.generation_id,
         generation.current_reference_count,
         generation.materialization_revision,
         slot.pack_id, count(*) AS body_count,
         count(*) FILTER (WHERE state.state='ready') AS ready_count,
         count(*) FILTER (
           WHERE state.state='ready'
             AND lease.lease_expires_at > clock_timestamp()
         ) AS leased_count
  FROM population_zone_generations_v2 AS generation
  JOIN population_spawn_slots_v2 AS slot
    ON slot.generation_id=generation.generation_id
   AND slot.entity_kind='sap_crawler'
  JOIN population_entity_state_v2 AS state
    ON state.entity_id=slot.entity_id
  LEFT JOIN population_runtime_entity_leases_v2 AS lease
    ON lease.entity_id=slot.entity_id
  WHERE generation.is_current
  GROUP BY generation.zone_id, generation.generation_id,
           generation.current_reference_count,
           generation.materialization_revision, slot.pack_id
)
SELECT zone_id, generation_id, materialization_revision, pack_id,
       body_count, ready_count, leased_count,
       CASE
         WHEN body_count NOT BETWEEN 5 AND 7
           THEN 'incomplete persisted Resin Crawler group'
         WHEN current_reference_count > 0
           AND ready_count > leased_count
           THEN 'ready bodies in referenced zone are not fully leased'
         ELSE 'ok'
       END AS audit_status
FROM current_sap
WHERE body_count NOT BETWEEN 5 AND 7
   OR (
     current_reference_count > 0
     AND ready_count > leased_count
   )
ORDER BY zone_id, pack_id;
