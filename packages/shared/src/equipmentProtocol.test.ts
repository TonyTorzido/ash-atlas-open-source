import { describe, expect, it } from "vitest";

import {
  combatKitActivatedMessageSchema,
  equipmentCombatStatsSchema,
  equipmentInstanceSchema,
  equipmentItemDerivedStatsSchema,
  equipmentSnapshotSchema,
  equipmentUpgradeResultMessageSchema,
  parseClientMessage,
  parseServerMessage
} from "./protocol.js";
import {
  EQUIPMENT_DEFINITIONS,
  EQUIPMENT_LOCATIONS,
  MAX_EQUIPMENT_LEVEL,
  emptyEquipmentSlots,
  type EquipmentLocation
} from "./equipment.js";
import {
  resolveEquipmentCombatStats,
  resolveEquipmentItemDerivedStats
} from "./equipmentBalance.js";

const REQUEST_ID = "stable-equipment-request";
const INSTANCE_ID = "00000000-0000-4000-8000-000000000001";

describe("equipment progression client protocol", () => {
  it("preserves level 0 in strict upgrade intent", () => {
    const request = {
      type: "UPGRADE_EQUIPMENT",
      requestId: REQUEST_ID,
      instanceId: INSTANCE_ID,
      expectedLevel: 0
    };

    expect(parseClientMessage(JSON.stringify(request))).toEqual(request);
    expect(() => parseClientMessage(JSON.stringify({ ...request, expectedLevel: -1 }))).toThrow();
    expect(() => parseClientMessage(JSON.stringify({ ...request, expectedLevel: MAX_EQUIPMENT_LEVEL + 1 }))).toThrow();
    expect(() => parseClientMessage(JSON.stringify({ ...request, goldCost: "1" }))).toThrow();
    expect(() => parseClientMessage(JSON.stringify({ ...request, resultingLevel: 1 }))).toThrow();
  });

  it("accepts only canonical family crafting and UUID-fenced manor purchases", () => {
    const authority = {
      manorSessionId: "00000000-0000-4000-8000-000000000010",
      manorMovementSequence: 7
    };
    const craft = {
      type: "CRAFT_EQUIPMENT",
      requestId: REQUEST_ID,
      familyId: "sword",
      ...authority
    };
    const purchase = {
      type: "PURCHASE_LIMITED_EQUIPMENT",
      requestId: REQUEST_ID,
      definitionId: "double_axe",
      ...authority
    };
    expect(parseClientMessage(JSON.stringify(craft))).toEqual(craft);
    expect(parseClientMessage(JSON.stringify(purchase))).toEqual(purchase);
    expect(() => parseClientMessage(JSON.stringify({
      ...craft,
      familyId: "legendary_cheat_sword"
    }))).toThrow();
    expect(() => parseClientMessage(JSON.stringify({
      ...purchase,
      manorSessionId: "not-a-session"
    }))).toThrow();
    expect(() => parseClientMessage(JSON.stringify({
      ...purchase,
      priceGold: "1"
    }))).toThrow();
    // A portable craft (starter gathering tool) may omit the Smithing Station authority.
    const portable = { type: "CRAFT_EQUIPMENT", requestId: REQUEST_ID, familyId: "wooden_axe" };
    expect(parseClientMessage(JSON.stringify(portable))).toEqual(portable);
    const { manorSessionId: _session, ...purchaseWithoutSession } = purchase;
    void _session;
    expect(() => parseClientMessage(JSON.stringify(purchaseWithoutSession))).toThrow();
  });

  it("accepts six revision-guarded kit slots and rejects client-authored loadouts", () => {
    for (const type of ["SAVE_COMBAT_KIT", "CLEAR_COMBAT_KIT", "ACTIVATE_COMBAT_KIT"] as const) {
      const request = {
        type,
        requestId: REQUEST_ID,
        kitIndex: 6,
        expectedInventoryRevision: 0
      };
      expect(parseClientMessage(JSON.stringify(request))).toEqual(request);
      expect(() => parseClientMessage(JSON.stringify({ ...request, kitIndex: 0 }))).toThrow();
      expect(() => parseClientMessage(JSON.stringify({ ...request, kitIndex: 7 }))).toThrow();
      expect(() => parseClientMessage(JSON.stringify({ ...request, items: [] }))).toThrow();
    }
  });

  it("accepts bounded kit names and only readied attack slots", () => {
    expect(parseClientMessage(JSON.stringify({
      type: "RENAME_COMBAT_KIT",
      requestId: REQUEST_ID,
      kitIndex: 1,
      name: "Ranged pressure"
    }))).toEqual({
      type: "RENAME_COMBAT_KIT",
      requestId: REQUEST_ID,
      kitIndex: 1,
      name: "Ranged pressure"
    });

    const toggle = {
      type: "TOGGLE_READIED_WEAPON",
      requestId: REQUEST_ID,
      readiedWeaponSlot: "secondary",
      expectedInventoryRevision: 0
    };
    expect(parseClientMessage(JSON.stringify(toggle))).toEqual(toggle);
    expect(() => parseClientMessage(JSON.stringify({
      ...toggle,
      readiedWeaponSlot: "shield"
    }))).toThrow();
  });

  it("requires a complete v2 snapshot and round-trips authoritative Level 0", () => {
    const snapshot = equipmentSnapshot();
    expect(equipmentSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(equipmentSnapshotSchema.parse(snapshot).instances[0]?.itemLevel).toBe(0);
    expect(equipmentSnapshotSchema.safeParse({
      ...snapshot,
      snapshotVersion: 1
    }).success).toBe(false);
    const { itemLevel: _missingLevel, ...withoutLevel } = snapshot.instances[0]!;
    expect(_missingLevel).toBe(0);
    expect(equipmentSnapshotSchema.safeParse({
      ...snapshot,
      instances: [withoutLevel]
    }).success).toBe(false);
  });

  it("accepts every authoritative equipment location and rejects unknown locations", () => {
    const instance = equipmentSnapshot().instances[0]!;
    for (const location of EQUIPMENT_LOCATIONS) {
      expect(equipmentInstanceSchema.safeParse({
        ...instance,
        location,
        equippedSlot: location === "equipped" ? "melee" : null
      }).success).toBe(true);
    }
    expect(equipmentInstanceSchema.safeParse({
      ...instance,
      location: "mail_attachment",
      equippedSlot: null
    }).success).toBe(false);
  });

  it.each(["world_drop", "market_escrow", "market_collection"] as const)(
    "parses complete equipment frames containing %s kit state",
    (location) => {
      const message = parseServerMessage(JSON.stringify({
        type: "EQUIPMENT_SNAPSHOT",
        equipment: equipmentSnapshotWithNonCarriedLocation(location)
      }));

      expect(message.type).toBe("EQUIPMENT_SNAPSHOT");
      if (message.type !== "EQUIPMENT_SNAPSHOT") return;
      expect(message.equipment.kits[0]?.items.melee).toMatchObject({ location });
      expect(message.equipment.kits[0]).toMatchObject({
        valid: false,
        invalidReason: "not_carried"
      });
      if (location === "world_drop") {
        expect(message.equipment.instances[0]).toMatchObject({ location });
      } else {
        expect(message.equipment.instances).toEqual([]);
      }
    }
  );

  it("accepts resolver-owned defense bypass fields for rings and the God Sword", () => {
    const ring = {
      instanceId: INSTANCE_ID,
      definition: EQUIPMENT_DEFINITIONS.chopping_ring,
      itemLevel: 0
    } as const;
    const ringDerived = resolveEquipmentItemDerivedStats({
      item: ring,
      slot: "ring",
      classId: "warrior"
    });
    expect(equipmentItemDerivedStatsSchema.parse(ringDerived)).toEqual(ringDerived);

    const active = emptyEquipmentSlots<Parameters<
      typeof resolveEquipmentCombatStats
    >[0]["loadout"]["active"]["ring"]>(null);
    active.ring = ring;
    active.melee = {
      instanceId: "00000000-0000-4000-8000-000000000002",
      definition: EQUIPMENT_DEFINITIONS.god_sword,
      itemLevel: 0
    };
    const combatStats = resolveEquipmentCombatStats({
      context: "pvp_open_world",
      characterLevel: 0,
      classId: "warrior",
      classRank: 0,
      loadout: { active, readiedWeaponSlot: "melee" },
      unlockedGearLevel: 0
    });
    expect(combatStats.bypassPveDefense).toBe(true);
    expect(equipmentCombatStatsSchema.parse(combatStats)).toEqual(combatStats);
  });

  it("accepts only exact one-level server upgrade results", () => {
    const result = {
      type: "EQUIPMENT_UPGRADE_RESULT",
      requestId: REQUEST_ID,
      replayed: false,
      instanceId: INSTANCE_ID,
      levelBefore: 0,
      levelAfter: 1,
      goldCost: "10",
      balanceVersion: 2,
      goldBalance: "90",
      equipment: equipmentSnapshot()
    };
    expect(equipmentUpgradeResultMessageSchema.parse(result)).toEqual(result);
    expect(equipmentUpgradeResultMessageSchema.safeParse({
      ...result,
      levelAfter: 2
    }).success).toBe(false);
  });

  it("requires activation correlation and authoritative revisions", () => {
    const activation = {
      type: "COMBAT_KIT_ACTIVATED",
      requestId: REQUEST_ID,
      kitIndex: 1,
      inventoryRevision: 2,
      activeRevision: 3,
      activationTick: 40,
      replayed: false,
      equipment: equipmentSnapshot()
    };
    expect(combatKitActivatedMessageSchema.parse(activation)).toEqual(activation);
    expect(combatKitActivatedMessageSchema.safeParse({
      ...activation,
      requestId: "",
      clientDerivedStats: {}
    }).success).toBe(false);
  });
});

function equipmentSnapshot() {
  const derived = {
    instanceId: INSTANCE_ID,
    definitionId: "starter_sword",
    slot: "melee",
    category: "melee_weapon",
    weaponCategory: "sword",
    armorCategory: null,
    twoHanded: false,
    itemLevel: 0,
    maximumItemLevel: MAX_EQUIPMENT_LEVEL,
    condition: 100,
    maximumCondition: 100,
    requiredCharacterLevel: 0,
    statScope: "universal",
    utilityKind: "none",
    affinityBonus: 0,
    effectiveItemLevel: 0,
    pveLevelScaling: 1,
    pveAttackContribution: 0,
    pveDefenseContribution: 0,
    pvpLevelContribution: 0,
    universalAttackContribution: 0,
    universalDefenseContribution: 0,
    bypassPveDefense: false,
    resourceMaximumBonus: 0,
    resourceGenerationMultiplier: 1,
    actionDurationMultiplier: 1,
    choppingDurationMultiplier: 1,
    miningDurationMultiplier: 1,
    movementSpeedMultiplier: 1,
    crowdControlDurationMultiplier: 1,
    balanceVersion: 2
  } as const;
  const instance = {
    instanceId: INSTANCE_ID,
    definitionId: "starter_sword",
    displayName: "Starter Sword",
    ownerPlayerId: "player-1",
    location: "equipped",
    equippedSlot: "melee",
    itemLevel: 0,
    maximumItemLevel: MAX_EQUIPMENT_LEVEL,
    condition: 100,
    maximumCondition: 100,
    category: "melee_weapon",
    balanceVersion: 2,
    enchantmentIdentity: null,
    attackPowerBonus: 0,
    defenseBonus: 0,
    weaponCategory: "sword",
    armorCategory: null,
    twoHanded: false,
    savedKitIndices: [1],
    derived,
    nextUpgradeCost: "10",
    nextUpgradeLevel: 1,
    upgradeDisabledReason: null,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z"
  } as const;
  const empty = {
    head: null,
    chest: null,
    gloves: null,
    boots: null,
    ring: null,
    ring_2: null,
    melee: instance,
    secondary: null,
    tool_axe: null,
    tool_pickaxe: null,
    tool_fishing_pole: null
  };
  const derivedItems = {
    head: null,
    chest: null,
    gloves: null,
    boots: null,
    ring: null,
    ring_2: null,
    melee: derived,
    secondary: null,
    tool_axe: null,
    tool_pickaxe: null,
    tool_fishing_pole: null
  };
  return {
    snapshotVersion: 2,
    balanceVersion: 2,
    playerId: "player-1",
    instances: [instance],
    active: empty,
    readiedWeaponSlot: "melee",
    activeKitIndex: null,
    kits: [1, 2, 3, 4, 5, 6].map((kitIndex) => ({
      kitIndex,
      name: `Kit ${kitIndex}`,
      readiedWeaponSlot: "melee",
      items: empty,
      valid: false,
      invalidReason: "incomplete",
      revision: 0
    })),
    inventoryRevision: 1,
    activeRevision: 1,
    checkpointRevision: 1,
    derivedStats: {
      balanceVersion: 2,
      context: "pvp_open_world",
      maximumHealth: 100,
      characterLevel: 0,
      classId: "warrior",
      classRank: 0,
      normalizedClassPower: 0,
      readiedWeaponSlot: "melee",
      readiedWeaponCategory: "sword",
      weaponItemLevel: 0,
      effectiveWeaponLevel: 0,
      weightedArmorLevel: 0,
      shieldLevel: null,
      shieldGuardBonus: 0,
      pvpOffense: 10,
      pvpGuard: 0,
      pveAttackPower: 10,
      pveDefense: 0,
      pveWeaponProficiencyMultiplier: 1,
      universalAttackPower: 10,
      universalDefense: 0,
      bypassPveDefense: false,
      weaponAttackPower: {
        melee: 10,
        secondary: 10
      },
      weaponCategories: {
        melee: "sword",
        secondary: null
      },
      resourceMaximumBonus: 0,
      resourceGenerationMultiplier: 1,
      actionDurationMultiplier: 1,
      choppingDurationMultiplier: 1,
      miningDurationMultiplier: 1,
      movementSpeedMultiplier: 1,
      crowdControlDurationMultiplier: 1,
      challengeProfile: {
        balanceVersion: 2,
        currentGearLevel: 0,
        unlockedGearLevel: 0,
        tier: "common",
        contributors: {
          melee: 0,
          chest: 0,
          secondary: 0
        }
      },
      attackIntervalMs: 1600,
      attackRangeM: 75,
      items: derivedItems
    },
    characterLevel: 0,
    repairMessage: null,
    weapon: instance,
    chest: null,
    totalAttackPowerBonus: 0,
    totalDefenseBonus: 0
  } as const;
}

function equipmentSnapshotWithNonCarriedLocation(location: EquipmentLocation) {
  const snapshot = equipmentSnapshot();
  const item = {
    ...snapshot.instances[0]!,
    location,
    equippedSlot: null
  };
  const inactive = emptyEquipmentSlots<null>(null);
  return {
    ...snapshot,
    instances: location === "world_drop" ? [item] : [],
    active: inactive,
    activeKitIndex: null,
    kits: snapshot.kits.map((kit, index) => index === 0
      ? {
          ...kit,
          items: { ...inactive, melee: item },
          valid: false,
          invalidReason: "not_carried"
        }
      : { ...kit, items: inactive }),
    weapon: null
  };
}
