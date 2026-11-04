import { BASIC_ATTACK_INTERVAL_MS, EQUIPMENT_SLOTS } from "@ash-atlas/shared";

const SLOT_COUNT = EQUIPMENT_SLOTS.length;
import { beforeAll, describe, expect, it } from "vitest";

import { playerEquipmentCombatStateFromSnapshot } from "./combatEngine.js";
import {
  EQUIPMENT_PROGRESSION_PROFILES,
  createEquipmentCombatSimulationSnapshot,
  equipmentCombatSimulationSuiteJson,
  equipmentCombatSimulationSuiteMarkdown,
  runEquipmentCombatSimulationSuite,
  type EquipmentCombatSimulationSuite
} from "./equipmentCombatSimulation.js";

/** One basic attack interval in 20 Hz ticks. */
const BEAT = BASIC_ATTACK_INTERVAL_MS * 20 / 1_000;
/** `count` beat-spaced ticks starting at `first`. */
const beats = (first: number, count: number) => Array.from({ length: count }, (_, index) => first + index * BEAT);

describe("real-engine equipment progression simulations", () => {
  let suite: EquipmentCombatSimulationSuite;

  beforeAll(() => {
    suite = runEquipmentCombatSimulationSuite();
  }, 20_000);

  it("runs the exact seven-row progression matrix through production combat", () => {
    expect(EQUIPMENT_PROGRESSION_PROFILES.map((profile) => [
      profile.characterLevel,
      profile.warriorRank,
      profile.gearLevel,
      profile.affinity
    ])).toEqual([
      [0, 0, 0, "preferred"],
      [15, 9, 0, "preferred"],
      [15, 9, 15, "preferred"],
      [20, 12, 20, "preferred"],
      [25, 15, 20, "preferred"],
      [25, 15, 25, "off_affinity"],
      [25, 15, 25, "preferred"]
    ]);
    const mirrors = suite.duels.filter((duel) => duel.category === "matrix_mirror");
    expect(mirrors).toHaveLength(7);
    expect(mirrors.every((duel) =>
      duel.left.power.maximumHealth === 100 &&
      duel.right.power.maximumHealth === 100
    )).toBe(true);

    const maximum = mirrors.find((duel) =>
      duel.scenarioId.endsWith("gear-25-preferred")
    )!;
    const winner = maximum.winnerSide === "left" ? maximum.left : maximum.right;
    // V3 4 + (25 - 25) + Axe mastery 4 = 8; health-tier innate adds 1/2/3 below 70/45/20 HP.
    expect(winner.successfulBasicAttacks).toBe(12);
    expect(winner.hitDamage).toEqual([8, 8, 8, 8, 8, 9, 9, 9, 10, 10, 11, 2]);
    expect(winner.hitDamage[0]).toBe(8);
  });

  it("covers gear gaps, neutral affinity, and ranged-versus-shield configurations", () => {
    expect(suite.gates.find((gate) => gate.id === "required_progression_gaps")?.passed)
      .toBe(true);
    expect(suite.gates.find((gate) => gate.id === "level_one_is_measurably_stronger")?.passed)
      .toBe(true);
    expect(suite.gates.find((gate) => gate.id === "level_zero_overwhelmingly_disadvantaged")?.passed)
      .toBe(true);
    expect(suite.gates.find((gate) => gate.id === "affinity_is_neutral")?.passed)
      .toBe(true);
    expect(suite.gates.find((gate) => gate.id === "all_equipment_levels_monotonic")?.passed)
      .toBe(true);
    expect(suite.gates.find((gate) => gate.id === "pve_proficiency_neutral_in_pvp")?.passed)
      .toBe(true);

    const secondary = suite.duels.find((duel) =>
      duel.scenarioId === "maximum-ranged-vs-maximum-shield"
    )!;
    expect(secondary.left.power).toMatchObject({
      readiedWeaponSlot: "secondary",
      readiedWeaponCategory: "bow",
      shieldLevel: null
    });
    expect(secondary.right.power).toMatchObject({
      readiedWeaponSlot: "melee",
      readiedWeaponCategory: "axe",
      shieldLevel: 25
    });
    expect(secondary.right.power.pvpGuard).toBeGreaterThan(secondary.left.power.pvpGuard);
  });

  it("proves inventory wealth and saved-kit cardinality do not enter combat", () => {
    const controls = suite.duels.filter((duel) =>
      duel.category === "independence_control"
    );
    expect(controls.map((duel) => [
      duel.left.inventoryItemCount,
      duel.left.validKitCount
    ])).toEqual([
      [SLOT_COUNT, 1],
      [SLOT_COUNT * 6, 1],
      [SLOT_COUNT, 6],
      [SLOT_COUNT * 6, 6]
    ]);
    expect(new Set(controls.map((duel) => JSON.stringify({
      ticks: duel.ticksElapsed,
      winner: duel.winnerSide,
      leftHealth: duel.left.finalHealth,
      rightHealth: duel.right.finalHealth,
      leftTicks: duel.left.hitTicks,
      rightTicks: duel.right.hitTicks,
      leftDamage: duel.left.hitDamage,
      rightDamage: duel.right.hitDamage,
      leftPower: duel.left.power,
      rightPower: duel.right.power
    })))).toHaveProperty("size", 1);
    expect(suite.gates.find((gate) => gate.id === "inventory_size_independence")?.passed)
      .toBe(true);
    expect(suite.gates.find((gate) => gate.id === "saved_kit_count_independence")?.passed)
      .toBe(true);
  });

  it("applies complete equipment state before or after resolution without changing cadence", () => {
    const before = suite.switches.find((entry) => entry.scenarioId === "before_attack_tick")!;
    const after = suite.switches.find((entry) => entry.scenarioId === "after_attack_tick")!;
    const middle = suite.switches.find((entry) => entry.scenarioId === "mid_fight")!;
    const repeated = suite.switches.find((entry) =>
      entry.scenarioId === "repeated_each_action"
    )!;

    expect(before.activationTicks).toEqual([1]);
    expect(after.activationTicks).toEqual([2]);
    expect(middle.activationTicks).toEqual([11]);
    expect(repeated.activationTicks).toEqual(beats(2, 5));
    expect(before.attackerHitTicks).toEqual(beats(1, 3));
    expect(after.attackerHitTicks).toEqual(beats(1, 3));
    expect(repeated.attackerHitTicks).toEqual(beats(1, 6));
    expect(before.attackerHitDamage[0]).toBeGreaterThan(after.attackerHitDamage[0]!);
    expect(after.attackerHitDamage[1]).toBe(before.attackerHitDamage[0]);
    expect(suite.switches.every((entry) =>
      entry.cadencePreserved && !entry.extraAttackObserved
    )).toBe(true);
  });

  it("preserves health, equipment, targets, and cadence across a live reconnect", () => {
    expect(suite.reconnect).toMatchObject({
      scenarioId: "authority_handoff_mid_combat",
      reconnectAfterTick: 40,
      authorityRotated: true,
      oldAuthorityRejected: true,
      replacementAuthorityAccepted: true,
      healthBeforeReconnect: {
        attacker: 92,
        defender: 84
      },
      healthAfterReconnect: {
        attacker: 92,
        defender: 84
      },
      healthPreserved: true,
      targetPreserved: true,
      runtimeRestored: true,
      restoredEquipment: {
        activeKitIndex: 1,
        inventoryRevision: SLOT_COUNT,
        activeRevision: 1,
        readiedWeaponSlot: "melee",
        pvpOffense: 35,
        pvpGuard: 25,
        maximumHealth: 100
      },
      attackerHitTicks: beats(1, 4),
      attackerHitDamage: [8, 8, 8, 8],
      defenderHitTicks: beats(1 + BEAT, 3),
      attackIntervalTicks: BEAT,
      cadencePreserved: true,
      damagePreserved: true
    });
    expect(suite.gates.find((gate) =>
      gate.id === "reconnect_preserves_live_combat_state"
    )?.passed).toBe(true);
  });

  it("keeps level 0 first-class and never treats a shield as the attacking weapon", () => {
    const profile = EQUIPMENT_PROGRESSION_PROFILES[0]!;
    const levelZero = createEquipmentCombatSimulationSnapshot({
      profile,
      ownerPlayerId: "level-zero-fixture",
      fixtureId: "level-zero-fixture",
      secondary: "shield",
      readiedWeaponSlot: "melee",
      inventorySetCount: 1,
      kitLayout: "six_reused"
    });
    expect(levelZero.instances).toHaveLength(SLOT_COUNT);
    expect(levelZero.instances.every((instance) => instance.itemLevel === 0)).toBe(true);
    expect(levelZero.kits).toHaveLength(6);
    expect(levelZero.kits.every((kit) => kit.valid)).toBe(true);
    expect(levelZero.active.secondary?.category).toBe("shield");
    expect(levelZero.weapon?.category).toBe("melee_weapon");
    expect(playerEquipmentCombatStateFromSnapshot(levelZero)).toMatchObject({
      hasShield: true,
      weaponCategory: "axe",
      stats: {
        weaponItemLevel: 0,
        effectiveWeaponLevel: 0,
        maximumHealth: 100
      }
    });
  });

  it("restores a readied secondary weapon as the active combat weapon", () => {
    const snapshot = createEquipmentCombatSimulationSnapshot({
      profile: EQUIPMENT_PROGRESSION_PROFILES[0]!,
      ownerPlayerId: "ninja-readied-secondary",
      fixtureId: "ninja-readied-secondary",
      readiedWeaponSlot: "secondary"
    });

    expect(playerEquipmentCombatStateFromSnapshot(snapshot)).toMatchObject({
      activeWeaponSlot: "secondary",
      weaponCategory: "bow",
      activeWeaponInstanceId: snapshot.active.secondary?.instanceId,
      stats: {
        readiedWeaponSlot: "secondary",
        readiedWeaponCategory: "bow"
      }
    });
  });

  it("serializes stable machine-readable JSON and a concise Markdown report", () => {
    const firstJson = equipmentCombatSimulationSuiteJson(suite);
    const secondJson = equipmentCombatSimulationSuiteJson(
      runEquipmentCombatSimulationSuite()
    );
    expect(secondJson).toBe(firstJson);
    expect(JSON.parse(firstJson)).toMatchObject({
      schemaVersion: 1,
      engine: "CombatEngine",
      tickRateHz: 20
    });

    const markdown = equipmentCombatSimulationSuiteMarkdown(suite);
    expect(markdown).toContain("production `CombatEngine`");
    expect(markdown).toContain("Character 25 / Warrior 15 / gear 25 preferred");
    expect(markdown).toContain(`| ${SLOT_COUNT * 6} | 6 |`);
    expect(markdown).toContain("Switch immediately before an attack tick");
    expect(markdown).toContain("Reconnect authority handoff");
    expect(markdown).toContain("| maximum_mirror_ttk | PASS |");
    expect(suite.gates.every((gate) => gate.passed)).toBe(true);
  });
});
