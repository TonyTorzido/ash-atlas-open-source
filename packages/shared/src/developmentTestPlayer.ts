import {
  DEFAULT_PLAYER_BODY_VARIANT_ID, projectPlayerAppearance,
  type PlayerAppearanceCatalog
} from "./appearance.js";
import { DEFAULT_PLAYER_APPEARANCE_CATALOG } from "./appearanceCatalog.js";
import { classLevelForXp, classLevelXp, type ClassSnapshot } from "./classes.js";
import {
  emptyEquipmentSlots, EQUIPMENT_BALANCE_VERSION, EQUIPMENT_GAMEPLAY_FAMILIES, MAX_EQUIPMENT_LEVEL,
  requireEquipmentDefinition, type EquipmentInstanceV2, type EquipmentSnapshotV2
} from "./equipment.js";
import { resolveEquipmentCombatStats, resolveEquipmentItemDerivedStats } from "./equipmentBalance.js";

/** Ordinary, unboosted generic actor for development hosts. All art/stats resolve from gameplay catalogs. */
export const DEFAULT_DEVELOPMENT_TEST_PLAYER = Object.freeze({
  classId: "warrior" as const,
  characterLevel: 0,
  classXp: 0,
  equipmentLevel: 0,
  weaponDefinitionId: EQUIPMENT_GAMEPLAY_FAMILIES.axe.stockDefinitionId!,
  armorDefinitionId: EQUIPMENT_GAMEPLAY_FAMILIES.breastplate.stockDefinitionId!,
  bodyVariantId: DEFAULT_PLAYER_BODY_VARIANT_ID,
  styles: Object.freeze({ eyes: "blue-eyes", hair: "viking-hair", beard: "blonde-beard" })
});

export function createDevelopmentTestPlayer(
  playerId: string,
  catalog: PlayerAppearanceCatalog = DEFAULT_PLAYER_APPEARANCE_CATALOG
) {
  const profile = DEFAULT_DEVELOPMENT_TEST_PLAYER;
  const classRank = classLevelForXp(profile.classXp, profile.classId);
  const active = emptyEquipmentSlots<EquipmentInstanceV2 | null>(null);
  for (const definitionId of [profile.weaponDefinitionId, profile.armorDefinitionId]) {
    const definition = requireEquipmentDefinition(definitionId);
    const instanceId = `${playerId}:${definitionId}`;
    const item = { instanceId, definition, itemLevel: profile.equipmentLevel };
    active[definition.slot] = {
      instanceId, definitionId, displayName: definition.displayName, ownerPlayerId: playerId,
      location: "equipped", equippedSlot: definition.slot, itemLevel: profile.equipmentLevel,
      maximumItemLevel: MAX_EQUIPMENT_LEVEL, category: definition.category,
      balanceVersion: EQUIPMENT_BALANCE_VERSION, enchantmentIdentity: null,
      attackPowerBonus: definition.attackPowerBonus, defenseBonus: definition.defenseBonus,
      weaponCategory: definition.weaponCategory, armorCategory: definition.armorCategory,
      twoHanded: definition.twoHanded, savedKitIndices: [],
      derived: resolveEquipmentItemDerivedStats({ item, slot: definition.slot, classId: profile.classId }),
      nextUpgradeLevel: null, nextUpgradeCost: null, upgradeDisabledReason: null,
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()
    };
  }
  const balanceActive = emptyEquipmentSlots<{
    instanceId: string; definition: ReturnType<typeof requireEquipmentDefinition>; itemLevel: number;
  } | null>(null);
  for (const item of Object.values(active)) if (item?.equippedSlot) {
    balanceActive[item.equippedSlot] = { instanceId: item.instanceId,
      definition: requireEquipmentDefinition(item.definitionId), itemLevel: item.itemLevel };
  }
  const derivedStats = resolveEquipmentCombatStats({ context: "pve", characterLevel: profile.characterLevel,
    classId: profile.classId, classRank, loadout: { active: balanceActive, readiedWeaponSlot: "melee" } });
  const equipment: EquipmentSnapshotV2 = {
    playerId, snapshotVersion: 2, balanceVersion: EQUIPMENT_BALANCE_VERSION,
    instances: Object.values(active).filter((item): item is EquipmentInstanceV2 => item !== null),
    active, readiedWeaponSlot: "melee", activeKitIndex: null, kits: [],
    inventoryRevision: 1, activeRevision: 1, checkpointRevision: 1,
    derivedStats, characterLevel: profile.characterLevel, repairMessage: null,
    weapon: active.melee, chest: active.chest,
    totalAttackPowerBonus: active.melee?.attackPowerBonus ?? 0,
    totalDefenseBonus: active.chest?.defenseBonus ?? 0
  };
  const classes: ClassSnapshot = {
    playerId, characterLevel: profile.characterLevel, activeClassId: profile.classId, activeSubclassId: null,
    warrior: { classId: profile.classId, level: classRank, xp: profile.classXp,
      nextLevelXp: classLevelXp(profile.classId)[classRank + 1] ?? null, completedAt: null },
    subclasses: [], loadout: { resetActives: [null, null], normalActives: [null, null],
      passiveTiers: [null, null, null], ultimateActive: null },
    legacyIds: [], rage: 0, maximumRage: 0, queuedAbility: null, cooldownEndsAt: {}, serverTime: 0, revision: 1
  };
  return {
    profile, equipment, classes,
    appearance: projectPlayerAppearance(equipment, catalog, {}, undefined, profile.bodyVariantId, profile.styles)
  };
}
