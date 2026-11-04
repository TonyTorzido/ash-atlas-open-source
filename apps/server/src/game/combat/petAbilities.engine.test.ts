import { destinationPoint, PET_ABILITY_IDS, PET_SPECIES_DEFINITIONS, PET_SPECIES_IDS, type LatLon, type PetAbilityId } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { CombatEngine } from "./combatEngine.js";
import { PetCompanionRuntime } from "./petCompanionRuntime.js";
import type { ActivePet } from "../petService.js";

const origin = { lat: 35.0844, lon: -106.6504 };
type Internal = Map<string, {
  currentHealth: number; maxHealth: number; position: LatLon;
  classRuntime?: { effects: Array<{ kind: string; endTick: number; amount: number }>; counters: Record<string, unknown> } | null;
}>;

/**
 * Every pet ability against a real CombatEngine: the server effect must land (damage, status,
 * movement, heal, stealth, buff) and the ability must return the notice the player sees.
 */
describe("pet abilities on the real combat engine", () => {
  for (const abilityId of PET_ABILITY_IDS) {
    it(`${abilityId} applies its effect and reports to the owner`, async () => {
      const species = PET_SPECIES_IDS.find((id) => PET_SPECIES_DEFINITIONS[id].abilities.includes(abilityId))!;
      const { engine, runtime, internals, mobId } = setup(species);
      const before = snapshot(internals, mobId);
      const owner = internals.get("p1")!;
      owner.currentHealth = 50;
      const petEntity = [...internals.entries()].find(([id]) => id.startsWith("pet-companion:"))![1];
      petEntity.currentHealth = Math.round(petEntity.maxHealth / 2);
      const result = await runtime.useAbility("p1", "pet-1", abilityId, 10_000);
      expect(result.notice.length).toBeGreaterThan(3);
      const after = snapshot(internals, mobId);
      const effects = internals.get(mobId)!.classRuntime?.effects.map((effect) => effect.kind) ?? [];
      const expectations: Record<PetAbilityId, () => void> = {
        track_hide: () => expect(result.ping).toMatchObject({ label: "Wolf" }),
        find_open_land: () => expect(result.ping).toMatchObject({ label: "Open land" }),
        sky_sight: () => expect(result.notice).toMatch(/no elites|found/u),
        web_snare: () => expect(effects).toContain("rooted"),
        envenom: () => { expect(effects).toContain("poison"); expect(after.health).toBeLessThan(before.health); },
        pounce: () => { expect(effects).toContain("rooted"); expect(after.health).toBeLessThan(before.health); },
        rending_bite: () => { expect(effects).toContain("bleed"); expect(effects).toContain("defense_reduction"); },
        squall_burst: () => { expect(effects).toContain("rooted"); expect(after.distanceFromStart).toBeGreaterThan(5); },
        hold_fast: () => expect(internals.get(mobId)!.classRuntime!.effects.find((effect) => effect.kind === "rooted")).toBeDefined(),
        shadow_hide: () => expect(Number(owner.classRuntime?.counters.petShadowHideUntil ?? 0)).toBeGreaterThan(0),
        bull_rush: () => { expect(effects).toContain("rooted"); expect(after.health).toBeLessThan(before.health); },
        fury: () => expect(owner.classRuntime?.effects.map((effect) => effect.kind)).toEqual(expect.arrayContaining(["flat_defense", "outgoing_damage"])),
        ember_spit: () => expect(after.health).toBeLessThan(before.health),
        tail_lash: () => expect(after.health).toBeLessThan(before.health),
        hug: () => { expect(after.health).toBeLessThan(before.health); expect(owner.currentHealth).toBeGreaterThan(50); },
        latch: () => expect(effects).toContain("movement_slow"),
        mend: () => { expect(owner.currentHealth).toBeGreaterThan(50); expect(petEntity.currentHealth).toBeGreaterThan(Math.round(petEntity.maxHealth / 2)); },
        mischief: () => expect(effects).toContain("gloom")
      };
      expectations[abilityId]();
      await expect(runtime.useAbility("p1", "pet-1", abilityId, 10_500)).rejects.toThrow(/ready in/u);
      void engine;
    });
  }
});

describe("drag-to-place Stay", () => {
  const petPosition = (internals: Internal) => [...internals.entries()].find(([id]) => id.startsWith("pet-companion:"))![1].position;
  const metres = (a: LatLon, b: LatLon) => Math.hypot((a.lat - b.lat) * 111_000, (a.lon - b.lon) * 111_000 * Math.cos(origin.lat * Math.PI / 180));

  it("walks to the spot at the normal speed and stays there until Follow", () => {
    const { runtime, internals } = setup("thicket_wolf");
    const spot = destinationPoint(origin, 400, 200);
    expect(runtime.placeStay("p1", "pet-1", spot, 10_000)).toEqual(spot);
    expect(runtime.stayAt("p1")).toEqual(spot);
    let previous = { ...petPosition(internals) };
    let maxStepM = 0;
    for (let tick = 1; tick <= 300; tick += 1) {
      runtime.update("p1", 10_000 + tick * 50);
      maxStepM = Math.max(maxStepM, metres(previous, petPosition(internals)));
      previous = { ...petPosition(internals) };
    }
    // 40 m/s at 50 ms steps: 2 m per step, never a jump; arrives in ~10 s and holds.
    expect(maxStepM).toBeLessThanOrEqual(2.05);
    expect(metres(petPosition(internals), spot)).toBeLessThan(0.6);
    // The owner walking away does not pull a staying pet.
    const ownerInternal = internals.get("p1")!;
    ownerInternal.position = destinationPoint(origin, 300, 0);
    for (let tick = 1; tick <= 40; tick += 1) runtime.update("p1", 30_000 + tick * 50);
    expect(metres(petPosition(internals), spot)).toBeLessThan(0.6);
    expect(runtime.command("p1", "pet-1", "follow", 40_000)).toBe(true);
    expect(runtime.stayAt("p1")).toBeNull();
  });

  it("refuses spots beyond 1 km, unwalkable spots and a pet that is not out", () => {
    const { runtime } = setup("thicket_wolf");
    expect(() => runtime.placeStay("p1", "pet-1", destinationPoint(origin, 1_050, 0), 10_000)).toThrow(/within 1 km/u);
    expect(() => runtime.placeStay("p1", "pet-2", destinationPoint(origin, 100, 0), 10_000)).toThrow(/not out/u);
    const water = destinationPoint(origin, 500, 0);
    const blocked = setup("thicket_wolf", false, [], (position) => position.lat < water.lat - 0.001);
    expect(() => blocked.runtime.placeStay("p1", "pet-1", water, 10_000)).toThrow(/can't reach/u);
    expect(blocked.runtime.stayAt("p1")).toBeNull();
    expect(blocked.runtime.placeStay("p1", "pet-1", destinationPoint(origin, 200, 0), 10_000)).toBeDefined();
  });

  it("does not walk a staying pet off to an out-of-reach ability target", async () => {
    const { engine, runtime } = setup("thornback_boar");
    const far = engine.spawnMob({ entityId: "mob:stay-far", archetype: "training_dummy", position: destinationPoint(origin, 110, 0), regionCode: "NM", zoneId: "world:NM" });
    runtime.placeStay("p1", "pet-1", destinationPoint(origin, 20, 180), 10_000);
    await expect(runtime.useAbility("p1", "pet-1", "bull_rush", 10_100, far.entityId)).rejects.toThrow(/Tap Follow first/u);
  });
});

describe("Tail Lash reach", () => {
  it("hits creatures up to 90 m from the drake and asks for an outdoor structure strike there", async () => {
    const { engine, runtime, internals } = setup("ember_drake");
    const near = engine.spawnMob({ entityId: "mob:swing-near", archetype: "training_dummy", position: destinationPoint(origin, 80, 90), regionCode: "NM", zoneId: "world:NM" });
    const far = engine.spawnMob({ entityId: "mob:swing-far", archetype: "training_dummy", position: destinationPoint(origin, 140, 90), regionCode: "NM", zoneId: "world:NM" });
    const nearBefore = internals.get(near.entityId)!.currentHealth;
    const farBefore = internals.get(far.entityId)!.currentHealth;
    const used = await runtime.useAbility("p1", "pet-1", "tail_lash", 10_000);
    expect(internals.get(near.entityId)!.currentHealth).toBeLessThan(nearBefore);
    expect(internals.get(far.entityId)!.currentHealth).toBe(farBefore);
    const pet = [...internals.entries()].find(([id]) => id.startsWith("pet-companion:"))![1];
    expect(used.structureStrike).toEqual({ origin: { lat: pet.position.lat, lon: pet.position.lon }, radiusM: 90 });
    const effect = engine.beginDeltaFlush().events.find((event) => event.type === "PET_ABILITY_EFFECT");
    expect(effect).toMatchObject({
      abilityId: "tail_lash", radiusM: 90, durationMs: 600,
      position: { lat: pet.position.lat, lon: pet.position.lon }
    });
    expect(effect!.sourceEntityId).toMatch(/^pet-companion:/u);
  });

  it("does not send the effect of a shadow-hidden pet to other players", () => {
    const { engine } = setup("thicket_wolf");
    engine.connectPlayer({
      playerId: "p2", name: "p2", regionCode: "NM", zoneId: "world:NM", position: destinationPoint(origin, 30, 180),
      accountId: "account-p2", connectionId: "connection-p2",
      profile: { playerId: "p2", maxHealth: 100, currentHealth: 100, baseAttackDamage: 10 }
    });
    engine.deltaForPlayer("p2", engine.beginDeltaFlush());
    engine.deltaForPlayer("p1", engine.beginDeltaFlush());
    engine.grantPetShadowHide("p1", 10_000);
    engine.emitPetAbilityEffect({ sourceEntityId: "pet-companion:pet-1", abilityId: "hold_fast", position: origin, durationMs: 300 });
    const frame = engine.beginDeltaFlush();
    const effectTypes = (playerId: string) => (engine.deltaForPlayer(playerId, frame)?.events ?? []).map((event) => event.type);
    expect(effectTypes("p1")).toContain("PET_ABILITY_EFFECT");
    expect(effectTypes("p2")).not.toContain("PET_ABILITY_EFFECT");
  });
});

describe("explicit pet ability targets", () => {
  it("sends the pet to an enemy picked in the target menu and strikes it", async () => {
    const { engine, runtime, internals } = setup("thornback_boar");
    const far = engine.spawnMob({ entityId: "mob:far", archetype: "training_dummy", position: destinationPoint(origin, 110, 0), regionCode: "NM", zoneId: "world:NM" });
    const before = internals.get(far.entityId)!.currentHealth;
    const used = await runtime.useAbility("p1", "pet-1", "bull_rush", 10_000, far.entityId);
    expect(used.pending).toBe(true);
    const petId = [...internals.keys()].find((id) => id.startsWith("pet-companion:"))!;
    // The pet runs over at its one constant speed (40 m/s here): never a jump.
    runtime.update("p1", 10_000);
    const farPosition = { ...internals.get(far.entityId)!.position };
    let previous = { ...internals.get(petId)!.position };
    let maxStepM = 0;
    for (let tick = 1; tick <= 50; tick += 1) {
      runtime.update("p1", 10_000 + tick * 100);
      const position = internals.get(petId)!.position;
      maxStepM = Math.max(maxStepM, Math.hypot((position.lat - previous.lat) * 111_000, (position.lon - previous.lon) * 111_000 * Math.cos(origin.lat * Math.PI / 180)));
      previous = { ...position };
    }
    expect(maxStepM).toBeLessThanOrEqual(4.1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(internals.get(far.entityId)!.currentHealth).toBeLessThan(before);
    expect(Math.abs(previous.lat - farPosition.lat) * 111_000).toBeLessThan(10);
  });

  it("refuses players the owner may not attack, and mob-only abilities on players", async () => {
    const { engine, runtime } = setup("brood_spinner", true);
    engine.connectPlayer({
      playerId: "p2", name: "p2", regionCode: "NM", zoneId: "world:NM", position: destinationPoint(origin, 20, 180),
      accountId: "account-p2", connectionId: "connection-p2",
      profile: { playerId: "p2", maxHealth: 100, currentHealth: 100, baseAttackDamage: 10 }
    });
    expect(engine.canOwnerHarmPlayer("p1", "p2")).toBe(false);
    await expect(runtime.useAbility("p1", "pet-1", "web_snare", 10_000, "p2")).rejects.toThrow(/can't reach that target/u);
    const wolf = setup("thicket_wolf");
    wolf.engine.connectPlayer({
      playerId: "p2", name: "p2", regionCode: "NM", zoneId: "world:NM", position: destinationPoint(origin, 20, 180),
      accountId: "account-p2", connectionId: "connection-p2",
      profile: { playerId: "p2", maxHealth: 100, currentHealth: 100, baseAttackDamage: 10 }
    });
    await expect(wolf.runtime.useAbility("p1", "pet-1", "hold_fast", 10_000, "p2")).rejects.toThrow(/can't reach that target/u);
  });

  it("lets player-hitting abilities land on an attackable player with the PvP hold cap", async () => {
    const { engine, runtime, internals } = setup("brood_spinner");
    engine.connectPlayer({
      playerId: "p2", name: "p2", regionCode: "NM", zoneId: "world:NM", position: destinationPoint(origin, 20, 180),
      accountId: "account-p2", connectionId: "connection-p2",
      profile: { playerId: "p2", maxHealth: 100, currentHealth: 100, baseAttackDamage: 10 }
    });
    await runtime.useAbility("p1", "pet-1", "web_snare", 10_000, "p2");
    for (let t = 10_000; t <= 13_000; t += 50) runtime.update("p1", t);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const root = internals.get("p2")!.classRuntime!.effects.find((effect) => effect.kind === "rooted")!;
    expect(root.endTick).toBeLessThanOrEqual(2 * 20 + 1);
  });

  it("refuses targets beyond reach of the owner", async () => {
    const { engine, runtime } = setup("thornback_boar");
    const distant = engine.spawnMob({ entityId: "mob:distant", archetype: "deer", position: destinationPoint(origin, 600, 0), regionCode: "NM", zoneId: "world:NM" });
    await expect(runtime.useAbility("p1", "pet-1", "bull_rush", 10_000, distant.entityId)).rejects.toThrow(/can't reach/u);
  });
});

describe("moving into range", () => {
  const farTarget = (engine: CombatEngine) => engine.spawnMob({
    entityId: "mob:dummy", archetype: "training_dummy", position: destinationPoint(origin, 140, 0), regionCode: "NM", zoneId: "world:NM"
  });
  const run = (runtime: PetCompanionRuntime, from: number, ms: number) => {
    for (let t = from; t <= from + ms; t += 50) runtime.update("p1", t);
  };

  it("walks into reach at normal speed, then fires and only then starts the cooldown", async () => {
    const deferred: Array<{ fired: boolean; notice: string }> = [];
    const { engine, runtime, internals } = setup("thornback_boar", false, deferred);
    const dummy = farTarget(engine);
    const before = internals.get(dummy.entityId)!.currentHealth;
    const result = await runtime.useAbility("p1", "pet-1", "bull_rush", 10_000, dummy.entityId);
    expect(result).toMatchObject({ pending: true, notice: expect.stringMatching(/moving into range/u) });
    expect(runtime.abilityReadyAt("p1").bull_rush).toBeUndefined();
    run(runtime, 10_000, 6_000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deferred).toEqual([expect.objectContaining({ fired: true })]);
    expect(internals.get(dummy.entityId)!.currentHealth).toBeLessThan(before);
    expect(runtime.abilityReadyAt("p1").bull_rush).toBeDefined();
  });

  it("cancels without a cooldown when told to Stay, when the target dies, or after 20 s", async () => {
    const deferred: Array<{ fired: boolean; notice: string }> = [];
    const { engine, runtime, internals } = setup("thornback_boar", false, deferred);
    const dummy = farTarget(engine);
    await runtime.useAbility("p1", "pet-1", "bull_rush", 10_000, dummy.entityId);
    runtime.command("p1", "pet-1", "stay", 10_100);
    expect(deferred.at(-1)).toMatchObject({ fired: false, notice: expect.stringMatching(/told to stay/u) });
    expect(runtime.abilityReadyAt("p1").bull_rush).toBeUndefined();

    runtime.command("p1", "pet-1", "follow", 10_200);
    await runtime.useAbility("p1", "pet-1", "bull_rush", 10_300, dummy.entityId);
    (internals.get(dummy.entityId) as unknown as { lifeState: string }).lifeState = "defeated";
    run(runtime, 10_300, 200);
    expect(deferred.at(-1)).toMatchObject({ fired: false, notice: expect.stringMatching(/target is gone/u) });
    expect(runtime.abilityReadyAt("p1").bull_rush).toBeUndefined();

    const blocked = setup("thornback_boar", false, deferred);
    const unreachable = farTarget(blocked.engine);
    blocked.engine.relocateCompanion = () => false;
    await blocked.runtime.useAbility("p1", "pet-1", "bull_rush", 10_000, unreachable.entityId);
    run(blocked.runtime, 10_000, 21_000);
    expect(deferred.at(-1)).toMatchObject({ fired: false, notice: expect.stringMatching(/couldn't reach/u) });
    expect(blocked.runtime.abilityReadyAt("p1").bull_rush).toBeUndefined();
  });
});

describe("Shadow Hide", () => {
  it("hides the wolf from other players with its owner and both reappear when the wolf acts", async () => {
    const { engine, runtime, internals } = setup("thicket_wolf");
    engine.connectPlayer({
      playerId: "p2", name: "p2", regionCode: "NM", zoneId: "world:NM", position: destinationPoint(origin, 30, 180),
      accountId: "account-p2", connectionId: "connection-p2",
      profile: { playerId: "p2", maxHealth: 100, currentHealth: 100, baseAttackDamage: 10 }
    });
    const petId = [...internals.keys()].find((id) => id.startsWith("pet-companion:"))!;
    const seen = (viewer: string) => engine.buildInterestFrame([viewer]).nearbyIdsByPlayer.get(viewer)!;
    expect(seen("p2").has(petId)).toBe(true);
    await runtime.useAbility("p1", "pet-1", "shadow_hide", 10_000);
    expect(seen("p2").has(petId)).toBe(false);
    expect(seen("p2").has("p1")).toBe(false);
    expect(seen("p1").has(petId)).toBe(true);
    await runtime.useAbility("p1", "pet-1", "hold_fast", 20_000);
    expect(seen("p2").has(petId)).toBe(true);
    expect(seen("p2").has("p1")).toBe(true);
  });
});

function setup(
  species: (typeof PET_SPECIES_IDS)[number],
  pvpBlocked = false,
  deferred: unknown[] = [],
  isMobPositionTraversable?: (position: LatLon) => boolean
) {
  const engine = new CombatEngine({
    tickRateHz: 20, playerMovementSpeedMps: 40, isPlayerAuthorityActive: () => true,
    isPvpBlocked: () => pvpBlocked,
    ...(isMobPositionTraversable ? { isMobPositionTraversable } : {})
  });
  engine.connectPlayer({
    playerId: "p1", name: "p1", regionCode: "NM", zoneId: "world:NM", position: origin,
    accountId: "account-p1", connectionId: "connection-p1",
    profile: { playerId: "p1", maxHealth: 100, currentHealth: 100, baseAttackDamage: 10 }
  });
  const mob = engine.spawnMob({ entityId: "mob:wolf", archetype: "wolf", position: destinationPoint(origin, 15, 90), regionCode: "NM", zoneId: "world:NM" });
  engine.startAttack({ attackerId: "p1", targetEntityId: mob.entityId, requestId: "target", accountId: "account-p1", connectionId: "connection-p1" });
  const runtime = new PetCompanionRuntime(engine, {
    playerBaseSpeedMps: 40,
    onDeferredAbility: (_owner, _pet, outcome) => { deferred.push(outcome); },
    findOpenLand: async (_owner, position) => ({ ...destinationPoint(position, 400, 0), distanceM: 400 })
  });
  const pet: ActivePet = {
    id: "pet-1", species, name: "Pet", effectiveLevel: 0,
    unlockedAbilities: [...PET_SPECIES_DEFINITIONS[species].abilities],
    baseMaxHealth: 100, health: 100, damage: 8, defense: 1, activeUntilMs: Number.MAX_SAFE_INTEGER
  };
  runtime.summon("p1", pet, 0);
  const internals = (engine as unknown as { entities: Internal }).entities;
  const petEntity = [...internals.entries()].find(([id]) => id.startsWith("pet-companion:"))![1];
  petEntity.position = destinationPoint(origin, 12, 90);
  engine.relocateCompanion([...internals.keys()].find((id) => id.startsWith("pet-companion:"))!, petEntity.position,
    { regionCode: "NM", zoneId: "world:NM" });
  return { engine, runtime, internals, mobId: mob.entityId };
}

function snapshot(internals: Internal, mobId: string) {
  const mob = internals.get(mobId)!;
  const start = destinationPoint(origin, 15, 90);
  const dLat = (mob.position.lat - start.lat) * 111_000;
  const dLon = (mob.position.lon - start.lon) * 111_000 * Math.cos(origin.lat * Math.PI / 180);
  return { health: mob.currentHealth, distanceFromStart: Math.hypot(dLat, dLon) };
}
