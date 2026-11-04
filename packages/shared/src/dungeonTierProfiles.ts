import {
  type DungeonChestRarity,
  type DungeonCatalogValidationIssue,
  type DungeonDefinition,
  type DungeonTierId
} from "./dungeonCatalog.js";
import { DUNGEON_ELITE_MODIFIER_IDS, type DungeonEliteModifierId } from "./dungeonEliteModifiers.js";
import { materializeDungeonRun } from "./dungeonRunMaterializer.js";

export const DUNGEON_TIER_ROOM_KINDS = [
  "fight", "breather", "lever_puzzle", "hazard", "nests", "miniboss", "trial", "vault", "mimic"
] as const;
export type DungeonTierRoomKind = (typeof DUNGEON_TIER_ROOM_KINDS)[number];

/** Minimums a dungeon that declares the tier must meet. Numbers are the owner's first pass. */
export type DungeonTierProfile = Readonly<{
  id: DungeonTierId;
  /** The dungeon the tier was drawn from. */
  reference: string;
  level: number;
  roomsMin: number;
  /** Mobs in the base (one-torch) set, summoned adds included. */
  mobsSoloMin: number;
  wavesPerFight: Readonly<{ min: number; max: number }>;
  elitePctMin: number;
  eliteModifiers: readonly DungeonEliteModifierId[];
  requiredRoomKinds: readonly DungeonTierRoomKind[];
  bossesMin: number;
  bossPhasesMin: number;
  minibossesMin: number;
  rewards: Readonly<{
    completionGoldPerMember: number;
    rarityFloor: DungeonChestRarity;
    chestsMin: number;
    rarePlusPctMin: number;
    /** 1 raw materials, 2 dungeon materials/enchant stones/gear, 3 rings/metals/recipes, 4 cosmetic or pet chance. */
    lootPoolTier: 1 | 2 | 3 | 4;
  }>;
  vaultChancePct: number;
  /** One chest in N is a mimic; null before mimics unlock. */
  mimicChestOneIn: number | null;
}>;

const STAT_ONLY: readonly DungeonEliteModifierId[] = ["hardy", "swift"];
const KINDS_T00: readonly DungeonTierRoomKind[] = ["fight", "breather"];
const KINDS_T05 = [...KINDS_T00, "lever_puzzle"] as const;
const KINDS_T10 = [...KINDS_T05, "hazard"] as const;
const KINDS_T15 = [...KINDS_T10, "nests", "miniboss"] as const;
const KINDS_T20 = [...KINDS_T15, "trial"] as const;
const KINDS_T25 = [...KINDS_T20, "vault", "mimic"] as const;

function profile(
  id: DungeonTierId, reference: string, roomsMin: number, mobsSoloMin: number,
  waves: [number, number], elitePctMin: number, requiredRoomKinds: readonly DungeonTierRoomKind[],
  bosses: [count: number, phases: number, minibosses: number],
  rewards: [gold: number, floor: DungeonChestRarity, chests: number, rarePlusPct: number, lootPoolTier: 1 | 2 | 3 | 4]
): DungeonTierProfile {
  const level = Number(id.slice(1));
  return {
    id, reference, level, roomsMin, mobsSoloMin,
    wavesPerFight: { min: waves[0], max: waves[1] },
    elitePctMin,
    eliteModifiers: level >= 20 ? DUNGEON_ELITE_MODIFIER_IDS : STAT_ONLY,
    requiredRoomKinds,
    bossesMin: bosses[0], bossPhasesMin: bosses[1], minibossesMin: bosses[2],
    rewards: {
      completionGoldPerMember: rewards[0], rarityFloor: rewards[1], chestsMin: rewards[2],
      rarePlusPctMin: rewards[3], lootPoolTier: rewards[4]
    },
    vaultChancePct: level >= 25 ? 35 : 0,
    mimicChestOneIn: level >= 25 ? 10 : null
  };
}

export const DUNGEON_TIER_PROFILES: Readonly<Record<DungeonTierId, DungeonTierProfile>> = {
  t00: profile("t00", "Cistern Warrens", 5, 30, [1, 2], 0, KINDS_T00, [1, 1, 0], [500, "common", 3, 5, 1]),
  t05: profile("t05", "Fangrock Cavern", 6, 40, [1, 2], 5, KINDS_T05, [1, 1, 0], [1_000, "common", 5, 8, 2]),
  t10: profile("t10", "The Eyrie", 7, 50, [2, 2], 8, KINDS_T10, [1, 2, 0], [1_750, "uncommon", 5, 12, 2]),
  t15: profile("t15", "Blightwood Grove", 8, 60, [2, 3], 10, KINDS_T15, [1, 2, 1], [2_500, "uncommon", 6, 16, 2]),
  t20: profile("t20", "Monastery", 9, 75, [2, 3], 12, KINDS_T20, [1, 3, 1], [3_500, "rare", 6, 20, 3]),
  t25: profile("t25", "Wyrm Hollow", 10, 90, [3, 3], 15, KINDS_T25, [1, 3, 2], [5_000, "rare", 7, 25, 3]),
  t30: profile("t30", "Drowned City", 15, 120, [3, 4], 18, KINDS_T25, [4, 3, 2], [7_500, "epic", 7, 30, 4]),
  t35: profile("t35", "Golem Forge", 15, 140, [3, 4], 20, KINDS_T25, [3, 3, 2], [10_000, "epic", 8, 35, 4]),
  t40: profile("t40", "Fallen Prison", 18, 170, [3, 4], 25, KINDS_T25, [3, 3, 2], [15_000, "epic", 8, 40, 4])
};

export function dungeonTierProfile(id: DungeonTierId): DungeonTierProfile {
  return DUNGEON_TIER_PROFILES[id];
}

/** Seeds the mob minimum is checked over; a rolled dungeon must meet it on every one. */
const TIER_CHECK_SEEDS = 24;

/**
 * Where a dungeon falls below a tier's minimums. Checked from data today: rooms, solo mobs, waves
 * per fight, elite chance and modifiers, bosses, and guaranteed chests.
 * TODO(dungeon tiers): required room kinds, boss phases and minibosses need room/boss metadata that
 * does not exist yet; completion gold, rarity floor, rare-or-better odds and the loot pool tier are
 * checked once the completion reward lands (WP2). Until then those profile fields are data only.
 */
export function dungeonTierIssues(
  dungeon: DungeonDefinition,
  profile: DungeonTierProfile
): DungeonCatalogValidationIssue[] {
  const issues: DungeonCatalogValidationIssue[] = [];
  const below = (field: string, actual: number, minimum: number, what: string) => {
    if (actual < minimum) issues.push({ path: `tier.${field}`, message: `${profile.id} needs at least ${minimum} ${what}; found ${actual}` });
  };
  const activeRooms = dungeon.rooms.filter((room) => room.active && !room.retired);
  below("roomsMin", activeRooms.length, profile.roomsMin, "active rooms");

  let soloMobs = Number.POSITIVE_INFINITY;
  for (let seed = 0; seed < TIER_CHECK_SEEDS; seed += 1) {
    const run = materializeDungeonRun(dungeon, `tier-check:${seed}`);
    soloMobs = Math.min(soloMobs, run.rooms.filter((room) => room.active && !room.retired)
      .reduce((sum, room) => sum + room.mobs.filter((mob) => !mob.retired && mob.partySet === undefined).length, 0));
    if (run === dungeon) break;
  }
  below("mobsSoloMin", soloMobs, profile.mobsSoloMin, "solo mobs");

  const encounters = dungeon.encounters.filter((encounter) => !encounter.retired);
  for (const encounter of encounters.filter((candidate) => !candidate.bossTemplateId)) {
    const waves = encounter.roll ? encounter.roll.waves.min : encounter.waves.length;
    if (waves < profile.wavesPerFight.min) {
      issues.push({ path: `tier.wavesPerFight.${encounter.id}`, message: `${profile.id} needs at least ${profile.wavesPerFight.min} waves per fight; ${encounter.id} has ${waves}` });
    }
  }
  if (profile.elitePctMin > 0) {
    const rolled = encounters.filter((encounter) => encounter.roll);
    if (rolled.length === 0) {
      issues.push({ path: "tier.elitePctMin", message: `${profile.id} needs rolled encounters with at least ${profile.elitePctMin}% elites` });
    }
    for (const encounter of rolled) {
      const chance = encounter.roll!.elite?.chancePct ?? 0;
      if (chance < profile.elitePctMin) {
        issues.push({ path: `tier.elitePctMin.${encounter.id}`, message: `${profile.id} needs at least ${profile.elitePctMin}% elites; ${encounter.id} rolls ${chance}%` });
      }
    }
  }
  for (const encounter of encounters) {
    for (const modifier of encounter.roll?.elite?.modifierPool ?? []) {
      if (!profile.eliteModifiers.includes(modifier)) {
        issues.push({ path: `tier.eliteModifiers.${encounter.id}`, message: `${profile.id} does not allow the ${modifier} elite modifier` });
      }
    }
  }
  below("bossesMin", encounters.filter((encounter) => encounter.bossTemplateId).length, profile.bossesMin, "boss encounters");
  below("rewards.chestsMin", guaranteedChests(dungeon), profile.rewards.chestsMin, "guaranteed chests");
  return issues;
}

/**
 * Chests present on every run (shown at once or revealed later): no spawn roll, plus each group's minimum.
 * A chest revealed only by a rolled run flag (a vault) is not guaranteed.
 */
function guaranteedChests(dungeon: DungeonDefinition): number {
  const groups = new Map<string, number>();
  const rolledFlags = new Set((dungeon.runRolls?.flags ?? []).map((flag) => flag.flagId));
  const flagGated = new Set<string>();
  for (const trigger of dungeon.triggers) {
    if (trigger.retired || trigger.event.type !== "dungeon_flag" || !rolledFlags.has(trigger.event.flagId)) continue;
    for (const action of trigger.actions) {
      if (action.type === "set_object_available") flagGated.add(`${action.roomId}:${action.objectId}`);
    }
  }
  let count = 0;
  for (const room of dungeon.rooms) {
    if (!room.active || room.retired) continue;
    for (const object of room.objects) {
      if (object.retired || object.type !== "chest" || flagGated.has(`${room.id}:${object.id}`)) continue;
      if (object.spawnGroup) groups.set(object.spawnGroup.id, object.spawnGroup.min);
      else if ((object.spawnChance ?? 100) >= 100) count += 1;
    }
  }
  return count + [...groups.values()].reduce((sum, minimum) => sum + minimum, 0);
}
