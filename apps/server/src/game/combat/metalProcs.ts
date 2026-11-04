import {
  ENCHANTMENT_STONE_VARIANTS,
  EQUIPMENT_METAL_DEFINITIONS,
  EQUIPMENT_METAL_IDS,
  metalEquipmentEnhancement,
  metalProcQualityMultiplier,
  parseEquipmentEnhancement,
  serializeEquipmentEnhancement,
  type EquipmentMetal,
  type MetalProcChance
} from "@ash-atlas/shared";

import type { EquipmentEnchantmentHandler, EquipmentProcContext } from "./equipmentProc.js";

/**
 * Every tunable metal proc number besides the proc chances, which live in the
 * shared metal registry (`EQUIPMENT_METAL_DEFINITIONS`). Durations are in ms.
 */
export const METAL_PROC_BALANCE = Object.freeze({
  /** Venom. Immune: constructs, ghost and wraith types (shelled mobs are skipped by the engine). */
  poison: Object.freeze({
    damageMin: 3, damageMax: 6, tickMs: 3_200, durationMs: 55_000,
    immuneArchetypes: Object.freeze(["moss_golem", "frost_wraith", "barrow_wight", "revenant_lich"] as readonly string[])
  }),
  /** Ember. Immune: dragons, phoenix and fire types. */
  burning: Object.freeze({
    damageMin: 2, damageMax: 5, tickMs: 3_300, durationMs: 27_000,
    spreadChancePerTick: 0.22, spreadRadiusM: 90,
    /** A spread fire lasts this fraction of its parent's full duration. */
    spreadDurationFraction: 0.45,
    /** A fire shorter than this cannot spread. */
    minSpreadDurationMs: 4_500,
    immuneArchetypes: Object.freeze(["fire_bird"] as readonly string[])
  }),
  /** Frost: speed multiplier is `1 - slowFraction`. */
  frost: Object.freeze({ slowFraction: 0.45, dodgeMultiplier: 0.88, durationMs: 27_000 }),
  /** Storm: every pulse, each enemy this player electrified within radius takes damage. */
  storm: Object.freeze({ durationMs: 27_000, pulseMs: 4_500, radiusM: 230, damageMin: 4, damageMax: 7 }),
  whetted: Object.freeze({ defenseReduction: 5, attackReduction: 4, durationMs: 52_000 }),
  gloom: Object.freeze({ durationMs: 17_000 }),
  expel: Object.freeze({ immunityMs: 55_000 }),
  mirage: Object.freeze({
    blinkRadiusM: 45, escapeMinM: 110, escapeMaxM: 185, blinkAttempts: 5,
    bonusDamage: 6, bonusWindowMs: 5_500
  }),
  gale: Object.freeze({ radiusM: 90, knockbackM: 55, damage: 6, maximumTargets: 10 }),
  fleet: Object.freeze({ stealFraction: 0.22, durationMs: 11_000 }),
  vengeance: Object.freeze({ weaponDamage: 11, armorDamage: 6, windowMs: 5_500 }),
  skyrise: Object.freeze({ immobilizeMs: 3_500, immunityMs: 4_500 }),
  vital: Object.freeze({ healMin: 3, healMax: 8 })
});

/** The ordered pieces of one armor metal; the highest-level piece represents it. */
export type ArmorMetalPiece = Readonly<{
  instanceId: string;
  enchantmentIdentity: string;
  itemLevel: number;
}>;

export type DistinctArmorMetal = Readonly<{ metal: EquipmentMetal } & ArmorMetalPiece>;

/** Armor metals with a reactive (non-event) effect. Revenant is handled by its own phase. */
export function isReactiveProcMetal(metal: EquipmentMetal | null | undefined): metal is EquipmentMetal {
  return metal !== null && metal !== undefined && EQUIPMENT_METAL_DEFINITIONS[metal].armor.kind !== "event";
}

/**
 * Several armor pieces carrying the same metal do not stack: each distinct metal
 * rolls once per incoming hit, using the highest-level piece carrying it.
 */
export function distinctArmorMetals(pieces: readonly ArmorMetalPiece[]): readonly DistinctArmorMetal[] {
  const best = new Map<EquipmentMetal, DistinctArmorMetal>();
  for (const piece of pieces) {
    const metal = parseEquipmentEnhancement(piece.enchantmentIdentity)?.metal;
    if (!isReactiveProcMetal(metal)) continue;
    const current = best.get(metal);
    if (!current || piece.itemLevel > current.itemLevel) best.set(metal, { metal, ...piece });
  }
  return EQUIPMENT_METAL_IDS.flatMap((metal) => {
    const entry = best.get(metal);
    return entry ? [entry] : [];
  });
}

function baseChance(chance: MetalProcChance, victimHealthFraction: number): number {
  switch (chance.kind) {
    case "fixed": return chance.chance;
    case "missing_hp":
      return chance.base + chance.perMissingHp * (1 - Math.min(1, Math.max(0, victimHealthFraction)));
    case "event": return 0;
  }
}

/**
 * Final proc probability: the registry chance (flat or missing-HP based) times the
 * proc quality multiplier. A killing blow from a Expel weapon, or onto a Expel
 * wearer, always expels.
 */
export function metalProcChance(
  metal: EquipmentMetal,
  procSource: "weapon" | "armor",
  context: EquipmentProcContext
): number {
  const definition = EQUIPMENT_METAL_DEFINITIONS[metal];
  if (metal === "expel" && context.killingBlow) return 1;
  const chance = baseChance(definition[procSource], context.victimHealthFraction);
  const multiplier = metalProcQualityMultiplier(context.attackerQuality, context.defenderQuality);
  return Math.min(1, Math.max(0, chance * multiplier));
}

export function metalProcHandlers(): readonly EquipmentEnchantmentHandler[] {
  return [...ENCHANTMENT_STONE_VARIANTS, null].flatMap((gemstone) =>
    EQUIPMENT_METAL_IDS.filter(isReactiveProcMetal).map((metal) => ({
      enchantmentIdentity: serializeEquipmentEnhancement(metalEquipmentEnhancement(gemstone, metal)),
      resolve(input) {
        const chance = metalProcChance(metal, input.procSource ?? "weapon", input.procContext ?? NEUTRAL_CONTEXT);
        const triggered = input.roll < chance;
        return {
          triggered,
          statusApplications: [{ statusId: EQUIPMENT_METAL_DEFINITIONS[metal].effect, applied: triggered }]
        };
      }
    } satisfies EquipmentEnchantmentHandler))
  );
}

const NEUTRAL_CONTEXT: EquipmentProcContext = Object.freeze({
  victimHealthFraction: 1, attackerQuality: 0, defenderQuality: 0, killingBlow: false
});
