import type { WeaponCategory } from "@ash-atlas/shared";
import {
  BASIC_ATTACK_RESET_COOLDOWN_GROUP,
  CLASS_DEFINITIONS,
  CLASS_SLOT_MILESTONES,
  TECHNIQUE_BY_ID,
  UNIVERSAL_TAUNT_ID,
  isLaunchClassId,
  isSingleTargetSupportTechnique,
  type AbilityTargetMode,
  type ClassCombatState,
  type ClassId,
  type ClassSnapshot,
  type PveCombatSessionSnapshot,
  type TechniqueDefinition
} from "@ash-atlas/shared";

export type ClassAbilityTargetSelection = {
  mode: AbilityTargetMode;
  targetEntityId: string | null;
  friendlyTargetEntityId?: string | null;
};

export type ClassAbilityTargetOption = {
  entityId: string;
  label: string;
  available?: boolean;
  unavailableReason?: string | null;
};

export type ClassCombatSlotModel = {
  id: string | null;
  definition: TechniqueDefinition | null;
  name: string;
  locked: boolean;
  lockLevel: number;
  cooldownMs: number;
  pending: boolean;
  unavailableText: string | null;
  resourceAmount: number;
  resourceCost: number;
  resourceProgress: number | null;
  insufficientResource: boolean;
  isActuallyReady: boolean;
  disabled: boolean;
  singleTargetSupport: boolean;
  selfTargetAvailable: boolean;
  target: ClassAbilityTargetSelection | null;
  activation: "armed" | "instant" | "drag";
};

export type ClassCombatControlModel = {
  className: string;
  resourceAmount: number;
  resourceMaximum: number;
  resourceName: string;
  weaponMode: "ranged" | "melee" | null;
  effectiveTargetSelection: ClassAbilityTargetSelection;
  resetSlots: readonly ClassCombatSlotModel[];
  normalSlots: readonly ClassCombatSlotModel[];
  activationLockoutMs: number;
  statusIndicators: readonly { id: string; text: string; remainingMs: number | null }[];
  taunt: {
    cooldownMs: number;
    pending: boolean;
    disabled: boolean;
    unavailableText: string | null;
  };
};

export function buildClassCombatControlModel({
  snapshot,
  combat,
  equipmentAvailable,
  weaponCategory = null,
  pveCombat,
  disabled,
  disabledReason = null,
  targetSelection,
  friendlyTargets = [],
  serverNow,
  activationLockoutEndsAt = 0
}: {
  snapshot: ClassSnapshot;
  combat: ClassCombatState | null;
  equipmentAvailable: boolean;
  weaponCategory?: WeaponCategory | null;
  pveCombat: PveCombatSessionSnapshot | null;
  disabled: boolean;
  disabledReason?: string | null;
  targetSelection?: ClassAbilityTargetSelection | null | undefined;
  friendlyTargets?: readonly ClassAbilityTargetOption[];
  serverNow: number;
  activationLockoutEndsAt?: number;
}): ClassCombatControlModel {
  const classInfo = CLASS_DEFINITIONS[snapshot.activeClassId];
  const isWarrior = snapshot.activeClassId === "warrior";
  const isLaunchClass = isLaunchClassId(snapshot.activeClassId);
  const activeProgress = snapshot.classes?.find((entry) => entry.classId === snapshot.activeClassId)
    ?? compatibilityProgress(snapshot);
  const resource = combat?.resource
    ?? snapshot.resources?.find((entry) => entry.classId === snapshot.activeClassId)
    ?? snapshot.resource;
  const resourceAmount = resource?.current
    ?? (snapshot.activeClassId === "warrior" ? combat?.rage ?? snapshot.rage : 0);
  const resourceMaximum = resource?.maximum ?? 100;
  const resourceName = resource?.displayName ?? title(classInfo.resourceId);
  const weaponMode = combat?.weaponMode ?? snapshot.weaponMode ?? null;
  const focusTargetEntityId = targetSelection?.mode === "hostile"
    ? targetSelection.targetEntityId
    : pveCombat?.focusTargetEntityId ?? null;
  const effectiveTargetSelection = normalizeTargetSelection(
    targetSelection,
    snapshot.playerId,
    focusTargetEntityId,
    friendlyTargets
  );
  const sharedResetEnd = combat?.cooldownGroupEndsAt?.[BASIC_ATTACK_RESET_COOLDOWN_GROUP]
    ?? combat?.cooldownEndsAt[BASIC_ATTACK_RESET_COOLDOWN_GROUP]
    ?? 0;
  const resetCooldownMs = Math.max(0, sharedResetEnd - serverNow);
  const globalUnavailableText = disabled ? disabledReason ?? "Unavailable" : null;
  const activationLockoutMs = Math.max(0, activationLockoutEndsAt - serverNow);

  const buildSlot = (
    id: string | null,
    index: number,
    kind: "reset" | "normal"
  ): ClassCombatSlotModel => {
    const definition = id ? TECHNIQUE_BY_ID[id] ?? null : null;
    const activation = definition?.activation ?? (kind === "reset" ? "armed" : "instant");
    const lockLevel = isWarrior && definition
      ? definition.unlockLevel
      : CLASS_SLOT_MILESTONES[kind][index]!;
    const locked = (activeProgress?.level ?? 0) < lockLevel;
    const hostileTargetRequired = requiresHostileTarget(id, snapshot.activeClassId);
    const singleTargetSupport = Boolean(
      definition && isSingleTargetSupportTechnique(definition)
    );
    const targetUnavailableText = definition
      ? abilityTargetUnavailableText(
          definition,
          effectiveTargetSelection,
          focusTargetEntityId,
          friendlyTargets,
          snapshot.playerId
        )
      : null;
    const baseUnavailableText = globalUnavailableText
      ?? (!equipmentAvailable
        ? "Equipment unavailable"
        : definition?.allowedWeaponCategories?.length
          && (!weaponCategory || !definition.allowedWeaponCategories.includes(weaponCategory))
          ? `Requires ${definition.allowedWeaponCategories.map(title).join(" or ")}`
        : null);
    const unavailableText = baseUnavailableText
      ?? (activationLockoutMs > 0 ? "Ability activation locked" : null)
      ?? (singleTargetSupport
        ? null
        : hostileTargetRequired && !focusTargetEntityId
          ? "Target unavailable"
          : targetUnavailableText);
    const cooldownEnd = kind === "reset"
      ? sharedResetEnd
      : id
        ? combat?.cooldownEndsAt[id] ?? 0
        : 0;
    const cooldownMs = kind === "reset"
      ? resetCooldownMs
      : Math.max(0, cooldownEnd - serverNow);
    const pendingId = kind === "reset"
      ? pveCombat?.pendingResetAbilityId
      : pveCombat?.pendingNormalAbilityId;
    const pending = Boolean(id && (pendingId === id || combat?.queuedAbility?.abilityId === id));
    const resourceCost = definition?.resourceCost ?? 0;
    const resourceProgress = classResourceProgress(resourceAmount, resourceCost);
    const insufficientResource = Boolean(
      definition && resourceAmount < resourceCost
    );
    const slotDisabled = Boolean(
      unavailableText
      || locked
      || !definition
      || cooldownMs > 0
      || insufficientResource
      || pending
      || activationLockoutMs > 0
    );
    return {
      id,
      definition,
      name: definition
        ? dynamicAbilityName(definition.id, weaponMode, definition.shortLabel)
        : isWarrior
          ? kind === "reset" ? "Attack Empower" : "Active Technique"
          : `${kind === "reset" ? "Empower" : "Skill"} ${index + 1}`,
      locked,
      lockLevel,
      cooldownMs,
      pending,
      unavailableText,
      resourceAmount,
      resourceCost,
      resourceProgress,
      insufficientResource,
      isActuallyReady: Boolean(definition && !slotDisabled),
      disabled: slotDisabled,
      singleTargetSupport,
      selfTargetAvailable: Boolean(
        definition
        && singleTargetSupport
        && !baseUnavailableText
        && !locked
        && cooldownMs <= 0
        && !insufficientResource
        && !pending
      ),
      target: definition
        ? resolveClassAbilityTarget(
            definition,
            snapshot.playerId,
            focusTargetEntityId,
            effectiveTargetSelection
          )
        : null,
      activation
    };
  };

  const tauntCooldownEnd = Math.max(
    pveCombat?.tauntCooldownEndsAt ?? 0,
    combat?.cooldownEndsAt[UNIVERSAL_TAUNT_ID] ?? 0,
    snapshot.cooldownEndsAt[UNIVERSAL_TAUNT_ID] ?? 0
  );
  const tauntCooldownMs = Math.max(0, tauntCooldownEnd - serverNow);
  const tauntPending = pveCombat?.pendingNormalAbilityId === UNIVERSAL_TAUNT_ID;

  return {
    className: classInfo.name,
    resourceAmount,
    resourceMaximum,
    resourceName,
    weaponMode,
    effectiveTargetSelection,
    resetSlots: (isLaunchClass ? [] : [0, 1]).map((index) =>
      buildSlot(snapshot.loadout.resetActives[index] ?? null, index, "reset")),
    normalSlots: [0, 1].map((index) =>
      buildSlot(snapshot.loadout.normalActives[index] ?? null, index, "normal")),
    activationLockoutMs,
    statusIndicators: (combat?.statusIndicators ?? []).map((indicator) => ({
      id: indicator.id,
      text: `${indicator.label}${indicator.stacks && indicator.stacks > 1 ? ` ×${indicator.stacks}` : ""}`,
      remainingMs: indicator.endsAt === undefined ? null : Math.max(0, indicator.endsAt - serverNow)
    })),
    taunt: {
      cooldownMs: tauntCooldownMs,
      pending: tauntPending,
      disabled: Boolean(globalUnavailableText || tauntCooldownMs > 0 || tauntPending),
      unavailableText: globalUnavailableText
    }
  };
}

export function classResourceProgress(resourceAmount: number, resourceCost: number): number | null {
  if (resourceCost <= 0) return null;
  return Math.min(1, Math.max(0, resourceAmount / resourceCost));
}

export function dynamicAbilityName(
  id: string,
  mode: "ranged" | "melee" | null,
  fallback: string
): string {
  if (mode !== "ranged") return fallback;
  return ({
    hunter_predators_strike: "Predator's Shot",
    hunter_marked_strike: "Marking Shot",
    hunter_cull: "Kill Shot",
    hunter_sweep: "Volley"
  } as Record<string, string>)[id] ?? fallback;
}

export function resolveClassAbilityTarget(
  definition: TechniqueDefinition,
  playerId: string,
  focusTargetEntityId: string | null,
  selected: ClassAbilityTargetSelection | null | undefined
): ClassAbilityTargetSelection {
  const targetType = techniqueTargetType(definition);
  const selection = selected ?? { mode: "self", targetEntityId: playerId };
  if (targetType === "self") {
    return { mode: "self", targetEntityId: playerId };
  }
  if (targetType === "friendly") {
    const friendlyTargetEntityId = selection.friendlyTargetEntityId
      ?? (selection.mode === "self" || selection.mode === "friendly"
        ? selection.targetEntityId
        : null)
      ?? playerId;
    return friendlyTargetEntityId === playerId
      ? { mode: "self", targetEntityId: playerId }
      : { mode: "friendly", targetEntityId: friendlyTargetEntityId };
  }
  if (targetType === "friendly_or_hostile") {
    return selection;
  }
  return { mode: "hostile", targetEntityId: focusTargetEntityId };
}

function normalizeTargetSelection(
  selected: ClassAbilityTargetSelection | null | undefined,
  playerId: string,
  focusTargetEntityId: string | null,
  friendlyTargets: readonly ClassAbilityTargetOption[]
): ClassAbilityTargetSelection {
  void focusTargetEntityId;
  void friendlyTargets;
  if (!selected) return { mode: "self", targetEntityId: playerId };
  if (
    selected.mode === "friendly"
    && !selected.targetEntityId
    && !selected.friendlyTargetEntityId
  ) {
    return { mode: "self", targetEntityId: playerId };
  }
  return selected;
}

function abilityTargetUnavailableText(
  definition: TechniqueDefinition,
  selection: ClassAbilityTargetSelection,
  focusTargetEntityId: string | null,
  friendlyTargets: readonly ClassAbilityTargetOption[],
  playerId: string
): string | null {
  const targetType = techniqueTargetType(definition);
  if (targetType === "self") return null;
  if (targetType === "hostile") return focusTargetEntityId ? null : "Target unavailable";
  if (targetType === "friendly") {
    const friendlyTargetEntityId = selection.friendlyTargetEntityId
      ?? (selection.mode === "self" || selection.mode === "friendly"
        ? selection.targetEntityId
        : null);
    if (friendlyTargetEntityId === playerId) return null;
    if (!friendlyTargetEntityId) return null;
    const option = friendlyTargets.find(({ entityId }) => entityId === friendlyTargetEntityId);
    if (!option) return "Selected party member is unavailable";
    return option.available === false
      ? option.unavailableReason ?? "Selected party member is unavailable"
      : null;
  }
  if (selection.mode === "self" && selection.targetEntityId === playerId) return null;
  if (selection.mode === "friendly") {
    if (!selection.targetEntityId) return null;
    const option = friendlyTargets.find(({ entityId }) => entityId === selection.targetEntityId);
    if (!option) return "Selected party member is unavailable";
    return option.available === false
      ? option.unavailableReason ?? "Selected party member is unavailable"
      : null;
  }
  if (selection.mode === "hostile") {
    return selection.targetEntityId && selection.targetEntityId === focusTargetEntityId
      ? null
      : "Selected enemy is unavailable";
  }
  return null;
}

function compatibilityProgress(snapshot: ClassSnapshot): { level: number } | undefined {
  if (snapshot.activeClassId === "warrior") return snapshot.warrior;
  if (snapshot.activeClassId === "hunter") return snapshot.hunter;
  const candidate = (snapshot as unknown as Record<string, unknown>)[snapshot.activeClassId];
  return candidate && typeof candidate === "object" && typeof (candidate as { level?: unknown }).level === "number"
    ? candidate as { level: number }
    : undefined;
}

function techniqueTargetType(
  definition: TechniqueDefinition
): "hostile" | "friendly" | "self" | "friendly_or_hostile" {
  if (!("targetType" in definition)) return "hostile";
  const value = definition.targetType;
  return value === "friendly" || value === "self" || value === "friendly_or_hostile"
    ? value
    : "hostile";
}

function requiresHostileTarget(id: string | null, classId: ClassId): boolean {
  if (classId === "hunter") return true;
  const definition = id ? TECHNIQUE_BY_ID[id] : null;
  return !definition || techniqueTargetType(definition) === "hostile";
}

function title(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
