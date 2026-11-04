import { describe, expect, it, vi } from "vitest";
import { moveToward, type LatLon, type MobArchetypeKey } from "@ash-atlas/shared";

import { CombatEngine } from "./combatEngine.js";
import { SENTINEL_STATUE, SLAG_TRAIL, SPARK_WISP_BURST } from "./golemForgeMobs.js";

const origin: LatLon = { lat: 35.0844, lon: -106.6504 };
const east = (m: number): LatLon => moveToward(origin, { lat: origin.lat, lon: origin.lon + 0.02 }, m);
const REGION = "interior:g";
const ZONE = "interior:g:room";

function createEngine(now?: () => number): CombatEngine {
  return new CombatEngine({
    tickRateHz: 20, playerMovementSpeedMps: 40,
    ...(now ? { now } : {}),
    isPlayerAuthorityActive: () => true, isSharedMobCombat: () => true,
    isMobPlayerAttackAuthorized: () => true, repositionPlayer: () => true
  });
}
function addPlayer(engine: CombatEngine, id = "p1", position: LatLon = origin, damage = 1): void {
  engine.connectPlayer({
    playerId: id, name: id, regionCode: REGION, zoneId: ZONE, position, accountId: `a-${id}`, connectionId: `c-${id}`,
    profile: { playerId: id, maxHealth: 1_000_000, currentHealth: 1_000_000, baseAttackDamage: damage }
  });
}
function spawn(engine: CombatEngine, archetype: MobArchetypeKey, id: string, position: LatLon) {
  return engine.spawnMob({ entityId: id, archetype, position, homePosition: position, regionCode: REGION, zoneId: ZONE, worldAi: false });
}
const run = (engine: CombatEngine, ticks: number) => { for (let tick = 0; tick < ticks; tick += 1) engine.tick(); };
const hit = (engine: CombatEngine, targetId: string) =>
  engine.startAttack({ attackerId: "p1", targetEntityId: targetId, requestId: `hit-${targetId}-${Math.random()}`, accountId: "a-p1", connectionId: "c-p1" });

describe("Golem Forge damage zones", () => {
  it("a slag crawler leaves a marked puddle behind it that burns a player standing in it", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawn(engine, "slag_crawler_gf", "mob", east(190));
    expect(engine.directMobTarget("mob", "p1")).toBe(true);
    const damage = vi.spyOn(engine, "applyScriptedDamage");
    let marked = false;
    for (let tick = 0; tick < 200 && !marked; tick += 1) {
      engine.tick();
      marked = (engine.entity("mob")?.telegraphs ?? []).some((cast) => cast.abilityId === SLAG_TRAIL.techniqueId);
    }
    expect(marked).toBe(true);
    // Zone damage hits the player where the puddle is: put a zone on them directly through the shared primitive.
    expect(engine.spawnDamageZone({
      ownerEntityId: "mob", center: origin, radiusM: 200, delayMs: 0, durationMs: 2_000, damage: 40,
      techniqueId: SLAG_TRAIL.techniqueId
    })).toBe(true);
    run(engine, 60);
    expect(damage).toHaveBeenCalledWith("mob", "p1", expect.any(Number), SLAG_TRAIL.techniqueId);
  });

  it("a spark wisp pops in a burst zone that outlives it", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, 100_000);
    spawn(engine, "spark_wisp_gf", "mob", east(60));
    const damage = vi.spyOn(engine, "applyScriptedDamage");
    hit(engine, "mob");
    run(engine, 40);
    expect(engine.entity("mob")).toBeNull();
    expect(engine.entity("p1")!.telegraphs?.some((cast) => cast.abilityId === SPARK_WISP_BURST.techniqueId)).toBe(true);
    run(engine, 60);
    expect(damage).toHaveBeenCalledWith("p1", "p1", expect.any(Number), SPARK_WISP_BURST.techniqueId);
  });
});

describe("Golem Forge gem immunity", () => {
  const raw = (engine: CombatEngine, id: string) =>
    (engine as unknown as { entities: Map<string, Record<string, any>> }).entities.get(id)!;
  const wield = (engine: CombatEngine, identity: string | null) => {
    raw(engine, "p1").equipmentCombatState = { activeWeaponEnchantmentIdentity: identity };
  };

  it("a geode golem shrugs off plain and gem-less metal weapons with Immune text, and dies to a gem weapon", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, 100_000);
    spawn(engine, "geode_golem_gf", "mob", east(60));
    const feedback = vi.spyOn(engine as unknown as { emitInnateEvent: (...args: unknown[]) => void }, "emitInnateEvent");
    const maxHealth = raw(engine, "mob").maxHealth;
    for (const identity of [null, "enh:v1:none:venomsteel"]) {
      wield(engine, identity);
      engine.applyScriptedDamage("p1", "mob", 100_000, "test_skill");
      expect(raw(engine, "mob").currentHealth).toBe(maxHealth);
    }
    expect(feedback).toHaveBeenCalledWith("mob", "mob", "IMMUNE", expect.any(String));
    wield(engine, "enh:v1:ruby:prepared");
    engine.applyScriptedDamage("p1", "mob", 100_000, "test_skill");
    run(engine, 5);
    expect(engine.entity("mob")).toBeNull();
  });
});

describe("Golem Forge sentinel statue", () => {
  it("sleeps untouchable and passive until a player comes within the wake radius, then fights and shows awake", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, 100_000);
    spawn(engine, "sentinel_statue_gf", "mob", east(SENTINEL_STATUE.wakeRadiusM + 200));
    const before = engine.entity("mob")!.currentHealth;
    run(engine, 200);
    expect(engine.entity("mob")!.targetEntityId).toBeNull();
    expect(engine.entity("mob")!.mobBuffs ?? []).toEqual([]);
    engine.applyScriptedDamage("p1", "mob", 100_000, "test_skill");
    expect(engine.entity("mob")!.currentHealth).toBe(before);
    // A second player walks up.
    addPlayer(engine, "p2", east(SENTINEL_STATUE.wakeRadiusM + 200 - 150), 1);
    run(engine, 5);
    expect(engine.entity("mob")!.mobBuffs?.some((buff) => buff.kind === "awake")).toBe(true);
    expect(engine.entity("mob")!.targetEntityId).not.toBeNull();
    engine.applyScriptedDamage("p1", "mob", 5, "test_skill");
    expect(engine.entity("mob")!.currentHealth).toBeLessThan(before);
  });
});

describe("Golem Forge roster behaviours", () => {
  const raw = (engine: CombatEngine, id: string) =>
    (engine as unknown as { entities: Map<string, Record<string, any>> }).entities.get(id)!;

  it("an iron golem warns with a slam circle, then damages and knocks back; the mender never slams", () => {
    // Strikes resolve on the engine clock, so drive it with a deterministic one (one tick = 50 ms).
    let clockMs = Date.now();
    const engine = createEngine(() => clockMs);
    const step = () => { clockMs += 50; engine.tick(); };
    addPlayer(engine);
    spawn(engine, "iron_golem_gf", "mob", east(60));
    spawn(engine, "mender_golem_gf", "mender", east(80));
    engine.directMobTarget("mob", "p1");
    engine.directMobTarget("mender", "p1");
    const damage = vi.spyOn(engine, "applyScriptedDamage");
    let cast;
    for (let tick = 0; tick < 400 && !cast; tick += 1) {
      step();
      cast = engine.entity("mob")?.telegraphs?.find((entry) => entry.abilityId === "iron_golem_gf_slam");
    }
    expect(cast?.geometry.kind).toBe("circle");
    for (let tick = 0; tick < 60; tick += 1) step();
    expect(damage).toHaveBeenCalledWith("mob", "p1", expect.any(Number), "ogre_ground_slam");
    expect(damage).not.toHaveBeenCalledWith("mender", "p1", expect.any(Number), "ogre_ground_slam");
  });

  it("a stone golem warns with a line before it charges", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawn(engine, "stone_golem_gf", "mob", east(190));
    engine.directMobTarget("mob", "p1");
    let cast;
    for (let tick = 0; tick < 400 && !cast; tick += 1) {
      engine.tick();
      cast = engine.entity("mob")?.telegraphs?.[0];
    }
    expect(cast?.geometry.kind).toBe("line");
  });

  it("a mender golem heals a hurt golem beside it on its pulse", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawn(engine, "iron_golem_gf", "golem", east(300));
    spawn(engine, "mender_golem_gf", "mender", east(340));
    raw(engine, "golem").currentHealth = 1;
    run(engine, 5);
    expect(raw(engine, "golem").currentHealth).toBeGreaterThan(1);
  });

  it("a spark wisp's hit also zaps up to two other nearby players", () => {
    const engine = createEngine();
    addPlayer(engine, "p1");
    for (const [id, m] of [["p2", 100], ["p3", 150], ["p4", 200]] as const) addPlayer(engine, id, east(m));
    spawn(engine, "spark_wisp_gf", "mob", east(60));
    engine.directMobTarget("mob", "p1");
    const damage = vi.spyOn(engine, "applyScriptedDamage");
    run(engine, 100);
    const zapped = new Set(damage.mock.calls.filter((call) => call[3] === "spark_wisp_chain").map((call) => call[1]));
    expect(zapped.size).toBe(2);
    expect(zapped.has("p1")).toBe(false);
  });

  it("a golem smith rebuilds a fresh golem after a 4 s channel, unless it is hit during it", () => {
    for (const interrupt of [false, true]) {
      const engine = createEngine();
      addPlayer(engine, "p1", origin, 100_000);
      spawn(engine, "golem_smith_gf", "smith", east(150));
      spawn(engine, "iron_golem_gf", "golem", east(200));
      engine.directMobTarget("smith", "p1");
      engine.applyScriptedDamage("p1", "golem", 1_000_000, "test_skill");
      run(engine, 5);
      expect(engine.entity("golem")).toBeNull();
      run(engine, 30);
      expect(engine.entity("smith")?.telegraphs?.some((entry) => entry.abilityId === "golem_smith_revive")).toBe(true);
      if (interrupt) engine.applyScriptedDamage("p1", "smith", 1, "test_skill");
      run(engine, 100);
      const golems = [...(engine as unknown as { entities: Map<string, Record<string, any>> }).entities.values()]
        .filter((entity) => entity.archetypeKey === "iron_golem_gf");
      expect(golems.length).toBe(interrupt ? 0 : 1);
    }
  });
});

describe("Golem Forge damage over time", () => {
  const raw = (engine: CombatEngine, id: string) =>
    (engine as unknown as { entities: Map<string, Record<string, any>> }).entities.get(id)!;
  const dot = (engine: CombatEngine, sourceId: string, targetId: string, amount: number, status: "burning" | "poison" | "storm" = "burning") =>
    (engine as unknown as { applyStatusDamage: (...args: unknown[]) => number })
      .applyStatusDamage(sourceId, raw(engine, targetId), amount, "status_test", status);
  const bossOwnership = {
    bossId: "corrupted_core", bossRevision: 1, encounterHandlerId: "corrupted_core", hostKind: "dungeon" as const,
    hostInstanceId: "i", encounterInstanceId: "e", appearanceId: "corrupted_core", lifeGeneration: 0
  };

  it("a burn from a non-gem weapon does nothing to a Geode Golem, a gem weapon burns it", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, 1);
    spawn(engine, "geode_golem_gf", "mob", east(60));
    const maxHealth = raw(engine, "mob").maxHealth;
    raw(engine, "p1").equipmentCombatState = { activeWeaponEnchantmentIdentity: null };
    expect(dot(engine, "p1", "mob", 50)).toBe(0);
    expect(raw(engine, "mob").currentHealth).toBe(maxHealth);
    raw(engine, "p1").equipmentCombatState = { activeWeaponEnchantmentIdentity: "enh:v1:ruby:prepared" };
    expect(dot(engine, "p1", "mob", 50)).toBeGreaterThan(0);
    expect(raw(engine, "mob").currentHealth).toBeLessThan(maxHealth);
  });

  it("a burn does nothing to a shielded Core, and a dormant statue", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, 1);
    spawn(engine, "geode_golem_gf", "core", east(60));
    raw(engine, "p1").equipmentCombatState = { activeWeaponEnchantmentIdentity: "enh:v1:ruby:prepared" };
    engine.setMobInvulnerable("core", true);
    const maxHealth = raw(engine, "core").maxHealth;
    expect(dot(engine, "p1", "core", 50)).toBe(0);
    expect(raw(engine, "core").currentHealth).toBe(maxHealth);
    engine.setMobInvulnerable("core", false);
    expect(dot(engine, "p1", "core", 50)).toBeGreaterThan(0);
    spawn(engine, "sentinel_statue_gf", "statue", east(SENTINEL_STATUE.wakeRadiusM + 400));
    expect(dot(engine, "p1", "statue", 50)).toBe(0);
  });

  it("damage over time reaches the boss damage listener, so floors and heals see it", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, 1);
    engine.spawnMob({
      entityId: "boss", archetype: "geode_golem_gf", position: east(60), homePosition: east(60), regionCode: REGION,
      zoneId: ZONE, worldAi: false, bossOwnership
    } as never);
    raw(engine, "p1").equipmentCombatState = { activeWeaponEnchantmentIdentity: "enh:v1:ruby:prepared" };
    const heard: number[] = [];
    engine.setBossDamageListener((_boss, amount) => { heard.push(amount); });
    const landed = dot(engine, "p1", "boss", 30);
    expect(landed).toBeGreaterThan(0);
    expect(heard).toEqual([landed]);
  });
});

describe("Golem Forge scripted spawns pay no rewards", () => {
  const raw = (engine: CombatEngine, id: string) =>
    (engine as unknown as { entities: Map<string, Record<string, any>> }).entities.get(id)!;
  function settlingEngine(): { engine: CombatEngine; settled: string[] } {
    const settled: string[] = [];
    const engine = new CombatEngine({
      tickRateHz: 20, playerMovementSpeedMps: 40,
      isPlayerAuthorityActive: () => true, isSharedMobCombat: () => true,
      isMobPlayerAttackAuthorized: () => true, repositionPlayer: () => true,
      onDefeatSettlementCandidate: (candidate: { defeatedEntityId: string }) => { settled.push(candidate.defeatedEntityId); return true; }
    } as never);
    return { engine, settled };
  }

  it("a killed scripted spawn (hammer, husk) settles no reward, an ordinary mob does", () => {
    const { engine, settled } = settlingEngine();
    addPlayer(engine);
    engine.spawnMob({
      entityId: "hammer", archetype: "iron_golem_gf", position: east(60), homePosition: east(60), regionCode: REGION,
      zoneId: ZONE, worldAi: false, summoned: true, noRewards: true
    });
    spawn(engine, "iron_golem_gf", "plain", east(80));
    engine.applyScriptedDamage("p1", "hammer", 1_000_000, "test_skill");
    engine.applyScriptedDamage("p1", "plain", 1_000_000, "test_skill");
    run(engine, 5);
    expect(engine.entity("hammer")).toBeNull();
    expect(settled).toEqual(["plain"]);
  });

  it("a rebuilt golem pays nothing and cannot be rebuilt again", () => {
    const { engine, settled } = settlingEngine();
    addPlayer(engine, "p1", origin, 100_000);
    spawn(engine, "golem_smith_gf", "smith", east(150));
    spawn(engine, "iron_golem_gf", "golem", east(200));
    engine.directMobTarget("smith", "p1");
    engine.applyScriptedDamage("p1", "golem", 1_000_000, "test_skill");
    run(engine, 140);
    const rebuilt = [...(engine as unknown as { entities: Map<string, Record<string, any>> }).entities.values()]
      .filter((entity) => entity.archetypeKey === "iron_golem_gf");
    expect(rebuilt.length).toBe(1);
    expect(settled).toEqual(["golem"]);
    engine.applyScriptedDamage("p1", rebuilt[0]!.entityId, 1_000_000, "test_skill");
    run(engine, 5);
    expect((engine as unknown as { golemRubble: unknown[] }).golemRubble).toEqual([]);
    run(engine, 150);
    expect([...(engine as unknown as { entities: Map<string, Record<string, any>> }).entities.values()]
      .filter((entity) => entity.archetypeKey === "iron_golem_gf").length).toBe(0);
    expect(settled).toEqual(["golem"]);
    expect(raw(engine, "smith")).toBeDefined();
  });
});

describe("Golem Forge damage zone cleanup", () => {
  it("clearDamageZones drops an owner's zones and telegraphs so nothing hits the next attempt", () => {
    const engine = createEngine();
    addPlayer(engine);
    spawn(engine, "iron_golem_gf", "boss", east(60));
    expect(engine.spawnDamageZone({
      ownerEntityId: "boss", center: origin, radiusM: 200, delayMs: 0, durationMs: 20_000, damage: 40, techniqueId: "test_pool"
    })).toBe(true);
    const damage = vi.spyOn(engine, "applyScriptedDamage");
    run(engine, 30);
    expect(damage).toHaveBeenCalled();
    expect(engine.clearDamageZones(["boss"])).toBe(1);
    damage.mockClear();
    run(engine, 60);
    expect(damage).not.toHaveBeenCalled();
    expect(engine.entity("boss")?.telegraphs?.some((cast) => cast.abilityId === "test_pool") ?? false).toBe(false);
    expect(engine.clearDamageZones(["boss"])).toBe(0);
  });
});

describe("Golem Forge sentinel statue reset", () => {
  it("falls dormant again once it is home, has no target and nobody is near", () => {
    const engine = createEngine();
    addPlayer(engine, "p1", origin, 1);
    spawn(engine, "sentinel_statue_gf", "mob", east(SENTINEL_STATUE.wakeRadiusM - 50));
    run(engine, 5);
    const raw = (engine as unknown as { entities: Map<string, Record<string, any>> }).entities;
    expect(engine.entity("mob")!.mobBuffs?.some((buff) => buff.kind === "awake")).toBe(true);
    // The threat resets and the player leaves.
    engine.disconnectPlayer("p1");
    raw.get("mob")!.targetEntityId = null;
    run(engine, 5);
    expect(engine.entity("mob")!.mobBuffs?.some((buff) => buff.kind === "awake") ?? false).toBe(false);
  });
});
