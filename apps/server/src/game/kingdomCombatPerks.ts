import {
  KINGDOM_PERK_TREACHEROUS_GROUND_ATTACK_BONUS,
  KINGDOM_PERK_TREACHEROUS_GROUND_RANGE_M,
  KINGDOM_PERK_VERDANT_SURGE_HEAL_BONUS,
  KINGDOM_PERK_BREACH_COMPANY_MAX_BONUS,
  KINGDOM_PERK_BREACH_COMPANY_RANGE_M,
  KINGDOM_PERK_SPEARHEAD_SPEED_BONUS,
  distanceMeters,
  type KingdomPerkId,
  type LatLon
} from "@ash-atlas/shared";
import type pg from "pg";

import { isDungeonRegion } from "./combat/petCompanionRuntime.js";
import { effectiveKingdomPerkIds } from "./kingdomPerks.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

/*
 * Kingdom perks that depend on where a member stands or on who is around
 * them (Verdant Surge, and the position-aware perks that follow it). The
 * combat engine is synchronous and in memory, so a periodic sync resolves
 * them here for every connected player and pushes plain numbers into the
 * engine; the engine never queries the database per hit or per heal.
 */

/** What the combat engine applies to one player until the next sync. */
export type KingdomCombatPerkEffects = Readonly<{
  /** Flat attack added on top of the player's resolved attack (Breach Company, Treacherous Ground). */
  attackBonus: number;
  /** Flat movement speed added to the player's speed (The Spearhead). */
  speedBonus: number;
  /** Flat amount added to each heal the player receives. */
  healingBonus: number;
}>;

export const NO_KINGDOM_COMBAT_PERK_EFFECTS: KingdomCombatPerkEffects = Object.freeze({ attackBonus: 0, healingBonus: 0, speedBonus: 0 });

/** One connected player as the combat engine sees them. */
export type KingdomCombatFootprint = Readonly<{
  playerId: string;
  lat: number;
  lon: number;
  regionCode: string;
}>;

/** A connected player's kingdom and the perks it currently grants them. */
export type KingdomCombatMember = Readonly<{
  kingdomId: string;
  perkIds: ReadonlySet<KingdomPerkId>;
}>;

/**
 * Kingdom and in-effect perks for many players in one query. A member still
 * inside the qualification period keeps their kingdom but has no perks.
 */
export async function loadKingdomCombatMembers(
  queryable: Queryable,
  playerIds: readonly string[],
  now: Date
): Promise<Map<string, KingdomCombatMember>> {
  const members = new Map<string, KingdomCombatMember>();
  if (playerIds.length === 0) return members;
  const result = await queryable.query<{
    player_id: string;
    kingdom_id: string;
    qualified: boolean;
    perk_id: string | null;
    active_until: Date | string | null;
  }>(
    `SELECT m.player_id::text AS player_id, m.kingdom_id::text AS kingdom_id,
            m.perk_qualified_at <= $2::timestamptz AS qualified, s.perk_id, s.active_until
     FROM kingdom_memberships m
     JOIN kingdoms k ON k.id = m.kingdom_id AND k.status = 'active'
     LEFT JOIN kingdom_perk_selections_in_effect s ON s.kingdom_id = m.kingdom_id
     WHERE m.player_id::text = ANY($1::text[]) AND m.status = 'active'`,
    [[...playerIds], now]
  );
  const rowsByPlayer = new Map<string, typeof result.rows>();
  for (const row of result.rows) {
    const rows = rowsByPlayer.get(row.player_id);
    if (rows) rows.push(row);
    else rowsByPlayer.set(row.player_id, [row]);
  }
  for (const [playerId, rows] of rowsByPlayer) {
    const first = rows[0]!;
    members.set(playerId, {
      kingdomId: first.kingdom_id,
      perkIds: first.qualified
        ? effectiveKingdomPerkIds(
          rows.filter((row): row is typeof row & { perk_id: string } => row.perk_id !== null),
          now
        )
        : new Set()
    });
  }
  return members;
}

/**
 * The subset of `entries` standing inside the claim of a standing Kingdom
 * Flag or Castle of their own kingdom (the same land test the Bricks yield
 * and Reserved Game use).
 */
export async function playersOnOwnKingdomLand(
  queryable: Queryable,
  entries: ReadonlyArray<Readonly<{ playerId: string; kingdomId: string; lat: number; lon: number }>>
): Promise<Set<string>> {
  if (entries.length === 0) return new Set();
  const result = await queryable.query<{ player_id: string }>(
    `WITH probe AS (
       SELECT p.player_id, p.kingdom_id::uuid AS kingdom_id,
              ST_SetSRID(ST_MakePoint(p.lon, p.lat), 4326)::geography AS g
       FROM unnest($1::text[], $2::text[], $3::float8[], $4::float8[]) AS p(player_id, kingdom_id, lat, lon)
     )
     SELECT probe.player_id
     FROM probe
     WHERE EXISTS (
       SELECT 1 FROM flags f
       LEFT JOIN kingdom_seats seat
         ON f.control_type = 'kingdom_seat' AND seat.source_flag_id = f.id AND seat.status = 'active'
       WHERE f.kingdom_id = probe.kingdom_id
         AND f.control_type IN ('kingdom', 'kingdom_seat')
         AND f.territory_collapse_id IS NULL
         AND ST_DWithin(COALESCE(seat.geom, f.geom)::geography, probe.g,
                        COALESCE(seat.territory_radius_m, f.claim_radius_m))
     )`,
    [
      entries.map((entry) => entry.playerId),
      entries.map((entry) => entry.kingdomId),
      entries.map((entry) => entry.lat),
      entries.map((entry) => entry.lon)
    ]
  );
  return new Set(result.rows.map((row) => row.player_id));
}

/**
 * The subset of `entries` within `radiusM` of an active cistern warrens entrance
 * (the dungeon entrances stored in the database; authored entrances are
 * checked in memory by the caller).
 */
export async function playersNearCisternWarrensEntrance(
  queryable: Queryable,
  entries: ReadonlyArray<Readonly<{ playerId: string; lat: number; lon: number }>>,
  radiusM: number
): Promise<Set<string>> {
  if (entries.length === 0) return new Set();
  const result = await queryable.query<{ player_id: string }>(
    `SELECT p.player_id
     FROM unnest($1::text[], $2::float8[], $3::float8[]) AS p(player_id, lat, lon)
     WHERE EXISTS (
       SELECT 1 FROM city_structures structure
       WHERE structure.structure_type = 'cistern_warrens'
         AND structure.state = 'active'
         AND ST_DWithin(structure.geom::geography,
                        ST_SetSRID(ST_MakePoint(p.lon, p.lat), 4326)::geography, $4)
     )`,
    [
      entries.map((entry) => entry.playerId),
      entries.map((entry) => entry.lat),
      entries.map((entry) => entry.lon),
      radiusM
    ]
  );
  return new Set(result.rows.map((row) => row.player_id));
}

/**
 * Breach Company: +1 attack per other online member of the same kingdom within
 * 550 m (same region, so dungeon rooms never mix with the overworld), up to +4.
 */
export function breachCompanyAttackBonus(nearbyMembers: number): number {
  return Math.max(0, Math.min(KINGDOM_PERK_BREACH_COMPANY_MAX_BONUS, Math.trunc(nearbyMembers)));
}

/** Effects for every footprint whose member has a position-aware perk in effect. */
export function resolveKingdomCombatPerkEffects(input: Readonly<{
  footprints: readonly KingdomCombatFootprint[];
  members: ReadonlyMap<string, KingdomCombatMember>;
  onOwnKingdomLand: ReadonlySet<string>;
  /** Players standing within 550 m of an overworld dungeon entrance. */
  nearDungeonEntrance?: ReadonlySet<string>;
}>): Map<string, KingdomCombatPerkEffects> {
  const effects = new Map<string, KingdomCombatPerkEffects>();
  const footprintsByKingdom = new Map<string, KingdomCombatFootprint[]>();
  for (const footprint of input.footprints) {
    const kingdomId = input.members.get(footprint.playerId)?.kingdomId;
    if (kingdomId === undefined) continue;
    const group = footprintsByKingdom.get(kingdomId);
    if (group) group.push(footprint);
    else footprintsByKingdom.set(kingdomId, [footprint]);
  }
  for (const footprint of input.footprints) {
    const member = input.members.get(footprint.playerId);
    if (!member) continue;
    let nearby = 0;
    if (member.perkIds.has("breach_company")) {
      for (const other of footprintsByKingdom.get(member.kingdomId) ?? []) {
        if (other.playerId === footprint.playerId || other.regionCode !== footprint.regionCode) continue;
        if (distanceMeters(footprint, other) <= KINGDOM_PERK_BREACH_COMPANY_RANGE_M) nearby += 1;
        if (nearby >= KINGDOM_PERK_BREACH_COMPANY_MAX_BONUS) break;
      }
    }
    const healingBonus = member.perkIds.has("verdant_surge") &&
      (isDungeonRegion(footprint.regionCode) || input.onOwnKingdomLand.has(footprint.playerId))
      ? KINGDOM_PERK_VERDANT_SURGE_HEAL_BONUS
      : 0;
    const treacherousGround = member.perkIds.has("treacherous_ground") &&
      input.nearDungeonEntrance?.has(footprint.playerId) === true
      ? KINGDOM_PERK_TREACHEROUS_GROUND_ATTACK_BONUS
      : 0;
    effects.set(footprint.playerId, {
      attackBonus: breachCompanyAttackBonus(nearby) + treacherousGround,
      healingBonus,
      speedBonus: member.perkIds.has("the_spearhead") ? KINGDOM_PERK_SPEARHEAD_SPEED_BONUS : 0
    });
  }
  return effects;
}

/**
 * One sync pass: resolve effects for the connected players and hand them to
 * `apply`. `nearAuthoredDungeonEntrance` checks the in-memory authored
 * dungeon entrances; cistern warrens entrances are read here.
 */
export async function syncKingdomCombatPerks(
  queryable: Queryable,
  footprints: readonly KingdomCombatFootprint[],
  apply: (playerId: string, effects: KingdomCombatPerkEffects) => void,
  now: Date = new Date(),
  nearAuthoredDungeonEntrance: (position: LatLon, radiusM: number) => boolean = () => false
): Promise<void> {
  const members = await loadKingdomCombatMembers(queryable, footprints.map((footprint) => footprint.playerId), now);
  const landCandidates = footprints.flatMap((footprint) => {
    const member = members.get(footprint.playerId);
    return member?.perkIds.has("verdant_surge") && !isDungeonRegion(footprint.regionCode)
      ? [{ playerId: footprint.playerId, kingdomId: member.kingdomId, lat: footprint.lat, lon: footprint.lon }]
      : [];
  });
  const onOwnKingdomLand = await playersOnOwnKingdomLand(queryable, landCandidates);
  // Treacherous Ground: overworld members only; authored entrances in memory, then one warrens query.
  const nearDungeonEntrance = new Set<string>();
  const sewerCandidates: KingdomCombatFootprint[] = [];
  for (const footprint of footprints) {
    if (!members.get(footprint.playerId)?.perkIds.has("treacherous_ground") || isDungeonRegion(footprint.regionCode)) continue;
    if (nearAuthoredDungeonEntrance(footprint, KINGDOM_PERK_TREACHEROUS_GROUND_RANGE_M)) nearDungeonEntrance.add(footprint.playerId);
    else sewerCandidates.push(footprint);
  }
  for (const playerId of await playersNearCisternWarrensEntrance(queryable, sewerCandidates, KINGDOM_PERK_TREACHEROUS_GROUND_RANGE_M)) {
    nearDungeonEntrance.add(playerId);
  }
  const effects = resolveKingdomCombatPerkEffects({ footprints, members, onOwnKingdomLand, nearDungeonEntrance });
  for (const footprint of footprints) {
    apply(footprint.playerId, effects.get(footprint.playerId) ?? NO_KINGDOM_COMBAT_PERK_EFFECTS);
  }
}
