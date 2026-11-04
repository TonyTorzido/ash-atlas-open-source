import {
  MOB_TACTICS_ENGAGE_SEATS,
  MOB_TACTICS_FRONT_BONUS_MS,
  MOB_TACTICS_FRONT_HALF_ANGLE_DEG,
  MOB_TACTICS_LANDING_MIN_GAP_MS,
  MOB_TACTICS_MELEE_TOKENS,
  MOB_TACTICS_RANGED_TOKENS,
  MOB_TACTICS_SEPARATION_MAX_SHARE,
  MOB_TACTICS_SEPARATION_RADIUS_M,
  MOB_TACTICS_SEPARATION_STRENGTH,
  MOB_TACTICS_SLOT_ARRIVE_M,
  MOB_TACTICS_SLOT_HYSTERESIS_DEG,
  MOB_TACTICS_SLOT_MIN_SPACING_M,
  MOB_TACTICS_STARVATION_MS,
  MOB_TACTICS_STRAFE_FLIP_MAX_MS,
  MOB_TACTICS_STRAFE_FLIP_MIN_MS,
  MOB_TACTICS_WAIT_SCORE_CAP_MS,
  mobTacticsTokenMaxHoldMs,
  angleDiffDeg,
  minSlotAngleDeg,
  normalizeAngleDeg,
  ringCapacity,
  tacticsHash01,
  tacticsMsToTicks,
  tacticsRingRadiusM,
  MOB_ARCH_GOVERNOR_BUDGET_HE,
  MOB_ARCH_GOVERNOR_WINDOW_MS,
  MOB_ARCH_SIGNATURE_LANDING_GAP_MS,
  MOB_ARCH_SIGNATURE_MIN_SPACING_MS,
  MOB_ARCH_SWARM_TOKEN_COST,
  type MobArchetypeId,
  type MobArchetypeParams,
  type MobSignatureParams,
  type MobRhythm,
  type TacticsPhase,
  type TacticsPool,
  type TacticsRing
} from "@ash-atlas/shared";

/**
 * Pure parts of mob tactics (docs/plans/mob-ai-phase1.md): token ledger, slot relaxation, ring
 * assignment, separation and steering. No engine types and no I/O; the engine wiring (chunk 3)
 * converts positions to a local metre frame around the target player (x east, y north) and calls
 * these. Everything is deterministic: ties break by id.
 */

// ---------------------------------------------------------------------------------------------
// Tokens

export type TokenCandidate = Readonly<{
  id: string;
  pool: TacticsPool;
  /** Token points: 1 for common to rare, 2 for epic and legendary. */
  cost: number;
  /** Tick the mob began waiting for a token (reset on release). */
  waitingSinceTick: number;
  /** Distance from the target player, metres. */
  distanceM: number;
  /** Bearing from the target player to the mob, degrees. */
  bearingDeg: number;
  /** The player just hit this mob: it goes first, ahead of fairness. */
  grabbed: boolean;
  /** Engage-ring radius for this mob, used for the small closeness bonus. */
  engageRadiusM: number;
  /** Archetype starvation threshold (Phase 2); absent = MOB_TACTICS_STARVATION_MS. */
  starvationMs?: number | undefined;
}>;

type Holder = { cost: number; pool: TacticsPool; grantedTick: number };

const TACTICS_POOLS: readonly TacticsPool[] = ["melee", "ranged"];
/** Smallest token cost: a common Swarmer pays half a point (Phase 2). Phase 1 costs are whole points (1 or 2). */
export const TOKEN_MIN_COST = MOB_ARCH_SWARM_TOKEN_COST;

/** A reserved landing on one player (Phase 2 landing windows; Phase 1 only ever reserves basic landings). */
export type LandingKind = "basic" | "signature";
export type LandingReservation = { tick: number; kind: LandingKind; waveId: string | null; mobId: string; /** Hit-equivalents this basic lands (archetypes), counted by the governor while in flight. */ he?: number };
const NO_IDS: readonly string[] = Object.freeze([]);

/** Score used to order token candidates. Higher goes first. */
export function tokenScore(
  candidate: TokenCandidate,
  nowTick: number,
  tickRateHz: number,
  headingDeg: number | null
): number {
  if (candidate.grabbed) return 1e12;
  const waitedMs = Math.max(0, ((nowTick - candidate.waitingSinceTick) * 1_000) / tickRateHz);
  if (waitedMs >= (candidate.starvationMs ?? MOB_TACTICS_STARVATION_MS)) return 1e9 + waitedMs;
  let score = Math.min(waitedMs, MOB_TACTICS_WAIT_SCORE_CAP_MS);
  if (headingDeg !== null &&
    Math.abs(angleDiffDeg(headingDeg, candidate.bearingDeg)) <= MOB_TACTICS_FRONT_HALF_ANGLE_DEG) {
    score += MOB_TACTICS_FRONT_BONUS_MS;
  }
  return score + Math.max(0, candidate.engageRadiusM - candidate.distanceM);
}

/**
 * One target player's token pools, reserved landings, signature slot and damage governor. Capacity is
 * in points (fractional costs allowed: a common Swarmer pays 0.5). Release is idempotent and
 * `validate` takes back anything stale, so a missed release cannot leak a token.
 *
 * Landing windows (Phase 2, spec 6.3) replace the Phase 1 single cursor: a new basic landing keeps
 * MOB_TACTICS_LANDING_MIN_GAP_MS from every reserved basic landing (members of one swarm wave may
 * share a tick) and MOB_ARCH_SIGNATURE_LANDING_GAP_MS from every signature landing. With basic
 * strikes of one windup length only (Phase 1), every new landing is the latest one, so this is
 * exactly the old cursor rule `land >= lastLanding + gap` (a test proves it).
 */
export class TokenLedger {
  readonly holders = new Map<string, Holder>();
  /** Reserved landings (pruned once they can no longer constrain a new one). */
  readonly landings: LandingReservation[] = [];
  /** One signature slot per player: the mob whose signature telegraph is live, from start to landing. */
  signatureHolderId: string | null = null;
  /** Last landing tick of the previous signature (MOB_ARCH_SIGNATURE_MIN_SPACING_MS spacing). */
  lastSignatureLandTick = Number.NEGATIVE_INFINITY;
  /**
   * A token holder whose ready signature waits for the basic landing windows to clear: no new basic windup starts
   * until it starts (or the hold expires), so the committed landings drain and a window opens. Combat feel: with 700 ms
   * windups a close rotation always had a committed basic landing inside the signature gap, so the pack lunge never
   * fired after the opener.
   */
  signatureBasicHold: { mobId: string; untilTick: number } | null = null;
  private readonly capacity: Record<TacticsPool, number>;
  private readonly used: Record<TacticsPool, number> = { melee: 0, ranged: 0 };
  private readonly maxHoldTicks: number;
  private readonly gapTicks: number;
  private readonly signatureGapTicks: number;
  private readonly signatureSpacingTicks: number;
  private readonly governorTicks: number;
  /** Landed hit-equivalents (HE) for the governor, oldest first. */
  private readonly landed: { tick: number; he: number }[] = [];
  private readonly orderScratch: TokenCandidate[] = [];
  private readonly scoreScratch: number[] = [];

  constructor(
    readonly playerId: string,
    private readonly tickRateHz: number,
    capacity: Partial<Record<TacticsPool, number>> = {},
    /** MOB_TELEGRAPH_SCALE: the stuck-holder fail-safe grows with the windups it must cover. */
    telegraphScale = 1
  ) {
    this.capacity = {
      melee: capacity.melee ?? MOB_TACTICS_MELEE_TOKENS,
      ranged: capacity.ranged ?? MOB_TACTICS_RANGED_TOKENS
    };
    this.maxHoldTicks = tacticsMsToTicks(mobTacticsTokenMaxHoldMs(telegraphScale), tickRateHz);
    this.gapTicks = tacticsMsToTicks(MOB_TACTICS_LANDING_MIN_GAP_MS, tickRateHz);
    this.signatureGapTicks = tacticsMsToTicks(MOB_ARCH_SIGNATURE_LANDING_GAP_MS, tickRateHz);
    this.signatureSpacingTicks = tacticsMsToTicks(MOB_ARCH_SIGNATURE_MIN_SPACING_MS, tickRateHz);
    this.governorTicks = tacticsMsToTicks(MOB_ARCH_GOVERNOR_WINDOW_MS, tickRateHz);
  }

  /** Pool capacity in points (Phase 2: casters get a second ranged point while archetypes are on). */
  setCapacity(pool: TacticsPool, points: number): void {
    this.capacity[pool] = points;
  }

  /** Cost actually charged for a requested cost: at least TOKEN_MIN_COST, at most the pool. */
  private chargedCost(cost: number, pool: TacticsPool): number {
    return Math.max(TOKEN_MIN_COST, Math.min(cost, this.capacity[pool]));
  }

  inUse(pool: TacticsPool): number {
    return this.used[pool];
  }

  holds(id: string): boolean {
    return this.holders.has(id);
  }

  /** Returns true when a token was actually released. */
  release(id: string): boolean {
    if (this.signatureBasicHold?.mobId === id) this.signatureBasicHold = null;
    const holder = this.holders.get(id);
    if (!holder) return false;
    this.holders.delete(id);
    this.used[holder.pool] -= holder.cost;
    return true;
  }

  clear(): void {
    this.holders.clear();
    this.used.melee = 0;
    this.used.ranged = 0;
    this.landings.length = 0;
    this.signatureHolderId = null;
    this.signatureBasicHold = null;
    this.landed.length = 0;
  }

  /** Holds new basic windups for `mobId`'s waiting signature, for at most one windup plus the gap (see signatureBasicHold). */
  holdBasicsForSignature(mobId: string, nowTick: number, maxTicks: number): void {
    if (this.signatureBasicHold && this.signatureBasicHold.untilTick > nowTick) return;
    this.signatureBasicHold = { mobId, untilTick: nowTick + maxTicks };
  }

  /** Cost a holder is charged now, or 0. */
  costOf(id: string): number {
    return this.holders.get(id)?.cost ?? 0;
  }

  /**
   * Raises a holder's cost (a basic cycle becoming a signature: the extra points are taken now).
   * False, and nothing changes, when the pool cannot cover the difference or `id` holds no token.
   */
  upgrade(id: string, cost: number): boolean {
    const holder = this.holders.get(id);
    if (!holder) return false;
    const next = this.chargedCost(cost, holder.pool);
    const delta = next - holder.cost;
    if (delta <= 0) return true;
    if (this.used[holder.pool] + delta > this.capacity[holder.pool] + 1e-9) return false;
    holder.cost = next;
    this.used[holder.pool] += delta;
    return true;
  }

  /**
   * Restarts the hold clock of a holder that has just started its strike, so the stuck-holder fail-safe never takes
   * the token back mid-windup (a longer walk to the seat plus a 750 ms windup could pass MOB_TACTICS_TOKEN_MAX_HOLD_MS
   * and let a third windup start alongside the two token holders).
   */
  restartHold(id: string, nowTick: number): void {
    const holder = this.holders.get(id);
    if (holder) holder.grantedTick = nowTick;
  }

  /** Takes back tokens whose holder is no longer valid or has held one too long. Returns the ids. */
  validate(isValid: (id: string) => boolean, nowTick: number): readonly string[] {
    let stale: string[] | null = null;
    for (const [id, holder] of this.holders) {
      if (!isValid(id) || nowTick - holder.grantedTick > this.maxHoldTicks) (stale ??= []).push(id);
    }
    if (stale === null) return NO_IDS;
    stale.sort();
    for (const id of stale) this.release(id);
    return stale;
  }

  /**
   * Grants tokens to the best candidates. Order: grabbed, starved, then score; ties by id. Within
   * a pool a candidate that does not fit stops the pool (strict priority, so an epic is not
   * starved by grunts). Candidates that already hold a token are ignored. Returns the new holders.
   */
  arbitrate(
    candidates: readonly TokenCandidate[],
    nowTick: number,
    headingDeg: number | null
  ): string[] {
    const granted: string[] = [];
    this.arbitrateInto(candidates, candidates.length, nowTick, headingDeg, granted);
    return granted;
  }

  /**
   * Allocation-free `arbitrate` for the engine's hot loop: reads the first `count` candidates,
   * writes the new holders into `out` (cleared first) and returns how many were granted. The
   * ordering scratch is reused across calls (insertion sort; rosters are at most 16 mobs).
   */
  arbitrateInto(
    candidates: readonly TokenCandidate[],
    count: number,
    nowTick: number,
    headingDeg: number | null,
    out: string[]
  ): number {
    out.length = 0;
    const order = this.orderScratch;
    const scores = this.scoreScratch;
    for (const pool of TACTICS_POOLS) {
      let size = 0;
      for (let index = 0; index < count; index += 1) {
        const candidate = candidates[index]!;
        if (candidate.pool !== pool || this.holders.has(candidate.id)) continue;
        const score = tokenScore(candidate, nowTick, this.tickRateHz, headingDeg);
        let slot = size;
        while (slot > 0) {
          const previous = order[slot - 1]!;
          const previousScore = scores[slot - 1]!;
          if (previousScore > score || (previousScore === score && previous.id < candidate.id)) break;
          order[slot] = previous;
          scores[slot] = previousScore;
          slot -= 1;
        }
        order[slot] = candidate;
        scores[slot] = score;
        size += 1;
      }
      for (let index = 0; index < size; index += 1) {
        const candidate = order[index]!;
        const cost = this.chargedCost(candidate.cost, pool);
        if (this.used[pool] + cost > this.capacity[pool] + 1e-9) break;
        this.holders.set(candidate.id, { cost, pool, grantedTick: nowTick });
        this.used[pool] += cost;
        out.push(candidate.id);
      }
      order.length = 0;
      scores.length = 0;
    }
    return out.length;
  }

  /** Drops reservations too old to constrain any landing from `nowTick` on. */
  private pruneLandings(nowTick: number): void {
    const horizon = nowTick - Math.max(this.signatureSpacingTicks, this.signatureGapTicks, this.gapTicks);
    let write = 0;
    for (let read = 0; read < this.landings.length; read += 1) {
      const reservation = this.landings[read]!;
      if (reservation.tick >= horizon) this.landings[write++] = reservation;
    }
    this.landings.length = write;
  }

  /** May a basic landing at `landTick` be reserved (basic gap, signature gap, shared wave tick)? */
  private basicLandingFits(landTick: number, waveId: string | null): boolean {
    for (const reservation of this.landings) {
      const apart = Math.abs(landTick - reservation.tick);
      if (reservation.kind === "signature") {
        if (apart < this.signatureGapTicks) return false;
      } else if (apart < this.gapTicks && !(waveId !== null && reservation.waveId === waveId && apart === 0)) {
        return false;
      }
    }
    return true;
  }

  /**
   * May a windup that lands `windupTicks` from now start this tick without breaking a landing gap?
   * Swarm wave members (same `waveId`) may land on the same tick.
   */
  canStartWindup(nowTick: number, windupTicks: number, waveId: string | null = null): boolean {
    if (this.signatureBasicHold) {
      if (this.signatureBasicHold.untilTick > nowTick) return false;
      this.signatureBasicHold = null;
    }
    this.pruneLandings(nowTick);
    return this.basicLandingFits(nowTick + windupTicks, waveId);
  }

  /** Records a started basic windup's landing. */
  commitLanding(nowTick: number, windupTicks: number, mobId = "", waveId: string | null = null, he = 0): void {
    this.landings.push({ tick: nowTick + windupTicks, kind: "basic", waveId, mobId, ...(he > 0 ? { he } : {}) });
  }

  /**
   * May a signature whose parts land `partTicks` from now (one entry, or two for a double strike)
   * start this tick? The slot must be free, each landing at least the signature spacing after the
   * previous signature and the signature gap from every reserved basic landing.
   */
  canStartSignature(nowTick: number, partTicks: readonly number[]): boolean {
    if (!this.signatureSlotOpen(nowTick, partTicks)) return false;
    this.pruneLandings(nowTick);
    for (const offset of partTicks) {
      const landTick = nowTick + offset;
      for (const reservation of this.landings) {
        const apart = Math.abs(landTick - reservation.tick);
        if (reservation.kind === "basic" ? apart < this.signatureGapTicks : apart < this.signatureSpacingTicks) return false;
      }
    }
    return true;
  }

  /**
   * The slot is free and a signature starting now would land the full spacing after the previous one (reserved
   * basic landings aside: those clear within a windup, so a signature-ready mob may wait for them with its token).
   */
  signatureSlotOpen(nowTick: number, partTicks: readonly number[]): boolean {
    if (this.signatureHolderId !== null || partTicks.length === 0) return false;
    return nowTick + partTicks[0]! - this.lastSignatureLandTick >= this.signatureSpacingTicks;
  }

  /** Takes the signature slot and reserves each part's landing. */
  takeSignatureSlot(mobId: string, nowTick: number, partTicks: readonly number[]): void {
    if (this.signatureBasicHold?.mobId === mobId) this.signatureBasicHold = null;
    this.signatureHolderId = mobId;
    for (const offset of partTicks) this.landings.push({ tick: nowTick + offset, kind: "signature", waveId: null, mobId });
  }

  /** The signature landed (its last part): the slot frees and the spacing clock starts. Idempotent. */
  finishSignature(mobId: string, landedTick: number): void {
    if (this.signatureHolderId !== mobId) return;
    this.signatureHolderId = null;
    this.lastSignatureLandTick = Math.max(this.lastSignatureLandTick, landedTick);
  }

  /** A signature cancelled before it landed: the slot frees and its unlanded reservations go. Idempotent. */
  cancelSignature(mobId: string, nowTick: number): void {
    if (this.signatureHolderId === mobId) this.signatureHolderId = null;
    let write = 0;
    for (let read = 0; read < this.landings.length; read += 1) {
      const reservation = this.landings[read]!;
      if (!(reservation.mobId === mobId && reservation.kind === "signature" && reservation.tick > nowTick)) {
        this.landings[write++] = reservation;
      }
    }
    this.landings.length = write;
  }

  /** Records landed hit-equivalents for the incoming-damage governor. */
  recordLanded(tick: number, he: number): void {
    if (he > 0) this.landed.push({ tick, he });
  }

  /** Landed HE over the governor window ending at `nowTick`. */
  governorLoad(nowTick: number): number {
    const horizon = nowTick - this.governorTicks;
    let drop = 0;
    while (drop < this.landed.length && this.landed[drop]!.tick <= horizon) drop += 1;
    if (drop > 0) this.landed.splice(0, drop);
    let total = 0;
    for (const entry of this.landed) total += entry.he;
    return total;
  }

  /** Would `extraHe` more keep the window at or under MOB_ARCH_GOVERNOR_BUDGET_HE? */
  governorAllows(nowTick: number, extraHe: number): boolean {
    // Basics already wound up but not landed count too: with 750 ms windups several are in flight at once, and
    // counting only this tick's starts let a dense pack overshoot the 2 s budget.
    let inFlight = 0;
    for (const landing of this.landings) if (landing.kind === "basic" && landing.tick > nowTick && landing.he) inFlight += landing.he;
    return this.governorLoad(nowTick) + inFlight + extraHe <= MOB_ARCH_GOVERNOR_BUDGET_HE + 1e-9;
  }
}

// ---------------------------------------------------------------------------------------------
// Rings and slots

export type RingItem = Readonly<{
  id: string;
  pool: TacticsPool;
  /** Sort key: higher gets an engage seat first (use tokenScore). */
  score: number;
  attackRangeM: number;
  currentRing: TacticsRing | null;
  /** Body-sized ring radii (engine); absent = the factor-of-range defaults. */
  engageRadiusM?: number;
  waitRadiusM?: number;
}>;

export type RingAssignment = Readonly<{ ring: TacticsRing; layer: number; radiusM: number }>;

/**
 * Melee mobs: the best MOB_TACTICS_ENGAGE_SEATS take the engage ring (current occupants first, so
 * seats do not flap); the rest wait on the wait ring. Ranged mobs use the outer ring. A ring that
 * is full spills the extra mobs outward by one layer each time.
 */
export function assignRings(
  items: readonly RingItem[],
  options: Readonly<{ engageSeats?: number; preferCurrent?: boolean; spacingM?: number }> = {}
): Map<string, RingAssignment> {
  const result = new Map<string, RingAssignment>();
  const engageSeats = Math.max(1, options.engageSeats ?? MOB_TACTICS_ENGAGE_SEATS);
  const preferCurrent = options.preferCurrent ?? true;
  const byOrder = (left: RingItem, right: RingItem) =>
    (preferCurrent ? Number(right.currentRing === "engage") - Number(left.currentRing === "engage") : 0) ||
    right.score - left.score ||
    (left.id < right.id ? -1 : 1);
  const melee = items.filter((item) => item.pool === "melee").sort(byOrder);
  const ranged = items.filter((item) => item.pool === "ranged").sort(byOrder);
  const counts = new Map<string, number>();
  const place = (item: RingItem, ring: TacticsRing): void => {
    const override = ring === "engage" ? item.engageRadiusM : ring === "wait" ? item.waitRadiusM : undefined;
    const baseRadius = override ?? tacticsRingRadiusM(item.attackRangeM, ring);
    const key = `${ring}`;
    const placed = counts.get(key) ?? 0;
    counts.set(key, placed + 1);
    const layer = Math.floor(placed / ringCapacity(baseRadius, options.spacingM));
    const radiusM = override !== undefined
      ? override + layer * (options.spacingM ?? MOB_TACTICS_SLOT_MIN_SPACING_M)
      : tacticsRingRadiusM(item.attackRangeM, ring, layer);
    result.set(item.id, { ring, layer, radiusM });
  };
  melee.forEach((item, index) => place(item, index < engageSeats ? "engage" : "wait"));
  for (const item of ranged) place(item, "outer");
  return result;
}

export type SlotItem = Readonly<{
  id: string;
  /** Bearing from the target to the mob now. */
  bearingDeg: number;
  /** The slot angle it held last time, or null for a new mob. */
  prevSlotDeg: number | null;
  /** Reachable arc (home leash): centre bearing and half-width. Absent or 180 = the whole ring. */
  arcCenterDeg?: number;
  arcHalfDeg?: number;
}>;

/**
 * Spreads the first `n` angles of `values` (sorted by bearing, in place) so neighbours are at
 * least `minAngle` apart, moving each pair apart symmetrically (a spread, never a teleport).
 * Works on an unwrapped copy in place, then normalises.
 */
function spreadAnglesInPlace(values: number[], n: number, minAngle: number): void {
  if (n <= 1) {
    if (n === 1) values[0] = normalizeAngleDeg(values[0]!);
    return;
  }
  const min = Math.min(minAngle, 360 / n);
  let previousRaw = values[0]!;
  for (let index = 1; index < n; index += 1) {
    const raw = values[index]!;
    values[index] = values[index - 1]! + normalizeAngleDeg(raw - previousRaw);
    previousRaw = raw;
  }
  for (let pass = 0; pass < 64; pass += 1) {
    let moved = false;
    for (let index = 0; index < n; index += 1) {
      const next = (index + 1) % n;
      const gap = next === 0 ? values[0]! + 360 - values[index]! : values[next]! - values[index]!;
      if (gap < min - 1e-9) {
        const half = (min - gap) / 2;
        values[index] = values[index]! - half;
        values[next] = values[next]! + half;
        moved = true;
      }
    }
    if (!moved) break;
  }
  for (let index = 0; index < n; index += 1) values[index] = normalizeAngleDeg(values[index]!);
}

/** Reusable scratch for relaxSlotsInto, so the engine's slot pass allocates nothing per call. */
export class SlotScratch {
  readonly order: SlotItem[] = [];
  readonly angles: number[] = [];
  readonly chosen: number[] = [];
  readonly ids: string[] = [];
  readonly arcCenters: number[] = [];
  readonly arcHalves: number[] = [];
}

const defaultSlotScratch = new SlotScratch();

/** Insertion sort of the first `n` entries of `ids`/`angles` (and the arc arrays) by angle, ties by id. */
function sortByAngle(ids: string[], angles: number[], n: number, arcCenters?: number[], arcHalves?: number[]): void {
  for (let index = 1; index < n; index += 1) {
    const id = ids[index]!;
    const angle = angles[index]!;
    const center = arcCenters?.[index] ?? 0;
    const half = arcHalves?.[index] ?? 180;
    let slot = index;
    while (slot > 0 && (angles[slot - 1]! > angle || (angles[slot - 1] === angle && ids[slot - 1]! > id))) {
      ids[slot] = ids[slot - 1]!;
      angles[slot] = angles[slot - 1]!;
      if (arcCenters && arcHalves) {
        arcCenters[slot] = arcCenters[slot - 1]!;
        arcHalves[slot] = arcHalves[slot - 1]!;
      }
      slot -= 1;
    }
    ids[slot] = id;
    angles[slot] = angle;
    if (arcCenters && arcHalves) {
      arcCenters[slot] = center;
      arcHalves[slot] = half;
    }
  }
}

/** Moves each angle into its reachable arc. Returns true if any moved. */
function clampToArcs(angles: number[], arcCenters: number[], arcHalves: number[], n: number): boolean {
  let moved = false;
  for (let index = 0; index < n; index += 1) {
    const half = arcHalves[index]!;
    if (half >= 180) continue;
    const offset = angleDiffDeg(arcCenters[index]!, angles[index]!);
    if (Math.abs(offset) <= half + 1e-9) continue;
    angles[index] = normalizeAngleDeg(arcCenters[index]! + Math.sign(offset) * half);
    moved = true;
  }
  return moved;
}

/**
 * Slot angle per mob on one ring. Each mob wants its current bearing (so it keeps the side it
 * came from and never crosses the player); the spread enforces the minimum spacing for the ring
 * radius; then hysteresis keeps a mob's previous slot unless the new one is more than
 * MOB_TACTICS_SLOT_HYSTERESIS_DEG away. A final spread repairs any spacing the kept slots break.
 */
export function relaxSlots(
  items: readonly SlotItem[],
  radiusM: number,
  hysteresisDeg: number = MOB_TACTICS_SLOT_HYSTERESIS_DEG
): Map<string, number> {
  const result = new Map<string, number>();
  relaxSlotsInto(items, items.length, radiusM, result, hysteresisDeg);
  return result;
}

/**
 * Allocation-free `relaxSlots`: reads the first `count` items and sets each id's slot angle in
 * `out` (existing entries for other ids are left alone). Uses `scratch` for all working arrays.
 */
export function relaxSlotsInto(
  items: readonly SlotItem[],
  count: number,
  radiusM: number,
  out: Map<string, number>,
  hysteresisDeg: number = MOB_TACTICS_SLOT_HYSTERESIS_DEG,
  scratch: SlotScratch = defaultSlotScratch,
  spacingM?: number
): void {
  if (count <= 0) return;
  const minAngle = minSlotAngleDeg(radiusM, spacingM);
  const { order, angles, chosen, ids, arcCenters, arcHalves } = scratch;
  order.length = 0;
  for (let index = 0; index < count; index += 1) {
    const item = items[index]!;
    const bearing = normalizeAngleDeg(item.bearingDeg);
    let slot = order.length;
    order.push(item);
    while (slot > 0) {
      const previous = order[slot - 1]!;
      const previousBearing = normalizeAngleDeg(previous.bearingDeg);
      if (previousBearing < bearing || (previousBearing === bearing && previous.id < item.id)) break;
      order[slot] = previous;
      slot -= 1;
    }
    order[slot] = item;
  }
  angles.length = count;
  for (let index = 0; index < count; index += 1) angles[index] = normalizeAngleDeg(order[index]!.bearingDeg);
  spreadAnglesInPlace(angles, count, minAngle);
  chosen.length = count;
  ids.length = count;
  arcCenters.length = count;
  arcHalves.length = count;
  let hasArc = false;
  for (let index = 0; index < count; index += 1) {
    const item = order[index]!;
    const fresh = angles[index]!;
    chosen[index] = item.prevSlotDeg !== null && Math.abs(angleDiffDeg(item.prevSlotDeg, fresh)) <= hysteresisDeg
      ? normalizeAngleDeg(item.prevSlotDeg)
      : fresh;
    ids[index] = item.id;
    arcCenters[index] = normalizeAngleDeg(item.arcCenterDeg ?? 0);
    arcHalves[index] = Math.max(0, Math.min(180, item.arcHalfDeg ?? 180));
    if (arcHalves[index]! < 180) hasArc = true;
  }
  // Kept and fresh slots can interleave, so order by the chosen angle before the repair pass.
  sortByAngle(ids, chosen, count, arcCenters, arcHalves);
  spreadAnglesInPlace(chosen, count, minAngle);
  if (hasArc) {
    // Leash-aware: alternate projecting into each mob's reachable arc and re-spreading, so a pack
    // fills its reachable arc evenly instead of bunching at the clamped edge. Ends projected.
    for (let pass = 0; pass < 24; pass += 1) {
      if (!clampToArcs(chosen, arcCenters, arcHalves, count) && pass > 0) break;
      sortByAngle(ids, chosen, count, arcCenters, arcHalves);
      spreadAnglesInPlace(chosen, count, minAngle);
    }
    clampToArcs(chosen, arcCenters, arcHalves, count);
  }
  for (let index = 0; index < count; index += 1) out.set(ids[index]!, chosen[index]!);
  order.length = 0;
}

// ---------------------------------------------------------------------------------------------
// Steering (local metre frame: x east, y north)

export type Vec2 = { x: number; y: number };

export type SeparationBody = Readonly<{ id: string; x: number; y: number; /** Half body width, metres. */ r?: number }>;

/**
 * Push for `self` away from the other bodies, in metres for this tick. Same shape as the
 * existing pack rule: pressure = (R - d) / R, scaled by the strength and one step, then capped
 * at MOB_TACTICS_SEPARATION_MAX_SHARE of a step so the mob still makes progress.
 */
export function separationPush(
  self: SeparationBody,
  others: readonly SeparationBody[],
  maxStepM: number,
  out: Vec2,
  radiusM: number = MOB_TACTICS_SEPARATION_RADIUS_M
): Vec2 {
  let pushX = 0;
  let pushY = 0;
  for (const other of others) {
    if (other.id === self.id) continue;
    let dx = self.x - other.x;
    let dy = self.y - other.y;
    let distance = Math.hypot(dx, dy);
    if (distance >= radiusM) continue;
    if (distance < 0.01) {
      const angle = tacticsHash01(`${self.id}|${other.id}`) * Math.PI * 2;
      dx = Math.sin(angle);
      dy = Math.cos(angle);
      distance = 1;
    }
    const pressure = (radiusM - Math.hypot(self.x - other.x, self.y - other.y)) / radiusM;
    const scale = (Math.max(0, pressure) * MOB_TACTICS_SEPARATION_STRENGTH * maxStepM) / distance;
    pushX += dx * scale;
    pushY += dy * scale;
  }
  const cap = maxStepM * MOB_TACTICS_SEPARATION_MAX_SHARE;
  const length = Math.hypot(pushX, pushY);
  if (length > cap && length > 0) {
    pushX *= cap / length;
    pushY *= cap / length;
  }
  out.x = pushX;
  out.y = pushY;
  return out;
}

/**
 * Firm minimum spacing: moves the proposed position `out` out of every other body closer than `minDistM`
 * (position projection, nearest overlap first in id order), with the total correction capped at
 * `maxCorrectionM` so a pushed mob still moves smoothly (never a teleport). Returns `out`.
 */
export function enforceMinSpacing(
  self: SeparationBody,
  others: readonly SeparationBody[],
  minDistM: number,
  maxCorrectionM: number,
  out: Vec2,
  gapM?: number
): Vec2 {
  const startX = out.x;
  const startY = out.y;
  for (let pass = 0; pass < 2; pass += 1) {
    for (const other of others) {
      if (other.id === self.id) continue;
      // Per-pair minimum when both bodies carry a half width (small mobs pack closer than big ones).
      const pairMinM = gapM !== undefined && self.r !== undefined && other.r !== undefined
        ? self.r + other.r + gapM
        : minDistM;
      let dx = out.x - other.x;
      let dy = out.y - other.y;
      let distance = Math.hypot(dx, dy);
      if (distance >= pairMinM) continue;
      if (distance < 0.01) {
        const angle = tacticsHash01(`${self.id}|${other.id}`) * Math.PI * 2;
        dx = Math.sin(angle);
        dy = Math.cos(angle);
        distance = 1;
      }
      const push = (pairMinM - Math.min(distance, pairMinM)) / distance;
      out.x += dx * push;
      out.y += dy * push;
    }
  }
  const correctionX = out.x - startX;
  const correctionY = out.y - startY;
  const correction = Math.hypot(correctionX, correctionY);
  if (correction > maxCorrectionM && correction > 0) {
    out.x = startX + (correctionX * maxCorrectionM) / correction;
    out.y = startY + (correctionY * maxCorrectionM) / correction;
  }
  return out;
}

/**
 * One movement step: seek the destination (stopping inside MOB_TACTICS_SLOT_ARRIVE_M) plus the
 * separation push, capped at `maxStepM`. Returns the new position in `out`.
 */
export function steerStep(
  x: number,
  y: number,
  destX: number,
  destY: number,
  push: Vec2,
  maxStepM: number,
  out: Vec2
): Vec2 {
  const dx = destX - x;
  const dy = destY - y;
  const distance = Math.hypot(dx, dy);
  let moveX = 0;
  let moveY = 0;
  if (distance > MOB_TACTICS_SLOT_ARRIVE_M && distance > 0) {
    const seek = Math.min(maxStepM, distance - MOB_TACTICS_SLOT_ARRIVE_M * 0.5);
    moveX = (dx / distance) * seek;
    moveY = (dy / distance) * seek;
  }
  moveX += push.x;
  moveY += push.y;
  const length = Math.hypot(moveX, moveY);
  if (length > maxStepM && length > 0) {
    moveX *= maxStepM / length;
    moveY *= maxStepM / length;
  }
  out.x = x + moveX;
  out.y = y + moveY;
  return out;
}

/**
 * A waiting mob's slow circle. `x`, `y` are relative to the target. Rotates by `stepM` of arc
 * (dir +1 = clockwise, increasing bearing) and eases the radius toward the ring.
 */
export function strafeStep(
  x: number,
  y: number,
  ringRadiusM: number,
  dir: 1 | -1,
  stepM: number,
  out: Vec2
): Vec2 {
  const radius = Math.hypot(x, y);
  if (radius < 1) {
    out.x = x;
    out.y = y;
    return out;
  }
  const bearing = Math.atan2(x, y) + (dir * stepM) / radius;
  const nextRadius = radius + Math.max(-stepM * 0.5, Math.min(stepM * 0.5, ringRadiusM - radius));
  out.x = Math.sin(bearing) * nextRadius;
  out.y = Math.cos(bearing) * nextRadius;
  return out;
}

/** Strafe direction, fixed per mob until it flips. */
export function strafeDirection(id: string, flips: number): 1 | -1 {
  return tacticsHash01(`${id}#${flips}`) < 0.5 ? 1 : -1;
}

/** Ticks until the next strafe flip, between the min and max, seeded by the mob and flip count. */
export function strafeFlipTicks(id: string, flips: number, tickRateHz: number): number {
  const ms = MOB_TACTICS_STRAFE_FLIP_MIN_MS +
    tacticsHash01(`${id}~${flips}`) * (MOB_TACTICS_STRAFE_FLIP_MAX_MS - MOB_TACTICS_STRAFE_FLIP_MIN_MS);
  return tacticsMsToTicks(ms, tickRateHz);
}

// ---------------------------------------------------------------------------------------------
// Engine-side state (transient, never persisted or sent to clients)

/**
 * Phase 2 archetype state of one managed mob (docs/plans/mob-ai-phase2.md section 6.1). Resolved
 * once at join from the shared tables; null on every mob while MOB_ARCHETYPES_ENABLED is off.
 * The per-mob signature cooldown lives on MobSpecialState (`archSignatureReadyTick`) so a target
 * swap or rejoin cannot reset it.
 */
export type ArchetypeTacticsState = {
  archetype: MobArchetypeId;
  params: MobArchetypeParams;
  /** The mob's signature move; null for none (shells, quills) and for the Swarmer (the wave is its basic). */
  signature: MobSignatureParams | null;
  /** Landing offsets (ticks from the telegraph start) of each signature part; empty without a signature. */
  signaturePartTicks: readonly number[];
  /** Token points a signature cycle costs (tier cost when higher). */
  signatureCost: number;
  /** Basic hit damage factor (1.0 = one Phase 1 hit). */
  basicDamageFactor: number;
  /** Flag-gated caster reach (owner decision 2), else null (keep the definition's range). */
  reachOverrideM: number | null;
  /** This cycle is a signature (its telegraph is live or resolving). */
  inSignature: boolean;
  /** Pack hurt retreat: retreating until this tick; may not retreat again before retreatReadyTick. */
  retreatUntilTick: number;
  retreatReadyTick: number;
  /** Skirmisher hop: hopping away until hopUntilTick along hopBearingDeg; next hop not before hopReadyTick. */
  hopUntilTick: number;
  hopReadyTick: number;
  hopBearingDeg: number;
  /** Hop distance still to cover (the hop ends when it reaches 0 or at hopUntilTick). */
  hopRemainingM: number;
  /** Swarm wave this mob's current strike belongs to, or null. */
  waveId: string | null;
};

/** One managed mob. Lives only while the mob fights a player under tactics. */
export type MobTacticsState = {
  mobId: string;
  /** The player whose ledger this mob is in (its current target). */
  targetId: string;
  phase: TacticsPhase;
  /** Tick the timed phases (windup, recover, cooldown) end on. */
  phaseEndTick: number;
  pool: TacticsPool;
  cost: number;
  rhythm: MobRhythm;
  ring: TacticsRing;
  layer: number;
  radiusM: number;
  /** World bearing from the target to the slot; null until the first slot pass. */
  slotAngleDeg: number | null;
  waitingSinceTick: number;
  joinedTick: number;
  /** Earliest tick a windup may start (arrival grace, target-swap penalty). */
  readyTick: number;
  /** The player hit this mob while it waited: it takes the next free token first. */
  grabbed: boolean;
  /** Completed attack cycles (seeds the cooldown jitter). */
  cycle: number;
  strafeFlips: number;
  strafeFlipTick: number;
  /** Bearing from the target the recover back-off steps along. */
  backoffBearingDeg: number;
  /** Phase 2 archetype state; null while MOB_ARCHETYPES_ENABLED is off (Phase 1, unchanged). */
  arch: ArchetypeTacticsState | null;
  /** Scratch, refreshed every tick: local metres from the target (x east, y north). */
  x: number;
  y: number;
  distanceM: number;
  bearingDeg: number;
};

type MutableCandidate = { -readonly [K in keyof TokenCandidate]: TokenCandidate[K] };
type MutableBody = { id: string; x: number; y: number; r?: number };
type MutableSlotItem = {
  id: string;
  bearingDeg: number;
  prevSlotDeg: number | null;
  arcCenterDeg: number;
  arcHalfDeg: number;
};

/** Last sampled position and movement heading of a target player (for the front bonus). */
export type TacticsHeading = { lat: number; lon: number; headingDeg: number | null };

/**
 * Owns every ledger and managed-mob state plus the reuse buffers the engine's per-tick pass
 * needs, so the hot loop allocates nothing per mob. `forget` is idempotent and releases the
 * mob's token, so every end case leaves the ledger empty.
 */
export class MobTacticsCoordinator {
  readonly mobs = new Map<string, MobTacticsState>();
  readonly ledgers = new Map<string, TokenLedger>();
  /** Managed mob ids per target player, in join order (deterministic). */
  readonly rosters = new Map<string, Set<string>>();
  readonly headings = new Map<string, TacticsHeading>();
  /** Round-robin cursor for the per-tick ceiling. */
  cursor = 0;
  readonly targetIds: string[] = [];
  readonly overflowBody: MutableBody = { id: "", x: 0, y: 0 };
  // Reuse buffers.
  readonly candidates: MutableCandidate[] = [];
  readonly bodies: MutableBody[] = [];
  readonly slotItems: MutableSlotItem[] = [];
  readonly slotScratch = new SlotScratch();
  readonly slotOut = new Map<string, number>();
  readonly granted: string[] = [];
  readonly push: Vec2 = { x: 0, y: 0 };
  readonly step: Vec2 = { x: 0, y: 0 };
  readonly strafe: Vec2 = { x: 0, y: 0 };
  private readonly candidatePool: MutableCandidate[] = [];
  private readonly bodyPool: MutableBody[] = [];
  private readonly slotItemPool: MutableSlotItem[] = [];

  constructor(
    private readonly tickRateHz: number,
    /** MOB_TELEGRAPH_SCALE, read when a player's ledger is made (the env knob needs a restart anyway). */
    private readonly telegraphScale: () => number = () => 1
  ) {}

  has(mobId: string): boolean {
    return this.mobs.has(mobId);
  }

  ledgerFor(playerId: string): TokenLedger {
    let ledger = this.ledgers.get(playerId);
    if (!ledger) {
      ledger = new TokenLedger(playerId, this.tickRateHz, {}, this.telegraphScale());
      this.ledgers.set(playerId, ledger);
    }
    return ledger;
  }

  /** Adds a state (the caller fills it) to its target's roster. */
  add(state: MobTacticsState): void {
    this.mobs.set(state.mobId, state);
    let roster = this.rosters.get(state.targetId);
    if (!roster) {
      roster = new Set();
      this.rosters.set(state.targetId, roster);
    }
    roster.add(state.mobId);
    this.ledgerFor(state.targetId);
  }

  /** Drops a mob and releases its token. Returns the state it had, or null. Idempotent. */
  forget(mobId: string): MobTacticsState | null {
    const state = this.mobs.get(mobId);
    if (!state) return null;
    this.mobs.delete(mobId);
    this.ledgers.get(state.targetId)?.release(mobId);
    const roster = this.rosters.get(state.targetId);
    roster?.delete(mobId);
    if (roster && roster.size === 0) this.dropLedger(state.targetId);
    return state;
  }

  /** Drops a target's ledger and every mob in its roster. Returns the forgotten mob ids. */
  forgetTarget(playerId: string): string[] {
    const roster = this.rosters.get(playerId);
    const ids = roster ? [...roster] : [];
    for (const id of ids) this.forget(id);
    this.dropLedger(playerId);
    return ids;
  }

  /** Total token points held across all ledgers (metrics and tests). */
  tokensInUse(): number {
    let total = 0;
    for (const ledger of this.ledgers.values()) total += ledger.inUse("melee") + ledger.inUse("ranged");
    return total;
  }

  candidate(index: number): MutableCandidate {
    let item = this.candidatePool[index];
    if (!item) {
      item = { id: "", pool: "melee", cost: 1, waitingSinceTick: 0, distanceM: 0, bearingDeg: 0, grabbed: false, engageRadiusM: 0 };
      this.candidatePool[index] = item;
    }
    this.candidates[index] = item;
    return item;
  }

  body(index: number): MutableBody {
    let item = this.bodyPool[index];
    if (!item) {
      item = { id: "", x: 0, y: 0 };
      this.bodyPool[index] = item;
    }
    this.bodies[index] = item;
    return item;
  }

  slotItem(index: number): MutableSlotItem {
    let item = this.slotItemPool[index];
    if (!item) {
      item = { id: "", bearingDeg: 0, prevSlotDeg: null, arcCenterDeg: 0, arcHalfDeg: 180 };
      this.slotItemPool[index] = item;
    }
    this.slotItems[index] = item;
    return item;
  }

  private dropLedger(playerId: string): void {
    this.ledgers.get(playerId)?.clear();
    this.ledgers.delete(playerId);
    this.rosters.delete(playerId);
    this.headings.delete(playerId);
  }
}
