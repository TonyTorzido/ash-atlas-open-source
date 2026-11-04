import {
  BASIC_ATTACK_INTERVAL_MS,
  KINGDOM_PERK_SWORN_RAMPARTS_TOWER_LEVEL,
  KINGDOM_PERK_BEACON_WARDENS_ATTACK_BONUS,
  KINGDOM_PERK_BEACON_WARDENS_RANGE_M,
  WAR_TOWER_BASE_FLAT_ATTACK_BONUS,
  TOWER_ATTACK_RANGE_M,
  TOWER_ATTACK_RAW_DAMAGE_VS_BOMBER,
  TOWER_ATTACK_RAW_DAMAGE_VS_SIEGE,
  structureWarfareProfileForFlag,
  structureWarfareProfileShoots,
  towerAttackDamageMultiplier
} from "@ash-atlas/shared";
import type pg from "pg";

/** Towers fire on the shared uniform attack cadence. */
export const TOWER_VOLLEY_TICK_MS = BASIC_ATTACK_INTERVAL_MS;

export type TowerVolleyPlayer = Readonly<{ playerId: string; lat: number; lon: number }>;

export type TowerVolleyTarget =
  | Readonly<{ kind: "player"; playerId: string }>
  | Readonly<{ kind: "group"; groupId: string; ownerPlayerId: string; unitType: "field_ballista" | "bomber" }>;

export type TowerVolleyShot = Readonly<{
  flagId: string;
  origin: Readonly<{ lat: number; lon: number }>;
  target: TowerVolleyTarget;
  distanceM: number;
  damageMultiplier: number;
  /** Flat raw damage added before the multiplier (Beacon Wardens). */
  attackBonus: number;
  /** Flat damage added after the matrix (War Towers only: base + Forward Sappers). */
  flatDamageBonus: number;
}>;

export type TowerVolleyHooks = Readonly<{
  /** Applies one tower arrow to a player through the combat authority; returns applied damage. */
  hitPlayer(input: Readonly<{
    flagId: string;
    targetPlayerId: string;
    damageMultiplier: number;
    attackBonus: number;
    origin: Readonly<{ lat: number; lon: number }>;
    /** Flat damage added to the arrow after the matrix (War Towers); 0 / absent otherwise. */
    flatDamageBonus?: number;
  }>): number;
  /** Applies tower damage to a hostile Siege / Bomber group; returns applied damage. */
  hitGroup?(input: Readonly<{ flagId: string; groupId: string; damage: number }>): Promise<number>;
  /** Best-effort notification after a group hit committed. */
  groupHit?(ownerPlayerId: string): void | Promise<void>;
  /**
   * Forward Sappers hook (perk tree, B1): the flat attack bonus each
   * kingdom's War Towers add to every arrow, keyed by kingdom id. Called once
   * per tick with the kingdoms whose War Towers are about to fire; a missing
   * entry (or no hook) means WAR_TOWER_BASE_FLAT_ATTACK_BONUS only.
   */
  warTowerAttackBonus?(kingdomIds: readonly string[]): ReadonlyMap<string, number> | Promise<ReadonlyMap<string, number>>;
}>;

type CandidateRow = {
  flag_id: string;
  control_type: string;
  anchor_kind: string;
  system_controlled: boolean;
  city_id: string | null;
  kingdom_id: string | null;
  reinforcement_level: number;
  tower_level: number;
  /** The tower's kingdom chose Beacon Wardens. */
  wardens: boolean;
  war_structure_kind: string | null;
  flag_lat: number;
  flag_lon: number;
  target_kind: "player" | "group";
  target_id: string;
  target_owner_id: string;
  unit_type: string | null;
  distance_m: number;
};

/*
 * One spatial query per volley tick. Targets are the online, world-present
 * players handed in by the caller plus deployed Siege / Bomber groups; each
 * target probes the small partial geography index of armed towers
 * (flags_armed_tower_geography_gix), so towers with nobody nearby are never
 * read. Hostility is resolved in the same statement:
 *   - personal Guard Tower: a mutual enemy mark with the tower owner;
 *   - City / Kingdom Tower: a member of a city or kingdom at war with the
 *     tower's organization, or anyone who damaged the structure in its
 *     current damage cycle.
 * Allies are never hit: the owner and anyone sharing the owner's city or
 * kingdom (personal), or members of the tower's own organization.
 * A burning tower still shoots; a collapsing or destroyed one does not.
 */
const TOWER_VOLLEY_CANDIDATES_SQL = `
WITH targets AS (
  SELECT 'player'::text AS target_kind, p.target_id, p.target_id AS target_owner_id, NULL::text AS unit_type,
         ST_SetSRID(ST_MakePoint(p.lon, p.lat), 4326)::geography AS geog
  FROM unnest($1::text[], $2::float8[], $3::float8[]) AS p(target_id, lat, lon)
  UNION ALL
  SELECT 'group', g.group_id::text, g.owner_player_id, g.unit_type,
         ST_SetSRID(ST_MakePoint(g.lon, g.lat), 4326)::geography
  FROM military_unit_groups g
  WHERE g.unit_type IN ('field_ballista', 'bomber')
    AND g.location_state IN ('FOLLOWING_PLAYER', 'DEPLOYED_FIELD')
    AND g.lat IS NOT NULL AND g.lon IS NOT NULL
),
armed AS (
  SELECT f.id AS flag_uuid, f.id::text AS flag_id, f.control_type, f.anchor_kind, f.system_controlled,
         f.owner_id AS tower_owner_id, f.city_id, f.kingdom_id, f.reinforcement_level, f.tower_level,
         f.war_structure_kind,
         f.damage_cycle_id, f.lat AS flag_lat, f.lon AS flag_lon, t.target_kind, t.target_id, t.target_owner_id, t.unit_type,
         ST_Distance(f.geom::geography, t.geog) AS distance_m
  FROM targets t
  JOIN flags f
    ON f.tower_level IS NOT NULL
   AND f.health > 0
   AND f.territory_collapse_id IS NULL
   AND ST_DWithin(f.geom::geography, t.geog, $4::float8)
   -- A War Tower falls silent the moment its war ends (the fall sweep breaks it).
   AND (f.war_id IS NULL OR EXISTS (
     SELECT 1 FROM organization_wars tied_war WHERE tied_war.war_id = f.war_id AND tied_war.status = 'active'
   ))
  UNION ALL
  -- Sworn Ramparts: the kingdom's obelisks shoot like a level 1
  -- Kingdom Tower.
  SELECT f.id, f.id::text, f.control_type, f.anchor_kind, f.system_controlled,
         f.owner_id, f.city_id, f.kingdom_id, f.reinforcement_level, $6::integer,
         f.war_structure_kind,
         f.damage_cycle_id, f.lat, f.lon, t.target_kind, t.target_id, t.target_owner_id, t.unit_type,
         ST_Distance(f.geom::geography, t.geog)
  FROM targets t
  JOIN flags f
    ON f.obelisk_level IS NOT NULL
   AND f.health > 0
   AND f.territory_collapse_id IS NULL
   AND ST_DWithin(f.geom::geography, t.geog, $4::float8)
   AND EXISTS (
     SELECT 1 FROM kingdom_perk_selections_in_effect perk
     WHERE perk.kingdom_id = f.kingdom_id AND perk.perk_id = 'sworn_ramparts'
   )
),
pairs AS (
  SELECT armed.*,
         (armed.control_type = 'kingdom' AND EXISTS (
           SELECT 1 FROM kingdom_perk_selections_in_effect perk
           WHERE perk.kingdom_id = armed.kingdom_id AND perk.perk_id = 'beacon_wardens'
         )) AS wardens
  FROM armed
),
target_orgs AS (
  SELECT DISTINCT pairs.target_owner_id AS player_id,
         (SELECT membership.city_id
          FROM city_memberships membership
          JOIN cities city ON city.id = membership.city_id AND city.active
          WHERE membership.player_id = pairs.target_owner_id AND membership.left_at IS NULL
          ORDER BY membership.joined_at DESC LIMIT 1) AS city_id,
         (SELECT membership.kingdom_id
          FROM kingdom_memberships membership
          JOIN kingdoms kingdom ON kingdom.id = membership.kingdom_id AND kingdom.status = 'active'
          WHERE membership.player_id = pairs.target_owner_id AND membership.status = 'active'
          LIMIT 1) AS kingdom_id
  FROM pairs
),
owner_orgs AS (
  SELECT DISTINCT pairs.tower_owner_id AS player_id,
         (SELECT membership.city_id
          FROM city_memberships membership
          JOIN cities city ON city.id = membership.city_id AND city.active
          WHERE membership.player_id = pairs.tower_owner_id AND membership.left_at IS NULL
          ORDER BY membership.joined_at DESC LIMIT 1) AS city_id,
         (SELECT membership.kingdom_id
          FROM kingdom_memberships membership
          JOIN kingdoms kingdom ON kingdom.id = membership.kingdom_id AND kingdom.status = 'active'
          WHERE membership.player_id = pairs.tower_owner_id AND membership.status = 'active'
          LIMIT 1) AS kingdom_id
  FROM pairs
  WHERE pairs.control_type = 'personal'
)
SELECT pairs.flag_id, pairs.control_type, pairs.anchor_kind, pairs.system_controlled,
       pairs.city_id::text, pairs.kingdom_id::text, pairs.reinforcement_level, pairs.tower_level,
       pairs.wardens, pairs.war_structure_kind, pairs.flag_lat, pairs.flag_lon,
       pairs.target_kind, pairs.target_id, pairs.target_owner_id, pairs.unit_type, pairs.distance_m
FROM pairs
JOIN target_orgs target_org ON target_org.player_id = pairs.target_owner_id
LEFT JOIN owner_orgs owner_org ON owner_org.player_id = pairs.tower_owner_id
WHERE pairs.distance_m <= CASE WHEN pairs.wardens THEN $4::float8 ELSE $5::float8 END
AND CASE
  WHEN pairs.control_type = 'personal' THEN
    pairs.target_owner_id <> pairs.tower_owner_id
    AND NOT (target_org.city_id IS NOT NULL AND target_org.city_id IS NOT DISTINCT FROM owner_org.city_id)
    AND NOT (target_org.kingdom_id IS NOT NULL AND target_org.kingdom_id IS NOT DISTINCT FROM owner_org.kingdom_id)
    AND EXISTS (
      SELECT 1 FROM player_enemy_marks mark
      WHERE mark.owner_id = LEAST(pairs.tower_owner_id, pairs.target_owner_id)
        AND mark.target_id = GREATEST(pairs.tower_owner_id, pairs.target_owner_id)
    )
  WHEN pairs.control_type IN ('city', 'kingdom') THEN
    NOT (pairs.city_id IS NOT NULL AND pairs.city_id IS NOT DISTINCT FROM target_org.city_id)
    AND NOT (pairs.kingdom_id IS NOT NULL AND pairs.kingdom_id IS NOT DISTINCT FROM target_org.kingdom_id)
    AND (
      EXISTS (
        SELECT 1 FROM organization_wars war
        WHERE war.status = 'active'
          AND (
            (war.side_a_kind = pairs.control_type
              AND war.side_a_id = COALESCE(pairs.city_id, pairs.kingdom_id)
              AND ((war.side_b_kind = 'city' AND war.side_b_id = target_org.city_id)
                OR (war.side_b_kind = 'kingdom' AND war.side_b_id = target_org.kingdom_id)))
            OR
            (war.side_b_kind = pairs.control_type
              AND war.side_b_id = COALESCE(pairs.city_id, pairs.kingdom_id)
              AND ((war.side_a_kind = 'city' AND war.side_a_id = target_org.city_id)
                OR (war.side_a_kind = 'kingdom' AND war.side_a_id = target_org.kingdom_id)))
          )
      )
      OR (
        pairs.damage_cycle_id IS NOT NULL
        AND (
          EXISTS (
            SELECT 1 FROM flag_attack_operations attack
            WHERE attack.flag_id = pairs.flag_uuid
              AND attack.damage_cycle_id = pairs.damage_cycle_id
              AND attack.player_id = pairs.target_owner_id
          )
          OR EXISTS (
            SELECT 1 FROM military_siege_operations siege
            WHERE siege.flag_id = pairs.flag_uuid
              AND siege.damage_cycle_id = pairs.damage_cycle_id
              AND siege.player_id = pairs.target_owner_id
          )
        )
      )
    )
  ELSE false
END
ORDER BY pairs.flag_id, pairs.distance_m, pairs.target_kind, pairs.target_id`;

/** Picks one volley per tower: the nearest hostile target. */
export function planTowerVolleys(
  rows: readonly CandidateRow[],
  warTowerAttackBonus: ReadonlyMap<string, number> = new Map()
): TowerVolleyShot[] {
  const shots = new Map<string, TowerVolleyShot>();
  for (const row of rows) {
    const distanceM = Number(row.distance_m);
    const current = shots.get(row.flag_id);
    if (current && current.distanceM <= distanceM) continue;
    const profile = structureWarfareProfileForFlag({
      controlType: row.control_type,
      anchorKind: row.anchor_kind,
      systemControlled: row.system_controlled,
      cityId: row.city_id,
      kingdomId: row.kingdom_id,
      reinforcementLevel: Number(row.reinforcement_level),
      towerLevel: Number(row.tower_level),
      warStructureKind: row.war_structure_kind ?? null
    });
    if (!structureWarfareProfileShoots(profile)) continue;
    const target: TowerVolleyTarget | null = row.target_kind === "player"
      ? { kind: "player", playerId: row.target_id }
      : row.unit_type === "field_ballista" || row.unit_type === "bomber"
        ? { kind: "group", groupId: row.target_id, ownerPlayerId: row.target_owner_id, unitType: row.unit_type }
        : null;
    if (!target) continue;
    shots.set(row.flag_id, {
      flagId: row.flag_id,
      origin: { lat: Number(row.flag_lat), lon: Number(row.flag_lon) },
      target,
      distanceM,
      damageMultiplier: towerAttackDamageMultiplier(profile!),
      attackBonus: row.wardens ? KINGDOM_PERK_BEACON_WARDENS_ATTACK_BONUS : 0,
      flatDamageBonus: profile!.kind === "war_tower"
        ? WAR_TOWER_BASE_FLAT_ATTACK_BONUS + Math.max(0, Math.trunc(warTowerAttackBonus.get(row.kingdom_id ?? "") ?? 0))
        : 0
    });
  }
  return [...shots.values()];
}

export function towerDamageAgainstGroup(
  unitType: "field_ballista" | "bomber",
  multiplier: number,
  attackBonus = 0,
  flatDamageBonus = 0
): number {
  const raw = (unitType === "field_ballista" ? TOWER_ATTACK_RAW_DAMAGE_VS_SIEGE : TOWER_ATTACK_RAW_DAMAGE_VS_BOMBER) +
    Math.max(0, attackBonus);
  return Math.max(1, Math.round(raw * Math.max(0, multiplier))) + Math.max(0, Math.trunc(flatDamageBonus));
}

export class TowerVolleyService {
  private running = false;

  constructor(
    private readonly pool: Pick<pg.Pool, "query">,
    private readonly hooks: TowerVolleyHooks
  ) {}

  /** Hostile tower targets around the given players and deployed military groups. */
  async planVolleys(players: readonly TowerVolleyPlayer[]): Promise<TowerVolleyShot[]> {
    const valid = players.filter((player) => Number.isFinite(player.lat) && Number.isFinite(player.lon));
    const result = await this.pool.query<CandidateRow>(TOWER_VOLLEY_CANDIDATES_SQL, [
      valid.map((player) => player.playerId),
      valid.map((player) => player.lat),
      valid.map((player) => player.lon),
      Math.max(TOWER_ATTACK_RANGE_M, KINGDOM_PERK_BEACON_WARDENS_RANGE_M),
      TOWER_ATTACK_RANGE_M,
      KINGDOM_PERK_SWORN_RAMPARTS_TOWER_LEVEL
    ]);
    const warTowerKingdoms = [...new Set(result.rows
      .filter((row) => row.war_structure_kind === "war_tower" && row.kingdom_id)
      .map((row) => row.kingdom_id!))];
    const bonus = warTowerKingdoms.length > 0 && this.hooks.warTowerAttackBonus
      ? await this.hooks.warTowerAttackBonus(warTowerKingdoms)
      : new Map<string, number>();
    return planTowerVolleys(result.rows, bonus);
  }

  /** One volley tick; overlapping ticks are skipped so each tower fires at most once per interval. */
  async tick(players: readonly TowerVolleyPlayer[]): Promise<TowerVolleyShot[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const shots = await this.planVolleys(players);
      const fired: TowerVolleyShot[] = [];
      const hitOwners = new Set<string>();
      for (const shot of shots) {
        if (shot.target.kind === "player") {
          const applied = this.hooks.hitPlayer({
            flagId: shot.flagId,
            targetPlayerId: shot.target.playerId,
            damageMultiplier: shot.damageMultiplier,
            attackBonus: shot.attackBonus,
            origin: shot.origin,
            ...(shot.flatDamageBonus > 0 ? { flatDamageBonus: shot.flatDamageBonus } : {})
          });
          if (applied > 0) fired.push(shot);
        } else if (this.hooks.hitGroup) {
          const applied = await this.hooks.hitGroup({
            flagId: shot.flagId,
            groupId: shot.target.groupId,
            damage: towerDamageAgainstGroup(shot.target.unitType, shot.damageMultiplier, shot.attackBonus, shot.flatDamageBonus)
          });
          if (applied > 0) {
            fired.push(shot);
            hitOwners.add(shot.target.ownerPlayerId);
          }
        }
      }
      for (const ownerPlayerId of hitOwners) {
        try {
          await this.hooks.groupHit?.(ownerPlayerId);
        } catch {
          // Notification is best-effort after the durable hit.
        }
      }
      return fired;
    } finally {
      this.running = false;
    }
  }
}
