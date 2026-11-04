import {
  DUNGEON_MAX_TORCHES,
  dungeonCatalogRoomNavigation,
  dungeonFormationOffset,
  dungeonRunFlagTriggerId,
  dungeonTierLevel,
  findWalkableDungeonPointInShape,
  type DungeonAnchorDefinition,
  type DungeonDefinition,
  type DungeonEncounterDefinition,
  type DungeonMobPlacementDefinition,
  type DungeonRoomDefinition
} from "./dungeonCatalog.js";
import { dungeonEliteModifierAllowed, type DungeonEliteModifierId } from "./dungeonEliteModifiers.js";
import { dungeonSeededRoll } from "./dungeonRolls.js";
import { isIndoorNavigationPointWalkable, type IndoorRoomNavigation } from "./indoor.js";

/** Default budget of each extra torch set, as a percentage of the rolled base budget. */
export const DUNGEON_PARTY_SET_BUDGET_PCT = 60;
const DEFAULT_ROLLED_WAVE_DELAY_MS = 1_000;
/** Hard cap per placement set, whatever the budget and costs allow. */
const MAX_ROLLED_MOBS_PER_SET = 40;
const MAX_ROLLED_GROUP_SIZE = 4;
const STAT_ONLY_MODIFIERS: readonly DungeonEliteModifierId[] = ["hardy", "swift"];

type EncounterRoll = NonNullable<DungeonEncounterDefinition["roll"]>;
type PoolEntry = EncounterRoll["pool"][number];
type RolledMob = { entry: PoolEntry; elite?: DungeonEliteModifierId[] };
type Formation = "scatter" | "line" | "wedge" | "circle";
type Random = () => number;

/** True when the dungeon has anything to roll per run; otherwise it materializes to itself. */
export function dungeonHasRunRolls(dungeon: DungeonDefinition): boolean {
  return Boolean(dungeon.runRolls) || dungeon.encounters.some((encounter) => encounter.roll !== undefined);
}

/**
 * The dungeon as one run plays it (Level 1): every encounter `roll` expanded into generated
 * placements and waves, elites picked, extra torch sets emitted, and run flags rolled. Pure and
 * seeded by `${runId}:${dungeon.revision}`, so a party (shared runId) sees one roll and every
 * generated id is stable for the run's lifetime. A dungeon with nothing to roll is returned as is.
 */
export function materializeDungeonRun(dungeon: DungeonDefinition, runId: string): DungeonDefinition {
  if (!dungeonHasRunRolls(dungeon)) return dungeon;
  const seed = `${runId}:${dungeon.revision}`;
  const output = structuredClone(dungeon) as DungeonDefinition;
  const level = dungeonTierLevel(dungeon);
  for (const encounter of output.encounters) {
    const roll = encounter.roll;
    if (!roll) continue;
    delete encounter.roll;
    // Boss encounters stay fixed: rolled adds never go into them (the validator rejects the roll).
    if (encounter.retired || encounter.bossTemplateId) continue;
    const room = output.rooms.find((candidate) => candidate.id === encounter.roomId && !candidate.retired);
    if (room) expandEncounterRoll(encounter, roll, room, seed, level);
  }
  const flags = output.runRolls?.flags ?? [];
  delete output.runRolls;
  for (const flag of flags) {
    if (dungeonSeededRoll(`${seed}:flags:${flag.flagId}`) * 100 >= flag.chancePct) continue;
    output.triggers.push({
      id: dungeonRunFlagTriggerId(flag.flagId), retired: false, enabled: true, scope: "instance",
      repetition: "once", cooldownMs: 0, event: { type: "timer", delayMs: 0 },
      conditions: { mode: "all", items: [] },
      actions: [{ type: "set_dungeon_flag", flagId: flag.flagId, value: true }]
    });
  }
  return output;
}

function expandEncounterRoll(
  encounter: DungeonEncounterDefinition,
  roll: EncounterRoll,
  room: DungeonRoomDefinition,
  seed: string,
  level: number
): void {
  const encounterSeed = `${seed}:encounter:${encounter.id}`;
  let formation: Formation = encounter.groupControls?.formation ?? "scatter";
  if (roll.formations) {
    formation = pick(roll.formations, seededRandom(`${encounterSeed}:formation`));
    // An absent groupControls links packs, so keep that when adding a formation.
    encounter.groupControls = { formation, linkedAggro: encounter.groupControls?.linkedAggro ?? true };
  }

  // Encounter roll: the base set (torch 1).
  const baseRandom = seededRandom(`${encounterSeed}:set:1`);
  const budget = intBetween(roll.budget.min, roll.budget.max, baseRandom);
  const sets: Array<{ set: number; mobs: RolledMob[] }> = [{ set: 1, mobs: pickMobs(roll.pool, budget, baseRandom, true) }];
  const waveCount = Math.min(sets[0]!.mobs.length, intBetween(roll.waves.min, roll.waves.max, baseRandom));

  // Torch sets 2..10, each from its own share of the base budget.
  const setBudget = Math.round(budget * (roll.partySetBudgetPct ?? DUNGEON_PARTY_SET_BUDGET_PCT) / 100);
  for (let set = 2; set <= DUNGEON_MAX_TORCHES; set += 1) {
    sets.push({ set, mobs: pickMobs(roll.pool, setBudget, seededRandom(`${seed}:party:${encounter.id}:${set}`), false) });
  }

  // Elite picks, base set first, capped across the whole encounter.
  if (roll.elite) {
    const eliteRandom = seededRandom(`${seed}:elite:${encounter.id}`);
    const allowed = (roll.elite.modifierPool ?? STAT_ONLY_MODIFIERS).filter((id) => dungeonEliteModifierAllowed(id, level));
    const modifiers = allowed.length > 0 ? allowed : STAT_ONLY_MODIFIERS;
    let elites = 0;
    for (const { mobs } of sets) for (const mob of mobs) {
      if (elites >= roll.elite.maxPerEncounter) break;
      if (mob.entry.eliteEligible === false) continue;
      if (eliteRandom() * 100 >= roll.elite.chancePct) continue;
      mob.elite = [pick(modifiers, eliteRandom)];
      elites += 1;
    }
  }

  encounter.waves = Array.from({ length: waveCount }, (_, index) => ({
    id: `${encounter.id}_roll_w${index + 1}`,
    mobSpawnIds: [] as string[],
    delayMs: index === 0 ? 0 : roll.waves.delayMs ?? DEFAULT_ROLLED_WAVE_DELAY_MS
  }));
  const navigation = dungeonCatalogRoomNavigation(room);
  for (const { set, mobs } of sets) {
    const placeRandom = seededRandom(`${encounterSeed}:place:${set}`);
    const byWave: RolledMob[][] = encounter.waves.map(() => []);
    shuffle(mobs, placeRandom).forEach((mob, index) => byWave[index % waveCount]!.push(mob));
    byWave.forEach((waveMobs, waveIndex) => {
      const groupCount = Math.ceil(waveMobs.length / MAX_ROLLED_GROUP_SIZE);
      for (let group = 0; group < groupCount; group += 1) {
        const members = waveMobs.slice(group * MAX_ROLLED_GROUP_SIZE, (group + 1) * MAX_ROLLED_GROUP_SIZE);
        const groupId = `${encounter.id}_roll_s${set}_w${waveIndex + 1}_g${group + 1}`;
        const spots = placeGroup(room, navigation, roll.spawn, encounter.id, groupId, members.length, formation, placeRandom);
        members.forEach((mob, memberIndex) => {
          const spot = spots[memberIndex]!;
          const placement: DungeonMobPlacementDefinition = {
            id: `${groupId}_m${memberIndex + 1}`,
            retired: false,
            archetype: mob.entry.archetype,
            anchorId: spot.anchor.id,
            facing: spot.anchor.facing ?? 0,
            encounterId: encounter.id,
            spawnGroupId: spot.spawnGroupId,
            waveIndex: waveIndex + 1,
            leashZoneId: encounter.leashZoneId,
            visualScale: mob.entry.visualScale ?? 1,
            ...(mob.elite ? { elite: { modifiers: mob.elite } } : {}),
            ...(set > 1 ? { partySet: set } : {}),
            generated: true
          };
          room.mobs.push(placement);
          encounter.waves[waveIndex]!.mobSpawnIds.push(placement.id);
        });
      }
    });
  }
}

/** Budget fill: the pool's minimums first (base set only), then weighted picks it can still afford. */
function pickMobs(pool: readonly PoolEntry[], budget: number, random: Random, base: boolean): RolledMob[] {
  const mobs: RolledMob[] = [];
  const counts = pool.map(() => 0);
  let remaining = budget;
  const add = (index: number) => {
    mobs.push({ entry: pool[index]! });
    counts[index]! += 1;
    remaining -= pool[index]!.cost;
  };
  if (base) pool.forEach((entry, index) => {
    for (let count = 0; count < (entry.min ?? 0) && mobs.length < MAX_ROLLED_MOBS_PER_SET; count += 1) add(index);
  });
  while (mobs.length < MAX_ROLLED_MOBS_PER_SET) {
    const candidates = pool.flatMap((entry, index) =>
      entry.cost <= remaining && (entry.max === undefined || counts[index]! < entry.max) ? [index] : []);
    if (candidates.length === 0) break;
    let selection = random() * candidates.reduce((sum, index) => sum + (pool[index]!.weight ?? 1), 0);
    add(candidates.find((index) => (selection -= pool[index]!.weight ?? 1) < 0) ?? candidates[candidates.length - 1]!);
  }
  // A base set is never empty, so every rolled wave has at least one mob.
  if (base && mobs.length === 0) {
    add(pool.reduce((cheapest, entry, index) => entry.cost < pool[cheapest]!.cost ? index : cheapest, 0));
  }
  return mobs;
}

/**
 * Spawn spots for one group: all members on one anchor with the encounter formation when every
 * formation-adjusted point is walkable, otherwise one spot per member (each its own spawn group).
 */
function placeGroup(
  room: DungeonRoomDefinition,
  navigation: IndoorRoomNavigation,
  spawn: EncounterRoll["spawn"],
  encounterId: string,
  groupId: string,
  size: number,
  formation: Formation,
  random: Random
): Array<{ anchor: DungeonAnchorDefinition; spawnGroupId: string }> {
  const formationFits = (point: { x: number; y: number }) => Array.from({ length: size }, (_, index) => {
    const offset = dungeonFormationOffset(formation, index, size);
    return {
      x: Math.max(0, Math.min(room.width, point.x + offset.x)),
      y: Math.max(0, Math.min(room.height, point.y + offset.y))
    };
  }).every((point) => isIndoorNavigationPointWalkable(navigation, point));
  if ("anchorIds" in spawn) {
    const anchors = spawn.anchorIds.flatMap((id) =>
      room.anchors.filter((anchor) => anchor.id === id && !anchor.retired));
    if (anchors.length === 0) throw new Error(`Rolled encounter ${encounterId} has no spawn anchor.`);
    const start = Math.floor(random() * anchors.length);
    for (let attempt = 0; attempt < anchors.length; attempt += 1) {
      const anchor = anchors[(start + attempt) % anchors.length]!;
      if (formationFits(anchor)) return Array.from({ length: size }, () => ({ anchor, spawnGroupId: groupId }));
    }
    return Array.from({ length: size }, (_, index) => ({
      anchor: anchors[(start + index) % anchors.length]!,
      spawnGroupId: `${groupId}_m${index + 1}`
    }));
  }
  const zones = spawn.zoneIds.flatMap((id) => room.zones.filter((zone) => zone.id === id && !zone.retired));
  if (zones.length === 0) throw new Error(`Rolled encounter ${encounterId} has no spawn zone.`);
  const start = Math.floor(random() * zones.length);
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const zone = zones[(start + attempt) % zones.length]!;
    const point = findWalkableDungeonPointInShape(zone, navigation, `${groupId}:${attempt}`, 1);
    if (point && formationFits(point)) {
      const anchor = generatedAnchor(room, `${groupId}_at`, point);
      return Array.from({ length: size }, () => ({ anchor, spawnGroupId: groupId }));
    }
  }
  return Array.from({ length: size }, (_, index) => {
    const zone = zones[(start + index) % zones.length]!;
    // The validator's probe point is the last resort; it proves the zone has walkable ground. Never fall
    // back onto the room's spawn anchor (players arrive there): a zone with no walkable ground is a bad
    // spawn zone, and the seed sweeps and the scaffolder must catch it.
    const point = findWalkableDungeonPointInShape(zone, navigation, `${groupId}:m${index + 1}`)
      ?? findWalkableDungeonPointInShape(zone, navigation, `validate:${encounterId}:${zone.id}`);
    if (!point) throw new Error(`Rolled encounter ${encounterId} found no walkable ground in spawn zone ${zone.id}.`);
    return {
      anchor: generatedAnchor(room, `${groupId}_m${index + 1}_at`, point),
      spawnGroupId: `${groupId}_m${index + 1}`
    };
  });
}

function generatedAnchor(room: DungeonRoomDefinition, id: string, point: { x: number; y: number }): DungeonAnchorDefinition {
  const anchor = { id, retired: false, x: point.x, y: point.y };
  room.anchors.push(anchor);
  return anchor;
}

function seededRandom(seed: string): Random {
  let index = 0;
  return () => dungeonSeededRoll(`${seed}:${index++}`);
}

function intBetween(minimum: number, maximum: number, random: Random): number {
  return minimum + Math.floor(random() * (maximum - minimum + 1));
}

function pick<T>(values: readonly T[], random: Random): T {
  return values[Math.floor(random() * values.length)]!;
}

function shuffle<T>(values: readonly T[], random: Random): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}
