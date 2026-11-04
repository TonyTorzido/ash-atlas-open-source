import {
  ATTACK_PROFILE_TICK_LENGTH_MS,
  DEFAULT_ATTACK_PROFILE,
  BOW_SHOT_PROFILE,
  SWING_BUFFER_EARLY_TICKS,
  attackComboNextIndex,
  attackProfileStep,
  attackStepCycleTicks,
  isAttackFinisherStep,
  type AttackProfile,
  type ShotProfile,
  type SwingComboIndex,
  type SwingRejectReason
} from "@ash-atlas/shared";

/**
 * Client side of action-combat swings: the pending map, the local combo and recovery (same rule
 * as the server), one buffered press, and reconciliation from SWING_RESULT. Modelled on
 * `movement/dash.ts`. Times passed in are performance.now() unless a name says server.
 */

/** Server tick length (20 Hz). */
export const SWING_TICK_MS = ATTACK_PROFILE_TICK_LENGTH_MS;
/** A press this close to the end of recovery is buffered (the server accepts 3 ticks early). */
export const SWING_BUFFER_WINDOW_MS = SWING_BUFFER_EARLY_TICKS * SWING_TICK_MS;
/** A pending swing with no SWING_RESULT or refusal after this long is dropped. */
export const SWING_PENDING_TIMEOUT_MS = 1_500;

export type SwingDirection = Readonly<{ dirX: number; dirY: number }>;

export type PendingSwing = {
  requestId: string;
  seq: number;
  pressedAtMs: number;
  dirX: number;
  dirY: number;
  /** The combo step the client predicted for this press (always 0 for a shot). */
  comboIndex: SwingComboIndex;
  /** A ranged weapon was active: this press is a hitscan shot (no combo, shot recovery). */
  shot: boolean;
  /** The attack profile this press played (attackProfiles.ts): its step's windup is the contact frame. */
  profileId: string;
  /** Press to blade contact for this step (0 for a shot). */
  windupMs: number;
  /** The profile's last combo step (bigger arc, heavier cue). */
  finisher: boolean;
  /** Phase 4 fills this with the mobs it showed predicted hit effects on, so SWING_RESULT can cancel the misses. */
  predictedHitIds: Set<string>;
  /** performance.now() at which the predicted hit effects land (the blade's contact frame); set when the swing is sent. */
  hitAtMs?: number;
  /** State before this press, restored if the swing is refused. */
  previous: { lastSwingAtMs: number; lastCombo: SwingComboIndex | null; nextSwingAtMs: number };
};

/** The one buffered press. `reaim` (auto-aim taps) is asked again when the swing actually goes out. */
export type BufferedSwing = { dirX: number; dirY: number; pressedAtMs: number; reaim?: (() => SwingDirection | null) | undefined };

export type SwingPressOutcome = "send" | "buffered" | "ignored";

export type SwingResultMessage = Readonly<{
  requestId: string;
  seq: number;
  comboIndex: SwingComboIndex;
  /** Server epoch ms. */
  nextSwingAt: number;
  hits: ReadonlyArray<Readonly<{ entityId: string }>>;
  rejected?: SwingRejectReason;
}>;

export type SwingResolution = Readonly<{
  pending: PendingSwing;
  pressToResultMs: number;
  rejected: SwingRejectReason | null;
  confirmedHitIds: readonly string[];
  /** Predicted by the client but not hit by the server: Phase 4 cancels their flash and nudge. */
  missedPredictedIds: readonly string[];
}>;

type Listener = () => void;

export class SwingClientState {
  private listeners = new Set<Listener>();
  readonly pending = new Map<string, PendingSwing>();
  /** Monotonic per connection; `reset()` (reconnect) starts it over. */
  private seq = 0;
  private highestResolvedSeq = -1;
  lastSwingAtMs = 0;
  private lastCombo: SwingComboIndex | null = null;
  /** No new swing may be sent before this. */
  nextSwingAtMs = 0;
  buffered: BufferedSwing | null = null;
  /** A shooting weapon is active: presses use the shot rules (no combo, `shotProfile` recovery). Set by the caller before each press. */
  ranged = false;
  /** The readied weapon's shot rules while `ranged` (the bow's, or the arcane blast for a staff or wand). */
  shotProfile: ShotProfile = BOW_SHOT_PROFILE;
  /** The readied weapon's attack profile (combo, cadence, reset window). Set by the caller before each press. */
  profile: AttackProfile = DEFAULT_ATTACK_PROFILE;
  revision = 0;
  /** Bumped when a press came too early to buffer (the HUD blinks the ring). */
  ignoredRevision = 0;
  /** Server clock minus Date.now(), refreshed by the sender. */
  serverClockOffsetMs = 0;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getRevision = (): number => this.revision;

  getIgnoredRevision = (): number => this.ignoredRevision;

  private emit(): void {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }

  /** The combo step a swing pressed at `nowMs` would use (the server's rule, on the current profile). */
  predictCombo(nowMs: number): SwingComboIndex {
    if (this.ranged) return 0;
    return attackComboNextIndex(this.profile, this.lastCombo, this.lastSwingAtMs, nowMs) as SwingComboIndex;
  }

  ready(nowMs: number): boolean {
    return nowMs >= this.nextSwingAtMs;
  }

  /**
   * Decide what a press does. "send": the caller sends now. "buffered": it is kept and
   * `takeBuffered` releases it at the end of recovery. "ignored": too early to buffer.
   */
  press(nowMs: number, direction: SwingDirection, reaim?: () => SwingDirection | null): SwingPressOutcome {
    if (nowMs >= this.nextSwingAtMs) {
      // This press goes out now and supersedes an older buffered one (a SWING_RESULT correction can leave one
      // behind), which would otherwise fire as a phantom swing at the end of this swing's recovery.
      this.buffered = null;
      return "send";
    }
    if (this.nextSwingAtMs - nowMs <= SWING_BUFFER_WINDOW_MS) {
      this.buffered = { dirX: direction.dirX, dirY: direction.dirY, pressedAtMs: nowMs, reaim };
      return "buffered";
    }
    this.ignoredRevision += 1;
    this.emit();
    return "ignored";
  }

  /** Milliseconds until the buffered press can go out (null when nothing is buffered). */
  bufferedDelayMs(nowMs: number): number | null {
    if (!this.buffered) return null;
    return Math.max(0, this.nextSwingAtMs - nowMs);
  }

  /** Release the buffered press once recovery is over (after a timer or a SWING_RESULT correction). */
  takeBuffered(nowMs: number): BufferedSwing | null {
    const buffered = this.buffered;
    if (!buffered || nowMs < this.nextSwingAtMs) return null;
    this.buffered = null;
    return buffered;
  }

  /** The next monotonic seq (one per sent SWING). */
  nextSeq(): number {
    const seq = this.seq;
    this.seq += 1;
    return seq;
  }

  /** The SWING went out: advance the local combo and recovery with the server's rule. */
  started(input: Readonly<{ requestId: string; seq: number; pressedAtMs: number; dirX: number; dirY: number }>): PendingSwing {
    const comboIndex = this.predictCombo(input.pressedAtMs);
    const step = attackProfileStep(this.profile, comboIndex);
    const pending: PendingSwing = {
      requestId: input.requestId,
      seq: input.seq,
      pressedAtMs: input.pressedAtMs,
      dirX: input.dirX,
      dirY: input.dirY,
      comboIndex,
      shot: this.ranged,
      profileId: this.profile.id,
      windupMs: this.ranged ? 0 : step.windupMs,
      finisher: !this.ranged && isAttackFinisherStep(this.profile, comboIndex),
      predictedHitIds: new Set<string>(),
      previous: { lastSwingAtMs: this.lastSwingAtMs, lastCombo: this.lastCombo, nextSwingAtMs: this.nextSwingAtMs }
    };
    this.pending.set(input.requestId, pending);
    this.lastSwingAtMs = input.pressedAtMs;
    this.lastCombo = comboIndex;
    const recoveryTicks = this.ranged ? this.shotProfile.recoveryTicks : attackStepCycleTicks(step);
    this.nextSwingAtMs = input.pressedAtMs + recoveryTicks * SWING_TICK_MS;
    this.emit();
    return pending;
  }

  /** A dash may start at any time and ends the swing recovery. */
  dashStarted(): void {
    this.nextSwingAtMs = 0;
    this.emit();
  }

  /**
   * SWING_RESULT: corrects the combo and recovery from the server and returns what Phase 4 needs.
   * `nowMs` is performance.now() at receipt; `serverNowMs` is the synchronized server time at receipt.
   */
  result(message: SwingResultMessage, nowMs: number, serverNowMs: number): SwingResolution | null {
    const pending = this.pending.get(message.requestId);
    if (!pending) return null;
    this.pending.delete(message.requestId);
    const rejected = message.rejected ?? null;
    const newest = message.seq >= this.highestResolvedSeq;
    if (newest) this.highestResolvedSeq = message.seq;
    const pressToResultMs = Math.max(0, nowMs - pending.pressedAtMs);
    const nextAtMs = nowMs + (message.nextSwingAt - serverNowMs);
    if (rejected === null) {
      if (newest) {
        this.lastCombo = message.comboIndex;
        this.nextSwingAtMs = nextAtMs;
      }
    } else if (newest) {
      // Refused: the swing did not happen, so neither does its combo step. Keep the server's recovery when it gave one.
      this.lastSwingAtMs = pending.previous.lastSwingAtMs;
      this.lastCombo = pending.previous.lastCombo;
      this.nextSwingAtMs = rejected === "too_soon" && message.nextSwingAt > 0 ? nextAtMs : pending.previous.nextSwingAtMs;
    }
    const confirmed = message.hits.map((hit) => hit.entityId);
    const confirmedSet = new Set(confirmed);
    const missedPredictedIds = [...pending.predictedHitIds].filter((id) => !confirmedSet.has(id));
    this.emit();
    return { pending, pressToResultMs, rejected, confirmedHitIds: confirmed, missedPredictedIds };
  }

  /**
   * The server refused the SWING at admission (DUNGEON_ERROR or MANOR_ERROR with its requestId), or no
   * answer came within SWING_PENDING_TIMEOUT_MS: the swing is gone, so undo its combo step and recovery.
   */
  fail(requestId: string | undefined): PendingSwing | null {
    if (!requestId) return null;
    const pending = this.pending.get(requestId);
    if (!pending) return null;
    this.pending.delete(requestId);
    if (this.lastSwingAtMs === pending.pressedAtMs) {
      this.lastSwingAtMs = pending.previous.lastSwingAtMs;
      this.lastCombo = pending.previous.lastCombo;
      this.nextSwingAtMs = pending.previous.nextSwingAtMs;
    }
    this.buffered = null;
    this.emit();
    return pending;
  }

  /** Drops (and returns) pending swings older than the timeout. */
  expire(nowMs: number): PendingSwing[] {
    const expired: PendingSwing[] = [];
    for (const pending of [...this.pending.values()]) {
      if (nowMs - pending.pressedAtMs < SWING_PENDING_TIMEOUT_MS) continue;
      const failed = this.fail(pending.requestId);
      if (failed) expired.push(failed);
    }
    return expired;
  }

  setRanged(ranged: boolean, profile: ShotProfile = BOW_SHOT_PROFILE): void {
    this.ranged = ranged;
    this.shotProfile = profile;
  }

  setProfile(profile: AttackProfile): void {
    this.profile = profile;
  }

  setServerClockOffset(offsetMs: number): void {
    if (Number.isFinite(offsetMs)) this.serverClockOffsetMs = offsetMs;
  }

  serverNow(): number {
    return Date.now() + this.serverClockOffsetMs;
  }

  /** Reconnect: a new connection starts its seq over and forgets everything in flight. */
  reset(): void {
    this.pending.clear();
    this.seq = 0;
    this.highestResolvedSeq = -1;
    this.lastSwingAtMs = 0;
    this.lastCombo = null;
    this.nextSwingAtMs = 0;
    this.buffered = null;
    this.emit();
  }
}

export const swingClientState = new SwingClientState();

/**
 * The drawn key-pose set (0 / 1 / 2 = swing 1 / 2 / 3) a combo step shows until a profile has its own art: the
 * finisher draws swing 3, the other steps alternate swings 1 and 2. The default combo maps 0 -> 0, 1 -> 1, 2 -> 2.
 */
export function swingPoseComboIndex(comboIndex: number, finisher: boolean): 0 | 1 | 2 {
  if (finisher) return 2;
  return comboIndex % 2 === 1 ? 1 : 0;
}
