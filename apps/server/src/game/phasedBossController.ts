import { bearingDegrees, destinationPoint, distanceMeters, type LatLon, type MobArchetypeKey } from "@ash-atlas/shared";
import type { BossController, BossControllerContext } from "./bossFramework.js";

/**
 * Data-driven boss mechanics kit. A spec lists HP-gated phases, each with an ability set (cooldown + weight),
 * plus an optional enrage. Abilities are separate telegraphed casts; auto-attack cadence is never touched.
 */
export type PhasedAbilityBase = Readonly<{
  /** Unique within the phase; also the cooldown key. */
  key: string;
  /** Cast ability id sent to clients and the damage table. Defaults to a spec-namespaced id. */
  abilityId?: string;
  cooldownMs: number;
  /** Relative pick weight among abilities that are off cooldown. Default 1. */
  weight?: number;
  /** Delay before the first use after activation or entering a phase. Default 0. */
  initialDelayMs?: number;
  /** Per-hit damage for the cast; omitted keeps the generic boss cast damage. */
  damage?: number;
  /** K2: used at most once each time its phase is entered (a phase-opening wave). */
  oncePerPhase?: boolean;
}>;

export type PhasedAbility =
  | (PhasedAbilityBase & Readonly<{ kind: "cleave"; rangeM: number; angleDegrees: number; telegraphMs: number }>)
  | (PhasedAbilityBase & Readonly<{ kind: "charge"; lengthM: number; widthM: number; telegraphMs: number }>)
  | (PhasedAbilityBase & Readonly<{ kind: "slam"; radiusM: number; telegraphMs: number }>)
  | (PhasedAbilityBase & Readonly<{
      kind: "summon";
      archetype: MobArchetypeKey;
      count: number;
      /** Boss takes no damage while any add from this boss lives. */
      shieldWhileAlive?: boolean;
      /** Not used again while earlier adds from this boss still live. Default true. */
      onlyWhenNoAdds?: boolean;
      /**
       * K1: room anchors the adds spawn on (one add per anchor, cycling when count is larger),
       * resolved through the host's `anchorPosition`; if any is unresolved the adds ring the boss.
       */
      spawnAnchors?: readonly string[];
    }>);

export type PhasedBossPhase = Readonly<{
  id: string;
  /** Phase ends once boss health percent falls to this value (0 for the last phase). */
  untilHealthPercent: number;
  abilities: readonly PhasedAbility[];
  /** K4: on entering this phase the boss moves to this room anchor (host `anchorPosition` + `moveBossTo`). */
  retreatToAnchor?: string;
}>;

export type PhasedBossEnrage = Readonly<{
  belowHealthPercent: number;
  /** Scales every cooldown and the gap between casts (e.g. 0.6). Default 1. */
  cooldownScale?: number;
  /** Outgoing damage multiplier through the boss combat modifier provider. Default 1. */
  damageMultiplier?: number;
}>;

export type PhasedBossSpec = Readonly<{
  id: string;
  phases: readonly PhasedBossPhase[];
  /** Minimum gap between any two ability starts. Default 3000. */
  castGapMs?: number;
  /** Delay before the first ability after activation. Default 1000. */
  openingDelayMs?: number;
  enrage?: PhasedBossEnrage;
  /**
   * While a shielding wave lives the boss shows phase `<phase id><suffix>` (e.g. "_shielded"), so
   * clients pick shielded art from the existing phase projection. Cooldowns are not reset by it.
   */
  shieldedPhaseSuffix?: string;
}>;

export type PhasedBossHooks = Readonly<{
  bossHealthRatio(bossEntityId: string): number;
  bossPosition(bossEntityId: string): LatLon | null;
  playerPosition(playerEntityId: string): LatLon | null;
  /** Spawns adds near the boss (or one at each given position) and returns their entity ids. */
  spawnAdds(bossEntityId: string, archetype: MobArchetypeKey, count: number, positions?: readonly LatLon[]): readonly string[];
  /** Combat position of an anchor in the boss's room (K1 spawn anchors, K4 retreat), or null. */
  anchorPosition?(bossEntityId: string, anchorId: string): LatLon | null;
  isAlive(entityId: string): boolean;
  /** Removes adds when their boss dies, resets or is destroyed. */
  despawnAdds?(entityIds: readonly string[]): void;
  /** Moves the boss (charge end point). */
  moveBossTo(bossEntityId: string, position: LatLon): void;
  /** Injectable for tests; defaults to Math.random. */
  random?(): number;
}>;

const DEFAULT_CAST_GAP_MS = 3_000;
const DEFAULT_OPENING_DELAY_MS = 1_000;
/** A charge may run this far past its target. */
const CHARGE_OVERSHOOT_M = 4;

export const phasedAbilityId = (specId: string, ability: PhasedAbility): string =>
  ability.abilityId ?? (ability.kind === "cleave" ? "dungeon_cone_cleave" : `${specId}_${ability.key}`);

/** Cast ability id to per-hit damage for every ability in the spec that declares one. */
export function phasedSpecCastDamage(spec: PhasedBossSpec): ReadonlyMap<string, number> {
  const damage = new Map<string, number>();
  for (const phase of spec.phases) {
    for (const ability of phase.abilities) {
      if (ability.damage !== undefined) damage.set(phasedAbilityId(spec.id, ability), ability.damage);
    }
  }
  return damage;
}

export function validatePhasedBossSpec(spec: PhasedBossSpec): PhasedBossSpec {
  if (!spec.id.trim()) throw new Error("Phased boss spec id is required");
  if (spec.phases.length === 0) throw new Error(`Phased boss spec ${spec.id} needs at least one phase`);
  let previousUntil = Infinity;
  const phaseIds = new Set<string>();
  for (const phase of spec.phases) {
    if (!phase.id.trim() || phaseIds.has(phase.id)) throw new Error(`Phased boss spec ${spec.id} has a bad phase id`);
    if (phase.retreatToAnchor !== undefined && !phase.retreatToAnchor.trim()) {
      throw new Error(`Phased boss spec ${spec.id} phase ${phase.id} has an empty retreat anchor`);
    }
    phaseIds.add(phase.id);
    if (phase.untilHealthPercent < 0 || phase.untilHealthPercent > 100 || phase.untilHealthPercent >= previousUntil) {
      throw new Error(`Phased boss spec ${spec.id} phase thresholds must descend within 0-100`);
    }
    previousUntil = phase.untilHealthPercent;
    const keys = new Set<string>();
    for (const ability of phase.abilities) {
      if (keys.has(ability.key)) throw new Error(`Phased boss spec ${spec.id} repeats ability ${ability.key}`);
      keys.add(ability.key);
      if (ability.kind === "summon" && ability.spawnAnchors !== undefined &&
          (ability.spawnAnchors.length === 0 || ability.spawnAnchors.some((anchor) => !anchor.trim()))) {
        throw new Error(`Phased boss spec ${spec.id} ability ${ability.key} has empty spawn anchors`);
      }
      if (!(ability.cooldownMs >= 0) || (ability.weight !== undefined && !(ability.weight > 0))) {
        throw new Error(`Phased boss spec ${spec.id} ability ${ability.key} has invalid cooldown or weight`);
      }
    }
  }
  return spec;
}

export function createPhasedController(specInput: PhasedBossSpec, hooks: PhasedBossHooks): BossController {
  const spec = validatePhasedBossSpec(specInput);
  const random = hooks.random ?? Math.random;
  let readyAt = new Map<string, number>();
  let nextCastAt = 0;
  let phaseIndex = 0;
  let addIds: string[] = [];
  let shielded = false;
  let enraged = false;
  let overrideSignature = "";
  let pendingDash: { resolveAt: number; to: LatLon } | null = null;
  let usedThisPhase = new Set<string>();

  const phase = () => spec.phases[phaseIndex]!;
  const gapScale = () => (enraged ? spec.enrage?.cooldownScale ?? 1 : 1);

  const livingAdds = (): string[] => {
    addIds = addIds.filter((id) => hooks.isAlive(id));
    return addIds;
  };

  const shieldVariant = (phaseId: string | null): boolean =>
    Boolean(spec.shieldedPhaseSuffix && phaseId?.endsWith(spec.shieldedPhaseSuffix));
  const basePhaseId = (phaseId: string | null): string | null =>
    phaseId && shieldVariant(phaseId) ? phaseId.slice(0, -spec.shieldedPhaseSuffix!.length) : phaseId;

  const applyModifiers = (context: BossControllerContext): void => {
    if (spec.shieldedPhaseSuffix && context.encounter.phase !== null) {
      const shown = `${phase().id}${shielded ? spec.shieldedPhaseSuffix : ""}`;
      if (context.encounter.phase !== shown && basePhaseId(context.encounter.phase) === phase().id) {
        context.encounter.transitionPhase(shown);
      }
    }
    const signature = `${shielded ? 1 : 0}${enraged ? 1 : 0}`;
    if (signature === overrideSignature) return;
    overrideSignature = signature;
    const damageMultiplier = enraged ? spec.enrage?.damageMultiplier : undefined;
    const scaled = damageMultiplier !== undefined && damageMultiplier !== 1;
    context.encounter.setMovementOverride(shielded || scaled
      ? {
          id: `${spec.id}-${shielded ? "shield" : ""}${enraged ? "enrage" : ""}`,
          generation: context.lifeGeneration,
          ...(shielded ? { incomingDamageMultiplier: 0 } : {}),
          ...(scaled ? { outgoingDamageMultiplier: damageMultiplier } : {})
        }
      : null);
  };

  const enterPhase = (context: BossControllerContext): void => {
    readyAt = new Map(phase().abilities.map((ability) => [ability.key, context.now + (ability.initialDelayMs ?? 0)]));
    usedThisPhase = new Set();
    const retreat = phase().retreatToAnchor;
    if (retreat) {
      const bossId = context.encounter.mobEntityId;
      const to = hooks.anchorPosition?.(bossId, retreat);
      if (to) hooks.moveBossTo(bossId, to);
    }
  };

  const clear = (context: BossControllerContext): void => {
    const leftover = livingAdds();
    if (leftover.length > 0) hooks.despawnAdds?.(leftover);
    readyAt = new Map();
    nextCastAt = 0;
    phaseIndex = 0;
    addIds = [];
    usedThisPhase = new Set();
    shielded = false;
    enraged = false;
    overrideSignature = "";
    pendingDash = null;
    context.encounter.setPhaseDeadline(null);
    context.encounter.setMovementOverride(null);
  };

  const phaseIndexFor = (healthPercent: number): number => {
    let index = phaseIndex;
    while (index < spec.phases.length - 1 && healthPercent <= spec.phases[index]!.untilHealthPercent) index += 1;
    return index;
  };

  const cast = (
    context: BossControllerContext,
    ability: PhasedAbility,
    origin: LatLon,
    target: { id: string; position: LatLon }
  ): boolean => {
    const abilityId = phasedAbilityId(spec.id, ability);
    const facing = bearingDegrees(origin, target.position);
    switch (ability.kind) {
      case "cleave":
        return context.beginCast({
          abilityId,
          geometry: { kind: "cone", origin, facingDegrees: facing, rangeM: ability.rangeM, angleDegrees: ability.angleDegrees },
          castDurationMs: ability.telegraphMs,
          targetEntityId: target.id
        }) !== null;
      case "charge": {
        const lengthM = Math.max(1, Math.min(ability.lengthM, distanceMeters(origin, target.position) + CHARGE_OVERSHOOT_M));
        const started = context.beginCast({
          abilityId,
          geometry: { kind: "line", origin, facingDegrees: facing, lengthM, widthM: ability.widthM },
          castDurationMs: ability.telegraphMs
        });
        if (!started) return false;
        pendingDash = { resolveAt: started.resolveTime, to: destinationPoint(origin, lengthM, facing) };
        return true;
      }
      case "slam":
        return context.beginCast({
          abilityId,
          geometry: { kind: "circle", center: origin, radiusM: ability.radiusM },
          castDurationMs: ability.telegraphMs
        }) !== null;
      case "summon": {
        const bossId = context.encounter.mobEntityId;
        const anchors = ability.spawnAnchors ?? [];
        const positions = anchors.length === 0 ? [] : Array.from({ length: ability.count },
          (_, index) => hooks.anchorPosition?.(bossId, anchors[index % anchors.length]!) ?? null);
        const spawned = positions.length > 0 && positions.every((position) => position !== null)
          ? hooks.spawnAdds(bossId, ability.archetype, ability.count, positions as LatLon[])
          : hooks.spawnAdds(bossId, ability.archetype, ability.count);
        addIds = [...livingAdds(), ...spawned];
        if (ability.shieldWhileAlive && spawned.length > 0) shielded = true;
        return spawned.length > 0;
      }
    }
  };

  return {
    onActivate: (context) => {
      nextCastAt = context.now + (spec.openingDelayMs ?? DEFAULT_OPENING_DELAY_MS);
      if (context.encounter.phase === null) {
        phaseIndex = 0;
        context.encounter.transitionPhase(phase().id);
      } else {
        phaseIndex = Math.max(0, spec.phases.findIndex((entry) => entry.id === basePhaseId(context.encounter.phase)));
        enterPhase(context);
      }
    },
    onPhaseTransition: (context, previousPhaseId) => {
      // Showing or dropping the shield variant of the same phase is presentation only.
      if (shieldVariant(context.encounter.phase) || (shieldVariant(previousPhaseId) && basePhaseId(previousPhaseId) === context.encounter.phase)) return;
      const index = spec.phases.findIndex((entry) => entry.id === context.encounter.phase);
      if (index >= 0) phaseIndex = index;
      pendingDash = null;
      enterPhase(context);
    },
    update: (context) => {
      const bossId = context.encounter.mobEntityId;
      const healthPercent = hooks.bossHealthRatio(bossId) * 100;

      if (!enraged && spec.enrage && healthPercent < spec.enrage.belowHealthPercent) enraged = true;
      if (shielded && livingAdds().length === 0) shielded = false;
      applyModifiers(context);

      const targetPhase = phaseIndexFor(healthPercent);
      if (targetPhase !== phaseIndex) {
        phaseIndex = targetPhase;
        context.encounter.transitionPhase(phase().id);
        return;
      }

      if (pendingDash && context.now >= pendingDash.resolveAt) {
        hooks.moveBossTo(bossId, pendingDash.to);
        pendingDash = null;
      }
      if (context.now < nextCastAt || pendingDash || context.encounter.activeCasts.length > 0) return;

      const origin = hooks.bossPosition(bossId);
      if (!origin) return;
      const targetId = context.selectTarget({ kind: "nearest", origin }, origin);
      const targetPosition = targetId ? hooks.playerPosition(targetId) : null;
      if (!targetId || !targetPosition) return;

      const eligible = phase().abilities.filter((ability) => {
        if ((readyAt.get(ability.key) ?? 0) > context.now) return false;
        if (ability.oncePerPhase && usedThisPhase.has(ability.key)) return false;
        if (ability.kind === "summon" && (ability.onlyWhenNoAdds ?? true) && livingAdds().length > 0) return false;
        return true;
      });
      if (eligible.length === 0) return;
      const total = eligible.reduce((sum, ability) => sum + (ability.weight ?? 1), 0);
      let roll = random() * total;
      const chosen = eligible.find((ability) => (roll -= ability.weight ?? 1) < 0) ?? eligible[eligible.length - 1]!;

      if (!cast(context, chosen, origin, { id: targetId, position: targetPosition })) return;
      readyAt.set(chosen.key, context.now + chosen.cooldownMs * gapScale());
      if (chosen.oncePerPhase) usedThisPhase.add(chosen.key);
      nextCastAt = context.now + (spec.castGapMs ?? DEFAULT_CAST_GAP_MS) * gapScale();
      applyModifiers(context);
    },
    onReset: clear,
    onDefeat: clear,
    destroy: clear
  };
}

/** Example 3-phase dungeon boss: cleave and slam, then charge, then adds behind a shield and an enrage. */
export const PHASED_DUNGEON_BOSS_SPEC: PhasedBossSpec = {
  id: "dungeon_phased",
  castGapMs: 3_500,
  enrage: { belowHealthPercent: 15, cooldownScale: 0.7, damageMultiplier: 1.25 },
  phases: [
    {
      id: "awakened",
      untilHealthPercent: 70,
      abilities: [
        { kind: "cleave", key: "cleave", cooldownMs: 5_000, weight: 3, rangeM: 120, angleDegrees: 70, telegraphMs: 1_200 },
        { kind: "slam", key: "slam", cooldownMs: 9_000, weight: 1, initialDelayMs: 4_000, radiusM: 150, telegraphMs: 1_500, damage: 16 }
      ]
    },
    {
      id: "rampage",
      untilHealthPercent: 35,
      abilities: [
        { kind: "cleave", key: "cleave", cooldownMs: 5_000, weight: 2, rangeM: 120, angleDegrees: 70, telegraphMs: 1_100 },
        { kind: "charge", key: "charge", cooldownMs: 10_000, weight: 2, lengthM: 450, widthM: 80, telegraphMs: 1_400, damage: 18 },
        { kind: "slam", key: "slam", cooldownMs: 8_000, weight: 1, radiusM: 150, telegraphMs: 1_400, damage: 16 }
      ]
    },
    {
      id: "last_stand",
      untilHealthPercent: 0,
      abilities: [
        { kind: "summon", key: "adds", cooldownMs: 25_000, weight: 4, archetype: "slime", count: 2, shieldWhileAlive: true },
        { kind: "cleave", key: "cleave", cooldownMs: 5_000, weight: 2, rangeM: 120, angleDegrees: 70, telegraphMs: 1_000 },
        { kind: "charge", key: "charge", cooldownMs: 10_000, weight: 2, lengthM: 450, widthM: 80, telegraphMs: 1_200, damage: 18 },
        { kind: "slam", key: "slam", cooldownMs: 7_000, weight: 1, radiusM: 150, telegraphMs: 1_200, damage: 16 }
      ]
    }
  ]
};

/** Lean preset: two phases, fewer abilities. */
export const MINIBOSS_SPEC: PhasedBossSpec = {
  id: "miniboss",
  castGapMs: 4_000,
  phases: [
    {
      id: "fighting",
      untilHealthPercent: 40,
      abilities: [
        { kind: "cleave", key: "cleave", cooldownMs: 5_000, weight: 2, rangeM: 110, angleDegrees: 70, telegraphMs: 1_200 },
        { kind: "slam", key: "slam", cooldownMs: 10_000, weight: 1, initialDelayMs: 4_000, radiusM: 130, telegraphMs: 1_500, damage: 14 }
      ]
    },
    {
      id: "desperate",
      untilHealthPercent: 0,
      abilities: [
        { kind: "cleave", key: "cleave", cooldownMs: 4_500, weight: 2, rangeM: 110, angleDegrees: 70, telegraphMs: 1_100 },
        { kind: "charge", key: "charge", cooldownMs: 10_000, weight: 1, lengthM: 380, widthM: 70, telegraphMs: 1_300, damage: 15 }
      ]
    }
  ]
};

/** Phased specs a boss definition can select through its `controllerId`. */
export const PHASED_BOSS_SPECS: readonly PhasedBossSpec[] = Object.freeze([PHASED_DUNGEON_BOSS_SPEC, MINIBOSS_SPEC]);
