import { bearingDegrees, type LatLon, type MobArchetypeKey } from "@ash-atlas/shared";
import type { BossController, BossControllerContext } from "./bossFramework.js";

/**
 * Tidemaw (Drowned City, north wing; docs/design/DROWNED_CITY_SPEC.md section 3). A maw in the
 * central pool with four tentacles in the corner pools, one of them marked. While submerged the
 * boss takes no damage. Killing the marked tentacle surfaces it for 15 s; then it dives again and
 * the mark moves to another pool. Unmarked tentacles regrow 8 s after they fall. Reset, defeat and
 * destroy remove every tentacle.
 *
 * Phase ids are presentation: "submerged" and "surfaced" pick the client's boss art.
 */
export const TIDEMAW = Object.freeze({
  poolAnchors: ["tidemaw_pool_nw", "tidemaw_pool_ne", "tidemaw_pool_sw", "tidemaw_pool_se"] as const,
  surfacedMs: 15_000,
  regrowMs: 8_000,
  openingDelayMs: 2_000,
  castGapMs: 4_000,
  biteDamage: 24,
  undertowDamage: 16
});

export const TIDEMAW_ABILITIES = Object.freeze({
  bite: "tidemaw_bite",
  undertow: "tidemaw_undertow"
});

export const TIDEMAW_PHASES = Object.freeze({ submerged: "submerged", surfaced: "surfaced" });

export type TidemawHooks = Readonly<{
  bossPosition(bossEntityId: string): LatLon | null;
  playerPosition(entityId: string): LatLon | null;
  anchorPosition(bossEntityId: string, anchorId: string): LatLon | null;
  /** Spawns one tentacle (summoned by the boss) and returns its entity id, or null. */
  spawnTentacle(bossEntityId: string, archetype: MobArchetypeKey, position: LatLon): string | null;
  isAlive(entityId: string): boolean;
  despawn(entityIds: readonly string[]): void;
  random?(): number;
}>;

type Slot = { anchorId: string; entityId: string | null; marked: boolean; regrowAt: number | null };

export function createTidemawController(hooks: TidemawHooks): BossController {
  const random = hooks.random ?? Math.random;
  let slots: Slot[] = [];
  let markedIndex = 0;
  let surfacedUntil: number | null = null;
  let nextCastAt = 0;
  let immune: boolean | null = null;

  const spawn = (context: BossControllerContext, slot: Slot, marked: boolean): void => {
    const bossId = context.encounter.mobEntityId;
    const position = hooks.anchorPosition(bossId, slot.anchorId);
    slot.marked = marked;
    slot.regrowAt = null;
    slot.entityId = position
      ? hooks.spawnTentacle(bossId, marked ? "tidemaw_tentacle_marked" : "tidemaw_tentacle", position)
      : null;
  };

  const setImmune = (context: BossControllerContext, value: boolean): void => {
    if (immune === value) return;
    immune = value;
    context.encounter.setMovementOverride(value
      ? { id: "tidemaw-submerged", generation: context.lifeGeneration, incomingDamageMultiplier: 0 }
      : null);
  };

  const submerge = (context: BossControllerContext, nextMark: number): void => {
    surfacedUntil = null;
    markedIndex = nextMark;
    const slot = slots[markedIndex]!;
    if (slot.entityId && hooks.isAlive(slot.entityId)) hooks.despawn([slot.entityId]);
    spawn(context, slot, true);
    setImmune(context, true);
    context.encounter.transitionPhase(TIDEMAW_PHASES.submerged);
  };

  const clear = (context: BossControllerContext): void => {
    const living = slots.flatMap((slot) => slot.entityId && hooks.isAlive(slot.entityId) ? [slot.entityId] : []);
    if (living.length > 0) hooks.despawn(living);
    slots = [];
    surfacedUntil = null;
    immune = null;
    context.encounter.setMovementOverride(null);
  };

  return {
    onActivate: (context) => {
      nextCastAt = context.now + TIDEMAW.openingDelayMs;
      if (slots.length > 0) return;
      slots = TIDEMAW.poolAnchors.map((anchorId) => ({ anchorId, entityId: null, marked: false, regrowAt: null }));
      markedIndex = Math.floor(random() * slots.length) % slots.length;
      slots.forEach((slot, index) => { if (index !== markedIndex) spawn(context, slot, false); });
      submerge(context, markedIndex);
    },
    update: (context) => {
      if (slots.length === 0) return;
      const now = context.now;
      if (surfacedUntil !== null) {
        if (now >= surfacedUntil) {
          // The mark moves to another pool.
          const choices = slots.map((_, index) => index).filter((index) => index !== markedIndex);
          submerge(context, choices[Math.floor(random() * choices.length) % choices.length]!);
        }
      } else {
        const marked = slots[markedIndex]!;
        if (!marked.entityId || !hooks.isAlive(marked.entityId)) {
          marked.entityId = null;
          surfacedUntil = now + TIDEMAW.surfacedMs;
          setImmune(context, false);
          context.encounter.transitionPhase(TIDEMAW_PHASES.surfaced);
        }
      }
      // Unmarked tentacles regrow; the marked pool stays empty while the boss is surfaced.
      slots.forEach((slot, index) => {
        if (index === markedIndex || (slot.entityId && hooks.isAlive(slot.entityId))) return;
        slot.entityId = null;
        if (slot.regrowAt === null) slot.regrowAt = now + TIDEMAW.regrowMs;
        else if (now >= slot.regrowAt) spawn(context, slot, false);
      });

      if (now < nextCastAt || context.encounter.activeCasts.length > 0) return;
      const origin = hooks.bossPosition(context.encounter.mobEntityId);
      if (!origin) return;
      const targetId = context.selectTarget({ kind: "nearest", origin }, origin);
      const target = targetId ? hooks.playerPosition(targetId) : null;
      if (!targetId || !target) return;
      const surfaced = surfacedUntil !== null;
      const started = surfaced && random() < 0.6
        ? context.beginCast({
            abilityId: TIDEMAW_ABILITIES.bite,
            geometry: { kind: "cone", origin, facingDegrees: bearingDegrees(origin, target), rangeM: 170, angleDegrees: 70 },
            castDurationMs: 1_100,
            targetEntityId: targetId
          })
        : context.beginCast({
            abilityId: TIDEMAW_ABILITIES.undertow,
            geometry: { kind: "circle", center: origin, radiusM: 240 },
            castDurationMs: 1_600
          });
      if (started) nextCastAt = now + TIDEMAW.castGapMs;
    },
    onReset: clear,
    onDefeat: clear,
    destroy: clear
  };
}
