import {
  CLASS_IDS,
  SUBCLASS_IDS,
  WARRIOR_LEVEL_XP,
  availableTechniqueIds,
  requireEquipmentDefinition,
  type ClassLoadoutView,
  type EquipmentDefinitionId,
  type EquipmentSnapshot
} from "@ash-atlas/shared";
import type pg from "pg";

import { loadConfig } from "../../config.js";
import { createPool } from "../../db/pool.js";
import { ClassRequestError, ClassService } from "./classService.js";

const playerId = `class-integration-${crypto.randomUUID()}`;
const pool = createPool({ databaseUrl: loadConfig().DATABASE_URL });
const classes = new ClassService(pool);

try {
  await pool.query(
    `INSERT INTO players (
       id, username, username_normalized, region_code, lat, lon, anchor_lat, anchor_lon,
       move_leash_radius_m, geom
     ) VALUES ($1,$2,$3,'NM',35.0844,-106.6504,35.0844,-106.6504,1000,
       ST_SetSRID(ST_MakePoint(-106.6504,35.0844),4326))`,
    [playerId, playerId, playerId]
  );
  await pool.query(
    `INSERT INTO player_progression_profiles (player_id, total_xp, level) VALUES ($1,0,1)`,
    [playerId]
  );

  const initial = await classes.getOrCreate(playerId);
  assert(initial.activeClassId === "warrior", "Warrior was not initialized as active");
  assert(initial.warrior.level === 0 && initial.warrior.xp === 0, "New Warrior did not start at Level 0");
  assert(initial.warrior.nextLevelXp === 100, "Level 1 threshold is not canonical");
  assert(initial.classes?.length === CLASS_IDS.length, "Every class progress row was not initialized");
  assert(initial.resources?.length === CLASS_IDS.length, "Every independent class resource was not initialized");
  assert(initial.subclasses.length === SUBCLASS_IDS.length && initial.subclasses.every((entry) => !entry.unlocked), "Subclass state is invalid");
  assert(availableTechniqueIds(initial).sort().join(",") === "warrior_ironhide,warrior_rageborn", "Level 0 automatic passives are invalid");

  await expectClassError(
    classes.learnTechnique(playerId, "warrior_cleave", "db-learn:removed"),
    "TECHNIQUE_LEARNING_REMOVED"
  );

  const levelEight = await classes.grantCombatMastery(playerId, "warrior", WARRIOR_LEVEL_XP[8]!, "db-xp:level-8");
  assert(levelEight.warriorPreviousLevel === 0 && levelEight.warriorResultingLevel === 8, "One award did not advance several levels");
  assert(levelEight.snapshot.warrior.xp === 4_200, "Level 8 XP is not canonical");
  assert(availableTechniqueIds(levelEight.snapshot).includes("warrior_cleave"), "Cleave did not unlock automatically");

  const replay = await classes.grantCombatMastery(playerId, "warrior", WARRIOR_LEVEL_XP[8]!, "db-xp:level-8");
  assert(replay.replayed && replay.snapshot.warrior.xp === 4_200, "XP replay double-awarded");

  const concurrentKey = "db-xp:concurrent";
  const concurrent = await Promise.all([
    classes.grantCombatMastery(playerId, "warrior", 100, concurrentKey),
    classes.grantCombatMastery(playerId, "warrior", 100, concurrentKey)
  ]);
  assert(concurrent.filter((entry) => entry.replayed).length === 1, "Concurrent XP replay was not canonical");
  assert(concurrent[0]!.snapshot.warrior.xp === 4_300 || concurrent[1]!.snapshot.warrior.xp === 4_300, "Concurrent XP awarded more than once");

  const maxed = await classes.grantCombatMastery(playerId, "warrior", 100_000, "db-xp:max");
  assert(maxed.snapshot.warrior.level === 25 && maxed.snapshot.warrior.xp === 38_000, "Warrior did not cap at Level 25");

  const fullLoadout: ClassLoadoutView = {
    resetActives: ["warrior_punishing_strike", "warrior_sundering_strike"],
    normalActives: ["warrior_cleave", "warrior_fortify"],
    passiveTiers: ["warrior_rageborn", "warrior_crowd_breaker", "warrior_last_stand"], ultimateActive: null
  };
  const equipped = await classes.updateLoadout(playerId, fullLoadout, "db-loadout:full", {
    inCombat: false,
    equipment: equipment(playerId)
  });
  assert(equipped.snapshot.loadout.normalActives[1] === "warrior_fortify", "Normal loadout did not persist");
  assert(equipped.snapshot.loadout.passiveTiers[2] === "warrior_last_stand", "Tier-20 passive did not persist");

  await expectClassError(
    classes.updateLoadout(playerId, {
      ...fullLoadout,
      normalActives: ["warrior_second_wind", "warrior_fortify"]
    }, "db-loadout:forged-old", { inCombat: false, equipment: equipment(playerId) }),
    "TECHNIQUE_LEVEL_REQUIRED"
  );
  await expectClassError(
    classes.updateLoadout(playerId, {
      ...fullLoadout,
      passiveTiers: ["warrior_crowd_breaker", null, "warrior_last_stand"]
    }, "db-loadout:wrong-tier", { inCombat: false, equipment: equipment(playerId) }),
    "LOADOUT_SLOT_INVALID"
  );

  await expectClassError(
    classes.activateSubclass(playerId, "reaver", "db-subclass:production-locked", { restricted: false }),
    "SUBCLASS_LOCKED"
  );
  const unlockedReaver = await classes.setOwnDevelopmentSubclassUnlock(
    playerId, "reaver", true, "db-dev:unlock-reaver", { restricted: false }
  );
  assert(unlockedReaver.snapshot.subclasses.find((entry) => entry.subclassId === "reaver")?.unlocked, "Reaver did not unlock");
  const reaver = await classes.activateSubclass(playerId, "reaver", "db-subclass:reaver", { restricted: false });
  assert(reaver.snapshot.activeSubclassId === "reaver", "Reaver did not activate");

  const reaverLoadout = await classes.updateLoadout(playerId, {
    ...fullLoadout,
    resetActives: ["reaver_bloodletting_strike", "warrior_sundering_strike"]
  }, "db-loadout:reaver", { inCombat: false, equipment: equipment(playerId) });
  assert(reaverLoadout.snapshot.loadout.resetActives[0] === "reaver_bloodletting_strike", "Subclass reset did not occupy a normal reset slot");
  await classes.activateSubclass(playerId, null, "db-subclass:clear-reaver", { restricted: false });
  const restoredReaver = await classes.activateSubclass(playerId, "reaver", "db-subclass:restore-reaver", { restricted: false });
  assert(restoredReaver.snapshot.loadout.resetActives[0] === "reaver_bloodletting_strike", "Persistent subclass reset was not restored");

  await classes.setOwnDevelopmentSubclassUnlock(playerId, "warden", true, "db-dev:unlock-warden", { restricted: false });
  await classes.activateSubclass(playerId, "warden", "db-subclass:warden", { restricted: false });
  const wardenEquipped = await classes.updateLoadout(playerId, {
    ...fullLoadout,
    resetActives: ["warden_guardians_reprisal", "warrior_sundering_strike"]
  }, "db-loadout:warden", { inCombat: false, equipment: equipment(playerId) });
  assert(wardenEquipped.snapshot.loadout.resetActives.filter(Boolean).length === 2, "Subclass reset created a third slot");
  const lockedWarden = await classes.setOwnDevelopmentSubclassUnlock(
    playerId, "warden", false, "db-dev:lock-warden", { restricted: false }
  );
  assert(lockedWarden.snapshot.activeSubclassId === null, "Locking active Warden did not deactivate it");
  assert(!lockedWarden.snapshot.loadout.resetActives.includes("warden_guardians_reprisal"), "Locking Warden did not clear its reset");

  await pool.query(
    `INSERT INTO player_class_legacy_unlocks (
       player_id, completed_class_id, legacy_id, display_name
     ) VALUES ($1,'warrior','warrior_legacy_iron_constitution','Warrior Legacy — Iron Constitution')`,
    [playerId]
  );
  const levelDown = await classes.adjustOwnDevelopmentProgression(
    playerId, "warrior_level", 4, "db-dev:warrior-level-4", { restricted: false }
  );
  assert(levelDown.snapshot.warrior.level === 4 && levelDown.snapshot.warrior.xp === 1_200, "Level-down threshold is not canonical");
  assert(levelDown.snapshot.loadout.resetActives.every((id) => id === null), "Locked reset survived level-down");
  assert(levelDown.snapshot.loadout.normalActives.every((id) => id === null), "Locked normal survived level-down");
  assert(levelDown.snapshot.loadout.passiveTiers[1] === null && levelDown.snapshot.loadout.passiveTiers[2] === null, "Locked passive tier survived level-down");
  assert(levelDown.snapshot.legacyIds.includes("warrior_legacy_iron_constitution"), "Permanent legacy was revoked");
  const savedSubclassResets = await pool.query<{ reset_id: string | null; reset_slot_index: number | null }>(
    `SELECT reset_id, reset_slot_index FROM player_subclass_loadouts WHERE player_id = $1`,
    [playerId]
  );
  assert(
    savedSubclassResets.rows.every((row) => row.reset_id === null && row.reset_slot_index === null),
    "Level-down retained a hidden subclass reset"
  );
  const levelReplay = await classes.adjustOwnDevelopmentProgression(
    playerId, "warrior_level", 4, "db-dev:warrior-level-4", { restricted: false }
  );
  assert(levelReplay.replayed, "Development level replay was not idempotent");

  const character = await classes.adjustOwnDevelopmentProgression(
    playerId, "character_level", 0, "db-dev:character-0", { restricted: false }
  );
  assert(character.snapshot.characterLevel === 0 && character.snapshot.warrior.level === 4, "Character Level altered Warrior Level");

  const hunterActivated = await classes.activateClass(
    playerId, "hunter", "db-class:hunter", { restricted: false, equipment: equipment(playerId) }
  );
  assert(hunterActivated.snapshot.hunter?.level === 0, "Hunter did not begin at Level 0");
  assert(hunterActivated.snapshot.resource?.resourceId === "focus" && hunterActivated.snapshot.resource.current === 100,
    "Hunter did not begin with 100 Focus");
  const hunterMaxed = await classes.adjustOwnDevelopmentProgression(
    playerId, "hunter_level", 25, "db-dev:hunter-level-25", { restricted: false }
  );
  assert(hunterMaxed.snapshot.hunter?.level === 25 && hunterMaxed.snapshot.warrior.level === 4,
    "Hunter Level was not independent from Warrior Level");
  const hunterLoadout: ClassLoadoutView = {
    resetActives: ["hunter_predators_strike", "hunter_cull"],
    normalActives: ["hunter_sweep", "hunter_snare_trap"],
    passiveTiers: ["hunter_hardened_leathers", "hunter_pack_hunter", "hunter_patient_hunter"], ultimateActive: null
  };
  await classes.updateLoadout(playerId, hunterLoadout, "db-loadout:hunter", { inCombat: false, equipment: equipment(playerId) });
  await classes.setOwnDevelopmentSubclassUnlock(playerId, "stalker", true, "db-dev:unlock-stalker", { restricted: false });
  const stalker = await classes.activateSubclass(
    playerId, "stalker", "db-subclass:stalker", { restricted: false, equipment: equipment(playerId) }
  );
  assert(stalker.snapshot.activeSubclassId === "stalker", "Stalker did not activate with a melee Hunter weapon");
  const runtime = await classes.loadRuntime(playerId);
  await classes.persistRuntime(playerId, {
    ...runtime,
    version: runtime.version + 1,
    resourceCurrent: 42,
    resourceReserved: 0,
    rage: 0,
    rageReserved: 0
  });
  await classes.activateClass(playerId, "warrior", "db-class:warrior-return", { restricted: false, equipment: equipment(playerId) });
  const hunterRestored = await classes.activateClass(playerId, "hunter", "db-class:hunter-return", { restricted: false, equipment: equipment(playerId) });
  assert(hunterRestored.snapshot.activeSubclassId === "stalker", "Hunter subclass selection was not restored");
  assert(hunterRestored.snapshot.resource?.current === 42, "Hunter Focus was not restored independently");
  assert(hunterRestored.snapshot.loadout.resetActives[0] === "hunter_predators_strike", "Hunter loadout was not restored");

  const raceBase = await classes.loadRuntime(playerId);
  let signalOlderStarted!: () => void;
  let releaseOlder!: () => void;
  const olderStarted = new Promise<void>((resolve) => { signalOlderStarted = resolve; });
  const olderGate = new Promise<void>((resolve) => { releaseOlder = resolve; });
  const delayedPool = {
    connect: async () => {
      signalOlderStarted();
      await olderGate;
      return pool.connect();
    }
  } as unknown as pg.Pool;
  const delayedClasses = new ClassService(delayedPool);
  const olderRejected = expectClassError(delayedClasses.persistRuntime(playerId, {
    ...raceBase,
    version: raceBase.version + 1,
    resourceCurrent: 11
  }), "CLASS_RUNTIME_STALE");
  await olderStarted;
  try {
    await classes.persistRuntime(playerId, {
      ...raceBase,
      version: raceBase.version + 2,
      resourceCurrent: 73
    });
  } finally {
    releaseOlder();
  }
  await olderRejected;
  await classes.persistRuntime(playerId, {
    ...raceBase,
    version: raceBase.version + 2,
    resourceCurrent: 12
  });
  const afterRuntimeRace = await classes.loadRuntime(playerId);
  assert(afterRuntimeRace.version === raceBase.version + 2 && afterRuntimeRace.resourceCurrent === 73,
    "An older or conflicting equal-version runtime overwrote the newer committed snapshot");

  const dormant = await pool.query<{
    training_points_earned: number;
    training_points_spent: number;
  }>(
    `SELECT training_points_earned, training_points_spent
     FROM player_class_progress WHERE player_id = $1 AND class_id = 'warrior'`,
    [playerId]
  );
  assert(Number(dormant.rows[0]?.training_points_earned) === 0, "Training Points were still earned");
  assert(Number(dormant.rows[0]?.training_points_spent) === 0, "Training Points were still spent");

  console.log(JSON.stringify({
    ok: true,
    initialLevel: initial.warrior.level,
    maximumLevel: maxed.snapshot.warrior.level,
    exactMaximumXp: maxed.snapshot.warrior.xp,
    legacyPreserved: levelDown.snapshot.legacyIds,
    reaverUnlocked: levelDown.snapshot.subclasses.find((entry) => entry.subclassId === "reaver")?.unlocked,
    wardenUnlocked: levelDown.snapshot.subclasses.find((entry) => entry.subclassId === "warden")?.unlocked,
    hunterLevel: hunterRestored.snapshot.hunter?.level,
    hunterFocus: hunterRestored.snapshot.resource?.current,
    hunterSubclass: hunterRestored.snapshot.activeSubclassId,
    runtimeRaceVersion: afterRuntimeRace.version,
    runtimeRaceCanonicalResource: afterRuntimeRace.resourceCurrent
  }, null, 2));
} finally {
  await pool.query(`DELETE FROM class_operations WHERE player_id = $1`, [playerId]);
  await pool.query(`DELETE FROM class_progression_operations WHERE player_id = $1`, [playerId]);
  await pool.query(`DELETE FROM dev_progression_operations WHERE player_id = $1`, [playerId]);
  await pool.query(`DELETE FROM players WHERE id = $1`, [playerId]);
  await pool.end();
}

async function expectClassError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected ${code}`);
  } catch (error) {
    assert(error instanceof ClassRequestError && error.code === code, `Expected ${code}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equipment(
  ownerPlayerId: string,
  definitionId: EquipmentDefinitionId = "starter_sword"
): EquipmentSnapshot {
  const definition = requireEquipmentDefinition(definitionId);
  const weapon = {
    instanceId: "00000000-0000-4000-8000-000000000001",
    definitionId,
    displayName: definition.displayName,
    ownerPlayerId,
    location: "equipped" as const,
    equippedSlot: "weapon" as const,
    attackPowerBonus: definition.attackPowerBonus,
    defenseBonus: definition.defenseBonus,
    weaponCategory: definition.weaponCategory,
    armorCategory: definition.armorCategory,
    twoHanded: definition.twoHanded,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
  return {
    playerId: ownerPlayerId,
    instances: [weapon],
    weapon,
    chest: null,
    totalAttackPowerBonus: definition.attackPowerBonus,
    totalDefenseBonus: definition.defenseBonus
  };
}
