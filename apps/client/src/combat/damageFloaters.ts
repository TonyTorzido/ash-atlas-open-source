import type { CombatEvent } from "@ash-atlas/shared";

import { DODGE_VISIBLE_MS, damagePopScale, type DamagePopKind } from "./hitFeedback.js";

export const DAMAGE_FLOATER_LIFETIME_MS = 2_200;
export const FLOATING_FEEDBACK_VISIBLE_MS = DAMAGE_FLOATER_LIFETIME_MS * 0.75;
export const REWARD_HUD_VISIBLE_MS = 2_200;
export const MAX_ACTIVE_DAMAGE_FLOATERS = 96;
export const MAX_SEEN_DAMAGE_EVENT_IDS = 512;

export type FloatingFeedbackKind =
  | "damage_dealt"
  | "damage_taken"
  | "damage_other"
  | "healing"
  | "healing_blocked"
  | "gold"
  | "character_xp"
  | "class_xp"
  | "profession_xp"
  | "profession_proc"
  | "class_innate"
  | "harvesting_notice"
  | "resource"
  | "resource_missing"
  | "resource_spent"
  | "resin_spent";

/** An item or resource art id (resources and equipment share one artwork lookup). */
export type FloatingFeedbackIcon = string;

export type FloatingFeedbackInput = Readonly<{
  eventId: string;
  targetEntityId: string;
  kind: FloatingFeedbackKind;
  amount: number;
  label?: string;
  icon?: FloatingFeedbackIcon;
  /** What was gained: the item name, or the class/profession name for skill XP. Feeds the loot feed rows. */
  subject?: string;
  presentationDelayMs?: number;
  /** Stationary world anchor retained when a destroyed structure is removed. */
  worldPosition?: Readonly<{ lat: number; lon: number }>;
  /** A combo finisher or a big incoming hit: a bigger pop that settles larger. */
  emphasis?: "big";
}>;

export type DamageFloater = FloatingFeedbackInput & {
  /** Set with `worldPosition` when the target was removed: how far above the anchor the chest sits (px). */
  chestLiftPx?: number;
  createdAtMs: number;
  expiresAtMs: number;
  xOffsetPx: number;
  startYOffsetPx: number;
  risePx: number;
  horizontalTravelPx: number;
  feedbackLane: number;
};

const FEEDBACK_START_X_PX = -16;
const FEEDBACK_HORIZONTAL_TRAVEL_PX = 32;
/** Start offset above the target chest point (the renderer anchors floaters at the chest, docs/plans/hurt-circles.md). */
export const FEEDBACK_BASE_Y_PX = -12;
const FEEDBACK_LANE_GAP_PX = 24;
const FEEDBACK_ARC_HEIGHT_PX = 26;
const FEEDBACK_FADE_START_PROGRESS = 0.5;
const FEEDBACK_FADE_END_PROGRESS = 0.75;
const REWARD_HUD_FADE_START_PROGRESS = 0.65;
const MAX_FEEDBACK_LANES = 5;
const DODGE_RISE_PX = 16;
const INCOMING_START_X_PX = 30;
const INCOMING_HORIZONTAL_TRAVEL_PX = 16;
const DODGE_FADE_MS = 300;

/** The DODGE cue (a dodged hit: class innate, mob wind-up or ranged aim dodged by a dash). */
export function isDodgeFeedback(floater: Pick<FloatingFeedbackInput, "kind" | "label">): boolean {
  return floater.kind === "class_innate" && floater.label === "DODGE";
}

/** Which damage pop a floater uses, or null for the older bounce (healing, rewards, notices). */
export function damagePopKind(floater: Pick<FloatingFeedbackInput, "kind" | "label" | "emphasis">): DamagePopKind | null {
  if (floater.emphasis === "big") return "big";
  if (floater.kind === "damage_taken") return "incoming";
  if (floater.kind === "damage_dealt" || floater.kind === "damage_other" || isDodgeFeedback(floater)) return "outgoing";
  return null;
}

type FloatingFeedbackFamily = "reward" | "action";

export function floatingFeedbackFamily(kind: FloatingFeedbackKind): FloatingFeedbackFamily {
  return kind === "resource"
    || kind === "gold"
    || kind === "character_xp"
    || kind === "class_xp"
    || kind === "profession_xp"
    || kind === "harvesting_notice"
    ? "reward"
    : "action";
}

export function rewardHudScreenPosition(input: Readonly<{
  feedbackLane: number;
  viewportWidth: number;
  contentWidth: number;
  firstRowBaselinePx: number;
  phone: boolean;
}>): { x: number; y: number } {
  const horizontalMarginPx = 18;
  return {
    x: input.phone
      ? input.viewportWidth / 2
      : Math.max(
          input.contentWidth / 2 + horizontalMarginPx,
          input.viewportWidth - input.contentWidth / 2 - horizontalMarginPx
        ),
    y: input.firstRowBaselinePx + input.feedbackLane * 28
  };
}

export class FloatingFeedbackState {
  private readonly seenEventIds = new Map<string, number>();
  private active: DamageFloater[] = [];

  enqueue(entries: readonly FloatingFeedbackInput[], nowMs: number): number {
    this.prune(nowMs);
    let created = 0;
    for (const entry of entries) {
      if (
        !entry.eventId ||
        !entry.targetEntityId ||
        !Number.isFinite(entry.amount) ||
        entry.amount <= 0 ||
        this.seenEventIds.has(entry.eventId)
      ) continue;
      this.rememberEvent(entry.eventId, nowMs);
      const feedbackLane = this.feedbackLaneFor(entry.targetEntityId, entry.kind);
      const dodge = isDodgeFeedback(entry);
      // Incoming damage stays to the right of the head (clear of the mob attack-countdown badge above it) and drifts
      // outward, so it never reads as damage dealt; DODGE pops straight up.
      const incoming = entry.kind === "damage_taken";
      this.active.push({
        ...entry,
        createdAtMs: nowMs + (entry.presentationDelayMs ?? 0),
        expiresAtMs: nowMs + (entry.presentationDelayMs ?? 0) + (
          floatingFeedbackFamily(entry.kind) === "reward"
            ? REWARD_HUD_VISIBLE_MS
            : dodge ? DODGE_VISIBLE_MS : FLOATING_FEEDBACK_VISIBLE_MS
        ),
        xOffsetPx: dodge ? 0 : incoming ? INCOMING_START_X_PX : FEEDBACK_START_X_PX,
        startYOffsetPx: FEEDBACK_BASE_Y_PX - feedbackLane * FEEDBACK_LANE_GAP_PX,
        risePx: dodge ? DODGE_RISE_PX : FEEDBACK_ARC_HEIGHT_PX,
        horizontalTravelPx: dodge ? 0 : incoming ? INCOMING_HORIZONTAL_TRAVEL_PX : FEEDBACK_HORIZONTAL_TRAVEL_PX,
        feedbackLane
      });
      created += 1;
      if (this.active.length > MAX_ACTIVE_DAMAGE_FLOATERS) {
        this.active.splice(0, this.active.length - MAX_ACTIVE_DAMAGE_FLOATERS);
      }
    }
    return created;
  }

  /** `bigHit` marks DAMAGE events that get the big pop (combo finisher, big incoming hit). */
  enqueueCombat(events: readonly CombatEvent[], localPlayerId: string, nowMs: number, bigHit?: (event: CombatEvent) => boolean): number {
    return this.enqueue(events.flatMap((event): FloatingFeedbackInput[] => {
      if (event.type === "CLASS_INNATE_TRIGGERED" && event.innateFeedback) {
        const targetEntityId = event.targetEntityId ?? event.sourceEntityId;
        if (!targetEntityId) return [];
        return [{
          eventId: event.eventId,
          targetEntityId,
          kind: "class_innate",
          amount: 1,
          label: innateFeedbackLabel(event.innateFeedback)
        }];
      }
      if (
        event.type === "HEAL_BLOCKED" && event.targetEntityId &&
        event.targetEntityId === localPlayerId && event.harmfulStatusId === "gloom"
      ) {
        return [{
          eventId: event.eventId,
          targetEntityId: event.targetEntityId,
          kind: "healing_blocked",
          amount: 1,
          label: "HEALING BLOCKED — WITHERED"
        }];
      }
      if (!event.targetEntityId || !event.amount || event.amount <= 0) return [];
      if (event.type === "DAMAGE") {
        return [{
          eventId: event.eventId,
          targetEntityId: event.targetEntityId,
          kind: event.targetEntityId === localPlayerId
            ? "damage_taken"
            : event.sourceEntityId === localPlayerId ? "damage_dealt" : "damage_other",
          amount: Math.max(1, event.amount - (event.professionBonusAmount ?? 0)),
          ...(event.presentationDelayMs === undefined ? {} : {
            presentationDelayMs: event.presentationDelayMs
          }),
          ...(bigHit?.(event) ? { emphasis: "big" as const } : {})
        }];
      }
      if (event.type === "HEAL") {
        return [{
          eventId: event.eventId,
          targetEntityId: event.targetEntityId,
          kind: "healing",
          amount: event.amount,
          ...(event.presentationDelayMs === undefined ? {} : {
            presentationDelayMs: event.presentationDelayMs
          })
        }];
      }
      if (event.type === "PROFESSION_OPENING_STRIKE" && event.sourceEntityId === localPlayerId) {
        return [{ eventId: event.eventId, targetEntityId: event.targetEntityId, kind: "profession_proc", amount: event.amount, label: `OPENING STRIKE +${event.amount}` }];
      }
      if (event.type === "PROFESSION_EXECUTED" && event.sourceEntityId === localPlayerId) {
        return [{ eventId: event.eventId, targetEntityId: event.targetEntityId, kind: "profession_proc", amount: event.amount, label: "EXECUTED" }];
      }
      return [];
    }), nowMs);
  }

  prune(nowMs: number): void {
    this.active = this.active.filter((floater) => floater.expiresAtMs > nowMs);
  }

  /**
   * Gives the floaters of targets that are about to be removed a world position (and chest lift) from `anchorFor`, so the
   * killing blow's number outlives its target instead of being erased in the same breath it was created in.
   */
  anchorTargets(
    entityIds: readonly string[],
    anchorFor: (entityId: string) => Readonly<{ lat: number; lon: number; chestLiftPx: number }> | null
  ): void {
    if (entityIds.length === 0) return;
    const removed = new Set(entityIds);
    for (const floater of this.active) {
      if (floater.worldPosition || !removed.has(floater.targetEntityId) || floatingFeedbackFamily(floater.kind) === "reward") continue;
      const anchor = anchorFor(floater.targetEntityId);
      if (!anchor) continue;
      (floater as { worldPosition?: { lat: number; lon: number } }).worldPosition = { lat: anchor.lat, lon: anchor.lon };
      floater.chestLiftPx = anchor.chestLiftPx;
    }
  }

  removeTargets(entityIds: readonly string[]): void {
    if (entityIds.length === 0) return;
    const removed = new Set(entityIds);
    // Reward cues are app-shell feedback rather than actor-projected combat
    // effects. Keep them visible when a scene removes its combat entities.
    // A floater anchored to the world (anchorTargets) no longer needs its target and plays out.
    this.active = this.active.filter((floater) =>
      floatingFeedbackFamily(floater.kind) === "reward" ||
      floater.worldPosition !== undefined ||
      !removed.has(floater.targetEntityId)
    );
  }

  floaters(): readonly DamageFloater[] {
    return this.active;
  }

  seenEventCount(): number {
    return this.seenEventIds.size;
  }

  clear(): void {
    this.active = [];
    this.seenEventIds.clear();
  }

  clearScene(): void {
    this.active = this.active.filter((floater) =>
      floatingFeedbackFamily(floater.kind) === "reward"
    );
  }

  private feedbackLaneFor(targetEntityId: string, kind: FloatingFeedbackKind): number {
    const family = floatingFeedbackFamily(kind);
    const laneUse = Array.from({ length: MAX_FEEDBACK_LANES }, () => ({
      count: 0,
      latestCreatedAtMs: Number.NEGATIVE_INFINITY
    }));
    for (const floater of this.active) {
      if (
        floater.targetEntityId !== targetEntityId ||
        floatingFeedbackFamily(floater.kind) !== family
      ) continue;
      const usage = laneUse[floater.feedbackLane];
      if (!usage) continue;
      usage.count += 1;
      usage.latestCreatedAtMs = Math.max(usage.latestCreatedAtMs, floater.createdAtMs);
    }
    const freeLane = laneUse.findIndex((usage) => usage.count === 0);
    if (freeLane >= 0) return freeLane;
    let selectedLane = 0;
    for (let lane = 1; lane < laneUse.length; lane += 1) {
      const candidate = laneUse[lane]!;
      const selected = laneUse[selectedLane]!;
      if (
        candidate.latestCreatedAtMs < selected.latestCreatedAtMs ||
        (
          candidate.latestCreatedAtMs === selected.latestCreatedAtMs &&
          candidate.count < selected.count
        )
      ) selectedLane = lane;
    }
    return selectedLane;
  }

  private rememberEvent(eventId: string, nowMs: number): void {
    this.seenEventIds.set(eventId, nowMs);
    while (this.seenEventIds.size > MAX_SEEN_DAMAGE_EVENT_IDS) {
      const oldest = this.seenEventIds.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.seenEventIds.delete(oldest);
    }
  }
}

function innateFeedbackLabel(feedback: NonNullable<CombatEvent["innateFeedback"]>): string {
  return feedback.replaceAll("_", " ");
}

export class DamageFloaterState {
  private readonly state = new FloatingFeedbackState();

  enqueue(events: readonly CombatEvent[], nowMs: number): number {
    return this.state.enqueueCombat(events, "", nowMs);
  }
  prune(nowMs: number): void { this.state.prune(nowMs); }
  removeTargets(entityIds: readonly string[]): void { this.state.removeTargets(entityIds); }
  floaters(): readonly DamageFloater[] { return this.state.floaters(); }
  seenEventCount(): number { return this.state.seenEventCount(); }
  clear(): void { this.state.clear(); }
}

export function combatEventsForAcceptedDelta(
  applyResult: "applied" | "ignored" | "gap",
  events: readonly CombatEvent[]
): readonly CombatEvent[] {
  return applyResult === "applied" ? events : [];
}

export function damageFloaterPresentation(
  floater: DamageFloater,
  nowMs: number,
  reducedMotion: boolean
): { alpha: number; xOffsetPx: number; yOffsetPx: number; scale: number } {
  const pending = nowMs < floater.createdAtMs;
  const progress = Math.min(
    1,
    Math.max(0, (nowMs - floater.createdAtMs) / DAMAGE_FLOATER_LIFETIME_MS)
  );
  const visibleProgress = Math.min(1, progress / FEEDBACK_FADE_END_PROGRESS);
  const horizontalProgress = visibleProgress * visibleProgress * (3 - 2 * visibleProgress);
  const partialArc = Math.sin(visibleProgress * Math.PI * 0.72);
  const fadeProgress = Math.min(1, Math.max(
    0,
    (progress - FEEDBACK_FADE_START_PROGRESS)
      / (FEEDBACK_FADE_END_PROGRESS - FEEDBACK_FADE_START_PROGRESS)
  ));
  const fadeEase = fadeProgress * fadeProgress * (3 - 2 * fadeProgress);
  const elapsedMs = nowMs - floater.createdAtMs;
  const popKind = damagePopKind(floater);
  if (isDodgeFeedback(floater)) {
    // DODGE: a quick pop straight up, gone in under a second (clear, not noisy).
    const life = floater.expiresAtMs - floater.createdAtMs;
    const fade = Math.min(1, Math.max(0, (elapsedMs - (life - DODGE_FADE_MS)) / DODGE_FADE_MS));
    const rise = Math.min(1, Math.max(0, elapsedMs / life));
    return {
      alpha: pending ? 0 : 1 - fade * fade * (3 - 2 * fade),
      xOffsetPx: 0,
      yOffsetPx: floater.startYOffsetPx - floater.risePx * (reducedMotion ? 0.2 : 1 - (1 - rise) * (1 - rise)),
      scale: damagePopScale(elapsedMs, "outgoing", reducedMotion)
    };
  }
  return {
    alpha: pending ? 0 : 1 - fadeEase,
    xOffsetPx: reducedMotion
      ? 0
      : floater.xOffsetPx + floater.horizontalTravelPx * horizontalProgress,
    yOffsetPx: floater.startYOffsetPx - (
      reducedMotion
        ? floater.risePx * visibleProgress * 0.2
        : floater.risePx * partialArc
    ),
    scale: popKind ? damagePopScale(elapsedMs, popKind, reducedMotion) : feedbackBounceScale(progress, reducedMotion)
  };
}

export function rewardHudPresentation(
  floater: DamageFloater,
  nowMs: number,
  reducedMotion: boolean
): { alpha: number; xOffsetPx: number; yOffsetPx: number; scale: number } {
  const progress = Math.min(
    1,
    Math.max(0, (nowMs - floater.createdAtMs) / REWARD_HUD_VISIBLE_MS)
  );
  const fadeProgress = Math.min(1, Math.max(
    0,
    (progress - REWARD_HUD_FADE_START_PROGRESS)
      / (1 - REWARD_HUD_FADE_START_PROGRESS)
  ));
  const fadeEase = fadeProgress * fadeProgress * (3 - 2 * fadeProgress);
  const settleProgress = Math.min(1, progress / 0.1);
  const settleEase = settleProgress * settleProgress * (3 - 2 * settleProgress);
  return {
    alpha: 1 - fadeEase,
    xOffsetPx: reducedMotion || settleProgress >= 1 ? 0 : -6 * (1 - settleEase),
    yOffsetPx: reducedMotion ? 0 : 4 * (1 - settleEase),
    scale: rewardHudScale(progress, reducedMotion)
  };
}

function rewardHudScale(progress: number, reducedMotion: boolean): number {
  if (reducedMotion || progress >= 0.1) return 1;
  if (progress < 0.055) return 0.92 + progress / 0.055 * 0.12;
  return 1.04 - (progress - 0.055) / 0.045 * 0.04;
}

function feedbackBounceScale(progress: number, reducedMotion: boolean): number {
  if (reducedMotion || progress >= 0.32) return 1;
  if (progress < 0.08) return 0.78 + progress / 0.08 * 0.4;
  if (progress < 0.16) return 1.18 - (progress - 0.08) / 0.08 * 0.22;
  if (progress < 0.24) return 0.96 + (progress - 0.16) / 0.08 * 0.09;
  return 1.05 - (progress - 0.24) / 0.08 * 0.05;
}

export function floatingFeedbackLabel(floater: FloatingFeedbackInput): string {
  if (floater.label) return floater.label;
  if (floater.kind.startsWith("damage")) return `-${floater.amount.toLocaleString()}`;
  if (floater.kind === "healing") return `+${floater.amount.toLocaleString()} HP`;
  if (floater.kind === "gold") return `+${floater.amount.toLocaleString()} Gold`;
  if (floater.kind === "character_xp") return `+${floater.amount.toLocaleString()} XP`;
  if (floater.kind === "class_xp") return `+${floater.amount.toLocaleString()} Class XP`;
  if (floater.kind === "profession_xp") return `+${floater.amount.toLocaleString()} Profession XP`;
  if (floater.kind === "resin_spent") return `-${floater.amount.toLocaleString()}`;
  return `+${floater.amount.toLocaleString()}`;
}
