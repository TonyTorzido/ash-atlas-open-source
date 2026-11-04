import {
  PLAYER_ATTACK_ACTION_WINDOW_MS,
  type CombatEntitySnapshot,
  type CombatEvent,
  type PlayerCombatPoseId
} from "@ash-atlas/shared";
import type { SwingVariant } from "@ash-atlas/player-renderer";

type PlayerActionPoseState = {
  actionStartedAtMs: number;
  actionUntilMs: number;
  lastAttackTick: number;
  eventIds: Set<string>;
  /** Screen-space aim (x right, y down) of the latest local swing; null for authoritative attacks. */
  aim: AttackMotionDirection | null;
  /** The arm swing the renderer should play (latest swing); kept until replaced so a slow frame still sees it. */
  swing: SwingPlayback | null;
};

/** Arm swing request for the renderer. A new `seq` means a new swing; `cancelled` stops it (dash). */
export type SwingPlayback = Readonly<{
  seq: number;
  variant: SwingVariant;
  /** The server combo step of the swing (0, 1, 2; a shot is 0): the Jacket B sword clip it plays. */
  comboIndex: 0 | 1 | 2;
  /** Screen side of the swinging arm (the aim's x). */
  side: "left" | "right";
  startedAtMs: number;
  cancelled: boolean;
}>;

export const ATTACK_JIGGLE_DURATION_MS = 450;
export const ATTACK_STRIKE_APPROACH_DURATION_MS = 135;
export const ATTACK_STRIKE_HOLD_DURATION_MS = 45;
export const ATTACK_STRIKE_RETURN_DURATION_MS = 270;
export const ATTACK_STRIKE_DISTANCE_PX = 6;
/** Forward step of a player swing (a swing commits about a character width; was 6, which is still the mob lunge). */
export const PLAYER_SWING_LUNGE_PX = 16;
export const ATTACK_STRIKE_MAX_ROTATION_DEGREES = 0;

export type AttackMotionDirection = Readonly<{ x: number; y: number }>;
export type AttackStrikeMotion = Readonly<{
  offsetX: number;
  offsetY: number;
  rotationRadians: number;
}>;

const DEFAULT_ATTACK_DIRECTION: AttackMotionDirection = { x: 0, y: -1 };
const ATTACK_STRIKE_HOLD_END_PROGRESS = (
  ATTACK_STRIKE_APPROACH_DURATION_MS + ATTACK_STRIKE_HOLD_DURATION_MS
) / ATTACK_JIGGLE_DURATION_MS;

function smoothStep(progress: number): number {
  return progress * progress * (3 - 2 * progress);
}

/**
 * Returns one decisive strike envelope: a controlled approach, held peak, and
 * clean return. Keeping the envelope here lets the world and dungeon
 * renderers share the same timing without changing authoritative combat
 * windows.
 */
export function attackStrikeProgress(
  elapsedMs: number,
  reducedMotion = false
): number {
  if (
    reducedMotion ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs <= 0 ||
    elapsedMs >= ATTACK_JIGGLE_DURATION_MS
  ) return 0;
  const progress = elapsedMs / ATTACK_JIGGLE_DURATION_MS;
  if (elapsedMs <= ATTACK_STRIKE_APPROACH_DURATION_MS) {
    const peakProgress = elapsedMs / ATTACK_STRIKE_APPROACH_DURATION_MS;
    return smoothStep(peakProgress);
  }
  if (progress <= ATTACK_STRIKE_HOLD_END_PROGRESS) return 1;
  const returnProgress = (
    elapsedMs - ATTACK_STRIKE_APPROACH_DURATION_MS - ATTACK_STRIKE_HOLD_DURATION_MS
  ) / ATTACK_STRIKE_RETURN_DURATION_MS;
  return 1 - smoothStep(returnProgress);
}

export function attackDirectionFromPoints(
  source: Readonly<{ x: number; y: number }>,
  target: Readonly<{ x: number; y: number }>
): AttackMotionDirection | null {
  const x = target.x - source.x;
  const y = target.y - source.y;
  const length = Math.hypot(x, y);
  return Number.isFinite(length) && length > 0
    ? { x: x / length, y: y / length }
    : null;
}

export function attackStrikeMotion(
  elapsedMs: number,
  direction: AttackMotionDirection | null = null,
  reducedMotion = false,
  distancePx = ATTACK_STRIKE_DISTANCE_PX
): AttackStrikeMotion {
  const progress = attackStrikeProgress(elapsedMs, reducedMotion);
  const length = direction
    ? Math.hypot(direction.x, direction.y)
    : Number.NaN;
  const unitDirection = direction && Number.isFinite(length) && length > 0
    ? { x: direction.x / length, y: direction.y / length }
    : DEFAULT_ATTACK_DIRECTION;
  return {
    offsetX: unitDirection.x * distancePx * progress,
    offsetY: unitDirection.y * distancePx * progress,
    rotationRadians: progress === 0 || ATTACK_STRIKE_MAX_ROTATION_DEGREES === 0
      ? 0
      : -ATTACK_STRIKE_MAX_ROTATION_DEGREES * Math.PI / 180 * progress
  };
}

export function attackJiggleRotationRadians(
  elapsedMs: number,
  reducedMotion = false
): number {
  return attackStrikeMotion(elapsedMs, null, reducedMotion).rotationRadians;
}

export class PlayerAppearancePoseController {
  private readonly states = new Map<string, PlayerActionPoseState>();
  private swingSeq = 0;
  /** When the latest damage landed on each entity (presentation clock), for the hit flash. */
  private readonly hits = new Map<string, number>();

  observeAuthoritativeEvents(
    events: readonly CombatEvent[],
    nowMs: number
  ): void {
    for (const event of events) {
      if (event.type === "DAMAGE" && event.targetEntityId && (event.amount ?? 0) > 0) {
        this.hits.set(event.targetEntityId, nowMs + (event.presentationDelayMs ?? 0));
      }
      if (event.type !== "ATTACK_LANDED" || !event.sourceEntityId) continue;
      const state = this.states.get(event.sourceEntityId) ?? {
        actionStartedAtMs: nowMs,
        actionUntilMs: 0,
        lastAttackTick: -1,
        eventIds: new Set<string>(),
        aim: null,
        swing: null
      };
      if (
        event.tick < state.lastAttackTick ||
        state.eventIds.has(event.eventId)
      ) {
        continue;
      }
      if (event.tick > state.lastAttackTick) {
        state.lastAttackTick = event.tick;
        state.eventIds.clear();
        state.actionStartedAtMs = nowMs;
      }
      state.eventIds.add(event.eventId);
      state.actionUntilMs = nowMs + PLAYER_ATTACK_ACTION_WINDOW_MS;
      this.states.set(event.sourceEntityId, state);
    }
  }

  /**
   * Action combat: the swing starts on the press, not on ATTACK_LANDED. The `attack_action` pose and
   * the strike lunge begin now, along `aim` (screen space, x right, y down).
   */
  beginLocalSwing(
    playerId: string,
    nowMs: number,
    aim: AttackMotionDirection | null,
    variant: SwingVariant = "swing",
    comboIndex: 0 | 1 | 2 = variant === "finisher" ? 2 : 0
  ): void {
    const state = this.states.get(playerId) ?? {
      actionStartedAtMs: nowMs,
      actionUntilMs: 0,
      lastAttackTick: -1,
      eventIds: new Set<string>(),
      aim: null,
      swing: null
    };
    state.actionStartedAtMs = nowMs;
    state.actionUntilMs = nowMs + PLAYER_ATTACK_ACTION_WINDOW_MS;
    state.aim = aim;
    // The arm on the facing side swings (the screen x of the aim; straight up or down keeps the right arm).
    state.swing = {
      seq: ++this.swingSeq,
      variant,
      comboIndex,
      side: aim && aim.x < -0.01 ? "left" : "right",
      startedAtMs: nowMs,
      cancelled: false
    };
    this.states.set(playerId, state);
  }

  /** The latest arm swing to play for the player, or null; the renderer plays each `seq` once. */
  swingPlaybackFor(playerId: string): SwingPlayback | null {
    return this.states.get(playerId)?.swing ?? null;
  }

  /** A dash cuts the swing pose and its recovery: the action ends now. */
  cancelLocalSwing(playerId: string): void {
    const state = this.states.get(playerId);
    if (!state) return;
    if (state.swing && !state.swing.cancelled) state.swing = { ...state.swing, cancelled: true };
    if (!state.aim) return;
    state.actionUntilMs = 0;
    state.aim = null;
  }

  /** Strike lunge of a local swing (null when the current action was not a local swing). */
  localSwingMotionFor(playerId: string, nowMs: number, reducedMotion = false): AttackStrikeMotion | null {
    const state = this.states.get(playerId);
    if (!state?.aim || nowMs >= state.actionUntilMs) return null;
    return attackStrikeMotion(nowMs - state.actionStartedAtMs, state.aim, reducedMotion, PLAYER_SWING_LUNGE_PX);
  }

  poseFor(
    playerId: string,
    combat: CombatEntitySnapshot | null,
    nowMs: number
  ): PlayerCombatPoseId {
    if (combat?.lifeState === "downed") return "downed";
    const state = this.states.get(playerId);
    if (state && nowMs < state.actionUntilMs) return "attack_action";
    return authoritativeCombatEngaged(combat) ? "combat_ready" : "idle";
  }

  attackJiggleRadians(
    playerId: string,
    nowMs: number,
    reducedMotion = false
  ): number {
    return this.attackStrikeMotionFor(playerId, nowMs, null, reducedMotion).rotationRadians;
  }

  attackStrikeMotionFor(
    playerId: string,
    nowMs: number,
    direction: AttackMotionDirection | null = null,
    reducedMotion = false
  ): AttackStrikeMotion {
    const state = this.states.get(playerId);
    return state
      ? attackStrikeMotion(nowMs - state.actionStartedAtMs, direction, reducedMotion)
      : attackStrikeMotion(Number.NaN, direction, reducedMotion);
  }

  /** ms since damage last landed on the entity; NaN when none was seen. */
  hitElapsedMs(entityId: string, nowMs: number): number {
    const hitAt = this.hits.get(entityId);
    return hitAt === undefined ? Number.NaN : nowMs - hitAt;
  }

  /** Strike envelope 0..1 of the entity's current basic attack (0 when none). */
  attackStrikeProgressFor(entityId: string, nowMs: number, reducedMotion = false): number {
    const state = this.states.get(entityId);
    return state ? attackStrikeProgress(nowMs - state.actionStartedAtMs, reducedMotion) : 0;
  }

  remove(playerId: string): void {
    this.states.delete(playerId);
    this.hits.delete(playerId);
  }

  clear(): void {
    this.states.clear();
    this.hits.clear();
  }
}

export function authoritativeCombatEngaged(
  combat: CombatEntitySnapshot | null
): boolean {
  return Boolean(
    combat &&
    combat.lifeState === "alive" &&
    (
      combat.activityState !== "idle" ||
      combat.targetEntityId !== null ||
      combat.pveCombat?.focusTargetEntityId
    )
  );
}
