import { describe, expect, it } from "vitest";

import {
  ARMORY_REPAIR_KIT_INPUTS,
  BALLISTA_STRUCTURAL_DAMAGE_PER_MEMBER,
  MILITARY_ART_HOOKS,
  militaryHumanRecoveryDurationMs,
  LODGE_CAPACITY_BY_LEVEL,
  LODGE_COSTS,
  MILITARY_FACILITY_QUEUE_CAPACITY,
  MILITARY_MAX_FUSION_SIZE,
  MILITARY_FUSION_RANGE_M,
  MILITARY_UNIT_ATTACK_DAMAGE,
  MILITARY_UNIT_ATTACK_RANGE_M,
  MILITARY_UNIT_MAX_HP,
  MILITARY_UNIT_RECIPES,
  bomberCrudeOilCost,
  MILITARY_CITY_FACILITY_COSTS,
  MILITARY_BALLISTA_VOLLEY_CADENCE_MS,
  MILITARY_BOMBER_CHANNEL_DURATION_MS,
  SIEGE_ATTACK_RANGE_METERS,
  SIEGE_ATTACK_RANGE_TOLERANCE_METERS,
  MILITARY_FOLLOW_DISTANCE_M,
  MILITARY_FOLLOW_FORMATION_SPACING_M,
  MILITARY_FOLLOW_SPEED_RATIO,
  TOWER_ATTACK_RANGE_METERS,
  isWithinSiegeAttackRange,
  planMilitaryGroupAttack,
  planBallistaStructuralDamage,
  militaryGroupDisplayName,
  militaryUnitDisplayName,
  POWDER_WORKS_TORCH_INPUTS,
  POWDER_WORKS_TORCH_OUTPUT_QUANTITY,
  SIEGE_CREW_CAPACITY_COST,
  SIEGE_CREW_TRAINING_COST
} from "./militaryIndustry.js";
import {
  STRUCTURE_WARFARE_BASE_HEALTH,
  STRUCTURE_WARFARE_HARDENED_BURN_THRESHOLD_HEALTH,
  STRUCTURE_WARFARE_HARDENED_HEALTH,
  STRUCTURE_WARFARE_STONE_BURN_DURATION_MS,
  STRUCTURE_WARFARE_TOWER_BURN_DURATION_MS,
  STRUCTURE_WARFARE_TOWER_BURN_THRESHOLD_HEALTH,
  STRUCTURE_WARFARE_TOWER_HEALTH,
  STRUCTURE_WARFARE_BOMBER_DAMAGE,
  structureWarfareBreachThresholdForReinforcementLevel,
  structureWarfareHealthForReinforcementLevel
} from "./structureWarfare.js";

describe("Military Industry V1 contracts", () => {
  it("keeps the Lodge capacity curve bounded at ten personnel slots", () => {
    expect(LODGE_CAPACITY_BY_LEVEL).toEqual({ 1: 2, 2: 4, 3: 6, 4: 8, 5: 10 });
    expect(Math.max(...Object.values(LODGE_CAPACITY_BY_LEVEL))).toBe(10);
    expect(LODGE_COSTS[1].materials).toEqual([
      { itemId: "wood", quantity: 50 },
      { itemId: "stone", quantity: 25 },
      { itemId: "leather", quantity: 5 },
      { itemId: "cloth", quantity: 5 }
    ]);
  });

  it("keeps retired personnel compatibility and bounded shared queues", () => {
    expect(SIEGE_CREW_CAPACITY_COST).toBe(2);
    expect(SIEGE_CREW_TRAINING_COST).toEqual({ food: 3, gold: 100, cloth: 2, leather: 2 });
    expect(MILITARY_FACILITY_QUEUE_CAPACITY).toBe(5);
  });

  it("keeps production recipes and siege values centralized", () => {
    expect(ARMORY_REPAIR_KIT_INPUTS).toEqual([
      { itemId: "chitin", quantity: 2 },
      { itemId: "balsam_resin", quantity: 1 }
    ]);
    expect(POWDER_WORKS_TORCH_INPUTS).toEqual([
      { itemId: "coal", quantity: 10 },
      { itemId: "crude_oil", quantity: 100 }
    ]);
    expect(POWDER_WORKS_TORCH_OUTPUT_QUANTITY).toBe(25);
    expect(MILITARY_MAX_FUSION_SIZE).toBe(6);
    expect(MILITARY_FUSION_RANGE_M).toBe(1_000);
    expect(MILITARY_UNIT_MAX_HP).toEqual({ infantry: 100, archer: 80, bomber: 60, field_ballista: 150 });
    expect(MILITARY_UNIT_ATTACK_DAMAGE).toEqual({ infantry: 11, archer: 9, bomber: 2, field_ballista: 0 });
    expect(MILITARY_UNIT_ATTACK_RANGE_M).toEqual({ infantry: 100, archer: 300, bomber: 100, field_ballista: 0 });
    expect(MILITARY_UNIT_RECIPES.infantry.durationMs).toBe(60_000);
    expect(MILITARY_UNIT_RECIPES.archer.durationMs).toBe(75_000);
    expect(MILITARY_UNIT_RECIPES.bomber.durationMs).toBe(90_000);
    expect(MILITARY_UNIT_RECIPES.field_ballista.durationMs).toBe(120_000);
    expect(MILITARY_UNIT_RECIPES.infantry.gold).toBe(50);
    expect(MILITARY_UNIT_RECIPES.infantry.materials).toEqual([
      { itemId: "simple_food", quantity: 50 },
      { itemId: "wood", quantity: 50 },
      { itemId: "leather", quantity: 25 }
    ]);
    expect(MILITARY_UNIT_RECIPES.archer.gold).toBe(75);
    expect(MILITARY_UNIT_RECIPES.archer.materials).toEqual([
      { itemId: "simple_food", quantity: 50 },
      { itemId: "wood", quantity: 75 },
      { itemId: "cloth", quantity: 25 }
    ]);
    expect(MILITARY_UNIT_RECIPES.bomber.gold).toBe(0);
    expect(MILITARY_UNIT_RECIPES.bomber.materials).toEqual([
      { itemId: "simple_food", quantity: 100 },
      { itemId: "sulfur", quantity: 6 },
      { itemId: "crude_oil", quantity: 55 }
    ]);
    expect(bomberCrudeOilCost(0)).toBe(55);
    expect(bomberCrudeOilCost(3)).toBe(190);
    expect(bomberCrudeOilCost(2, 3)).toBe(145 + 190 + 235);
    expect(MILITARY_UNIT_RECIPES.field_ballista.gold).toBe(250);
    expect(MILITARY_UNIT_RECIPES.field_ballista.materials).toEqual([
      { itemId: "simple_food", quantity: 100 },
      { itemId: "iron_bar", quantity: 25 },
      { itemId: "wood", quantity: 150 },
      { itemId: "cloth", quantity: 75 }
    ]);
    expect(MILITARY_CITY_FACILITY_COSTS.barracks).toEqual({
      materials: [
        { itemId: "wood", quantity: 250 },
        { itemId: "stone", quantity: 200 },
        { itemId: "iron_bar", quantity: 10 },
        { itemId: "leather", quantity: 10 },
        { itemId: "cloth", quantity: 10 }
      ],
      cityCoins: 500
    });
    expect(MILITARY_CITY_FACILITY_COSTS.demolition_factory).toEqual({
      materials: [
        { itemId: "iron_bar", quantity: 100 },
        { itemId: "sulfur", quantity: 100 },
        { itemId: "cloth", quantity: 200 },
        { itemId: "wood", quantity: 500 }
      ],
      cityCoins: 0
    });
    expect(MILITARY_BOMBER_CHANNEL_DURATION_MS).toBe(5_000);
    expect(MILITARY_UNIT_RECIPES.bomber.facility).toBe("demolition_factory");
    expect(MILITARY_UNIT_RECIPES.field_ballista.facility).toBe("demolition_factory");
    expect(BALLISTA_STRUCTURAL_DAMAGE_PER_MEMBER).toBe(7);
    expect(MILITARY_BALLISTA_VOLLEY_CADENCE_MS).toBe(75_000);
    expect(MILITARY_ART_HOOKS.field_ballista.fallbackKey).toBe("ballista-with-crew-silhouette");
    expect(SIEGE_ATTACK_RANGE_METERS).toBe(575);
    expect(isWithinSiegeAttackRange(SIEGE_ATTACK_RANGE_METERS)).toBe(true);
    expect(isWithinSiegeAttackRange(SIEGE_ATTACK_RANGE_METERS + SIEGE_ATTACK_RANGE_TOLERANCE_METERS * 2)).toBe(false);
    expect(MILITARY_FOLLOW_DISTANCE_M).toBe(125);
    expect(MILITARY_FOLLOW_FORMATION_SPACING_M).toBe(50);
    expect(MILITARY_FOLLOW_SPEED_RATIO).toBe(0.7);
    expect(TOWER_ATTACK_RANGE_METERS).toBe(450);
  });

  it("centralizes Kippen military group names and bounded fusion levels", () => {
    expect(militaryUnitDisplayName("field_ballista")).toBe("Kippen Siege");
    expect(militaryUnitDisplayName("bomber")).toBe("Kippen Bomber");
    expect(militaryGroupDisplayName("field_ballista", 1)).toBe("Kippen Siege +1");
    expect(militaryGroupDisplayName("bomber", 4)).toBe("Kippen Bomber +4");
    expect(militaryGroupDisplayName("bomber", 99)).toBe("Kippen Bomber +6");
  });

  it("plans one sustained Ballista volley per underlying member", () => {
    expect(planBallistaStructuralDamage(200, 1)).toBe(7);
    expect(planBallistaStructuralDamage(200, 6)).toBe(42);
    expect(planBallistaStructuralDamage(145, 6)).toBe(42);
    expect(planBallistaStructuralDamage(2_400, 6, 1_200)).toBe(42);
    expect(planBallistaStructuralDamage(100, 6)).toBe(0);
  });

  it("keeps Siege damage exact across fusion levels and repeated minutes", () => {
    for (let level = 1; level <= MILITARY_MAX_FUSION_SIZE; level += 1) {
      expect(planBallistaStructuralDamage(STRUCTURE_WARFARE_TOWER_HEALTH, level, 1_200)).toBe(7 * level);
    }

    let health = STRUCTURE_WARFARE_TOWER_HEALTH;
    for (let minute = 1; minute <= 10; minute += 1) {
      health -= planBallistaStructuralDamage(health, MILITARY_MAX_FUSION_SIZE, 1_200);
      if (minute === 1) {
        expect(health).toBe(2_658);
      }
    }
    expect(health).toBe(2_280);
  });

  it("keeps the tier durability and demolition contract explicit", () => {
    expect(STRUCTURE_WARFARE_BASE_HEALTH).toBe(220);
    expect(STRUCTURE_WARFARE_HARDENED_HEALTH).toBe(220);
    expect(STRUCTURE_WARFARE_HARDENED_BURN_THRESHOLD_HEALTH).toBe(110);
    expect(STRUCTURE_WARFARE_STONE_BURN_DURATION_MS).toBe(22 * 60 * 60 * 1_000);
    expect(STRUCTURE_WARFARE_TOWER_HEALTH).toBe(2_700);
    expect(STRUCTURE_WARFARE_TOWER_BURN_THRESHOLD_HEALTH).toBe(1_350);
    expect(STRUCTURE_WARFARE_TOWER_BURN_DURATION_MS).toBe(22 * 60 * 60 * 1_000);
    expect(STRUCTURE_WARFARE_BOMBER_DAMAGE).toBe(1_150);
    expect(structureWarfareHealthForReinforcementLevel(1)).toBe(220);
    expect(structureWarfareHealthForReinforcementLevel(3)).toBe(2_700);
    expect(structureWarfareBreachThresholdForReinforcementLevel(0)).toBe(110);
    expect(structureWarfareBreachThresholdForReinforcementLevel(1)).toBe(110);
    expect(structureWarfareBreachThresholdForReinforcementLevel(3)).toBe(1_350);
  });

  it("aggregates ordinary attacks by surviving members and keeps Ballistas structure-only", () => {
    expect(planMilitaryGroupAttack("infantry", 6)).toEqual({
      memberCount: 6,
      damage: 66,
      rangeM: 100,
      sourceTechniqueId: "military_infantry_basic_attack"
    });
    expect(planMilitaryGroupAttack("infantry", 5)?.damage).toBe(55);
    expect(planMilitaryGroupAttack("archer", 3)).toEqual({
      memberCount: 3,
      damage: 27,
      rangeM: 300,
      sourceTechniqueId: "military_archer_basic_attack"
    });
    expect(planMilitaryGroupAttack("bomber", 2)?.damage).toBe(4);
    expect(planMilitaryGroupAttack("field_ballista", 6)).toBeNull();
    expect(planMilitaryGroupAttack("infantry", 0)).toBeNull();
  });
});

describe("military human recovery", () => {
  it("takes 20 minutes, or 28 against a Watchfires kingdom at war", () => {
    expect(militaryHumanRecoveryDurationMs(false)).toBe(20 * 60_000);
    expect(militaryHumanRecoveryDurationMs(true)).toBe(28 * 60_000);
  });
});
