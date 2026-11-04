import {
  EQUIPMENT_METAL_DEFINITIONS,
  parseEquipmentEnhancement,
  type ArmorCategory,
  type EquipmentCombatStats,
  type EquipmentSnapshotV2,
  type ReadiedWeaponSlot,
  type WeaponCategory,
  type WeaponSwitchPolicy
} from "@ash-atlas/shared";

export type PlayerEquipmentCombatState = {
  activeKitIndex: number | null;
  inventoryRevision: number;
  activeRevision: number;
  stats: EquipmentCombatStats;
  weaponCategory: WeaponCategory | null;
  chestArmorCategory: ArmorCategory | null;
  chestDefinitionId?: string | null;
  heavyArmorPieces: number;
  hasShield: boolean;
  activeWeaponInstanceId: string | null;
  activeWeaponEnchantmentIdentity: string | null;
  reactiveArmorEnhancements?: readonly Readonly<{
    instanceId: string;
    enchantmentIdentity: string;
    /** Q1 for the proc quality multiplier. */
    itemLevel?: number;
  }>[];
  /** The readied weapon when it is inscribed. */
  inscribedWeapon?: Readonly<{ instanceId: string; name: string }> | null;
  /** Worn armor pieces and shield that are inscribed. */
  inscribedArmorIds?: readonly string[];
  armorEnchantmentIdentities: Record<"head" | "chest" | "gloves" | "boots", string | null>;
  /** Any worn armor piece (chest, shield, or a legacy head/glove/boot) carries Revenant metal. */
  revenantArmor?: boolean;
  weaponSlots: Record<ReadiedWeaponSlot, {
    instanceId: string | null;
    definitionId?: string | null;
    category: WeaponCategory | null;
    enchantmentIdentity: string | null;
  }>;
  activeWeaponSlot: ReadiedWeaponSlot;
  switchPolicy: WeaponSwitchPolicy;
  switchingToSlot: ReadiedWeaponSlot | null;
  switchStartedAtTick: number | null;
  switchCompletesAtTick: number | null;
};

export function playerEquipmentCombatStateFromSnapshot(
  snapshot: EquipmentSnapshotV2
): PlayerEquipmentCombatState {
  const melee = snapshot.active.melee;
  const secondary = snapshot.active.secondary?.category === "ranged_weapon"
    ? snapshot.active.secondary
    : null;
  const activeWeapon = snapshot.active[snapshot.readiedWeaponSlot];
  const heavyArmorPieces = (["head", "chest", "gloves", "boots"] as const)
    .filter((slot) => snapshot.active[slot]?.armorCategory === "heavy")
    .length;
  // Every armor piece (head, chest, gloves, boots, shield) carrying a reactive metal.
  const reactiveArmorEnhancements = ([
    snapshot.active.head, snapshot.active.chest, snapshot.active.gloves, snapshot.active.boots,
    snapshot.active.secondary?.category === "shield" ? snapshot.active.secondary : null
  ] as const).flatMap((item) => {
    const metal = parseEquipmentEnhancement(item?.enchantmentIdentity ?? null)?.metal;
    return item && item.enchantmentIdentity && metal &&
      EQUIPMENT_METAL_DEFINITIONS[metal].armor.kind !== "event"
      ? [{
          instanceId: item.instanceId,
          enchantmentIdentity: item.enchantmentIdentity,
          itemLevel: item.itemLevel
        }]
      : [];
  });
  const revenantArmor = ([
    snapshot.active.head, snapshot.active.chest, snapshot.active.gloves, snapshot.active.boots,
    snapshot.active.secondary?.category === "shield" ? snapshot.active.secondary : null
  ] as const).some((item) => parseEquipmentEnhancement(item?.enchantmentIdentity ?? null)?.metal === "revenant");
  return normalizePlayerEquipmentCombatState({
    activeKitIndex: snapshot.activeKitIndex,
    inventoryRevision: snapshot.inventoryRevision,
    activeRevision: snapshot.activeRevision,
    stats: snapshot.derivedStats,
    weaponCategory: activeWeapon?.weaponCategory ?? null,
    chestArmorCategory: snapshot.active.chest?.armorCategory ?? null,
    chestDefinitionId: snapshot.active.chest?.definitionId ?? null,
    heavyArmorPieces,
    hasShield: snapshot.active.secondary?.category === "shield",
    activeWeaponInstanceId: activeWeapon?.instanceId ?? null,
    activeWeaponEnchantmentIdentity: activeWeapon?.enchantmentIdentity ?? null,
    reactiveArmorEnhancements,
    inscribedWeapon: activeWeapon?.inscription
      ? { instanceId: activeWeapon.instanceId, name: activeWeapon.inscription.name }
      : null,
    inscribedArmorIds: ([
      snapshot.active.head, snapshot.active.chest, snapshot.active.gloves, snapshot.active.boots,
      snapshot.active.secondary?.category === "shield" ? snapshot.active.secondary : null
    ] as const).flatMap((item) => item?.inscription ? [item.instanceId] : []),
    armorEnchantmentIdentities: {
      head: snapshot.active.head?.enchantmentIdentity ?? null,
      chest: snapshot.active.chest?.enchantmentIdentity ?? null,
      gloves: snapshot.active.gloves?.enchantmentIdentity ?? null,
      boots: snapshot.active.boots?.enchantmentIdentity ?? null
    },
    revenantArmor,
    weaponSlots: {
      melee: {
        instanceId: melee?.instanceId ?? null,
        definitionId: melee?.definitionId ?? null,
        category: melee?.weaponCategory ?? null,
        enchantmentIdentity: melee?.enchantmentIdentity ?? null
      },
      secondary: {
        instanceId: secondary?.instanceId ?? null,
        definitionId: secondary?.definitionId ?? null,
        category: secondary?.weaponCategory ?? null,
        enchantmentIdentity: secondary?.enchantmentIdentity ?? null
      }
    },
    activeWeaponSlot: snapshot.readiedWeaponSlot,
    switchPolicy: "melee_priority",
    switchingToSlot: null,
    switchStartedAtTick: null,
    switchCompletesAtTick: null
  });
}

export function normalizePlayerEquipmentCombatState(
  state: PlayerEquipmentCombatState
): PlayerEquipmentCombatState {
  if (
    state.activeKitIndex !== null &&
    (!Number.isInteger(state.activeKitIndex) ||
      state.activeKitIndex < 1 ||
      state.activeKitIndex > 6)
  ) {
    throw new Error("Active combat-kit index must be between 1 and 6");
  }
  if (!Number.isSafeInteger(state.inventoryRevision) || state.inventoryRevision < 0) {
    throw new Error("Equipment inventory revision must be a nonnegative safe integer");
  }
  if (!Number.isSafeInteger(state.activeRevision) || state.activeRevision < 0) {
    throw new Error("Equipment active revision must be a nonnegative safe integer");
  }
  if (
    !Number.isInteger(state.heavyArmorPieces) ||
    state.heavyArmorPieces < 0 ||
    state.heavyArmorPieces > 4
  ) {
    throw new Error("Heavy armor piece count must be between 0 and 4");
  }
  for (const [label, value] of [
    ["PvE attack power", state.stats.pveAttackPower],
    ["PvE defense", state.stats.pveDefense],
    ["PvP Offense", state.stats.pvpOffense],
    ["PvP Guard", state.stats.pvpGuard]
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${label} must be a nonnegative finite number`);
    }
  }

  if (
    state.activeWeaponSlot !== "melee" &&
    state.activeWeaponSlot !== "secondary"
  ) {
    throw new Error("Active weapon slot must be melee or secondary");
  }
  for (const slot of ["head", "chest", "gloves", "boots"] as const) {
    const identity = state.armorEnchantmentIdentities[slot];
    if (identity !== null && typeof identity !== "string") {
      throw new Error(`Armor enhancement identity for ${slot} must be a string or null`);
    }
  }
  const active = state.weaponSlots[state.activeWeaponSlot];
  if (
    state.activeWeaponInstanceId !== active.instanceId ||
    state.weaponCategory !== active.category ||
    state.activeWeaponEnchantmentIdentity !== active.enchantmentIdentity
  ) {
    throw new Error("Active weapon identity must match the active runtime slot");
  }
  if (
    state.switchingToSlot === null
      ? state.switchStartedAtTick !== null || state.switchCompletesAtTick !== null
      : state.switchStartedAtTick === null ||
        state.switchCompletesAtTick === null ||
        state.switchCompletesAtTick < state.switchStartedAtTick
  ) {
    throw new Error("Weapon switch timing is incomplete");
  }
  return structuredClone(state);
}

export function telemetryEquipmentState(state: PlayerEquipmentCombatState): {
  activeKitIndex: number | null;
  readiedWeaponSlot: "melee" | "secondary";
  weaponCategory: string | null;
  weaponItemLevel: number | null;
  effectiveWeaponLevel: number | null;
  weightedArmorLevel: number;
  shieldLevel: number | null;
  pvpOffense: number;
  pvpGuard: number;
} {
  return {
    activeKitIndex: state.activeKitIndex,
    readiedWeaponSlot: state.stats.readiedWeaponSlot,
    weaponCategory: state.stats.readiedWeaponCategory,
    weaponItemLevel: state.activeWeaponInstanceId === null
      ? null
      : state.stats.weaponItemLevel,
    effectiveWeaponLevel: state.activeWeaponInstanceId === null
      ? null
      : state.stats.effectiveWeaponLevel,
    weightedArmorLevel: state.stats.weightedArmorLevel,
    shieldLevel: state.stats.shieldLevel,
    pvpOffense: state.stats.pvpOffense,
    pvpGuard: state.stats.pvpGuard
  };
}
