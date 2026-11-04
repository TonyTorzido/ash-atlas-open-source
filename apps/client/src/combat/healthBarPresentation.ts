import type { CombatEntitySnapshot } from "@ash-atlas/shared";
export const CRITICAL_HEALTH_RATIO = 0.25;

export const HEALTH_BAR_TIMING = {
  fillMs: 120,
  damageTrailHoldMs: 150,
  damageTrailDrainMs: 300,
  criticalPulseMs: 2_400
} as const;

export const HEALTH_BAR_COLORS = {
  frame: 0x181512,
  frameBorder: 0x595851,
  track: 0x0d0b08,
  damageTrail: 0xffe8a3,
  fillTop: 0x35c766,
  fillBottom: 0x17833c,
  fillHighlight: 0xa7efb7,
  criticalFrame: 0xa65347,
  gildedRim: 0xd4b26a
} as const;

export type WorldHealthBarTone = "friendly" | "hostile" | "passive";

/** Fill colors by relationship to the local player. Friendly keeps the original green. */
export const WORLD_HEALTH_BAR_TONES: Record<
  WorldHealthBarTone,
  Readonly<{ top: number; bottom: number; highlight: number }>
> = {
  friendly: {
    top: HEALTH_BAR_COLORS.fillTop,
    bottom: HEALTH_BAR_COLORS.fillBottom,
    highlight: HEALTH_BAR_COLORS.fillHighlight
  },
  hostile: { top: 0xe5484d, bottom: 0x9f1d22, highlight: 0xffb3b0 },
  passive: { top: 0xc9b48a, bottom: 0x8a7650, highlight: 0xefe2c4 }
};

export type WorldHealthBarVariant = "player" | "mob" | "boss";

/**
 * Aggressive mobs (server `hostility`) are red even when idle. Passive mobs and
 * observers stay sand until they engage: a target, chasing or attacking, or a
 * combat acquisition countdown turns them red. Companions and players read friendly.
 */
export function worldHealthBarTone(
  kind: "player" | "mob",
  combat: Pick<CombatEntitySnapshot, "targetEntityId" | "activityState" | "aiPresentation" | "companion" | "hostility" | "undead"> | null,
  viewerPlayerId?: string
): WorldHealthBarTone {
  if (kind === "player" || !combat || combat.companion) return "friendly";
  // Revenant Metal undead read as allies to their owner and as enemies to everyone else.
  if (combat.undead) return combat.undead.ownerPlayerId === viewerPlayerId ? "friendly" : "hostile";
  return combat.hostility === "aggressive" ||
    combat.targetEntityId !== null ||
    combat.activityState === "chasing" ||
    combat.activityState === "attacking" ||
    combat.aiPresentation?.intent === "combat"
    ? "hostile"
    : "passive";
}

export function worldHealthBarVariant(
  kind: "player" | "mob",
  combat: Pick<CombatEntitySnapshot, "boss"> | null
): WorldHealthBarVariant {
  return kind === "mob" && combat?.boss === true ? "boss" : kind;
}

export const WORLD_HEALTH_BAR_METRICS = {
  player: {
    width: 50,
    height: 7,
    inset: 1.5,
    cornerCut: 1.5
  },
  mob: {
    width: 54,
    height: 7,
    inset: 1.5,
    cornerCut: 1.5
  },
  boss: {
    width: 80,
    height: 8,
    inset: 1.5,
    cornerCut: 2
  }
} as const;

/** An ordinary mob's bar is at most this share of its sprite's on-screen width (never wider than the mob). */
export const MOB_HEALTH_BAR_SPRITE_WIDTH_SHARE = 0.75;
/** Floor so a tiny sprite still gets a readable bar. */
export const MOB_HEALTH_BAR_MIN_WIDTH_PX = 18;

/**
 * Horizontal scale for an ordinary mob's bar: a share of the sprite width, capped at the authored bar width and
 * floored for tiny art. Bosses and players keep their bars (callers only apply this to the "mob" variant).
 */
export function mobHealthBarScaleX(spriteWidthPx: number): number {
  if (!(spriteWidthPx > 0)) return 1;
  const targetPx = Math.max(MOB_HEALTH_BAR_MIN_WIDTH_PX, spriteWidthPx * MOB_HEALTH_BAR_SPRITE_WIDTH_SHARE);
  return Math.min(1, targetPx / WORLD_HEALTH_BAR_METRICS.mob.width);
}

export const WORLD_HEALTH_BAR_FRAME_POINTS: Record<WorldHealthBarVariant, number[]> = {
  player: clippedFramePoints(WORLD_HEALTH_BAR_METRICS.player),
  mob: clippedFramePoints(WORLD_HEALTH_BAR_METRICS.mob),
  boss: clippedFramePoints(WORLD_HEALTH_BAR_METRICS.boss)
};

/**
 * Shared local-space placement for passive world health bars. Sprites and
 * authored PNGs use a normalized anchor, so the bar belongs just beyond the
 * visible artwork bottom rather than at a structure-specific fixed offset.
 */
export function worldHealthBarOffsetBelowAnchor(
  artworkHeightPx: number,
  anchorY: number,
  gapPx = 4
): number {
  const height = Number.isFinite(artworkHeightPx) && artworkHeightPx > 0
    ? artworkHeightPx
    : 0;
  const normalizedAnchorY = Number.isFinite(anchorY)
    ? Math.max(0, Math.min(1, anchorY))
    : 1;
  const gap = Number.isFinite(gapPx) && gapPx > 0 ? gapPx : 0;
  return height * (1 - normalizedAnchorY) + gap;
}

export type HealthBarTransitionSnapshot = Readonly<{
  fillRatio: number;
  damageTrailRatio: number;
  damageTrailActive: boolean;
  targetRatio: number;
}>;

export function healthRatio(currentHealth: number, maxHealth: number): number {
  if (!Number.isFinite(currentHealth) || !Number.isFinite(maxHealth) || maxHealth <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, currentHealth / maxHealth));
}

export function healthPercent(currentHealth: number, maxHealth: number): number {
  return healthRatio(currentHealth, maxHealth) * 100;
}

/** Compact world/UI copy for structures that are below their maximum health. */
export function damagedHealthLabel(
  currentHealth: number | null | undefined,
  maximumHealth: number | null | undefined
): string | null {
  if (
    currentHealth === null || currentHealth === undefined ||
    maximumHealth === null || maximumHealth === undefined ||
    !Number.isFinite(currentHealth) || !Number.isFinite(maximumHealth) ||
    maximumHealth <= 0 || currentHealth >= maximumHealth
  ) {
    return null;
  }
  return `${Math.max(0, Math.round(currentHealth))}/${Math.round(maximumHealth)}`;
}

export function wardBarPresentation(
  currentHealth: number,
  maxHealth: number,
  ward: number
): { leftRatio: number; widthRatio: number } {
  const health = healthRatio(currentHealth, maxHealth);
  const widthRatio = !Number.isFinite(ward) || ward <= 0 || maxHealth <= 0
    ? 0
    : Math.min(1, ward / maxHealth);
  return {
    leftRatio: Math.min(health, Math.max(0, 1 - widthRatio)),
    widthRatio
  };
}

export function isCriticalHealth(currentHealth: number, maxHealth: number): boolean {
  const ratio = healthRatio(currentHealth, maxHealth);
  return ratio > 0 && ratio <= CRITICAL_HEALTH_RATIO;
}

export function criticalHealthFrameEmphasis(nowMs: number, reducedMotion: boolean): number {
  if (reducedMotion) {
    return 0.68;
  }
  const phase = ((nowMs % HEALTH_BAR_TIMING.criticalPulseMs) / HEALTH_BAR_TIMING.criticalPulseMs)
    * Math.PI
    * 2;
  return 0.5 + (Math.sin(phase - Math.PI / 2) + 1) * 0.14;
}

export class HealthBarTransitionState {
  private fillRatio: number;
  private fillStartRatio: number;
  private fillStartedAtMs: number;
  private damageTrailRatio: number;
  private damageTrailStartRatio: number;
  private damageTrailHoldUntilMs: number;
  private damageTrailActive = false;
  private targetRatio: number;

  constructor(currentHealth = 1, maxHealth = 1, nowMs = 0) {
    const ratio = healthRatio(currentHealth, maxHealth);
    this.fillRatio = ratio;
    this.fillStartRatio = ratio;
    this.fillStartedAtMs = nowMs;
    this.damageTrailRatio = ratio;
    this.damageTrailStartRatio = ratio;
    this.damageTrailHoldUntilMs = nowMs;
    this.targetRatio = ratio;
  }

  setHealth(
    currentHealth: number,
    maxHealth: number,
    nowMs: number,
    reducedMotion = false
  ): boolean {
    this.advance(nowMs, reducedMotion);
    const nextRatio = healthRatio(currentHealth, maxHealth);
    if (nextRatio === this.targetRatio) {
      return false;
    }
    if (reducedMotion) {
      this.snapTo(nextRatio, nowMs);
      return true;
    }

    const previousTarget = this.targetRatio;
    if (nextRatio < previousTarget) {
      this.damageTrailRatio = Math.max(
        this.damageTrailRatio,
        this.fillRatio,
        previousTarget
      );
      this.damageTrailStartRatio = this.damageTrailRatio;
      this.damageTrailHoldUntilMs = nowMs + HEALTH_BAR_TIMING.damageTrailHoldMs;
      this.damageTrailActive = this.damageTrailRatio > nextRatio;
    } else {
      this.damageTrailActive = false;
      this.damageTrailRatio = this.fillRatio;
      this.damageTrailStartRatio = this.fillRatio;
    }

    this.fillStartRatio = this.fillRatio;
    this.fillStartedAtMs = nowMs;
    this.targetRatio = nextRatio;
    return true;
  }

  setInitialHealth(currentHealth: number, maxHealth: number, nowMs: number): boolean {
    const nextRatio = healthRatio(currentHealth, maxHealth);
    const changed = nextRatio !== this.targetRatio || nextRatio !== this.fillRatio;
    this.snapTo(nextRatio, nowMs);
    return changed;
  }

  advance(nowMs: number, reducedMotion = false): boolean {
    if (reducedMotion) {
      const changed =
        this.fillRatio !== this.targetRatio ||
        this.damageTrailRatio !== this.targetRatio ||
        this.damageTrailActive;
      this.snapTo(this.targetRatio, nowMs);
      return changed;
    }

    const previousFill = this.fillRatio;
    const previousTrail = this.damageTrailRatio;
    const previousTrailActive = this.damageTrailActive;
    const fillProgress = normalizedProgress(
      nowMs - this.fillStartedAtMs,
      HEALTH_BAR_TIMING.fillMs
    );
    this.fillRatio = interpolate(
      this.fillStartRatio,
      this.targetRatio,
      easeOutQuad(fillProgress)
    );

    if (this.damageTrailActive && nowMs > this.damageTrailHoldUntilMs) {
      const trailProgress = normalizedProgress(
        nowMs - this.damageTrailHoldUntilMs,
        HEALTH_BAR_TIMING.damageTrailDrainMs
      );
      this.damageTrailRatio = interpolate(
        this.damageTrailStartRatio,
        this.targetRatio,
        easeOutQuad(trailProgress)
      );
      if (trailProgress >= 1) {
        this.damageTrailRatio = this.targetRatio;
        this.damageTrailActive = false;
      }
    } else if (!this.damageTrailActive) {
      this.damageTrailRatio = this.fillRatio;
    }

    return (
      previousFill !== this.fillRatio ||
      previousTrail !== this.damageTrailRatio ||
      previousTrailActive !== this.damageTrailActive
    );
  }

  snapshot(): HealthBarTransitionSnapshot {
    return {
      fillRatio: this.fillRatio,
      damageTrailRatio: this.damageTrailRatio,
      damageTrailActive: this.damageTrailActive,
      targetRatio: this.targetRatio
    };
  }

  currentFillRatio(): number {
    return this.fillRatio;
  }

  currentDamageTrailRatio(): number {
    return this.damageTrailRatio;
  }

  isDamageTrailActive(): boolean {
    return this.damageTrailActive;
  }

  private snapTo(ratio: number, nowMs: number): void {
    this.fillRatio = ratio;
    this.fillStartRatio = ratio;
    this.fillStartedAtMs = nowMs;
    this.damageTrailRatio = ratio;
    this.damageTrailStartRatio = ratio;
    this.damageTrailHoldUntilMs = nowMs;
    this.damageTrailActive = false;
    this.targetRatio = ratio;
  }
}

function normalizedProgress(elapsedMs: number, durationMs: number): number {
  return Math.min(1, Math.max(0, elapsedMs / durationMs));
}

function interpolate(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

function easeOutQuad(progress: number): number {
  return 1 - (1 - progress) ** 2;
}

function clippedFramePoints(metrics: {
  width: number;
  height: number;
  cornerCut: number;
}): number[] {
  const left = -metrics.width / 2;
  const right = metrics.width / 2;
  return [
    left + metrics.cornerCut, 0,
    right - metrics.cornerCut, 0,
    right, metrics.cornerCut,
    right, metrics.height - metrics.cornerCut,
    right - metrics.cornerCut, metrics.height,
    left + metrics.cornerCut, metrics.height,
    left, metrics.height - metrics.cornerCut,
    left, metrics.cornerCut
  ];
}
