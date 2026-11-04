import {
  activeProjectilePresentation,
  attackProfileStep,
  isAttackFinisherStep,
  parseSwingEventAbilityId,
  SHOT_RANGE_M,
  projectilePresentationForAppearance,
  towerFlagIdFromCombatSource,
  DEFAULT_PLAYER_APPEARANCE_CATALOG,
  type CombatEntitySnapshot,
  type CombatEvent,
  type PlayerAppearanceSnapshot
} from "@ash-atlas/shared";
import { projectileAimRadians } from "@ash-atlas/player-renderer";

import {
  FloatingFeedbackState,
  type FloatingFeedbackInput
} from "./damageFloaters.js";
import { LootCardState, type LootCard } from "./lootCards.js";
import { LootFlyState } from "./lootFly.js";
import { lootCardItemLookup } from "./lootItemLookup.js";
import { ARC_LEAD_MS, boltFlightMs, HOLY_ARC_TINT, SHOT_FLIGHT_MS, SwingEffectsState } from "./swingEffects.js";
import { clientShotProfile, isBoltShot } from "./clericArc.js";

const METERS_PER_DEG_LAT = 111_320;

/** One SWING "shot" event of a batch: where the shot left, its aim, its reach and how long it flies over it. */
type ShotLaunch = Readonly<{ lat: number; lon: number; facingDeg: number; reachM: number; flightMs: number; bolt: boolean }>;
import { BIG_HIT_HEALTH_SHARE, ScreenShakeState } from "./hitFeedback.js";
import { PlayerAppearancePoseController } from "./playerAppearancePose.js";
import { swingPoseComboIndex } from "./swing.js";
import {
  ProjectileImpactState,
  type ProjectileImpactInput
} from "./projectileImpacts.js";

export type CombatPresentationPoint = Readonly<{ x: number; y: number }>;

/** Tower volleys reuse the Bow's arrow artwork. */
const TOWER_ARROW_PROJECTILE = projectilePresentationForAppearance(
  DEFAULT_PLAYER_APPEARANCE_CATALOG.appearances.find((appearance) =>
    appearance.familyId === "bow" && appearance.projectileAssetKey
  )
);

export type CombatPresentationListener = () => void;

export type CombatPresentationContext = Readonly<{
  localPlayerId: string;
  nowMs?: number;
  appearanceForEntity?: (entityId: string) => PlayerAppearanceSnapshot | undefined;
  pointForEntity?: (entityId: string) => CombatPresentationPoint | null;
  /** Map bearing (compass degrees at the top of the screen); turns a SWING facing into a screen aim. */
  mapBearingDeg?: number;
  /** Max HP of an entity (a big incoming hit pops a bigger number). */
  maxHealthForEntity?: (entityId: string) => number | undefined;
}>;

/**
 * Location-neutral sink for accepted combat presentation events.
 *
 * The combat store owns live entity state. This controller owns only short-lived
 * presentation state so the map and indoor scene can render the same event once,
 * using their own coordinate projector at the boundary.
 */
export class CombatPresentationController {
  readonly floatingFeedback = new FloatingFeedbackState();
  readonly projectileImpacts = new ProjectileImpactState();
  /** Reveal cards for mob kills and chest opens; they outlive scene changes (a chest opened just before leaving). */
  readonly lootCards = new LootCardState();
  /** Fly-to-HUD loot feedback fed by the same reward events (icons to the HUD, rare pills). */
  readonly lootFly = new LootFlyState();
  /** Viewport pixel where a mob last died; loot icons pop out of it (null/old: from the player). */
  private lastKillSpot: { x: number; y: number; atMs: number } | null = null;
  readonly appearancePoses = new PlayerAppearancePoseController();
  /** Action combat: pooled slash arcs and sparks, predicted hit flash, hitstop and nudge. */
  readonly swingEffects = new SwingEffectsState();
  /** Hit feedback screen shake (finisher, big incoming hit, signature move); the map overlay applies it. */
  readonly screenShake = new ScreenShakeState();
  private readonly listeners = new Set<CombatPresentationListener>();

  subscribe(listener: CombatPresentationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  enqueueCombatEvents(
    events: readonly CombatEvent[],
    context: CombatPresentationContext
  ): void {
    if (events.length === 0) return;
    const nowMs = context.nowMs ?? performance.now();
    // A hitscan shot already draws its own pooled arrow flight (SWING event / the local press), so the
    // ATTACK_LANDED of that same tick must not add a second, stretched source-to-target arrow.
    const shotLaunches = new Map<string, ShotLaunch>();
    for (const event of events) {
      if (event.type !== "SWING" || event.abilityId !== "shot" || !event.sourceEntityId) continue;
      const profile = context.appearanceForEntity?.(event.sourceEntityId);
      const bolt = isBoltShot(profile ? clientShotProfile(profile) : null);
      const reachM = typeof event.radiusM === "number" && event.radiusM > 0 ? event.radiusM : SHOT_RANGE_M;
      shotLaunches.set(event.sourceEntityId, {
        lat: event.position?.lat ?? 0, lon: event.position?.lon ?? 0, facingDeg: event.facingDegrees ?? 0,
        reachM, flightMs: bolt ? boltFlightMs(reachM) : SHOT_FLIGHT_MS, bolt
      });
    }
    // The damage number of a shot waits for the arrow to land: the rest of the flight (the local arrow
    // started on the press; a remote one starts now).
    let localShotStartMs = Number.NEGATIVE_INFINITY;
    for (const shot of this.swingEffects.shots) if (shot.active && shot.kind !== "heal" && shot.startMs > localShotStartMs) localShotStartMs = shot.startMs;
    const sinceLaunchMs = (sourceEntityId: string): number =>
      sourceEntityId === context.localPlayerId && Number.isFinite(localShotStartMs) ? nowMs - localShotStartMs : 0;
    const floaterEvents = events.map((event) => {
      if (event.presentationDelayMs !== undefined || !event.sourceEntityId) return event;
      if (event.type === "HEAL") {
        const delayMs = this.holyHealDelayMs(event, shotLaunches, context);
        return delayMs === null ? event : { ...event, presentationDelayMs: Math.max(0, delayMs - sinceLaunchMs(event.sourceEntityId)) };
      }
      if (event.type !== "DAMAGE") return event;
      const launch = shotLaunches.get(event.sourceEntityId);
      if (launch) return { ...event, presentationDelayMs: Math.max(0, launch.flightMs - sinceLaunchMs(event.sourceEntityId)) };
      // A melee number waits for the blade's contact frame (the predicted hit's start) so it pops with the flash.
      const waitMs = event.sourceEntityId === context.localPlayerId && event.targetEntityId
        ? this.swingEffects.contactWaitMs(event.targetEntityId, nowMs)
        : 0;
      return waitMs > 0 ? { ...event, presentationDelayMs: waitMs } : event;
    });
    // Big pop: the local combo finisher's damage (its predicted hit is still on record), or a big hit on the local player.
    const bigHit = (event: CombatEvent): boolean => {
      if (event.type !== "DAMAGE" || !event.targetEntityId || !event.amount) return false;
      if (event.sourceEntityId === context.localPlayerId) {
        return this.swingEffects.hitRecord(event.targetEntityId)?.strength === "finisher";
      }
      if (event.targetEntityId !== context.localPlayerId) return false;
      const maxHealth = context.maxHealthForEntity?.(event.targetEntityId);
      return maxHealth !== undefined && maxHealth > 0 && event.amount >= maxHealth * BIG_HIT_HEALTH_SHARE;
    };
    this.floatingFeedback.enqueueCombat(floaterEvents, context.localPlayerId, nowMs, bigHit);
    this.appearancePoses.observeAuthoritativeEvents(events, nowMs);
    this.observeSwingEvents(events, context, nowMs, shotLaunches);
    this.projectileImpacts.enqueue(
      events.flatMap((event): ProjectileImpactInput[] => {
        if (
          event.type !== "ATTACK_LANDED" ||
          !event.sourceEntityId ||
          !event.targetEntityId ||
          shotLaunches.has(event.sourceEntityId)
        ) return [];
        const towerSource = towerFlagIdFromCombatSource(event.sourceEntityId) !== null;
        if (towerSource) {
          if (!TOWER_ARROW_PROJECTILE || !event.position) return [];
          return [{
            eventId: event.eventId,
            sourceEntityId: event.sourceEntityId,
            targetEntityId: event.targetEntityId,
            assetKey: TOWER_ARROW_PROJECTILE.assetKey,
            transform: TOWER_ARROW_PROJECTILE.transform,
            aimRadians: 0,
            sourcePosition: event.position
          }];
        }
        const appearance = context.appearanceForEntity?.(event.sourceEntityId);
        const projectile = appearance
          ? activeProjectilePresentation(DEFAULT_PLAYER_APPEARANCE_CATALOG, appearance)
          : null;
        if (!projectile) return [];
        const sourcePoint = context.pointForEntity?.(event.sourceEntityId) ?? null;
        const targetPoint = context.pointForEntity?.(event.targetEntityId) ?? null;
        return [{
          eventId: event.eventId,
          sourceEntityId: event.sourceEntityId,
          targetEntityId: event.targetEntityId,
          assetKey: projectile.assetKey,
          transform: projectile.transform,
          aimRadians: sourcePoint && targetPoint
            ? projectileAimRadians(sourcePoint, targetPoint)
            : 0
        }];
      }),
      nowMs
    );
    this.notify();
  }

  /**
   * How long after the shot left a holy arc heal on `event.targetEntityId` shows: the time the bolt takes to reach that
   * ally along its line (the ally's distance from the shot origin, along the aim), or null when this is not a holy arc heal.
   */
  private holyHealDelayMs(
    event: CombatEvent,
    shotLaunches: ReadonlyMap<string, ShotLaunch>,
    context: CombatPresentationContext
  ): number | null {
    if (!event.sourceEntityId || !event.targetEntityId || event.sourceEntityId === event.targetEntityId) return null;
    const caster = context.appearanceForEntity?.(event.sourceEntityId);
    if (!caster || clientShotProfile(caster)?.id !== "holy_arc") return null;
    const ally = context.pointForEntity?.(event.targetEntityId) ?? null;
    const launch = shotLaunches.get(event.sourceEntityId);
    if (!ally || !launch) return boltFlightMs(0);
    const cosLat = Math.cos((launch.lat * Math.PI) / 180);
    const northM = (ally.y - launch.lat) * METERS_PER_DEG_LAT;
    const eastM = (ally.x - launch.lon) * METERS_PER_DEG_LAT * cosLat;
    const rad = (launch.facingDeg * Math.PI) / 180;
    const alongM = Math.min(launch.reachM, Math.max(0, eastM * Math.sin(rad) + northM * Math.cos(rad)));
    return boltFlightMs(alongM);
  }

  /** Remote players' SWING events draw the same arc and pose; the local player already did on the press. */
  private observeSwingEvents(
    events: readonly CombatEvent[],
    context: CombatPresentationContext,
    nowMs: number,
    shotLaunches: ReadonlyMap<string, ShotLaunch>
  ): void {
    let localShotStartMs = Number.NEGATIVE_INFINITY;
    for (const shot of this.swingEffects.shots) if (shot.active && shot.kind !== "heal" && shot.startMs > localShotStartMs) localShotStartMs = shot.startMs;
    for (const event of events) {
      // A holy arc heal (any Cleric, the local one too): a white-gold burst on the healed ally as the bolt passes them.
      if (
        event.type === "HEAL" && event.sourceEntityId && event.targetEntityId &&
        event.sourceEntityId !== event.targetEntityId && (event.amount ?? 0) > 0
      ) {
        const caster = context.appearanceForEntity?.(event.sourceEntityId);
        if (caster && clientShotProfile(caster)?.id === "holy_arc") {
          const delayMs = this.holyHealDelayMs(event, shotLaunches, context) ?? 0;
          const launchedAgoMs = event.sourceEntityId === context.localPlayerId && Number.isFinite(localShotStartMs) ? nowMs - localShotStartMs : 0;
          this.swingEffects.spawnHealBurst(nowMs + Math.max(0, delayMs - launchedAgoMs), event.targetEntityId);
        }
        continue;
      }
      if (event.type !== "SWING" || !event.sourceEntityId || event.sourceEntityId === context.localPlayerId) continue;
      if (!event.position || typeof event.facingDegrees !== "number") continue;
      const facing = event.facingDegrees;
      const shot = event.abilityId === "shot";
      // "swing_<step>", tagged "@<profile>" when the attacker's profile differs from the default.
      const parsed = shot ? null : parseSwingEventAbilityId(event.abilityId ?? "");
      const finisher = parsed !== null && isAttackFinisherStep(parsed.profile, parsed.comboIndex);
      if (shot) {
        // Hitscan shot: the same arrow (or arcane bolt) flight as the local player, to the hit point (radiusM) or the full range.
        const projectile = context.appearanceForEntity?.(event.sourceEntityId);
        const distanceM = typeof event.radiusM === "number" && event.radiusM > 0 ? event.radiusM : SHOT_RANGE_M;
        const shotProfile = projectile ? clientShotProfile(projectile) : null;
        const presentation = projectile && !isBoltShot(shotProfile)
          ? activeProjectilePresentation(DEFAULT_PLAYER_APPEARANCE_CATALOG, projectile)
          : null;
        if (isBoltShot(shotProfile)) {
          const tint = shotProfile?.id === "holy_arc" ? HOLY_ARC_TINT : undefined;
          this.swingEffects.spawnArcaneBlast(nowMs, event.position.lat, event.position.lon, facing, distanceM, event.targetEntityId ?? "", tint, shotProfile?.id === "holy_arc");
        } else if (presentation) {
          this.swingEffects.spawnShot(nowMs, event.position.lat, event.position.lon, facing, distanceM, event.targetEntityId ?? "", presentation.assetKey, presentation.transform);
          if (event.targetEntityId) {
            const at = context.pointForEntity?.(event.targetEntityId);
            if (at) this.swingEffects.spawnSpark(nowMs + SHOT_FLIGHT_MS, event.position.lat, event.position.lon, event.targetEntityId);
          }
        }
      } else {
        // A "contact" profile's arc lands at its contact frame, as on the attacker's own screen; the default stays on receipt.
        const step = parsed && parsed.profile.hitTiming === "contact" ? attackProfileStep(parsed.profile, parsed.comboIndex) : null;
        const arcAtMs = step ? nowMs + Math.max(0, step.windupMs - ARC_LEAD_MS) : nowMs;
        this.swingEffects.spawnArc(arcAtMs, event.position.lat, event.position.lon, facing, finisher, event.sourceEntityId);
      }
      const rad = ((facing - (context.mapBearingDeg ?? 0)) * Math.PI) / 180;
      const variant = finisher ? "finisher" : shot ? "shot" : "swing";
      const comboIndex = parsed ? swingPoseComboIndex(parsed.comboIndex, finisher) : 0;
      this.appearancePoses.beginLocalSwing(event.sourceEntityId, nowMs, { x: Math.sin(rad), y: -Math.cos(rad) }, variant, comboIndex);
    }
  }

  /** Set by the map: viewport pixel of a world position, or null when it is off screen. */
  private worldProjector: ((lat: number, lon: number) => { x: number; y: number } | null) | null = null;

  setWorldProjector(projector: ((lat: number, lon: number) => { x: number; y: number } | null) | null): void {
    this.worldProjector = projector;
  }

  /**
   * Item and gold gains from harvesting, ground pickups and the like fly to the HUD like kill loot
   * instead of becoming feed rows. Returns true when the feedback was taken as a gain.
   */
  private enqueueGainFlight(feedback: FloatingFeedbackInput, nowMs: number): boolean {
    const isGold = feedback.kind === "gold";
    if (!(isGold || (feedback.kind === "resource" && feedback.icon)) || !(feedback.amount > 0)) return false;
    const itemId = isGold ? null : feedback.icon!;
    const described = itemId ? lootCardItemLookup(itemId) : null;
    const name = isGold ? "Gold" : feedback.subject ?? (described && described.name !== itemId ? described.name : null)
      ?? feedback.label?.replace(/^\+?[\d,]+\s+/, "") ?? itemId!;
    const position = feedback.worldPosition ? this.worldProjector?.(feedback.worldPosition.lat, feedback.worldPosition.lon) : null;
    this.enqueueLootCard({
      id: `gain:${feedback.eventId}`, source: "gift", boss: false, eyebrow: null, heading: name,
      createdAtMs: nowMs, expiresAtMs: nowMs,
      entries: [{
        key: feedback.eventId, kind: isGold ? "gold" : "item", itemId, name,
        quantity: feedback.amount, rarity: described?.rarity ?? "common"
      }]
    }, nowMs, position ?? undefined);
    return true;
  }

  enqueueFloatingFeedback(feedback: FloatingFeedbackInput, nowMs = performance.now()): void {
    if (this.enqueueGainFlight(feedback, nowMs)) return;
    this.floatingFeedback.enqueue([feedback], nowMs);
    this.notify();
  }

  enqueueLootCard(card: LootCard, nowMs = performance.now(), origin?: Readonly<{ x: number; y: number }>): void {
    if (!this.lootCards.push(card)) return;
    this.lootFly.accept(card, nowMs, origin ?? (card.source === "kill" ? this.recentKillSpot(nowMs) ?? undefined : undefined));
    this.notify();
  }

  private playerPointProvider: (() => { x: number; y: number } | null) | null = null;

  /** Set by the map: the local player's viewport pixel, so loot fans out away from the player. */
  setPlayerScreenPointProvider(provider: (() => { x: number; y: number } | null) | null): void {
    this.playerPointProvider = provider;
  }

  playerScreenPoint(): { x: number; y: number } | null {
    return this.playerPointProvider?.() ?? null;
  }

  noteKillSpot(x: number, y: number, nowMs = performance.now()): void {
    this.lastKillSpot = { x, y, atMs: nowMs };
  }

  /** Where a kill just happened on screen, or null when no kill was seen in the last few seconds. */
  recentKillSpot(nowMs = performance.now()): Readonly<{ x: number; y: number }> | null {
    const spot = this.lastKillSpot;
    return spot && nowMs - spot.atMs <= 6_000 ? spot : null;
  }

  /** Anchors the floaters of soon-to-be-removed targets in the world so they survive the removal (see FloatingFeedbackState.anchorTargets). */
  anchorFloaterTargets(
    entityIds: readonly string[],
    anchorFor: (entityId: string) => Readonly<{ lat: number; lon: number; chestLiftPx: number }> | null
  ): void {
    this.floatingFeedback.anchorTargets(entityIds, anchorFor);
  }

  removeCombatTargets(entityIds: readonly string[]): void {
    this.floatingFeedback.removeTargets(entityIds);
    this.projectileImpacts.removeEntities(entityIds);
    for (const entityId of entityIds) this.appearancePoses.remove(entityId);
    this.notify();
  }

  clear(): void {
    this.floatingFeedback.clear();
    this.lootCards.clear();
    this.lootFly.clear();
    this.projectileImpacts.clear();
    this.appearancePoses.clear();
    this.swingEffects.clear();
    this.screenShake.clear();
    this.notify();
  }

  clearScene(): void {
    this.floatingFeedback.clearScene();
    this.projectileImpacts.clear();
    this.appearancePoses.clear();
    this.swingEffects.clear();
    this.screenShake.clear();
    this.notify();
  }

  poseFor(
    entityId: string,
    combat: CombatEntitySnapshot | null,
    nowMs = performance.now()
  ) {
    return this.appearancePoses.poseFor(entityId, combat, nowMs);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
