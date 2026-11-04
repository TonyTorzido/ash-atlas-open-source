import type { CombatContext } from "@ash-atlas/shared";

export const EQUIPMENT_PROC_RULESET_VERSION = 1 as const;

export type EquipmentProcStatusApplication = {
  statusId: string;
  applied: boolean;
};

export type EquipmentProcTelemetry = {
  rulesetVersion: typeof EQUIPMENT_PROC_RULESET_VERSION;
  enchantmentIdentity: string | null;
  evaluated: boolean;
  triggered: boolean;
  roll: number | null;
  reason: "null_enchantment" | "not_landed" | "not_weapon_attack" | "unsupported" | "resolved";
};

export type EquipmentProcResolution = {
  statusApplications: readonly EquipmentProcStatusApplication[];
  telemetry: EquipmentProcTelemetry;
};

export type EquipmentProcInput = {
  combatContext: CombatContext;
  actionSequence: number;
  attackerEntityId: string;
  targetEntityId: string;
  activeWeaponInstanceId: string | null;
  enchantmentIdentity: string | null;
  landed: boolean;
  qualifyingWeaponAttack: boolean;
  appliedDamage: number;
  procSource?: "weapon" | "armor";
  procContext?: EquipmentProcContext;
};

/** Live combat facts the metal proc chance depends on (HP after the hit, item quality, kills). */
export type EquipmentProcContext = Readonly<{
  /** HP fraction (0..1) of the opposing combatant after the hit: the target for weapons, the wearer for armor. */
  victimHealthFraction: number;
  /** Q1: item level of the gear carrying the metal. */
  attackerQuality: number;
  /** Q2: level of the opposing piece (chest or shield, weapon, or mob level / 5). */
  defenderQuality: number;
  /** The hit that triggered this proc killed its victim. */
  killingBlow: boolean;
}>;

export type EquipmentEnchantmentHandler = {
  enchantmentIdentity: string;
  resolve(
    input: EquipmentProcInput & { activeWeaponInstanceId: string; roll: number }
  ): Omit<EquipmentProcResolution, "telemetry"> & {
    triggered: boolean;
  };
};

/**
 * Server-owned extension point for future enchanted-material procs.
 *
 * Null enchantments and equipment swaps never consume randomness or apply
 * status. A handler receives a deterministic injected random sample only after
 * a qualifying weapon attack has landed.
 */
export class EquipmentWeaponProcResolver {
  private readonly handlers: ReadonlyMap<string, EquipmentEnchantmentHandler>;

  constructor(
    handlers: readonly EquipmentEnchantmentHandler[] = [],
    private readonly random: () => number = Math.random
  ) {
    this.handlers = new Map(handlers.map((handler) => [
      requireStableIdentity(handler.enchantmentIdentity),
      handler
    ]));
    if (this.handlers.size !== handlers.length) {
      throw new Error("Duplicate equipment enchantment handler identity");
    }
  }

  resolve(input: EquipmentProcInput): EquipmentProcResolution {
    requireNonnegativeInteger(input.actionSequence, "combat action sequence");
    requireNonnegativeInteger(input.appliedDamage, "applied damage");
    if (!input.landed) return noProc(input.enchantmentIdentity, "not_landed");
    if (!input.qualifyingWeaponAttack || input.activeWeaponInstanceId === null) {
      return noProc(input.enchantmentIdentity, "not_weapon_attack");
    }
    if (input.enchantmentIdentity === null) return noProc(null, "null_enchantment");
    const identity = requireStableIdentity(input.enchantmentIdentity);
    const handler = this.handlers.get(identity);
    if (!handler) return noProc(identity, "unsupported");
    const roll = requireRoll(this.random());
    const result = handler.resolve({
      ...input,
      activeWeaponInstanceId: input.activeWeaponInstanceId,
      enchantmentIdentity: identity,
      roll
    });
    return {
      statusApplications: result.statusApplications.map((application) => ({
        statusId: requireStableIdentity(application.statusId),
        applied: Boolean(application.applied)
      })),
      telemetry: {
        rulesetVersion: EQUIPMENT_PROC_RULESET_VERSION,
        enchantmentIdentity: identity,
        evaluated: true,
        triggered: Boolean(result.triggered),
        roll,
        reason: "resolved"
      }
    };
  }
}

function requireRoll(roll: number): number {
  if (!Number.isFinite(roll) || roll < 0 || roll >= 1) {
    throw new Error("Equipment proc random source must return a value in [0, 1)");
  }
  return roll;
}

function noProc(
  enchantmentIdentity: string | null,
  reason: EquipmentProcTelemetry["reason"]
): EquipmentProcResolution {
  return {
    statusApplications: [],
    telemetry: {
      rulesetVersion: EQUIPMENT_PROC_RULESET_VERSION,
      enchantmentIdentity,
      evaluated: false,
      triggered: false,
      roll: null,
      reason
    }
  };
}

function requireStableIdentity(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(value)) {
    throw new Error("Equipment enchantment identity must be a bounded stable ID");
  }
  return value;
}

function requireNonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative safe integer`);
  }
  return value;
}
