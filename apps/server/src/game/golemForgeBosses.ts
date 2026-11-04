import {
  bearingDegrees, destinationPoint, distanceMeters, isPointInsideBossGeometry, moveToward, MELEE_ATTACK_RANGE_M,
  type BossLineGeometry, type LatLon, type MobArchetypeKey
} from "@ash-atlas/shared";
import type { BossController, BossControllerContext, BossRoomHooks } from "./bossFramework.js";

/**
 * Golem Forge bespoke bosses (docs/design/GOLEM_FORGE_PLAN.md sections 4.1 and 4.3). Every number lives in the
 * two tunable blocks below; distances are combat meters (melee 100, a walking player about 125 per second).
 */

/** Granite Bull: a charge that breaks healer monoliths, a mender that rebuilds them. */
export const GRANITE_BULL = Object.freeze({
  openingDelayMs: 2_500,
  castGapMs: 3_000,
  /** Each standing monolith heals the Bull for this fraction of every hit it takes (three stand = nine tenths healed). */
  healFractionPerMonolith: 0.3,
  /** Object id of each monolith and the room anchor of its socket (golem_forge.json, gf_bull_pen). */
  monoliths: Object.freeze([
    { objectId: "healer_monolith_nw", anchorId: "monolith_nw_anchor" },
    { objectId: "healer_monolith_ne", anchorId: "monolith_ne_anchor" },
    { objectId: "healer_monolith_sw", anchorId: "monolith_sw_anchor" }
  ] as const),
  charge: Object.freeze({
    cooldownMs: 10_000,
    telegraphMs: 1_500,
    /** Telegraph width; a monolith breaks when its socket is within this plus the padding of the line. */
    widthM: 90,
    socketPaddingM: 40,
    /** The line runs this far past the targeted player, so a player standing in front of a monolith baits it. */
    overrunM: 450,
    minLengthM: 250,
    maxLengthM: 700,
    damage: 22,
    knockbackM: 80,
    stunMs: 1_000
  }),
  enrage: Object.freeze({
    belowHealthPercent: 25,
    /** Enraged: this many charges back to back, the later ones with a shorter telegraph. */
    chargesInARow: 2,
    chainedTelegraphMs: 1_000
  }),
  stomp: Object.freeze({
    cooldownMs: 8_000,
    telegraphMs: 1_500,
    radiusM: 150,
    damage: 20,
    /** Stomps when at least this many players stand within meleeRadiusM of the Bull. */
    minPlayersInMelee: 2,
    meleeRadiusM: MELEE_ATTACK_RANGE_M * 1.3
  }),
  mender: Object.freeze({
    archetype: "mender_golem_gf" as MobArchetypeKey,
    intervalMs: 30_000,
    doorAnchorId: "door_e",
    channelMs: 8_000,
    walkMps: 70,
    arriveRadiusM: 45
  })
});

export const GRANITE_BULL_ABILITIES = Object.freeze({ charge: "granite_bull_charge", stomp: "granite_bull_stomp" });
/** Phase ids are presentation (the HUD label): how many monoliths stand, and the enrage. */
export const graniteBullPhaseId = (standing: number, enraged: boolean): string =>
  `${enraged ? "enraged_" : ""}monoliths_${standing}`;

export type GraniteBullHooks = Readonly<{
  bossHealthRatio(bossEntityId: string): number;
  bossPosition(bossEntityId: string): LatLon | null;
  playerPosition(entityId: string): LatLon | null;
  anchorPosition(bossEntityId: string, anchorId: string): LatLon | null;
  /** Spawns a scripted mob: stationary (the controller walks it) and unable to attack. Null when it could not spawn. */
  spawnScriptedMob(bossEntityId: string, archetype: MobArchetypeKey, position: LatLon): string | null;
  mobPosition(entityId: string): LatLon | null;
  moveMobTo(entityId: string, position: LatLon): boolean;
  moveBossTo(bossEntityId: string, position: LatLon): boolean;
  healBoss(bossEntityId: string, amount: number): void;
  isAlive(entityId: string): boolean;
  despawn(entityIds: readonly string[]): void;
  random?(): number;
}>;

type PendingCharge = Readonly<{
  castInstanceId: string;
  resolveAt: number;
  origin: LatLon;
  facingDegrees: number;
  lengthM: number;
  geometry: BossLineGeometry;
}>;

type MenderState = {
  id: string;
  targetObjectId: string;
  targetPosition: LatLon;
  channelEndsAt: number | null;
};

export function createGraniteBullController(hooks: GraniteBullHooks): BossController {
  const random = hooks.random ?? Math.random;
  const tuning = GRANITE_BULL;
  let nextCastAt = 0;
  let chargeReadyAt = 0;
  let stompReadyAt = 0;
  let enraged = false;
  let chargesQueued = 0;
  let pending: PendingCharge | null = null;
  let mender: MenderState | null = null;
  let nextMenderAt = 0;
  let lastUpdateAt = 0;

  const room = (context: BossControllerContext): BossRoomHooks | undefined => context.encounter.host.room;
  const isStanding = (context: BossControllerContext, objectId: string): boolean =>
    room(context)?.objectState(objectId) !== "destroyed";
  const standingCount = (context: BossControllerContext): number =>
    tuning.monoliths.filter((monolith) => isStanding(context, monolith.objectId)).length;

  const showPhase = (context: BossControllerContext): void => {
    // A phase change cancels pending casts, so it waits for a quiet moment.
    if (context.encounter.activeCasts.length > 0) return;
    const phase = graniteBullPhaseId(standingCount(context), enraged);
    if (context.encounter.phase !== phase) context.encounter.transitionPhase(phase);
  };

  const restoreMonoliths = (context: BossControllerContext): void => {
    for (const monolith of tuning.monoliths) room(context)?.setObjectState(monolith.objectId, "intact");
  };

  const dropMender = (context: BossControllerContext): void => {
    if (mender && hooks.isAlive(mender.id)) hooks.despawn([mender.id]);
    mender = null;
    context.encounter.setPhaseDeadline(null);
  };

  const clear = (context: BossControllerContext): void => {
    dropMender(context);
    restoreMonoliths(context);
    nextCastAt = 0;
    chargeReadyAt = 0;
    stompReadyAt = 0;
    enraged = false;
    chargesQueued = 0;
    pending = null;
    nextMenderAt = 0;
    lastUpdateAt = 0;
    context.encounter.setMovementOverride(null);
  };

  const beginCharge = (context: BossControllerContext, telegraphMs: number): boolean => {
    const bossId = context.encounter.mobEntityId;
    const origin = hooks.bossPosition(bossId);
    if (!origin) return false;
    const candidates = context.eligibleParticipants
      .map((id) => ({ id, position: hooks.playerPosition(id) }))
      .filter((entry): entry is { id: string; position: LatLon } => entry.position !== null);
    if (candidates.length === 0) return false;
    const target = candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))]!;
    const facingDegrees = bearingDegrees(origin, target.position);
    const lengthM = Math.max(tuning.charge.minLengthM,
      Math.min(tuning.charge.maxLengthM, distanceMeters(origin, target.position) + tuning.charge.overrunM));
    const geometry: BossLineGeometry = { kind: "line", origin, facingDegrees, lengthM, widthM: tuning.charge.widthM };
    const started = context.beginCast({ abilityId: GRANITE_BULL_ABILITIES.charge, geometry, castDurationMs: telegraphMs });
    if (!started) return false;
    pending = { castInstanceId: started.castInstanceId, resolveAt: started.resolveTime, origin, facingDegrees, lengthM, geometry };
    chargeReadyAt = context.now + tuning.charge.cooldownMs;
    return true;
  };

  /** The charge landed: the Bull rushes to the end of the line and every monolith socket on it breaks. */
  const finishCharge = (context: BossControllerContext, charge: PendingCharge): void => {
    const bossId = context.encounter.mobEntityId;
    for (const fraction of [1, 0.75, 0.5, 0.25]) {
      if (hooks.moveBossTo(bossId, destinationPoint(charge.origin, charge.lengthM * fraction, charge.facingDegrees))) break;
    }
    const wide: BossLineGeometry = { ...charge.geometry, widthM: tuning.charge.widthM + tuning.charge.socketPaddingM * 2 };
    let broken = 0;
    for (const monolith of tuning.monoliths) {
      if (!isStanding(context, monolith.objectId)) continue;
      const socket = hooks.anchorPosition(bossId, monolith.anchorId);
      if (!socket || !isPointInsideBossGeometry(socket, wide)) continue;
      room(context)?.setObjectState(monolith.objectId, "destroyed");
      broken += 1;
    }
    if (broken > 0) {
      room(context)?.notify(null, broken === 1 ? "The Bull smashes a healer monolith!" : "The Bull smashes through the monoliths!", "success");
    }
  };

  const stepMender = (context: BossControllerContext, dtSeconds: number): void => {
    const bossId = context.encounter.mobEntityId;
    const hooksRoom = room(context);
    if (mender) {
      if (!hooks.isAlive(mender.id)) {
        mender = null;
        context.encounter.setPhaseDeadline(null);
        hooksRoom?.notify(null, "The Mender Golem is destroyed.", "success");
        return;
      }
      if (mender.channelEndsAt === null) {
        const position = hooks.mobPosition(mender.id);
        if (!position) return;
        if (distanceMeters(position, mender.targetPosition) <= tuning.mender.arriveRadiusM) {
          mender.channelEndsAt = context.now + tuning.mender.channelMs;
          context.encounter.setPhaseDeadline(mender.channelEndsAt);
          hooksRoom?.notify(null, "The Mender Golem begins repairing a monolith. Kill it!", "warning");
        } else {
          hooks.moveMobTo(mender.id, moveToward(position, mender.targetPosition, tuning.mender.walkMps * dtSeconds));
        }
        return;
      }
      if (context.now >= mender.channelEndsAt) {
        hooksRoom?.setObjectState(mender.targetObjectId, "intact");
        hooksRoom?.notify(null, "The Mender Golem rebuilds a healer monolith.", "warning");
        dropMender(context);
      }
      return;
    }
    if (context.now < nextMenderAt) return;
    const door = hooks.anchorPosition(bossId, tuning.mender.doorAnchorId);
    if (!door) return;
    let nearest: { objectId: string; position: LatLon; distance: number } | null = null;
    for (const monolith of tuning.monoliths) {
      if (isStanding(context, monolith.objectId)) continue;
      const position = hooks.anchorPosition(bossId, monolith.anchorId);
      if (!position) continue;
      const distance = distanceMeters(door, position);
      if (nearest === null || distance < nearest.distance) nearest = { objectId: monolith.objectId, position, distance };
    }
    if (!nearest) return;
    const id = hooks.spawnScriptedMob(bossId, tuning.mender.archetype, door);
    nextMenderAt = context.now + tuning.mender.intervalMs;
    if (!id) return;
    mender = { id, targetObjectId: nearest.objectId, targetPosition: nearest.position, channelEndsAt: null };
    hooksRoom?.notify(null, "A Mender Golem comes through the door to repair a monolith.", "warning");
  };

  return {
    onActivate: (context) => {
      nextCastAt = context.now + tuning.openingDelayMs;
      nextMenderAt = context.now + tuning.mender.intervalMs;
      lastUpdateAt = context.now;
      restoreMonoliths(context);
      showPhase(context);
    },
    update: (context) => {
      const now = context.now;
      const bossId = context.encounter.mobEntityId;
      const dtSeconds = lastUpdateAt === 0 ? 0 : Math.min(0.5, Math.max(0, (now - lastUpdateAt) / 1_000));
      lastUpdateAt = now;
      if (!enraged && hooks.bossHealthRatio(bossId) * 100 < tuning.enrage.belowHealthPercent) enraged = true;
      stepMender(context, dtSeconds);

      const casting = context.encounter.activeCasts;
      if (pending && now >= pending.resolveAt && !casting.some((cast) => cast.castInstanceId === pending!.castInstanceId)) {
        const charge = pending;
        pending = null;
        finishCharge(context, charge);
        if (chargesQueued > 0) {
          chargesQueued -= 1;
          if (!beginCharge(context, tuning.enrage.chainedTelegraphMs)) chargesQueued = 0;
          return;
        }
      }
      showPhase(context);
      if (now < nextCastAt || pending || context.encounter.activeCasts.length > 0) return;
      const origin = hooks.bossPosition(bossId);
      if (!origin) return;

      const inMelee = context.eligibleParticipants.filter((id) => {
        const position = hooks.playerPosition(id);
        return position !== null && distanceMeters(origin, position) <= tuning.stomp.meleeRadiusM;
      }).length;
      if (now >= stompReadyAt && inMelee >= tuning.stomp.minPlayersInMelee) {
        const started = context.beginCast({
          abilityId: GRANITE_BULL_ABILITIES.stomp,
          geometry: { kind: "circle", center: origin, radiusM: tuning.stomp.radiusM },
          castDurationMs: tuning.stomp.telegraphMs
        });
        if (started) {
          stompReadyAt = now + tuning.stomp.cooldownMs;
          nextCastAt = now + tuning.castGapMs;
        }
        return;
      }
      if (now >= chargeReadyAt && beginCharge(context, tuning.charge.telegraphMs)) {
        if (enraged) chargesQueued = tuning.enrage.chargesInARow - 1;
        nextCastAt = now + tuning.castGapMs;
      }
    },
    onDamage: (context, amount) => {
      const standing = standingCount(context);
      if (standing <= 0) return;
      hooks.healBoss(context.encounter.mobEntityId, amount * tuning.healFractionPerMonolith * standing);
    },
    onReset: clear,
    onDefeat: clear,
    destroy: clear
  };
}

/** The Forgemaster : walking hammers feed the anvil; a fourth strike throws the room out. */
export const FORGEMASTER = Object.freeze({
  openingDelayMs: 3_000,
  castGapMs: 3_200,
  hammerArchetype: "walking_hammer_gf" as MobArchetypeKey,
  golemArchetype: "iron_golem_gf" as MobArchetypeKey,
  anvilAnchorId: "great_anvil_anchor",
  /** South, east and west wall spawn points (gf_great_forge anchors). The anvil is on the north wall. */
  hammerSpawnAnchors: Object.freeze(["hammer_spawn_s", "hammer_spawn_e", "hammer_spawn_w"]) as readonly string[],
  strikesToFail: 4,
  /** Phase boundaries by health percent: 100-66 one hammer at a time, 66-33 two, below 33 three. */
  phaseBelowHealthPercent: Object.freeze([66, 33]) as readonly number[],
  hammersAtOnceByPhase: Object.freeze([1, 2, 3]) as readonly number[],
  /** Hammer walking speed by phase; the last phase walks faster. */
  hammerWalkMpsByPhase: Object.freeze([28, 28, 44]) as readonly number[],
  firstHammerDelayMs: 5_000,
  nextHammerDelayMs: 4_000,
  arriveRadiusM: 40,
  /** Iron Golems spawn on this ring around the anvil, one angle step per arrival, so none share a point. */
  golemRingRadiusM: 90,
  golemRingStepDegrees: 72,
  cleave: Object.freeze({ cooldownMs: 5_000, telegraphMs: 1_200, rangeM: 150, angleDegrees: 80, damage: 24, weight: 3 }),
  slam: Object.freeze({ cooldownMs: 9_000, telegraphMs: 1_600, radiusM: 170, damage: 26, weight: 1 }),
  /** From this health percent down, steam zones land on the floor. */
  quench: Object.freeze({
    belowHealthPercent: 50,
    cooldownMs: 13_000,
    zones: 3,
    radiusM: 90,
    delayMs: 1_800,
    durationMs: 5_000,
    damagePerSecond: 14,
    techniqueId: "forgemaster_quench_steam"
  }),
  /** The slam and cleave fire only when someone is this close to the Forgemaster. */
  engageRangeM: 260
});

export const FORGEMASTER_ABILITIES = Object.freeze({ cleave: "forgemaster_cleave", slam: "forgemaster_slam" });
export const forgemasterPhaseId = (strikes: number): string => `anvil_strikes_${strikes}`;

export type ForgemasterHooks = Readonly<{
  bossHealthRatio(bossEntityId: string): number;
  bossPosition(bossEntityId: string): LatLon | null;
  playerPosition(entityId: string): LatLon | null;
  anchorPosition(bossEntityId: string, anchorId: string): LatLon | null;
  /** Scripted: stationary and unable to attack (the controller walks it). Otherwise an ordinary add. */
  spawnMob(bossEntityId: string, archetype: MobArchetypeKey, position: LatLon, scripted: boolean): string | null;
  mobPosition(entityId: string): LatLon | null;
  moveMobTo(entityId: string, position: LatLon): boolean;
  isAlive(entityId: string): boolean;
  despawn(entityIds: readonly string[]): void;
  spawnDamageZone(bossEntityId: string, center: LatLon, radiusM: number, delayMs: number, durationMs: number, damagePerSecond: number, techniqueId: string): void;
  /** Removes every damage zone this boss left (reset, wipe, defeat). */
  clearDamageZones(bossEntityId: string): void;
  random?(): number;
}>;

export function createForgemasterController(hooks: ForgemasterHooks): BossController {
  const random = hooks.random ?? Math.random;
  const tuning = FORGEMASTER;
  let strikes = 0;
  let arrivals = 0;
  let hammers: string[] = [];
  let golems: string[] = [];
  let nextHammerAt = 0;
  let nextCastAt = 0;
  let cleaveReadyAt = 0;
  let slamReadyAt = 0;
  let quenchReadyAt = 0;
  let lastUpdateAt = 0;
  let failed = false;

  const phaseIndexFor = (healthPercent: number): number => {
    let index = 0;
    while (index < tuning.phaseBelowHealthPercent.length && healthPercent <= tuning.phaseBelowHealthPercent[index]!) index += 1;
    return index;
  };

  const clear = (context: BossControllerContext): void => {
    const living = [...hammers, ...golems].filter((id) => hooks.isAlive(id));
    if (living.length > 0) hooks.despawn(living);
    hammers = [];
    golems = [];
    strikes = 0;
    arrivals = 0;
    nextHammerAt = 0;
    nextCastAt = 0;
    cleaveReadyAt = 0;
    slamReadyAt = 0;
    quenchReadyAt = 0;
    lastUpdateAt = 0;
    failed = false;
    hooks.clearDamageZones(context.encounter.mobEntityId);
    context.encounter.setPhaseDeadline(null);
  };

  const showPhase = (context: BossControllerContext): void => {
    if (context.encounter.activeCasts.length > 0) return;
    const phase = forgemasterPhaseId(strikes);
    if (context.encounter.phase !== phase) context.encounter.transitionPhase(phase);
  };

  const hammerArrived = (context: BossControllerContext, anvil: LatLon): void => {
    const bossId = context.encounter.mobEntityId;
    strikes += 1;
    const angle = (arrivals * tuning.golemRingStepDegrees) % 360;
    arrivals += 1;
    const golemId = hooks.spawnMob(bossId, tuning.golemArchetype, destinationPoint(anvil, tuning.golemRingRadiusM, angle), false);
    if (golemId) golems.push(golemId);
    const hooksRoom = context.encounter.host.room;
    if (strikes >= tuning.strikesToFail) {
      hooksRoom?.notify(null, "The anvil rings a fourth time. The Forge throws you out!", "warning");
      clear(context);
      failed = true;
      context.encounter.requestFailure("anvil_struck");
      return;
    }
    hooksRoom?.notify(null, `A hammer reaches the anvil! Strike ${strikes} of ${tuning.strikesToFail}. An Iron Golem rises.`, "warning");
    showPhase(context);
  };

  const castAttacks = (context: BossControllerContext, healthPercent: number): void => {
    const now = context.now;
    if (now < nextCastAt || context.encounter.activeCasts.length > 0) return;
    const bossId = context.encounter.mobEntityId;
    const origin = hooks.bossPosition(bossId);
    if (!origin) return;
    const players = context.eligibleParticipants
      .map((id) => ({ id, position: hooks.playerPosition(id) }))
      .filter((entry): entry is { id: string; position: LatLon } => entry.position !== null);
    if (players.length === 0) return;

    if (healthPercent < tuning.quench.belowHealthPercent && now >= quenchReadyAt) {
      for (let zone = 0; zone < tuning.quench.zones; zone += 1) {
        const pick = players[Math.min(players.length - 1, Math.floor(random() * players.length))]!;
        // The first zone lands on a player; the rest scatter around players so the floor fills up.
        const center = zone === 0 ? pick.position : destinationPoint(pick.position, 40 + random() * 120, random() * 360);
        hooks.spawnDamageZone(bossId, center, tuning.quench.radiusM, tuning.quench.delayMs, tuning.quench.durationMs,
          tuning.quench.damagePerSecond, tuning.quench.techniqueId);
      }
      quenchReadyAt = now + tuning.quench.cooldownMs;
      nextCastAt = now + tuning.castGapMs;
      return;
    }
    const nearest = players.reduce((best, entry) =>
      distanceMeters(origin, entry.position) < distanceMeters(origin, best.position) ? entry : best);
    if (distanceMeters(origin, nearest.position) > tuning.engageRangeM) return;
    const options: { weight: number; run: () => boolean }[] = [];
    if (now >= cleaveReadyAt) {
      options.push({ weight: tuning.cleave.weight, run: () => {
        const started = context.beginCast({
          abilityId: FORGEMASTER_ABILITIES.cleave,
          geometry: { kind: "cone", origin, facingDegrees: bearingDegrees(origin, nearest.position), rangeM: tuning.cleave.rangeM, angleDegrees: tuning.cleave.angleDegrees },
          castDurationMs: tuning.cleave.telegraphMs
        });
        if (started) cleaveReadyAt = now + tuning.cleave.cooldownMs;
        return started !== null;
      } });
    }
    if (now >= slamReadyAt) {
      options.push({ weight: tuning.slam.weight, run: () => {
        const started = context.beginCast({
          abilityId: FORGEMASTER_ABILITIES.slam,
          geometry: { kind: "circle", center: origin, radiusM: tuning.slam.radiusM },
          castDurationMs: tuning.slam.telegraphMs
        });
        if (started) slamReadyAt = now + tuning.slam.cooldownMs;
        return started !== null;
      } });
    }
    if (options.length === 0) return;
    let roll = random() * options.reduce((sum, option) => sum + option.weight, 0);
    const chosen = options.find((option) => (roll -= option.weight) < 0) ?? options[options.length - 1]!;
    if (chosen.run()) nextCastAt = now + tuning.castGapMs;
  };

  return {
    onActivate: (context) => {
      lastUpdateAt = context.now;
      nextCastAt = context.now + tuning.openingDelayMs;
      nextHammerAt = context.now + tuning.firstHammerDelayMs;
      showPhase(context);
    },
    update: (context) => {
      if (failed) return;
      const now = context.now;
      const bossId = context.encounter.mobEntityId;
      const dtSeconds = lastUpdateAt === 0 ? 0 : Math.min(0.5, Math.max(0, (now - lastUpdateAt) / 1_000));
      lastUpdateAt = now;
      const healthPercent = hooks.bossHealthRatio(bossId) * 100;
      const phase = phaseIndexFor(healthPercent);
      const anvil = hooks.anchorPosition(bossId, tuning.anvilAnchorId);

      hammers = hammers.filter((id) => hooks.isAlive(id));
      golems = golems.filter((id) => hooks.isAlive(id));
      if (anvil) {
        for (const id of [...hammers]) {
          const position = hooks.mobPosition(id);
          if (!position) continue;
          const step = tuning.hammerWalkMpsByPhase[phase]! * dtSeconds;
          if (distanceMeters(position, anvil) <= tuning.arriveRadiusM + step) {
            hammers = hammers.filter((hammer) => hammer !== id);
            hooks.despawn([id]);
            hammerArrived(context, anvil);
            if (failed) return;
          } else {
            hooks.moveMobTo(id, moveToward(position, anvil, step));
          }
        }
        if (hammers.length < tuning.hammersAtOnceByPhase[phase]! && now >= nextHammerAt) {
          const anchor = tuning.hammerSpawnAnchors[Math.min(tuning.hammerSpawnAnchors.length - 1,
            Math.floor(random() * tuning.hammerSpawnAnchors.length))]!;
          const spawnAt = hooks.anchorPosition(bossId, anchor);
          const id = spawnAt ? hooks.spawnMob(bossId, tuning.hammerArchetype, spawnAt, true) : null;
          if (id) {
            hammers.push(id);
            context.encounter.host.room?.notify(null, "The Forgemaster hurls a living hammer at the anvil!", "warning");
          }
          nextHammerAt = now + tuning.nextHammerDelayMs;
        }
      }
      showPhase(context);
      castAttacks(context, healthPercent);
    },
    onReset: clear,
    onDefeat: clear,
    destroy: clear
  };
}

/**
 * The Corrupted Core (docs/design/GOLEM_FORGE_PLAN.md section 4.2). Four dormant husks stand in the
 * alcoves. The Core possesses them one at a time (clockwise, the last is the Gem Husk): while it does it is
 * untargetable and the possessed husk fights. When the husk dies the Core is thrown out, exposed and taking
 * double damage for a short window, then dives into the next husk. After the fourth the husks reassemble and
 * the Core enrages. Every number is here; distances are combat meters (melee 100, a walking player about 125 per second).
 */
export const CORRUPTED_CORE = Object.freeze({
  /** Alcove anchors (gf_containment), in possession order: clockwise from the north-west. The last one is the Gem Husk. */
  huskAnchors: Object.freeze(["husk_nw", "husk_ne", "husk_se", "husk_sw"]) as readonly string[],
  huskArchetype: "corrupted_husk_gf" as MobArchetypeKey,
  gemHuskArchetype: "gem_husk_gf" as MobArchetypeKey,
  exposed: Object.freeze({
    durationMs: 12_000,
    incomingDamageMultiplier: 2,
    /**
     * The Core's health (percent) cannot be driven below this while exposed after husk 1, 2 and 3 on the first
     * loop, so the husks are spread over the health curve and the Gem Husk always comes at 25% or less. The window
     * ends early when the floor is reached. After husk 4 (and on enraged loops) there is no floor.
     */
    floorPercentAfterHusk: Object.freeze([75, 50, 25]) as readonly number[]
  }),
  /** Chain arc: lightning from the possessed husk at the nearest player, then jumping on. */
  arc: Object.freeze({
    firstDelayMs: 5_000,
    intervalMs: 8_000,
    /** The first strike is telegraphed for this long; later jumps are quicker. */
    firstTelegraphMs: 1_400,
    jumpTelegraphMs: 500,
    /** A target must still stand within this of its telegraph ring when the arc lands, else it fizzles. */
    ringRadiusM: 60,
    beamWidthM: 24,
    /** A jump goes to the nearest player not yet hit within this of the last one hit (the plan's 80 m, in combat meters). */
    chainRangeM: 80,
    /** Targets per arc, the first included. */
    maxLinks: 6,
    damage: 14,
    /** Link n deals damage * (1 + damageStep * (n - 1)): x1.0, x1.3, x1.6, ... */
    damageStep: 0.3,
    techniqueId: "corrupted_core_chain_arc"
  }),
  pool: Object.freeze({ radiusM: 110, delayMs: 800, durationMs: 20_000, damagePerSecond: 12, techniqueId: "corrupted_core_pool" }),
  enrage: Object.freeze({ arcIntervalMs: 5_000, exposedDurationMs: 8_000 })
});

export const CORRUPTED_CORE_ABILITIES = Object.freeze({
  /** Visual-only telegraphs (the ring on the target, the beam from the last point); the arc itself is applied by the controller. */
  arcRing: "corrupted_core_arc_ring",
  arcBeam: "corrupted_core_arc_beam"
});

/** Phase ids are presentation (HUD label, client art): which husk is possessed (1-4), or the Core exposed after it. */
export const corruptedCorePhaseId = (kind: "possessing" | "exposed", huskNumber: number, enraged: boolean): string =>
  `${enraged ? "enraged_" : ""}${kind}_${huskNumber}`;

export type CorruptedCoreHooks = Readonly<{
  bossHealthRatio(bossEntityId: string): number;
  bossPosition(bossEntityId: string): LatLon | null;
  playerPosition(entityId: string): LatLon | null;
  anchorPosition(bossEntityId: string, anchorId: string): LatLon | null;
  /** Spawns a husk dormant: inert (stunned), invulnerable, dormant art. Null when it could not spawn. */
  spawnHusk(bossEntityId: string, archetype: MobArchetypeKey, position: LatLon): string | null;
  /** Wakes a husk: possessed art, vulnerable, and it goes for this player (the nearest). */
  possessHusk(huskEntityId: string, targetPlayerEntityId: string | null): void;
  /** The Core's own basic attacks land nothing (it only arcs and pools); true while the fight runs. */
  setBossPassive(bossEntityId: string, passive: boolean): void;
  /** The Core takes no damage while shielded (it is inside a husk). */
  setBossShielded(bossEntityId: string, shielded: boolean): void;
  mobPosition(entityId: string): LatLon | null;
  moveBossTo(bossEntityId: string, position: LatLon): boolean;
  /** Heals the boss back up to this fraction of its maximum health (never down). */
  healBossToRatio(bossEntityId: string, ratio: number): void;
  isAlive(entityId: string): boolean;
  despawn(entityIds: readonly string[]): void;
  spawnDamageZone(bossEntityId: string, center: LatLon, radiusM: number, delayMs: number, durationMs: number, damagePerSecond: number, techniqueId: string): void;
  /** Removes every damage zone this boss left (reset, wipe, defeat). */
  clearDamageZones(bossEntityId: string): void;
  /** One chain arc hit on a player. */
  strikePlayer(bossEntityId: string, playerEntityId: string, damage: number, techniqueId: string): void;
}>;

type CoreHusk = { id: string; position: LatLon };
type CoreArc = {
  ringCastId: string;
  resolveAt: number;
  targetId: string;
  ringCenter: LatLon;
  link: number;
  hit: string[];
};

export function createCorruptedCoreController(hooks: CorruptedCoreHooks): BossController {
  const tuning = CORRUPTED_CORE;
  let husks: CoreHusk[] = [];
  let index = 0;
  let state: "idle" | "possessing" | "exposed" = "idle";
  let enraged = false;
  let home: LatLon | null = null;
  let exposedUntil = 0;
  let floorPercent: number | null = null;
  let nextArcAt = 0;
  let arc: CoreArc | null = null;

  const notify = (context: BossControllerContext, message: string, kind: "success" | "warning" = "warning"): void => {
    context.encounter.host.room?.notify(null, message, kind);
  };

  const livePlayers = (context: BossControllerContext): { id: string; position: LatLon }[] =>
    context.eligibleParticipants
      .map((id) => ({ id, position: hooks.playerPosition(id) }))
      .filter((entry): entry is { id: string; position: LatLon } => entry.position !== null);

  const spawnHusks = (context: BossControllerContext): void => {
    const bossId = context.encounter.mobEntityId;
    husks = [];
    tuning.huskAnchors.forEach((anchorId, slot) => {
      const position = hooks.anchorPosition(bossId, anchorId);
      if (!position) return;
      const gem = slot === tuning.huskAnchors.length - 1;
      const id = hooks.spawnHusk(bossId, gem ? tuning.gemHuskArchetype : tuning.huskArchetype, position);
      if (id) husks.push({ id, position });
    });
  };

  const clear = (context: BossControllerContext): void => {
    const living = husks.filter((husk) => hooks.isAlive(husk.id)).map((husk) => husk.id);
    if (living.length > 0) hooks.despawn(living);
    husks = [];
    index = 0;
    state = "idle";
    enraged = false;
    exposedUntil = 0;
    floorPercent = null;
    nextArcAt = 0;
    arc = null;
    hooks.setBossShielded(context.encounter.mobEntityId, false);
    hooks.setBossPassive(context.encounter.mobEntityId, false);
    hooks.clearDamageZones(context.encounter.mobEntityId);
    context.encounter.setMovementOverride(null);
    context.encounter.setPhaseDeadline(null);
  };

  const setCoreOverride = (context: BossControllerContext, incomingDamageMultiplier: number): void => {
    // The Core never walks; it floats where it is (or where the husk threw it out).
    context.encounter.setMovementOverride({
      id: "corrupted-core", generation: context.lifeGeneration, movementSpeedMultiplier: 0, incomingDamageMultiplier
    });
  };

  const beginPossession = (context: BossControllerContext, first: boolean): void => {
    const bossId = context.encounter.mobEntityId;
    const husk = husks[index];
    if (!husk) return;
    state = "possessing";
    arc = null;
    floorPercent = null;
    if (home) hooks.moveBossTo(bossId, home);
    hooks.setBossShielded(bossId, true);
    setCoreOverride(context, 1);
    context.encounter.setPhaseDeadline(null);
    const players = livePlayers(context);
    const nearest = players.length === 0 ? null : players.reduce((best, entry) =>
      distanceMeters(husk.position, entry.position) < distanceMeters(husk.position, best.position) ? entry : best);
    hooks.possessHusk(husk.id, nearest?.id ?? null);
    nextArcAt = context.now + (first ? tuning.arc.firstDelayMs : enraged ? tuning.enrage.arcIntervalMs : tuning.arc.intervalMs);
    context.encounter.transitionPhase(corruptedCorePhaseId("possessing", index + 1, enraged));
    notify(context, `The Core possesses husk ${index + 1} of ${tuning.huskAnchors.length}.`);
  };

  /** No husk could spawn: the Core would sit idle and passive forever, so the attempt ends (the room is thrown out and resets). */
  const failNoHusks = (context: BossControllerContext): void => {
    notify(context, "The husks never stir. The Forge throws you out!");
    clear(context);
    context.encounter.requestFailure("no_husks");
  };

  const huskDown = (context: BossControllerContext): void => {
    const bossId = context.encounter.mobEntityId;
    const husk = husks[index]!;
    // The husk leaves a corruption pool on its spot, and the Core is thrown out there.
    hooks.spawnDamageZone(bossId, husk.position, tuning.pool.radiusM, tuning.pool.delayMs, tuning.pool.durationMs,
      tuning.pool.damagePerSecond, tuning.pool.techniqueId);
    state = "exposed";
    arc = null;
    const windowMs = enraged ? tuning.enrage.exposedDurationMs : tuning.exposed.durationMs;
    exposedUntil = context.now + windowMs;
    floorPercent = !enraged && index < tuning.exposed.floorPercentAfterHusk.length
      ? tuning.exposed.floorPercentAfterHusk[index]! : null;
    hooks.moveBossTo(bossId, husk.position);
    hooks.setBossShielded(bossId, false);
    setCoreOverride(context, tuning.exposed.incomingDamageMultiplier);
    context.encounter.transitionPhase(corruptedCorePhaseId("exposed", index + 1, enraged));
    context.encounter.setPhaseDeadline(exposedUntil);
    notify(context, "The Core is thrown out of the husk, stunned and exposed! Double damage!", "success");
  };

  const endExposure = (context: BossControllerContext): void => {
    if (index + 1 < husks.length) {
      index += 1;
      beginPossession(context, false);
      return;
    }
    // All the husks are used and the Core lives: they reassemble and it enrages.
    const living = husks.filter((husk) => hooks.isAlive(husk.id)).map((husk) => husk.id);
    if (living.length > 0) hooks.despawn(living);
    enraged = true;
    spawnHusks(context);
    if (husks.length === 0) { failNoHusks(context); return; }
    index = 0;
    notify(context, "The husks reassemble! The Core enrages!");
    beginPossession(context, false);
  };

  const beginLink = (
    context: BossControllerContext, from: LatLon, target: { id: string; position: LatLon }, link: number, hit: string[]
  ): boolean => {
    const telegraphMs = link === 1 ? tuning.arc.firstTelegraphMs : tuning.arc.jumpTelegraphMs;
    const ring = context.beginCast({
      abilityId: CORRUPTED_CORE_ABILITIES.arcRing,
      geometry: { kind: "circle", center: target.position, radiusM: tuning.arc.ringRadiusM },
      castDurationMs: telegraphMs
    });
    if (!ring) return false;
    context.beginCast({
      abilityId: CORRUPTED_CORE_ABILITIES.arcBeam,
      geometry: {
        kind: "line", origin: from, facingDegrees: bearingDegrees(from, target.position),
        lengthM: Math.max(10, distanceMeters(from, target.position)), widthM: tuning.arc.beamWidthM
      },
      castDurationMs: telegraphMs
    });
    arc = { ringCastId: ring.castInstanceId, resolveAt: ring.resolveTime, targetId: target.id, ringCenter: target.position, link, hit };
    return true;
  };

  const startArc = (context: BossControllerContext): void => {
    const husk = husks[index];
    const origin = (husk ? hooks.mobPosition(husk.id) : null) ?? husk?.position ?? null;
    if (!origin) return;
    const players = livePlayers(context);
    if (players.length === 0) return;
    const nearest = players.reduce((best, entry) =>
      distanceMeters(origin, entry.position) < distanceMeters(origin, best.position) ? entry : best);
    if (beginLink(context, origin, nearest, 1, [])) {
      nextArcAt = context.now + (enraged ? tuning.enrage.arcIntervalMs : tuning.arc.intervalMs);
    }
  };

  /** The ring landed: the target is struck if it is still inside, then the arc jumps to the nearest player not yet hit. */
  const resolveLink = (context: BossControllerContext, landed: CoreArc): void => {
    const bossId = context.encounter.mobEntityId;
    const position = hooks.playerPosition(landed.targetId);
    if (!position || distanceMeters(position, landed.ringCenter) > tuning.arc.ringRadiusM) return;
    const damage = tuning.arc.damage * (1 + tuning.arc.damageStep * (landed.link - 1));
    hooks.strikePlayer(bossId, landed.targetId, damage, tuning.arc.techniqueId);
    const hit = [...landed.hit, landed.targetId];
    if (landed.link >= tuning.arc.maxLinks) return;
    const next = livePlayers(context)
      .filter((entry) => !hit.includes(entry.id) && distanceMeters(position, entry.position) <= tuning.arc.chainRangeM)
      .reduce<{ id: string; position: LatLon } | null>((best, entry) =>
        best === null || distanceMeters(position, entry.position) < distanceMeters(position, best.position) ? entry : best, null);
    if (next) beginLink(context, position, next, landed.link + 1, hit);
  };

  return {
    onActivate: (context) => {
      if (husks.length > 0) return;
      const bossId = context.encounter.mobEntityId;
      home = hooks.bossPosition(bossId);
      hooks.setBossPassive(bossId, true);
      enraged = false;
      index = 0;
      spawnHusks(context);
      if (husks.length === 0) { failNoHusks(context); return; }
      beginPossession(context, true);
    },
    update: (context) => {
      const now = context.now;
      if (state === "idle") return;
      for (const husk of husks) {
        const position = hooks.isAlive(husk.id) ? hooks.mobPosition(husk.id) : null;
        if (position) husk.position = position;
      }
      if (state === "exposed") {
        const ratioPercent = hooks.bossHealthRatio(context.encounter.mobEntityId) * 100;
        if (now >= exposedUntil || (floorPercent !== null && ratioPercent <= floorPercent + 0.01)) endExposure(context);
        return;
      }
      const husk = husks[index];
      if (!husk || !hooks.isAlive(husk.id)) {
        huskDown(context);
        return;
      }
      if (arc) {
        const landed = arc;
        if (!context.encounter.activeCasts.some((cast) => cast.castInstanceId === landed.ringCastId)) {
          arc = null;
          // Gone before its time means a phase change cancelled it; the arc is dropped.
          if (now >= landed.resolveAt) resolveLink(context, landed);
        }
        return;
      }
      if (now >= nextArcAt) startArc(context);
    },
    onDamage: (context) => {
      if (state !== "exposed" || floorPercent === null) return;
      // The shell holds at the floor: no window can skip a husk.
      hooks.healBossToRatio(context.encounter.mobEntityId, floorPercent / 100);
    },
    onReset: (context) => {
      const bossId = context.encounter.mobEntityId;
      clear(context);
      if (home) hooks.moveBossTo(bossId, home);
    },
    onDefeat: clear,
    destroy: clear
  };
}
