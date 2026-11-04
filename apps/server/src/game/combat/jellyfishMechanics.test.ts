import { describe, expect, it, vi } from "vitest";

import {
  BASIC_ATTACK_INTERVAL_MS,
  beatAlignedAmountScale,
  beatAlignedIntervalMs,
  destinationPoint,
  distanceMeters,
  type LatLon
} from "@ash-atlas/shared";
import {
  CombatEngine,
  type PopulationMobCombatRuntimeState
} from "./combatEngine.js";
import { packageIdForPosition, zoneIdForPosition } from "../spatialZones.js";

const origin = { lat: 35.0844, lon: -106.6504 };
/** The 5-per-2 s, 12 s design poison on the beat: spacing (20 Hz ticks), pulses and exact pulse damage. */
const POISON_PULSE_TICKS = beatAlignedIntervalMs(2_000) * 20 / 1_000;
const POISON_PULSES = Math.round(12_000 / beatAlignedIntervalMs(2_000));
const POISON_PER_PULSE = 5 * beatAlignedAmountScale(2_000);
const POISON_TOTAL = Math.floor(POISON_PER_PULSE * POISON_PULSES + 1e-9);

describe("Jellyfish miniboss mechanics", () => {
  it("deals one direct damage and runs one non-refreshing beat-aligned Poison", () => {
    const onHarmfulStatusDamage = vi.fn();
    const engine = createEngine({ onHarmfulStatusDamage });
    addPlayer(engine);
    const jellyfish = spawnJellyfish(engine);
    engine.beginDeltaFlush();

    expect(resolveBasicAttack(engine, jellyfish.entityId, "player")).toBe(1);
    expect(engine.entity("player")).toMatchObject({
      currentHealth: 99,
      harmfulStatusIds: ["poison"]
    });
    const initial = harmfulEffect(engine, "poison");

    tick(engine, 20);
    expect(resolveBasicAttack(engine, jellyfish.entityId, "player")).toBe(1);
    expect(harmfulEffect(engine, "poison")).toMatchObject({
      endTick: initial.endTick,
      stacks: initial.stacks
    });
    expect(harmfulEffects(engine).filter((effect) => effect.kind === "poison"))
      .toHaveLength(1);

    tick(engine, POISON_PULSE_TICKS * POISON_PULSES);
    expect(engine.entity("player")).toMatchObject({
      currentHealth: 98 - POISON_TOTAL,
      harmfulStatusIds: []
    });
    expect(harmfulEffects(engine)).toEqual([]);
    const poisonTicks = engine.beginDeltaFlush().events.filter((event) =>
      event.type === "DAMAGE" && event.sourceEntityId === jellyfish.entityId && (event.amount ?? 0) > 1
    ).map((event) => event.tick);
    expect(poisonTicks).toHaveLength(POISON_PULSES);
    // Whole beats apart, and never on a tick the jellyfish's own attack could share.
    poisonTicks.slice(1).forEach((at, index) => expect(at - poisonTicks[index]!).toBe(POISON_PULSE_TICKS));
    expect(POISON_PULSE_TICKS % (BASIC_ATTACK_INTERVAL_MS * 20 / 1_000)).toBe(0);
    expect(onHarmfulStatusDamage).toHaveBeenCalledTimes(POISON_PULSES);
    expect(onHarmfulStatusDamage.mock.calls.reduce(
      (sum, [event]) => sum + event.appliedDamage,
      0
    )).toBe(POISON_TOTAL);
    expect(onHarmfulStatusDamage).toHaveBeenCalledWith(expect.objectContaining({
      playerId: "player",
      harmfulStatusId: "poison",
      appliedDamage: Math.floor(POISON_PER_PULSE)
    }));

    resolveBasicAttack(engine, jellyfish.entityId, "player");
    expect(engine.entity("player")?.harmfulStatusIds).toEqual(["poison"]);
    expect(harmfulEffect(engine, "poison").endTick).toBeGreaterThan(initial.endTick);
  });

  it("keeps authoritative status state across a live reconnect snapshot", () => {
    const engine = createEngine();
    addPlayer(engine);
    const jellyfish = spawnJellyfish(engine);
    resolveBasicAttack(engine, jellyfish.entityId, "player");

    reconnectPlayer(engine, 99);

    expect(engine.entity("player")?.harmfulStatusIds).toEqual(["poison"]);
  });

  it("lets Poison defeat a player without recursively applying attack effects", () => {
    const onHarmfulStatusDamage = vi.fn();
    const engine = createEngine({ onHarmfulStatusDamage });
    const firstPulse = Math.floor(POISON_PER_PULSE);
    addPlayer(engine, firstPulse + 1);
    const jellyfish = spawnJellyfish(engine);

    resolveBasicAttack(engine, jellyfish.entityId, "player");
    expect(engine.entity("player")?.currentHealth).toBe(firstPulse);
    tick(engine, POISON_PULSE_TICKS + 8);

    expect(engine.entity("player")).toMatchObject({
      currentHealth: 0,
      lifeState: "respawning",
      harmfulStatusIds: []
    });
    const frame = engine.beginDeltaFlush();
    expect(frame.events.filter((event) => event.type === "DAMAGE")).toHaveLength(2);
    expect(frame.events.filter((event) => event.type === "ATTACK_LANDED")).toHaveLength(1);
    expect(onHarmfulStatusDamage).toHaveBeenCalledOnce();
    expect(onHarmfulStatusDamage).toHaveBeenCalledWith(expect.objectContaining({ appliedDamage: firstPulse }));
  });

  it("enables fixed-duration Shade only in stage three and blocks healing entry points", async () => {
    const engine = createEngine({ resolveMobRetreatDestination: async () => null });
    addPlayer(engine, 50);
    const jellyfish = spawnJellyfish(engine);

    resolveBasicAttack(engine, jellyfish.entityId, "player");
    expect(engine.entity("player")?.harmfulStatusIds).toEqual(["poison"]);
    damageMob(engine, jellyfish.entityId, 650);
    await settlePromises();
    resolveBasicAttack(engine, jellyfish.entityId, "player");
    expect(engine.entity("player")?.harmfulStatusIds).toEqual(["poison", "gloom"]);
    const initialShade = harmfulEffect(engine, "gloom");

    expect(engine.healEntity("player", 20)).toBe(0);
    applyAmbientHealing(engine, 20);
    expect(applyClassHealing(engine, 20)).toEqual({ effective: 0, overheal: 20 });
    expect(engine.entity("player")?.currentHealth).toBe(48);
    resolveBasicAttack(engine, jellyfish.entityId, "player");
    expect(harmfulEffect(engine, "gloom").endTick).toBe(initialShade.endTick);

    tick(engine, POISON_PULSE_TICKS * POISON_PULSES);
    expect(engine.entity("player")?.harmfulStatusIds).toEqual([]);
    expect(engine.healEntity("player", 20)).toBe(20);
    expect(engine.beginDeltaFlush().events.some((event) =>
      event.type === "HEAL_BLOCKED" && event.harmfulStatusId === "gloom"
    )).toBe(true);
  });

  it("retreats once as the same durable actor and resumes from elapsed movement", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(10_000));
      const destination = destinationPoint(origin, 650, 90);
      const persisted: PopulationMobCombatRuntimeState[] = [];
      const engine = createEngine({
        resolveMobRetreatDestination: async () => destination
      });
      engine.setPopulationMobRuntimeStateSink((_entityId, state) => persisted.push(state));
      addPlayer(engine);
      const jellyfish = spawnJellyfish(engine, {
        populationAuthority: authority(),
        movementSpeedMpsOverride: 100
      });

      damageMob(engine, jellyfish.entityId, 301);
      await settlePromises();
      expect(engine.entity(jellyfish.entityId)).toMatchObject({
        entityId: jellyfish.entityId,
        currentHealth: 599,
        activityState: "fleeing"
      });
      expect(persisted.at(-1)).toMatchObject({
        currentHealth: 599,
        maxHealth: 900,
        jellyfish: {
          stage: 2,
          retreatPhase: "moving",
          retreatTriggered: true,
          secondRetreatTriggered: false,
          retreatsCompleted: 0
        }
      });

      vi.setSystemTime(new Date(13_000));
      const resumed = createEngine();
      resumed.spawnMob({
        entityId: jellyfish.entityId,
        archetype: "jellyfish",
        position: origin,
        homePosition: origin,
        regionCode: packageIdForPosition(origin),
        zoneId: zoneIdForPosition(origin),
        worldAi: true,
        populationAuthority: authority(),
        movementSpeedMpsOverride: 100,
        populationRuntimeState: persisted.at(-1)
      });
      const resumedSnapshot = resumed.entity(jellyfish.entityId)!;
      expect(resumedSnapshot.currentHealth).toBe(599);
      expect(distanceMeters(origin, point(resumedSnapshot))).toBeCloseTo(310, 0);
      expect(resumedSnapshot.regionCode).toBe(packageIdForPosition(point(resumedSnapshot)));
      expect(resumedSnapshot.zoneId).toBe(zoneIdForPosition(point(resumedSnapshot)));

      tick(resumed, 70);
      const arrived = resumed.entity(jellyfish.entityId)!;
      expect(distanceMeters(origin, point(arrived))).toBeCloseTo(650, 0);
      expect(arrived).toMatchObject({
        entityId: jellyfish.entityId,
        currentHealth: 599,
        activityState: "idle"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rescales a persisted Ashen-sized jellyfish by health ratio once and does not compound across reloads", () => {
    const legacyState = {
      schemaVersion: 1,
      revision: 7,
      archetype: "jellyfish",
      maxHealth: 4_500,
      currentHealth: 2_250,
      position: origin,
      jellyfish: {
        stage: 2,
        retreatTriggered: true,
        secondRetreatTriggered: false,
        retreatsCompleted: 1,
        shadeEnabled: false,
        retreatPhase: "complete",
        retreatStartPosition: null,
        retreatDestination: null,
        retreatStartedAtMs: null
      }
    } as const;
    const persisted: PopulationMobCombatRuntimeState[] = [];
    const first = createEngine();
    first.setPopulationMobRuntimeStateSink((_entityId, state) => persisted.push(state));
    addPlayer(first);
    const restored = spawnJellyfish(first, {
      populationAuthority: authority(),
      populationRuntimeState: legacyState
    });

    expect(restored).toMatchObject({ maxHealth: 900, currentHealth: 450 });
    damageMob(first, restored.entityId, 1);
    expect(persisted.at(-1)).toMatchObject({
      schemaVersion: 1,
      currentHealth: 449,
      maxHealth: 900
    });

    const second = createEngine();
    const reloaded = spawnJellyfish(second, {
      populationAuthority: authority(),
      populationRuntimeState: persisted.at(-1)
    });
    expect(reloaded).toMatchObject({ maxHealth: 900, currentHealth: 449 });
  });

  it("retreats again exactly once when it crosses one-third health", async () => {
    const resolveMobRetreatDestination = vi.fn(async (input: { retreatIndex: 1 | 2 }) =>
      destinationPoint(origin, 650, input.retreatIndex === 1 ? 0 : 90)
    );
    const persisted: PopulationMobCombatRuntimeState[] = [];
    const engine = createEngine({ resolveMobRetreatDestination });
    engine.setPopulationMobRuntimeStateSink((_entityId, state) => persisted.push(state));
    addPlayer(engine);
    const jellyfish = spawnJellyfish(engine, {
      populationAuthority: authority(),
      movementSpeedMpsOverride: 100
    });

    damageMob(engine, jellyfish.entityId, 301);
    await settlePromises();
    tick(engine, 150);
    expect(resolveMobRetreatDestination).toHaveBeenCalledTimes(1);
    expect(persisted.at(-1)?.jellyfish).toMatchObject({
      retreatsCompleted: 1,
      retreatPhase: "complete"
    });

    damageMob(engine, jellyfish.entityId, 300);
    await settlePromises();
    expect(resolveMobRetreatDestination).toHaveBeenCalledTimes(2);
    expect(engine.entity(jellyfish.entityId)).toMatchObject({
      entityId: jellyfish.entityId,
      currentHealth: 299,
      activityState: "fleeing"
    });
    tick(engine, 250);
    expect(persisted.at(-1)?.jellyfish).toMatchObject({
      secondRetreatTriggered: true,
      retreatsCompleted: 2,
      retreatPhase: "complete"
    });

    damageMob(engine, jellyfish.entityId, 1);
    expect(resolveMobRetreatDestination).toHaveBeenCalledTimes(2);
  });

  it("deterministically crosses both thresholds on one large hit without duplicating", async () => {
    const resolveMobRetreatDestination = vi.fn(async (input: { retreatIndex: 1 | 2 }) =>
      destinationPoint(origin, 650, input.retreatIndex === 1 ? 180 : 270)
    );
    const persisted: PopulationMobCombatRuntimeState[] = [];
    const engine = createEngine({ resolveMobRetreatDestination });
    engine.setPopulationMobRuntimeStateSink((_entityId, state) => persisted.push(state));
    addPlayer(engine);
    const jellyfish = spawnJellyfish(engine, { populationAuthority: authority() });

    damageMob(engine, jellyfish.entityId, 700);
    await settlePromises();
    damageMob(engine, jellyfish.entityId, 1);

    expect(resolveMobRetreatDestination).toHaveBeenCalledOnce();
    expect(engine.entity(jellyfish.entityId)).toMatchObject({
      entityId: jellyfish.entityId,
      currentHealth: 199,
      activityState: "fleeing"
    });
    expect(persisted.at(-1)).toMatchObject({
      currentHealth: 199,
      jellyfish: {
        stage: 3,
        retreatTriggered: true,
        secondRetreatTriggered: true,
        retreatsCompleted: 0,
        shadeEnabled: true,
        retreatPhase: "moving"
      }
    });
    expect(() => spawnJellyfish(engine)).toThrow(/already exists/u);

    tick(engine, 3_000);
    await settlePromises();
    expect(resolveMobRetreatDestination).toHaveBeenCalledTimes(2);
    expect(engine.entity(jellyfish.entityId)?.activityState).toBe("fleeing");
    tick(engine, 3_000);
    resolveBasicAttack(engine, jellyfish.entityId, "player");
    expect(engine.entity("player")?.harmfulStatusIds).toEqual(["poison", "gloom"]);
    expect(persisted.at(-1)?.jellyfish).toMatchObject({
      retreatsCompleted: 2,
      retreatPhase: "complete"
    });
  });
});

function createEngine(
  overrides: Partial<ConstructorParameters<typeof CombatEngine>[0]> = {}
): CombatEngine {
  return new CombatEngine({
    tickRateHz: 20,
    playerMovementSpeedMps: 40,
    isPlayerAuthorityActive: () => true,
    ...overrides
  });
}

function addPlayer(engine: CombatEngine, currentHealth = 100): void {
  engine.connectPlayer({
    playerId: "player",
    name: "Player",
    regionCode: packageIdForPosition(origin),
    zoneId: zoneIdForPosition(origin),
    position: origin,
    accountId: "account-player",
    connectionId: "connection-player",
    profile: {
      playerId: "player",
      maxHealth: 100,
      currentHealth,
      baseAttackDamage: 100
    }
  });
}

function reconnectPlayer(engine: CombatEngine, currentHealth: number): void {
  engine.connectPlayer({
    playerId: "player",
    name: "Player",
    regionCode: packageIdForPosition(origin),
    zoneId: zoneIdForPosition(origin),
    position: origin,
    accountId: "account-player",
    connectionId: "connection-player-reconnected",
    profile: {
      playerId: "player",
      maxHealth: 100,
      currentHealth,
      baseAttackDamage: 100
    }
  });
}

function spawnJellyfish(
  engine: CombatEngine,
  overrides: Partial<Parameters<CombatEngine["spawnMob"]>[0]> = {}
) {
  return engine.spawnMob({
    entityId: "00000000-0000-8000-8000-000000000901",
    archetype: "jellyfish",
    position: destinationPoint(origin, 10, 90),
    homePosition: origin,
    regionCode: packageIdForPosition(origin),
    zoneId: zoneIdForPosition(origin),
    ...overrides
  });
}

function resolveBasicAttack(engine: CombatEngine, attackerId: string, targetId: string): number {
  const internal = engine as unknown as {
    entities: Map<string, unknown>;
    resolveBasicAttack(attacker: unknown, target: unknown): number;
  };
  return internal.resolveBasicAttack(
    internal.entities.get(attackerId),
    internal.entities.get(targetId)
  );
}

function damageMob(engine: CombatEngine, targetId: string, damage: number): number {
  const internal = engine as unknown as {
    entities: Map<string, unknown>;
    applyDamage(
      attacker: unknown,
      target: unknown,
      damage: number,
      techniqueId: string,
      direct: boolean
    ): number;
  };
  return internal.applyDamage(
    internal.entities.get("player"),
    internal.entities.get(targetId),
    damage,
    "test_strike",
    true
  );
}

function harmfulEffects(engine: CombatEngine): Array<{
  kind: string;
  endTick: number;
  stacks: number;
}> {
  const internal = engine as unknown as {
    entities: Map<string, {
      classRuntime: { effects: Array<{ kind: string; endTick: number; stacks: number }> };
    }>;
  };
  return internal.entities.get("player")!.classRuntime.effects.filter((effect) =>
    effect.kind === "poison" || effect.kind === "gloom"
  );
}

function harmfulEffect(engine: CombatEngine, kind: "poison" | "gloom") {
  return harmfulEffects(engine).find((effect) => effect.kind === kind)!;
}

function applyAmbientHealing(engine: CombatEngine, amount: number): void {
  const internal = engine as unknown as {
    entities: Map<string, unknown>;
    applyAmbientHealing(target: unknown, amount: number): void;
  };
  internal.applyAmbientHealing(internal.entities.get("player"), amount);
}

function applyClassHealing(engine: CombatEngine, amount: number) {
  const internal = engine as unknown as {
    entities: Map<string, unknown>;
    applyHealing(
      source: unknown,
      target: unknown,
      amount: number,
      techniqueId: string
    ): { effective: number; overheal: number };
  };
  const player = internal.entities.get("player");
  return internal.applyHealing(player, player, amount, "test_heal");
}

function tick(engine: CombatEngine, count: number): void {
  for (let index = 0; index < count; index += 1) engine.tick();
}

async function settlePromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function authority() {
  return {
    ownerToken: "00000000-0000-4000-8000-000000000999",
    fencingGeneration: 1,
    cutoverRevision: 1
  };
}

function point(snapshot: { lat: number; lon: number }): LatLon {
  return { lat: snapshot.lat, lon: snapshot.lon };
}
