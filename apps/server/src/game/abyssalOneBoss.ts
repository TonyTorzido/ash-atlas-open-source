import { bearingDegrees, type LatLon, type MobArchetypeKey } from "@ash-atlas/shared";
import type { BossController, BossControllerContext, BossRoomHooks } from "./bossFramework.js";

/**
 * The Abyssal One (Drowned City sanctum; docs/design/DROWNED_CITY_SPEC.md section 3). Stationary in
 * its pit with four arms on the corner platforms.
 *
 * - Rituals (K3 timed adds): at 80/55/30% health it calls three Abyssal Cultists and a 50 s deadline
 *   (the HUD countdown). All must die in time; otherwise the encounter fails: the room is ejected to
 *   the hub and the boss returns at full health (DungeonRuntime.failEncounterAndEject).
 * - Tide bombs: every 20 s one of four floor bombs appears. A player picks one up and has 15 s to
 *   plant it on an intact arm (-15% boss damage per planted arm, at most 3), or it explodes on them.
 *   Everything is cleared on reset.
 *
 * Phase ids are presentation (the client's art): "awakened", "ritual", "weakened" (an arm planted).
 */
export const ABYSSAL_ONE = Object.freeze({
  ritualThresholdsPercent: [80, 55, 30] as const,
  ritualDeadlineMs: 50_000,
  ritualCultists: 3,
  cultistAnchors: ["abyssal_cultist_w", "abyssal_cultist_e"] as const,
  bombObjectIds: ["tide_bomb_1", "tide_bomb_2", "tide_bomb_3", "tide_bomb_4"] as const,
  armObjectIds: ["abyssal_arm_nw", "abyssal_arm_ne", "abyssal_arm_sw", "abyssal_arm_se"] as const,
  firstBombMs: 8_000,
  bombIntervalMs: 20_000,
  carryMs: 15_000,
  damageReductionPerStack: 0.15,
  maxStacks: 3,
  bombExplosionDamage: 45,
  openingDelayMs: 2_500,
  castGapMs: 3_500,
  slamDamage: 26,
  gazeDamage: 26
});

export const ABYSSAL_ONE_ABILITIES = Object.freeze({ slam: "abyssal_arm_slam", gaze: "abyssal_gaze" });
export const ABYSSAL_ONE_PHASES = Object.freeze({ awakened: "awakened", ritual: "ritual", weakened: "weakened" });

export type AbyssalOneHooks = Readonly<{
  bossHealthRatio(bossEntityId: string): number;
  bossPosition(bossEntityId: string): LatLon | null;
  playerPosition(entityId: string): LatLon | null;
  anchorPosition(bossEntityId: string, anchorId: string): LatLon | null;
  spawnAdds(bossEntityId: string, archetype: MobArchetypeKey, count: number, positions?: readonly LatLon[]): readonly string[];
  isAlive(entityId: string): boolean;
  despawn(entityIds: readonly string[]): void;
  /** A carried bomb went off on its carrier. */
  explodeOn(bossEntityId: string, playerId: string, damage: number): void;
  random?(): number;
}>;

export function createAbyssalOneController(hooks: AbyssalOneHooks): BossController {
  const random = hooks.random ?? Math.random;
  let ritualsStarted = 0;
  let ritualAdds: string[] = [];
  let ritualDeadline: number | null = null;
  let stacks = 0;
  const carriers = new Map<string, number>();
  let nextBombAt = 0;
  let nextCastAt = 0;

  const room = (context: BossControllerContext): BossRoomHooks | undefined => context.encounter.host.room;

  const showPhase = (context: BossControllerContext): void => {
    const phase = ritualDeadline !== null ? ABYSSAL_ONE_PHASES.ritual
      : stacks > 0 ? ABYSSAL_ONE_PHASES.weakened : ABYSSAL_ONE_PHASES.awakened;
    if (context.encounter.phase !== phase) context.encounter.transitionPhase(phase);
  };

  const applyStacks = (context: BossControllerContext): void => {
    context.encounter.setMovementOverride(stacks > 0
      ? {
          id: `abyssal-one-bombed-${stacks}`,
          generation: context.lifeGeneration,
          outgoingDamageMultiplier: 1 - ABYSSAL_ONE.damageReductionPerStack * stacks
        }
      : null);
  };

  const clear = (context: BossControllerContext): void => {
    const living = ritualAdds.filter((id) => hooks.isAlive(id));
    if (living.length > 0) hooks.despawn(living);
    ritualAdds = [];
    ritualDeadline = null;
    ritualsStarted = 0;
    stacks = 0;
    carriers.clear();
    const hooksRoom = room(context);
    for (const bomb of ABYSSAL_ONE.bombObjectIds) hooksRoom?.setObjectAvailable(bomb, false);
    for (const arm of ABYSSAL_ONE.armObjectIds) hooksRoom?.setObjectState(arm, "intact");
    context.encounter.setPhaseDeadline(null);
    context.encounter.setMovementOverride(null);
  };

  const startRitual = (context: BossControllerContext): void => {
    const bossId = context.encounter.mobEntityId;
    const positions = ABYSSAL_ONE.cultistAnchors.map((anchor) => hooks.anchorPosition(bossId, anchor));
    ritualAdds = [...(positions.every((position) => position !== null)
      ? hooks.spawnAdds(bossId, "abyssal_cultist", ABYSSAL_ONE.ritualCultists, positions as LatLon[])
      : hooks.spawnAdds(bossId, "abyssal_cultist", ABYSSAL_ONE.ritualCultists))];
    ritualsStarted += 1;
    ritualDeadline = context.now + ABYSSAL_ONE.ritualDeadlineMs;
    context.encounter.setPhaseDeadline(ritualDeadline);
    room(context)?.notify(null, "The Abyssal One begins a ritual. Kill all three cultists before it completes!", "warning");
    showPhase(context);
  };

  return {
    onActivate: (context) => {
      nextCastAt = context.now + ABYSSAL_ONE.openingDelayMs;
      if (nextBombAt === 0) nextBombAt = context.now + ABYSSAL_ONE.firstBombMs;
      showPhase(context);
    },
    update: (context) => {
      const now = context.now;
      const bossId = context.encounter.mobEntityId;
      // Rituals: timed adds (K3).
      if (ritualDeadline !== null) {
        ritualAdds = ritualAdds.filter((id) => hooks.isAlive(id));
        if (ritualAdds.length === 0) {
          ritualDeadline = null;
          context.encounter.setPhaseDeadline(null);
          room(context)?.notify(null, "The ritual is broken.", "success");
          showPhase(context);
        } else if (now >= ritualDeadline) {
          context.encounter.requestFailure("ritual_completed");
          return;
        }
      } else {
        const threshold = ABYSSAL_ONE.ritualThresholdsPercent[ritualsStarted];
        if (threshold !== undefined && hooks.bossHealthRatio(bossId) * 100 <= threshold) startRitual(context);
      }
      // Tide bombs: one appears every 20 s while a free one is left.
      const hooksRoom = room(context);
      if (hooksRoom && now >= nextBombAt) {
        nextBombAt = now + ABYSSAL_ONE.bombIntervalMs;
        const free = ABYSSAL_ONE.bombObjectIds.filter((bomb) => !hooksRoom.objectAvailable(bomb));
        if (free.length > 0 && stacks < ABYSSAL_ONE.maxStacks) {
          hooksRoom.setObjectAvailable(free[Math.floor(random() * free.length) % free.length]!, true);
          hooksRoom.notify(null, "A tide bomb washes up.", "info");
        }
      }
      for (const [playerId, explodesAt] of carriers) {
        if (now < explodesAt) continue;
        carriers.delete(playerId);
        hooks.explodeOn(bossId, playerId, ABYSSAL_ONE.bombExplosionDamage);
        hooksRoom?.notify(playerId, "The tide bomb goes off in your hands.", "warning");
      }
      // Attacks.
      if (now < nextCastAt || context.encounter.activeCasts.length > 0) return;
      const origin = hooks.bossPosition(bossId);
      if (!origin) return;
      const targetId = context.selectTarget({ kind: "nearest", origin }, origin);
      const target = targetId ? hooks.playerPosition(targetId) : null;
      if (!targetId || !target) return;
      const started = random() < 0.5
        ? context.beginCast({
            abilityId: ABYSSAL_ONE_ABILITIES.gaze,
            geometry: { kind: "cone", origin, facingDegrees: bearingDegrees(origin, target), rangeM: 450, angleDegrees: 22 },
            castDurationMs: 1_300,
            targetEntityId: targetId
          })
        : context.beginCast({
            abilityId: ABYSSAL_ONE_ABILITIES.slam,
            geometry: { kind: "circle", center: target, radiusM: 160 },
            castDurationMs: 1_500
          });
      if (started) nextCastAt = now + ABYSSAL_ONE.castGapMs;
    },
    onObjectInteract: (context, playerId, objectId) => {
      const hooksRoom = room(context);
      if (!hooksRoom) return;
      const now = context.now;
      if ((ABYSSAL_ONE.bombObjectIds as readonly string[]).includes(objectId)) {
        if (!hooksRoom.objectAvailable(objectId)) return;
        if (carriers.has(playerId)) { hooksRoom.notify(playerId, "You are already carrying a tide bomb.", "info"); return; }
        hooksRoom.setObjectAvailable(objectId, false);
        carriers.set(playerId, now + ABYSSAL_ONE.carryMs);
        hooksRoom.notify(playerId, "Tide bomb! Plant it on an arm within 15 seconds.", "warning");
        return;
      }
      if (!(ABYSSAL_ONE.armObjectIds as readonly string[]).includes(objectId)) return;
      if (!carriers.has(playerId)) { hooksRoom.notify(playerId, "Bring a tide bomb to weaken this arm.", "info"); return; }
      if (hooksRoom.objectState(objectId) === "destroyed") { hooksRoom.notify(playerId, "That arm is already broken.", "info"); return; }
      if (stacks >= ABYSSAL_ONE.maxStacks) { hooksRoom.notify(playerId, "The Abyssal One is as weak as it will get.", "info"); return; }
      carriers.delete(playerId);
      stacks += 1;
      hooksRoom.setObjectState(objectId, "destroyed");
      applyStacks(context);
      hooksRoom.notify(null, `An arm breaks. The Abyssal One strikes ${Math.round(ABYSSAL_ONE.damageReductionPerStack * stacks * 100)}% weaker.`, "success");
      showPhase(context);
    },
    onReset: clear,
    onDefeat: clear,
    destroy: clear
  };
}
