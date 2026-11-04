import { createHash } from "node:crypto";

import {
  INSPIRATION_BONUS_PERCENT,
  KINGDOM_BRICK_YIELD_CHANCE,
  KINGDOM_OBELISK_RADIUS_M,
  KINGDOM_PERK_SKYWARD_STONEWORK_RADIUS_M,
  KINGDOM_PERK_FAR_RENOWN_BRICK_BONUS,
  KINGDOM_PERK_HEARTH_GROUND_BRICK_BONUS_PER_UNIT,
  KINGDOM_PERK_GRAND_MASONRY_BRICK_BONUS,
  KINGDOM_PERK_PICKET_LINES_BRICK_MULTIPLIER,
  KINGDOM_PERK_BOUNDARY_WRIT_WAR_BRICK_CHANCE,
  kingdomBrickYieldQuantity,
  monolithHunterYield
} from "@ash-atlas/shared";
import type pg from "pg";

import { inspirationActive } from "./fieldConsumables.js";
import { monolithHunterQuantity } from "./monoliths.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

export type KingdomBrickYield = Readonly<{
  kingdomId: string;
  obeliskLevel: number | null;
  member: boolean;
  quantity: number;
  /** Combined kingdom perk multiplier applied to the base quantity (1 without perks). */
  perkMultiplier: number;
}>;

type LandPerkRow = Readonly<{
  member: boolean;
  qualified: boolean;
  picket_lines: boolean;
  grand_masonry: boolean;
  far_renown: boolean;
  hearth_ground: boolean;
  following_units: number | string;
}>;

/**
 * The land kingdom's perks for its own qualified members gathering on its
 * land: Picket Lines x2, Grand Masonry +12%, Far Renown +12%, and Hearth Ground
 * +4% per military unit following the member.
 */
export function kingdomBrickPerkMultiplier(row: LandPerkRow): number {
  if (!row.member || !row.qualified) return 1;
  const units = row.hearth_ground ? Math.max(0, Number(row.following_units) || 0) : 0;
  return (row.picket_lines ? KINGDOM_PERK_PICKET_LINES_BRICK_MULTIPLIER : 1) *
    (1 + (row.grand_masonry ? KINGDOM_PERK_GRAND_MASONRY_BRICK_BONUS : 0) +
      (row.far_renown ? KINGDOM_PERK_FAR_RENOWN_BRICK_BONUS : 0) +
      units * KINGDOM_PERK_HEARTH_GROUND_BRICK_BONUS_PER_UNIT);
}

/**
 * Boundary Writ: a qualified member of a kingdom with the perk rolls
 * 25% instead of 10% on the land of a kingdom their kingdom is at war with.
 */
export function kingdomBrickYieldChance(boundaryWritWarLand: boolean): number {
  return boundaryWritWarLand ? KINGDOM_PERK_BOUNDARY_WRIT_WAR_BRICK_CHANCE : KINGDOM_BRICK_YIELD_CHANCE;
}

/** Deterministic roll in [0, 1) for one gather or kill, so a retried settlement rolls the same. */
export function kingdomBrickYieldRoll(rollKey: string): number {
  const digest = createHash("sha256").update(`kingdom-brick-yield-v1:${rollKey}`).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

/**
 * Bricks earned by one completed gather or mob kill at `position`. The roll
 * is checked first, so the land / obelisk lookup only runs for the ~10% of
 * actions that can drop Bricks. "Kingdom land" is the claim of a standing
 * Kingdom Flag or Castle of an active kingdom; the strongest standing
 * obelisk of that kingdom within 550 m (900 m with Skyward Stonework) sets
 * the multiplier, and the kingdom's perks scale its members' yield. Read-only: no
 * locks are taken, so it is safe inside any reward transaction.
 */
export async function kingdomBrickYieldAt(
  queryable: Queryable,
  input: Readonly<{ playerId: string; position: Readonly<{ lat: number; lon: number }>; rollKey: string }>
): Promise<KingdomBrickYield | null> {
  const roll = kingdomBrickYieldRoll(input.rollKey);
  // The widest chance any row can have; the land lookup decides whether this roll really hits.
  if (roll >= KINGDOM_PERK_BOUNDARY_WRIT_WAR_BRICK_CHANCE) return null;
  if (!Number.isFinite(input.position.lat) || !Number.isFinite(input.position.lon)) return null;
  const result = await queryable.query<LandPerkRow & {
    kingdom_id: string;
    obelisk_level: number | null;
    boundary_writ_war_land: boolean;
  }>(
    `WITH point AS (
       SELECT ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography AS g
     ), land AS (
       SELECT DISTINCT f.kingdom_id
       FROM flags f
       JOIN kingdoms kingdom ON kingdom.id = f.kingdom_id AND kingdom.status = 'active'
       LEFT JOIN kingdom_seats seat
         ON f.control_type = 'kingdom_seat' AND seat.source_flag_id = f.id AND seat.status = 'active'
       CROSS JOIN point
       WHERE f.kingdom_id IS NOT NULL
         AND f.control_type IN ('kingdom', 'kingdom_seat')
         AND f.territory_collapse_id IS NULL
         AND ST_DWithin(
           COALESCE(seat.geom, f.geom)::geography,
           point.g,
           COALESCE(seat.territory_radius_m, f.claim_radius_m)
         )
     )
     , perks AS (
       SELECT land.kingdom_id,
              array_agg(perk.perk_id) FILTER (WHERE perk.perk_id IS NOT NULL) AS ids
       FROM land
       LEFT JOIN kingdom_perk_selections_in_effect perk ON perk.kingdom_id = land.kingdom_id
       GROUP BY land.kingdom_id
     ), membership AS (
       SELECT membership.kingdom_id, membership.perk_qualified_at <= now() AS qualified
       FROM kingdom_memberships membership
       WHERE membership.player_id = $4 AND membership.status = 'active'
     )
     SELECT land.kingdom_id::text,
            (SELECT max(obelisk.obelisk_level)
             FROM flags obelisk, point
             WHERE obelisk.kingdom_id = land.kingdom_id
               AND obelisk.obelisk_level IS NOT NULL
               AND obelisk.health > 0
               AND obelisk.territory_collapse_id IS NULL
               AND ST_DWithin(
                 obelisk.geom::geography,
                 point.g,
                 CASE WHEN 'skyward_stonework' = ANY(COALESCE(perks.ids, '{}')) THEN $5::float8 ELSE $3::float8 END
               )) AS obelisk_level,
            membership.kingdom_id IS NOT NULL AS member,
            COALESCE(membership.qualified, false) AS qualified,
            'picket_lines' = ANY(COALESCE(perks.ids, '{}')) AS picket_lines,
            'grand_masonry' = ANY(COALESCE(perks.ids, '{}')) AS grand_masonry,
            'far_renown' = ANY(COALESCE(perks.ids, '{}')) AS far_renown,
            'hearth_ground' = ANY(COALESCE(perks.ids, '{}')) AS hearth_ground,
            COALESCE(own.qualified AND own.kingdom_id <> land.kingdom_id AND EXISTS (
              SELECT 1 FROM kingdom_perk_selections_in_effect own_perk
              WHERE own_perk.kingdom_id = own.kingdom_id AND own_perk.perk_id = 'boundary_writ'
            ) AND EXISTS (
              SELECT 1 FROM organization_wars war
              WHERE war.status = 'active'
                AND ((war.side_a_kind = 'kingdom' AND war.side_a_id = own.kingdom_id
                      AND war.side_b_kind = 'kingdom' AND war.side_b_id = land.kingdom_id)
                  OR (war.side_b_kind = 'kingdom' AND war.side_b_id = own.kingdom_id
                      AND war.side_a_kind = 'kingdom' AND war.side_a_id = land.kingdom_id))
            ), false) AS boundary_writ_war_land,
            CASE WHEN membership.kingdom_id IS NOT NULL AND 'hearth_ground' = ANY(COALESCE(perks.ids, '{}')) THEN (
              SELECT count(*) FROM military_units unit
              JOIN military_unit_groups unit_group ON unit_group.group_id = unit.group_id
              WHERE unit_group.owner_player_id = $4
                AND unit_group.location_state = 'FOLLOWING_PLAYER'
                AND unit.status = 'available'
                AND unit.current_hp > 0
            ) ELSE 0 END AS following_units
     FROM land
     JOIN perks ON perks.kingdom_id = land.kingdom_id
     LEFT JOIN membership ON membership.kingdom_id = land.kingdom_id
     LEFT JOIN (
       SELECT kingdom_id, perk_qualified_at <= now() AS qualified
       FROM kingdom_memberships
       WHERE player_id = $4 AND status = 'active'
     ) own ON true
     ORDER BY obelisk_level DESC NULLS LAST, land.kingdom_id
     LIMIT 1`,
    [input.position.lat, input.position.lon, KINGDOM_OBELISK_RADIUS_M, input.playerId,
      KINGDOM_PERK_SKYWARD_STONEWORK_RADIUS_M]
  );
  const row = result.rows[0];
  if (!row) return null;
  const obeliskLevel = row.obelisk_level === null ? null : Number(row.obelisk_level);
  const baseQuantity = kingdomBrickYieldQuantity(roll, obeliskLevel, row.member, kingdomBrickYieldChance(row.boundary_writ_war_land));
  if (baseQuantity <= 0) return null;
  // An allied Hunter monolith in range adds 27% (35% at Field Engineering rank 3).
  const monolithQuantity = await monolithHunterQuantity(queryable, {
    playerId: input.playerId,
    position: input.position,
    quantity: baseQuantity,
    rollKey: `bricks:${input.rollKey}`
  });
  // A Spark Tonic adds 12% on top, with the same whole-unit rounding the monolith uses.
  const inspiredQuantity = await inspirationActive(queryable, input.playerId)
    ? monolithHunterYield(monolithQuantity, INSPIRATION_BONUS_PERCENT, kingdomBrickYieldRoll(`inspiration:${input.rollKey}`))
    : monolithQuantity;
  const perkMultiplier = kingdomBrickPerkMultiplier(row);
  const quantity = Math.round(inspiredQuantity * perkMultiplier);
  return quantity > 0
    ? { kingdomId: row.kingdom_id, obeliskLevel, member: row.member, quantity, perkMultiplier }
    : null;
}
