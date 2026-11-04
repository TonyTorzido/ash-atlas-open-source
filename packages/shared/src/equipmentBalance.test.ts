import { describe, expect, it } from "vitest";

import { BASIC_ATTACK_INTERVAL_MS } from "./combatConstants.js";
import {
  BOOTS_CC_DURATION_REDUCTION_AT_CAP,
  BOOTS_MOVEMENT_SPEED_BONUS_AT_CAP,
  EQUIPMENT_BASE_BASIC_ATTACK,
  EQUIPMENT_UPGRADE_COSTS_V1,
  GLOVES_ACTION_DURATION_REDUCTION_AT_CAP,
  HEAD_RESOURCE_GENERATION_BONUS_AT_CAP,
  HEAD_RESOURCE_MAXIMUM_AT_CAP,
  SHIELD_DEFENSE_PER_LEVEL,
  WEAPON_SWITCH_DELAY_MS,
  WEAPON_SWITCH_HYSTERESIS_M,
  classEquipmentAffinitySnapshot,
  equipmentUpgradeCost,
  mobChallengeTier,
  resolveEquipmentAffinityBonus,
  resolveEquipmentChallengeProfile,
  resolveEquipmentCombatStats,
  resolveEquipmentItemDerivedStats,
  resolveVersionedCombatDamage,
  type EquipmentBalanceItem
} from "./equipmentBalance.js";
import {
  EQUIPMENT_DEFINITIONS,
  MAX_EQUIPMENT_LEVEL,
  emptyEquipmentSlots,
  requireEquipmentDefinition,
  type EquipmentDefinitionId,
  type EquipmentSlot
} from "./equipment.js";
import {
  EQUIPMENT_DEATH_CONDITION_LOSS,
  EQUIPMENT_MAX_CONDITION,
  EQUIPMENT_REPAIR_AMOUNT,
  conditionAfterRepair,
  equipmentRepairCostForFamily
} from "./equipmentRepair.js";

describe("equipment balance version 2", () => {
  it("keeps positive monotonic paid upgrades from level 0 to the level cap", () => {
    // The schedule is defined through Level 40; only levels below the cap are reachable.
    expect(EQUIPMENT_UPGRADE_COSTS_V1).toHaveLength(40);
    for (let currentLevel = 0; currentLevel < MAX_EQUIPMENT_LEVEL; currentLevel += 1) {
      const cost = equipmentUpgradeCost(currentLevel);
      expect(cost).toBeGreaterThan(0);
      if (currentLevel > 0) {
        expect(cost).toBeGreaterThan(equipmentUpgradeCost(currentLevel - 1));
      }
    }
    expect(equipmentUpgradeCost(0)).toBe(10);
    expect(equipmentUpgradeCost(24)).toBe(2_420);
    expect(EQUIPMENT_UPGRADE_COSTS_V1[39]).toBe(8_750);
    expect(() => equipmentUpgradeCost(25)).toThrow(/maximum level/i);
  });

  it("declares explicit scopes and keeps affinity neutral", () => {
    expect(classEquipmentAffinitySnapshot("warrior")).toBeNull();
    expect(resolveEquipmentAffinityBonus({
      classId: "warrior",
      definition: {
        category: "melee_weapon",
        weaponCategory: "axe",
        armorCategory: null
      }
    })).toBe(0);
    expect(EQUIPMENT_DEFINITIONS.training_axe.statScope).toBe("universal");
    expect(EQUIPMENT_DEFINITIONS.training_heavy_gloves.statScope).toBe("utility_only");
    expect(EQUIPMENT_DEFINITIONS.training_ring.utilityKind).toBe("none");
  });

  it.each([0, 5, 6, 10, 11, 15, 16, 20, 21, 25])(
    "uses direct raw level contributions at level %i",
    (level) => {
      const weapon = derived("training_axe", level, "melee");
      const chest = derived("breast_plate", level, "chest");
      const shield = derived("training_shield", level, "secondary");
      expect(weapon.universalAttackContribution).toBe(level);
      expect(chest.universalDefenseContribution).toBe(level);
      expect(shield.universalDefenseContribution).toBe(
        Math.round(level * SHIELD_DEFENSE_PER_LEVEL)
      );
      expect(shield.universalAttackContribution).toBe(0);
    }
  );

  it("scales eligible chest defense to durable condition and centralizes repair costs", () => {
    const full = derived("breast_plate", 25, "chest", 100);
    const damaged = derived("breast_plate", 25, "chest", 40);
    const broken = derived("breast_plate", 25, "chest", 0);
    expect(full.condition).toBe(EQUIPMENT_MAX_CONDITION);
    expect(full.universalDefenseContribution).toBe(25);
    expect(damaged.universalDefenseContribution).toBe(10);
    expect(broken.universalDefenseContribution).toBe(0);
    expect(equipmentRepairCostForFamily("breastplate")).toMatchObject({
      repairKitQuantity: 1,
      materials: [{ itemId: "iron_bar", quantity: 2 }]
    });
    expect(conditionAfterRepair(80)).toBe(100);
    expect(EQUIPMENT_REPAIR_AMOUNT).toBe(25);
    expect(EQUIPMENT_DEATH_CONDITION_LOSS).toBe(10);
  });

  it.each([0, 1, 10, 25])(
    "keeps stock and cosmetic items on identical family scaling at level %i",
    (level) => {
      const doubleAxe = derived("double_axe", level, "melee");
      const axe = derived("training_axe", level, "melee");
      const hammer = derived("hammer", level, "melee");
      const sword = derived("starter_sword", level, "melee");
      const breastPlate = derived("breast_plate", level, "chest");

      const mechanics = ({ instanceId: _instanceId, definitionId: _definitionId, ...stats }:
        ReturnType<typeof derived>) => {
        void [_instanceId, _definitionId];
        return stats;
      };
      expect(mechanics(doubleAxe)).toEqual(mechanics(axe));
      // The Hammer is its own one-handed family, scaled like every other melee weapon.
      const { weaponCategory: hammerCategory, ...hammerScaling } = mechanics(hammer);
      const { weaponCategory: _swordCategory, ...swordScaling } = mechanics(sword);
      void _swordCategory;
      expect(hammerCategory).toBe("hammer");
      expect(hammerScaling).toEqual(swordScaling);
      expect(doubleAxe.affinityBonus).toBe(0);
      expect(doubleAxe.maximumItemLevel).toBe(MAX_EQUIPMENT_LEVEL);
      expect(breastPlate.universalDefenseContribution).toBe(level);
      expect(breastPlate.affinityBonus).toBe(0);
      expect(breastPlate.maximumItemLevel).toBe(MAX_EQUIPMENT_LEVEL);
    }
  );

  it("applies the same attack and defense in PvE and PvP", () => {
    const loadout = loadoutWith({
      melee: balanceItem("training_axe", 25),
      chest: balanceItem(requireEquipmentDefinition("breast_plate").definitionId, 25),
      secondary: balanceItem("training_shield", 25)
    });
    const pve = resolveEquipmentCombatStats({
      context: "pve",
      characterLevel: 25,
      classId: "warrior",
      classRank: 15,
      loadout
    });
    const pvp = resolveEquipmentCombatStats({
      context: "pvp_open_world",
      characterLevel: 25,
      classId: "warrior",
      classRank: 15,
      loadout
    });
    expect(pve.universalAttackPower).toBe(35);
    expect(pve.universalDefense).toBe(35);
    expect(pvp.universalAttackPower).toBe(pve.universalAttackPower);
    expect(pvp.universalDefense).toBe(pve.universalDefense);
  });

  it("gives the level-0 God Sword 1,000 raw attack through normal equipment stats", () => {
    const stats = resolveEquipmentCombatStats({
      context: "pve",
      characterLevel: 25,
      classId: "warrior",
      classRank: 1,
      loadout: loadoutWith({ melee: balanceItem("god_sword", 0) })
    });

    expect(stats.weaponAttackPower.melee).toBe(1_000);
    expect(stats.universalAttackPower).toBe(1_000);
    expect(stats.bypassPveDefense).toBe(true);
  });

  it("meets the matched level-25 hit-count bands", () => {
    const weaponAndChestDamage = resolveVersionedCombatDamage({
      rawAttack: EQUIPMENT_BASE_BASIC_ATTACK + 25,
      defense: 25
    });
    const shieldDamage = resolveVersionedCombatDamage({
      rawAttack: EQUIPMENT_BASE_BASIC_ATTACK + 25,
      defense: 25 + Math.round(25 * SHIELD_DEFENSE_PER_LEVEL)
    });
    expect(Math.ceil(100 / weaponAndChestDamage)).toBeGreaterThanOrEqual(11);
    expect(Math.ceil(100 / weaponAndChestDamage)).toBeLessThanOrEqual(13);
    expect(Math.ceil(100 / shieldDamage)).toBeGreaterThanOrEqual(14);
    expect(Math.ceil(100 / shieldDamage)).toBeLessThanOrEqual(16);
  });

  it("resolves typed utility items without generic ring stats", () => {
    const heavyHead = derived("training_heavy_helm", MAX_EQUIPMENT_LEVEL, "head");
    const lightHead = derived("training_light_hood", MAX_EQUIPMENT_LEVEL, "head");
    const gloves = derived("training_heavy_gloves", MAX_EQUIPMENT_LEVEL, "gloves");
    const boots = derived("training_light_boots", MAX_EQUIPMENT_LEVEL, "boots");
    const ring = derived("training_ring", MAX_EQUIPMENT_LEVEL, "ring");
    expect(heavyHead.resourceMaximumBonus).toBe(HEAD_RESOURCE_MAXIMUM_AT_CAP);
    expect(lightHead.resourceGenerationMultiplier).toBe(
      1 + HEAD_RESOURCE_GENERATION_BONUS_AT_CAP
    );
    expect(gloves.actionDurationMultiplier).toBe(
      1 - GLOVES_ACTION_DURATION_REDUCTION_AT_CAP
    );
    expect(boots.movementSpeedMultiplier).toBe(
      1 + BOOTS_MOVEMENT_SPEED_BONUS_AT_CAP
    );
    expect(boots.crowdControlDurationMultiplier).toBe(
      1 - BOOTS_CC_DURATION_REDUCTION_AT_CAP
    );
    expect(ring.universalAttackContribution).toBe(0);
    expect(ring.universalDefenseContribution).toBe(0);
  });

  it("applies fixed ring effects without changing the challenge profile", () => {
    const chopping = derived("chopping_ring", 25, "ring");
    const mining = derived("mining_ring", 25, "ring");
    const attack = derived("attack_ring", 25, "ring");
    expect(chopping.choppingDurationMultiplier).toBe(0.8);
    expect(chopping.miningDurationMultiplier).toBe(1);
    expect(mining.miningDurationMultiplier).toBe(0.8);
    expect(mining.choppingDurationMultiplier).toBe(1);
    expect(attack.universalAttackContribution).toBe(3);

    const withoutRing = resolveEquipmentCombatStats({
      context: "pve",
      characterLevel: 25,
      classId: "warrior",
      classRank: 1,
      loadout: loadoutWith({ melee: balanceItem("starter_sword", 5) })
    });
    const withAttackRing = resolveEquipmentCombatStats({
      context: "pve",
      characterLevel: 25,
      classId: "warrior",
      classRank: 1,
      loadout: loadoutWith({
        melee: balanceItem("starter_sword", 5),
        ring: balanceItem("attack_ring", 25)
      })
    });
    expect(withAttackRing.weaponAttackPower).toEqual({ melee: 18, secondary: 13 });
    expect(withAttackRing.pveAttackPower).toBe(withoutRing.pveAttackPower + 3);
    expect(withAttackRing.challengeProfile).toEqual(withoutRing.challengeProfile);
  });

  it("tracks separate melee/ranged attacks and never treats a shield as a weapon", () => {
    const ranged = resolveEquipmentCombatStats({
      context: "pve",
      characterLevel: 25,
      classId: "hunter",
      classRank: 1,
      loadout: loadoutWith({
        melee: balanceItem("starter_sword", 5),
        secondary: balanceItem("starter_bow", 20)
      })
    });
    expect(ranged.weaponAttackPower).toEqual({ melee: 15, secondary: 30 });
    expect(ranged.weaponCategories).toEqual({ melee: "sword", secondary: "bow" });

    const shield = resolveEquipmentCombatStats({
      context: "pve",
      characterLevel: 25,
      classId: "warrior",
      classRank: 1,
      loadout: loadoutWith({
        melee: balanceItem("starter_sword", 5),
        secondary: balanceItem("training_shield", 25)
      })
    });
    expect(shield.weaponAttackPower.secondary).toBe(EQUIPMENT_BASE_BASIC_ATTACK);
    expect(shield.weaponCategories.secondary).toBeNull();
    expect(WEAPON_SWITCH_HYSTERESIS_M).toBe(5);
    expect(WEAPON_SWITCH_DELAY_MS).toBe(BASIC_ATTACK_INTERVAL_MS / 4);
  });

  it.each([
    [0, "common"],
    [5, "common"],
    [6, "uncommon"],
    [10, "uncommon"],
    [11, "rare"],
    [15, "rare"],
    [16, "epic"],
    [20, "epic"],
    [21, "legendary"],
    [25, "legendary"]
  ] as const)("maps level %i to %s and keeps unlocked monotonic", (level, tier) => {
    expect(mobChallengeTier(level)).toBe(tier);
    expect(resolveEquipmentChallengeProfile({
      meleeLevel: 3,
      chestLevel: 6,
      secondaryLevel: 9,
      secondaryCategory: "weapon",
      unlockedGearLevel: level
    }).unlockedGearLevel).toBe(Math.max(8, level));
  });

  it.each([
    [8, 8, null, null, 8],
    [10, 3, null, null, 7],
    [10, 3, 15, "weapon", 9],
    [10, 3, 6, "armor", 8],
    [10, null, null, null, 10],
    [null, 7, null, null, 7],
    [null, null, null, null, 0],
    [0, 0, null, null, 0]
  ] as const)(
    "uses ceil(mean(best weapon, best armor)) for melee %s / chest %s / secondary %s (%s) = %i",
    (meleeLevel, chestLevel, secondaryLevel, secondaryCategory, expected) => {
      expect(resolveEquipmentChallengeProfile({
        meleeLevel,
        chestLevel,
        secondaryLevel,
        secondaryCategory
      })).toMatchObject({
        currentGearLevel: expected,
        unlockedGearLevel: expected
      });
    }
  );
});

function derived(
  definitionId: string,
  itemLevel: number,
  slot: EquipmentSlot,
  condition?: number
) {
  const definition = requireEquipmentDefinition(definitionId);
  return resolveEquipmentItemDerivedStats({
    item: {
      instanceId: `${definitionId}-${itemLevel}`,
      definition,
      itemLevel,
      ...(condition === undefined ? {} : { condition })
    },
    slot,
    classId: "warrior"
  });
}

function balanceItem(
  definitionId: EquipmentDefinitionId,
  itemLevel: number
): EquipmentBalanceItem {
  return {
    instanceId: `${definitionId}-${itemLevel}`,
    definition: requireEquipmentDefinition(definitionId),
    itemLevel
  };
}

function loadoutWith(
  items: Partial<Record<EquipmentSlot, EquipmentBalanceItem>>
) {
  return {
    active: {
      ...emptyEquipmentSlots<EquipmentBalanceItem | null>(null),
      ...items
    },
    readiedWeaponSlot: "melee" as const
  };
}
