import { DEFAULT_PLAYER_SPEED_MPS, destinationPoint, distanceMeters, type LatLon } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { CombatEngine } from "./combatEngine.js";
import {
  GOBLIN_DEFENDER_CHATTER_CHANCE,
  GOBLIN_DEFENDER_CHATTER_INTERVAL_MS,
  GOBLIN_DEFENDER_DIALOGUE,
  GOBLIN_DEFENDER_FUNNY_DIALOGUE,
  GOBLIN_DEFENDER_ATTENTION_COOLDOWN_MS,
  GOBLIN_DEFENDER_OBSERVATION_CHANCE,
  GOBLIN_DEFENDER_OBSERVATION_ROLL_INTERVAL_MS,
  GOBLIN_DEFENDER_SPEECH_DURATION_MS,
  GOBLIN_DEFENDER_SNARKY_DIALOGUE,
  GOBLIN_DEFENDER_WANDER_PAUSE_MS,
  GOBLIN_DEFENDER_WANDER_RADIUS_M,
  goblinDefenderDialogueForRoll
} from "./goblinDefenderAmbient.js";
import { mobMovementSpeedMps, requireMobDefinition } from "./mobDefinitions.js";
import { packageIdForPosition, zoneIdForPosition } from "../spatialZones.js";

const origin = { lat: 35.0844, lon: -106.6504 };

describe("Goblin defender ambient AI", () => {
  it("defines 50 unique equal-width dialogue bins and exact chatter constants", () => {
    expect(GOBLIN_DEFENDER_DIALOGUE).toHaveLength(50);
    expect(new Set(GOBLIN_DEFENDER_DIALOGUE)).toHaveLength(50);
    expect(GOBLIN_DEFENDER_SNARKY_DIALOGUE).toHaveLength(45);
    expect(GOBLIN_DEFENDER_FUNNY_DIALOGUE).toHaveLength(5);
    expect(GOBLIN_DEFENDER_DIALOGUE).toEqual([
      ...GOBLIN_DEFENDER_SNARKY_DIALOGUE,
      ...GOBLIN_DEFENDER_FUNNY_DIALOGUE
    ]);
    expect(GOBLIN_DEFENDER_CHATTER_INTERVAL_MS).toBe(5_000);
    expect(GOBLIN_DEFENDER_CHATTER_CHANCE).toBe(0.01);
    expect(GOBLIN_DEFENDER_SPEECH_DURATION_MS).toBe(6_000);
    expect(GOBLIN_DEFENDER_OBSERVATION_CHANCE).toBe(0.05);
    expect(GOBLIN_DEFENDER_OBSERVATION_ROLL_INTERVAL_MS).toBe(30_000);
    expect(GOBLIN_DEFENDER_ATTENTION_COOLDOWN_MS).toBe(120_000);
    expect(GOBLIN_DEFENDER_WANDER_PAUSE_MS).toBe(30_000);
    GOBLIN_DEFENDER_DIALOGUE.forEach((line, index) => {
      expect(goblinDefenderDialogueForRoll((index + 0.5) / 50)).toBe(line);
      expect(goblinDefenderDialogueForRoll((index + 0.999_999) / 50)).toBe(line);
    });
  });

  it("uses exactly 75% player speed and 200m same-pack separation", () => {
    expect(requireMobDefinition("goblin").movementSpeedMultiplier).toBe(0.75);
    expect(mobMovementSpeedMps("goblin", DEFAULT_PLAYER_SPEED_MPS))
      .toBe(DEFAULT_PLAYER_SPEED_MPS * 0.75);
    expect(requireMobDefinition("goblin").combatSeparationM).toBe(200);
  });

  it("rolls speech independently after five seconds, including for stationary archers", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(100_000));
      const rolls = [0.049, 0.009, 0, 1, 0.049];
      const engine = createEngine({ random: () => rolls.shift() ?? 1 });
      addPlayer(engine, "neutral", destinationPoint(origin, 10, 90));
      const archer = spawnDefender(engine, origin, 0, "archer");
      engine.tick();
      expect(engine.entity(archer.entityId)?.aiPresentation?.phase).toBe("observing");
      expect(engine.entity(archer.entityId)?.ambientSpeech).toBeUndefined();
      vi.advanceTimersByTime(4_999);
      engine.tick();
      expect(engine.entity(archer.entityId)?.ambientSpeech).toBeUndefined();
      vi.advanceTimersByTime(1);
      engine.tick();
      expect(engine.entity(archer.entityId)?.ambientSpeech).toEqual({
        text: GOBLIN_DEFENDER_DIALOGUE[0], expiresAt: 111_000
      });
      expect(position(engine, archer.entityId)).toEqual(origin);
      vi.advanceTimersByTime(120_000);
      engine.tick();
      expect(engine.entity(archer.entityId)?.aiPresentation?.phase).toBe("observing");
      expect(position(engine, archer.entityId)).toEqual(origin);
    } finally {
      vi.useRealTimers();
    }
  });

  it("observes a nearby neutral for four seconds and waits through its attention cooldown", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(100_000));
      const rolls = [0.049, 1, 0.049];
      const engine = createEngine({ random: () => rolls.shift() ?? 1 });
      addPlayer(engine, "player", destinationPoint(origin, 10, 90));
      const goblin = spawnDefender(engine, origin, 0, "archer");
      engine.tick();
      expect(engine.entity(goblin.entityId)?.aiPresentation?.phase).toBe("observing");
      vi.advanceTimersByTime(4_000);
      engine.tick();
      expect(engine.entity(goblin.entityId)?.aiPresentation).toBeNull();
      engine.tick();
      expect(engine.entity(goblin.entityId)?.aiPresentation).toBeNull();
      vi.advanceTimersByTime(120_000);
      engine.tick();
      expect(engine.entity(goblin.entityId)?.aiPresentation?.phase).toBe("observing");
    } finally {
      vi.useRealTimers();
    }
  });

  it("observes neutral players when production combat-acquisition callbacks reject them", () => {
    const engine = createEngine({
      random: () => 0.049,
      canMobProactivelyAcquire: () => false,
      canMobContinueIntent: () => false
    });
    addPlayer(engine, "neutral", destinationPoint(origin, 10, 90));
    const goblin = spawnDefender(engine, origin);
    engine.tick();
    expect(engine.entity(goblin.entityId)?.aiPresentation?.phase).toBe("observing");
  });

  it("rolls for neutral observation at most once every 30 seconds after a miss", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(100_000));
      const random = vi.fn()
        .mockReturnValueOnce(0.5)
        .mockReturnValueOnce(0.049)
        .mockReturnValue(1);
      const engine = createEngine({ random });
      addPlayer(engine, "neutral", destinationPoint(origin, 10, 90));
      const archer = spawnDefender(engine, origin, 0, "archer");
      const runtime = engine as unknown as {
        entities: Map<string, { mobAi: { nextAmbientSpeechRollAtMs: number } }>;
      };
      runtime.entities.get(archer.entityId)!.mobAi.nextAmbientSpeechRollAtMs = Number.POSITIVE_INFINITY;
      engine.tick();
      expect(random).toHaveBeenCalledTimes(1);
      expect(engine.entity(archer.entityId)?.aiPresentation).toBeNull();
      for (let tick = 0; tick < 100; tick += 1) engine.tick();
      expect(random).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(29_999);
      engine.tick();
      expect(random).toHaveBeenCalledTimes(1);
      expect(engine.entity(archer.entityId)?.aiPresentation).toBeNull();
      vi.advanceTimersByTime(1);
      engine.tick();
      expect(engine.entity(archer.entityId)?.aiPresentation?.phase).toBe("observing");
    } finally {
      vi.useRealTimers();
    }
  });

  it("wanders mobile defenders beyond 30m within 600m but never moves stationary archers", () => {
    const engine = createEngine({ random: () => 0.25 });
    const mobile = spawnDefender(engine, origin);
    const tower = spawnDefender(engine, destinationPoint(origin, 100, 90), 0, "archer");
    const towerStart = position(engine, tower.entityId);
    for (let tick = 0; tick < 100; tick += 1) engine.tick();
    expect(GOBLIN_DEFENDER_WANDER_RADIUS_M).toBe(600);
    expect(distanceMeters(position(engine, mobile.entityId), origin)).toBeGreaterThan(30);
    expect(distanceMeters(position(engine, mobile.entityId), origin)).toBeLessThanOrEqual(600);
    expect(position(engine, tower.entityId)).toEqual(towerStart);
  });

  it("spreads nearby same-pack defenders toward the 200m preferred separation", () => {
    const engine = createEngine({ random: () => 0.25 });
    const first = spawnDefender(engine, origin, undefined, "warrior", "goblin:first");
    const secondStart = destinationPoint(origin, 1, 90);
    const second = spawnDefender(
      engine,
      secondStart,
      undefined,
      "warrior",
      "goblin:second"
    );
    const initialSeparation = distanceMeters(
      position(engine, first.entityId),
      position(engine, second.entityId)
    );
    for (let tick = 0; tick < 40; tick += 1) engine.tick();
    const spreadSeparation = distanceMeters(
      position(engine, first.entityId),
      position(engine, second.entityId)
    );
    expect(initialSeparation).toBeCloseTo(1, 3);
    expect(spreadSeparation).toBeGreaterThan(50);
    expect(spreadSeparation).toBeLessThanOrEqual(200);
  });

  it("spreads same-pack defenders straddling the antimeridian without a world-wide jump", () => {
    const engine = createEngine({ random: () => 0.25 });
    const seamOrigin = { lat: -17.8, lon: 179.999995 };
    const first = spawnDefender(engine, seamOrigin, undefined, "warrior", "goblin:seam-first");
    const secondStart = destinationPoint(seamOrigin, 1, 90);
    expect(secondStart.lon).toBeLessThan(0);
    const second = spawnDefender(engine, secondStart, undefined, "warrior", "goblin:seam-second");
    for (let tick = 0; tick < 40; tick += 1) engine.tick();
    const firstPosition = position(engine, first.entityId);
    const secondPosition = position(engine, second.entityId);
    const spreadSeparation = distanceMeters(firstPosition, secondPosition);
    expect(spreadSeparation).toBeGreaterThan(50);
    expect(spreadSeparation).toBeLessThanOrEqual(200);
    for (const mob of [firstPosition, secondPosition]) {
      expect(Math.abs(mob.lon)).toBeLessThanOrEqual(180);
      expect(distanceMeters(seamOrigin, mob)).toBeLessThan(700);
    }
  });

  it("releases neutral observation when hostility is marked and acquires for pack defense", () => {
    const engine = createEngine({
      random: () => 0.049,
      canMobProactivelyAcquire: () => true,
      canMobContinueIntent: () => true
    });
    addPlayer(engine, "player", destinationPoint(origin, 10, 90));
    const goblin = spawnDefender(engine, origin);
    engine.tick();
    expect(engine.entity(goblin.entityId)?.aiPresentation?.phase).toBe("observing");
    engine.markNpcCityPlayerEnemy("11111111-1111-4111-8111-111111111111", "player");
    expect(engine.entity(goblin.entityId)?.aiPresentation).toBeNull();
    engine.tick();
    expect(engine.entity(goblin.entityId)?.targetEntityId).toBe("player");
  });

  it("prioritizes a farther confirmed enemy over a closer neutral player", () => {
    const engine = createEngine({ random: () => 1 });
    addPlayer(engine, "neutral", destinationPoint(origin, 10, 90));
    addPlayer(engine, "enemy", destinationPoint(origin, 80, 90));
    engine.markNpcCityPlayerEnemy("11111111-1111-4111-8111-111111111111", "enemy");
    const goblin = spawnDefender(engine, origin);
    engine.tick();
    expect(engine.entity(goblin.entityId)?.targetEntityId).toBe("enemy");
    expect(engine.entity(goblin.entityId)?.aiPresentation).toBeNull();
  });

  it("interrupts an existing neutral observation when another eligible enemy appears", () => {
    const rolls = [0.049];
    const engine = createEngine({ random: () => rolls.shift() ?? 1 });
    addPlayer(engine, "neutral", destinationPoint(origin, 10, 90));
    const goblin = spawnDefender(engine, origin);
    engine.tick();
    expect(engine.entity(goblin.entityId)?.aiPresentation?.phase).toBe("observing");

    addPlayer(engine, "enemy", destinationPoint(origin, 80, 90));
    engine.markNpcCityPlayerEnemy("11111111-1111-4111-8111-111111111111", "enemy");
    engine.tick();
    expect(engine.entity(goblin.entityId)?.targetEntityId).toBe("enemy");
  });
});

function createEngine(overrides: Partial<ConstructorParameters<typeof CombatEngine>[0]> = {}) {
  return new CombatEngine({
    tickRateHz: 20,
    playerMovementSpeedMps: DEFAULT_PLAYER_SPEED_MPS,
    isPlayerAuthorityActive: () => true,
    canMobProactivelyAcquire: () => true,
    canMobContinueIntent: () => true,
    isMobPositionTraversable: () => true,
    ...overrides
  });
}

function addPlayer(engine: CombatEngine, playerId: string, position: LatLon): void {
  engine.connectPlayer({
    playerId, name: playerId, regionCode: packageIdForPosition(position),
    zoneId: zoneIdForPosition(position), position,
    accountId: `account-${playerId}`, connectionId: `connection-${playerId}`,
    profile: { playerId, maxHealth: 100, currentHealth: 100, baseAttackDamage: 10 }
  });
}

function spawnDefender(
  engine: CombatEngine,
  position: LatLon,
  movementSpeedMpsOverride?: number,
  role: "warrior" | "archer" = "warrior",
  entityId?: string
) {
  return engine.spawnMob({
    ...(entityId ? { entityId } : {}),
    archetype: "goblin", worldAi: true, position, homePosition: position,
    regionCode: packageIdForPosition(position), zoneId: zoneIdForPosition(position),
    packId: "goblin-city:test",
    ...(movementSpeedMpsOverride === undefined ? {} : { movementSpeedMpsOverride }),
    npcFaction: {
      cityId: "11111111-1111-4111-8111-111111111111", cityName: "Goblin Village",
      culture: "goblin", role, presentationKey: `goblin_${role}`, invulnerable: true,
      annexRadiusM: 300
    }
  });
}

function position(engine: CombatEngine, entityId: string): LatLon {
  const snapshot = engine.entity(entityId)!;
  return { lat: snapshot.lat, lon: snapshot.lon };
}
