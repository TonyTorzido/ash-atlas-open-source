import { describe, expect, it } from "vitest";

import {
  DEFAULT_HEAL_TARGET_SETTINGS,
  HOLY_ARC_SHOT_PROFILE,
  HOLY_ARC_XP_CREDIT_WINDOW_MS,
  destinationPoint,
  emptyEquipmentSlots,
  holyArcHealAmount,
  requireEquipmentDefinition,
  resolveEquipmentCombatStats,
  type ActiveEquipmentLoadout,
  type EquipmentDefinitionId,
  type HealTargetSettings,
  type LatLon
} from "@ash-atlas/shared";
import {
  CombatEngine,
  type CombatDefeatSettlementCandidate as EngineSettlementCandidate,
  type HolyArcPlayerRelations,
  type PlayerEquipmentCombatState,
  type SwingResolution
} from "./combatEngine.js";

const origin = { lat: 35.0844, lon: -106.6504 };
const EAST = { dirX: 1, dirY: 0 };

type Internals = {
  entities: Map<string, { currentHealth: number; maxHealth: number; position: LatLon }>;
  currentTick: number;
};
const internals = (engine: CombatEngine) => engine as unknown as Internals;
const at = (distanceM: number, bearing = 90): LatLon => destinationPoint(origin, distanceM, bearing);

type Setup = {
  clericArc?: boolean;
  party?: readonly string[];
  fighting?: (a: string, b: string) => boolean;
  candidates?: EngineSettlementCandidate[];
};

function createEngine(setup: Setup = {}): { engine: CombatEngine; advanceMs(ms: number): void } {
  let clock = 1_000_000;
  const party = setup.party ?? [];
  const engine = new CombatEngine({
    tickRateHz: 20,
    playerMovementSpeedMps: 40,
    isPlayerAuthorityActive: () => true,
    actionCombatEnabled: () => true,
    mobAiEnabled: () => false,
    clericArcEnabled: () => setup.clericArc ?? true,
    now: () => clock,
    partyAuthority: {
      partyForPlayer: (playerId: string) => party.includes(playerId)
        ? { partyId: "party", leaderPlayerId: party[0]!, memberPlayerIds: [...party], allowTravel: true, autoFollowPlayerIds: [], revision: 1 }
        : null,
      sameParty: (left: string, right: string) => party.includes(left) && party.includes(right)
    } as never,
    ...(setup.fighting ? { pvpIsFighting: setup.fighting } : {}),
    ...(setup.candidates ? { onDefeatSettlementCandidate: (candidate: EngineSettlementCandidate) => { setup.candidates!.push(candidate); } } : {})
  });
  const tick = engine.tick.bind(engine);
  engine.tick = () => {
    clock += 50;
    tick();
  };
  return { engine, advanceMs: (ms) => { clock += ms; } };
}

function addPlayer(engine: CombatEngine, playerId: string, position: LatLon = origin, currentHealth = 100): void {
  engine.connectPlayer({
    playerId,
    name: playerId,
    regionCode: "NM",
    zoneId: "world:NM",
    position,
    accountId: `account-${playerId}`,
    connectionId: `connection-${playerId}`,
    profile: { playerId, maxHealth: 100, currentHealth, baseAttackDamage: 10 }
  });
}

function equipWeapon(engine: CombatEngine, playerId: string, definitionId: EquipmentDefinitionId): void {
  const weapon = requireEquipmentDefinition(definitionId);
  const slot = weapon.category === "ranged_weapon" ? "secondary" as const : "melee" as const;
  const loadout: ActiveEquipmentLoadout = { active: emptyEquipmentSlots(null), readiedWeaponSlot: slot };
  const instanceId = `weapon-${definitionId}`;
  loadout.active[slot] = { instanceId, definition: weapon, itemLevel: 0 };
  const stats = resolveEquipmentCombatStats({
    context: "pvp_open_world", characterLevel: 25, classId: "warrior", classRank: 0, loadout
  });
  const empty = { instanceId: null, definitionId: null, category: null, enchantmentIdentity: null };
  const filled = { instanceId, definitionId: weapon.definitionId, category: weapon.weaponCategory, enchantmentIdentity: null };
  const state: PlayerEquipmentCombatState = {
    activeKitIndex: 1,
    inventoryRevision: 1,
    activeRevision: 1,
    stats,
    weaponCategory: weapon.weaponCategory,
    chestArmorCategory: null,
    chestDefinitionId: null,
    heavyArmorPieces: 0,
    hasShield: false,
    activeWeaponInstanceId: instanceId,
    activeWeaponEnchantmentIdentity: null,
    armorEnchantmentIdentities: { head: null, chest: null, gloves: null, boots: null },
    weaponSlots: { melee: slot === "melee" ? filled : empty, secondary: slot === "secondary" ? filled : empty },
    activeWeaponSlot: slot,
    switchPolicy: "melee_priority",
    switchingToSlot: null,
    switchStartedAtTick: null,
    switchCompletesAtTick: null
  };
  expect(engine.syncPlayerEquipmentCombatState(playerId, state)).not.toBeNull();
}

function relations(input: Partial<Omit<HolyArcPlayerRelations, "settings">> & { settings?: Partial<HealTargetSettings> } = {}): HolyArcPlayerRelations {
  return {
    kingdomId: input.kingdomId ?? null,
    cityId: input.cityId ?? null,
    friendIds: input.friendIds ?? new Set(),
    enemyKingdomIds: input.enemyKingdomIds ?? new Set(),
    enemyCityIds: input.enemyCityIds ?? new Set(),
    settings: { ...DEFAULT_HEAL_TARGET_SETTINGS, ...input.settings }
  };
}

let nextSeq = 1;
function cast(engine: CombatEngine, playerId = "cleric", lagMs = 0): SwingResolution {
  return engine.resolveSwing(playerId, { seq: nextSeq++, ...EAST, lagMs });
}

const health = (engine: CombatEngine, id: string) => internals(engine).entities.get(id)!.currentHealth;
const HEAL = holyArcHealAmount(10);

/** A Cleric at the origin aiming east with a scepter, plus the given injured players. */
function clericWith(players: Array<[string, number]>, setup: Setup = {}) {
  const made = createEngine(setup);
  addPlayer(made.engine, "cleric", origin, 50);
  equipWeapon(made.engine, "cleric", "training_scepter");
  for (const [id, distanceM] of players) addPlayer(made.engine, id, at(distanceM), 50);
  return made;
}

describe("CombatEngine holy arc (scepter, CLERIC_ARC_ENABLED)", () => {
  it("heals each eligible ally on the line before the first enemy, damages that enemy, and stops there", () => {
    const { engine } = clericWith([["near", 60], ["mid", 100], ["behind-mob", 200]]);
    for (const id of ["near", "mid", "behind-mob"]) {
      engine.setHolyArcRelations(id, relations({ kingdomId: "k1" }));
    }
    engine.setHolyArcRelations("cleric", relations({ kingdomId: "k1" }));
    engine.spawnMob({ entityId: "wolf", archetype: "wolf", position: at(150), regionCode: "NM", zoneId: "world:NM" });
    engine.beginDeltaFlush();
    const result = cast(engine);
    expect(result.hits.map((hit) => hit.entityId)).toEqual(["wolf"]);
    expect(health(engine, "near")).toBe(50 + HEAL);
    expect(health(engine, "mid")).toBe(50 + HEAL);
    expect(health(engine, "behind-mob")).toBe(50);
    expect(health(engine, "cleric")).toBe(50);
    const events = engine.beginDeltaFlush().events;
    const heals = events.filter((event) => event.type === "HEAL");
    expect(heals.map((event) => [event.sourceEntityId, event.targetEntityId, event.amount, event.currentHealth])).toEqual([
      ["cleric", "near", HEAL, 50 + HEAL],
      ["cleric", "mid", HEAL, 50 + HEAL]
    ]);
    expect(events.find((event) => event.type === "SWING")).toMatchObject({ abilityId: "shot", targetEntityId: "wolf" });
  });

  it("heals along the full range when no enemy is on the line, never past it", () => {
    const { engine } = clericWith([["a", 40], ["b", 250], ["beyond", HOLY_ARC_SHOT_PROFILE.rangeM + 40]]);
    engine.setHolyArcRelations("cleric", relations({ friendIds: new Set(["a", "b", "beyond"]) }));
    engine.beginDeltaFlush();
    expect(cast(engine).hits).toEqual([]);
    expect([health(engine, "a"), health(engine, "b"), health(engine, "beyond")]).toEqual([50 + HEAL, 50 + HEAL, 50]);
    expect(engine.beginDeltaFlush().events.find((event) => event.type === "SWING"))
      .toMatchObject({ targetEntityId: null, radiusM: HOLY_ARC_SHOT_PROFILE.rangeM });
  });

  it("never heals the caster, even standing on the line", () => {
    const { engine } = clericWith([]);
    engine.setHolyArcRelations("cleric", relations({ settings: { neutral: true } }));
    cast(engine);
    expect(health(engine, "cleric")).toBe(50);
  });

  it("follows each heal-target checkbox (party, friends, kingdom, city, neutral)", () => {
    const groups = {
      party: { party: ["cleric", "target"] },
      friends: { own: { friendIds: new Set(["target"]) } },
      kingdom: { own: { kingdomId: "k1" }, theirs: { kingdomId: "k1" } },
      city: { own: { cityId: "c1" }, theirs: { cityId: "c1" } },
      neutral: {}
    } as const satisfies Record<string, { party?: readonly string[]; own?: object; theirs?: object }>;
    for (const [group, shape] of Object.entries(groups) as Array<[keyof HealTargetSettings, { party?: readonly string[]; own?: object; theirs?: object }]>) {
      for (const ticked of [true, false]) {
        const { engine } = clericWith([["target", 80]], shape.party ? { party: shape.party } : {});
        const settings = { party: false, friends: false, kingdom: false, city: false, neutral: false, [group]: ticked };
        engine.setHolyArcRelations("cleric", relations({ ...(shape.own ?? {}), settings }));
        engine.setHolyArcRelations("target", relations({ ...(shape.theirs ?? {}) }));
        cast(engine);
        expect(health(engine, "target"), `${group} ${ticked ? "ticked" : "unticked"}`).toBe(ticked ? 50 + HEAL : 50);
      }
    }
  });

  it("defaults heal the party but not a neutral stranger", () => {
    const { engine } = clericWith([["member", 60], ["stranger", 120]], { party: ["cleric", "member"] });
    cast(engine);
    expect(health(engine, "member")).toBe(50 + HEAL);
    expect(health(engine, "stranger")).toBe(50);
  });

  it("never heals an enemy: a kingdom or city at war, or anyone fighting the caster or the caster's party", () => {
    const warKingdom = clericWith([["foe", 80]]);
    warKingdom.engine.setHolyArcRelations("cleric", relations({
      friendIds: new Set(["foe"]), enemyKingdomIds: new Set(["k2"]), settings: { neutral: true }
    }));
    warKingdom.engine.setHolyArcRelations("foe", relations({ kingdomId: "k2" }));
    cast(warKingdom.engine);
    expect(health(warKingdom.engine, "foe")).toBe(50);

    const warCity = clericWith([["foe", 80]]);
    warCity.engine.setHolyArcRelations("cleric", relations({ enemyCityIds: new Set(["c2"]), settings: { neutral: true } }));
    warCity.engine.setHolyArcRelations("foe", relations({ cityId: "c2" }));
    cast(warCity.engine);
    expect(health(warCity.engine, "foe")).toBe(50);

    const fightingMe = clericWith([["foe", 80]], { fighting: (a, b) => a === "cleric" && b === "foe" });
    fightingMe.engine.setHolyArcRelations("cleric", relations({ friendIds: new Set(["foe"]) }));
    cast(fightingMe.engine);
    expect(health(fightingMe.engine, "foe")).toBe(50);

    const fightingParty = clericWith([["foe", 80], ["mate", 300]], {
      party: ["cleric", "mate"], fighting: (a, b) => a === "mate" && b === "foe"
    });
    fightingParty.engine.setHolyArcRelations("cleric", relations({ settings: { neutral: true } }));
    cast(fightingParty.engine);
    expect(health(fightingParty.engine, "foe")).toBe(50);
  });

  it("with the flag off the scepter swings: no shot, no heal", () => {
    const { engine } = clericWith([["member", 60]], { clericArc: false, party: ["cleric", "member"] });
    engine.beginDeltaFlush();
    cast(engine);
    for (let index = 0; index < 20; index += 1) engine.tick();
    expect(health(engine, "member")).toBe(50);
    const swingEvent = engine.beginDeltaFlush().events.find((event) => event.type === "SWING");
    expect(swingEvent?.abilityId).not.toBe("shot");
  });

  it("rewinds allies by the lag hint, like mob targets", () => {
    const stepOff = (engine: CombatEngine) => {
      for (let index = 0; index < 4; index += 1) engine.tick();
      // The ally stood on the line, then stepped well off it (north) one tick ago.
      engine.syncPlayer({ playerId: "mover", position: destinationPoint(at(80), 60, 0), regionCode: "NM", zoneId: "world:NM" });
      engine.tick();
    };
    const now = clericWith([["mover", 80]], { party: ["cleric", "mover"] });
    stepOff(now.engine);
    cast(now.engine);
    expect(health(now.engine, "mover")).toBe(50);
    const lagged = clericWith([["mover", 80]], { party: ["cleric", "mover"] });
    stepOff(lagged.engine);
    // 150 ms of lag rewinds three ticks, to when the ally was still on the line.
    cast(lagged.engine, "cleric", 150);
    expect(health(lagged.engine, "mover")).toBe(50 + HEAL);
  });

  it("gives the Cleric kill credit on the mob a healed ally was fighting when it dies inside the window", () => {
    const candidates: EngineSettlementCandidate[] = [];
    const { engine } = clericWith([["fighter", 60]], { party: [], candidates });
    engine.setHolyArcRelations("cleric", relations({ friendIds: new Set(["fighter"]) }));
    engine.spawnMob({ entityId: "wolf", archetype: "wolf", position: at(60, 0), regionCode: "NM", zoneId: "world:NM" });
    // The fighter engages the wolf (north of the Cleric, off the arc's line).
    engine.resolveSwing("fighter", { seq: nextSeq++, dirX: -1, dirY: 1, lagMs: 0 });
    engine.startAttack({
      attackerId: "fighter", targetEntityId: "wolf", requestId: "r", accountId: "account-fighter", connectionId: "connection-fighter"
    });
    for (let index = 0; index < 5; index += 1) engine.tick();
    internals(engine).entities.get("fighter")!.currentHealth = 50;
    cast(engine);
    expect(health(engine, "fighter")).toBeGreaterThan(50);
    internals(engine).entities.get("wolf")!.currentHealth = 1;
    for (let index = 0; index < 60 && candidates.length === 0; index += 1) engine.tick();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.eligibleParticipantIds).toEqual(expect.arrayContaining(["fighter", "cleric"]));
  });

  it("drops the kill credit when the mob dies after the window", () => {
    const candidates: EngineSettlementCandidate[] = [];
    const { engine, advanceMs } = clericWith([["fighter", 60]], { candidates });
    engine.setHolyArcRelations("cleric", relations({ friendIds: new Set(["fighter"]) }));
    engine.spawnMob({ entityId: "wolf", archetype: "wolf", position: at(60, 0), regionCode: "NM", zoneId: "world:NM" });
    engine.resolveSwing("fighter", { seq: nextSeq++, dirX: -1, dirY: 1, lagMs: 0 });
    for (let index = 0; index < 5; index += 1) engine.tick();
    internals(engine).entities.get("fighter")!.currentHealth = 50;
    cast(engine);
    advanceMs(HOLY_ARC_XP_CREDIT_WINDOW_MS + 1_000);
    internals(engine).entities.get("wolf")!.currentHealth = 1;
    for (let index = 0; index < 30; index += 1) engine.tick();
    engine.resolveSwing("fighter", { seq: nextSeq++, dirX: -1, dirY: 1, lagMs: 0 });
    for (let index = 0; index < 60 && candidates.length === 0; index += 1) engine.tick();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.eligibleParticipantIds).not.toContain("cleric");
  });
});

describe("CombatEngine.healEntity (player heal floaters)", () => {
  it("heals a player and emits a HEAL event with the source, amount and new health", () => {
    const { engine } = createEngine();
    addPlayer(engine, "healer");
    addPlayer(engine, "hurt", at(20), 40);
    engine.beginDeltaFlush();
    expect(engine.healEntity("hurt", 25, "healer")).toBe(25);
    expect(health(engine, "hurt")).toBe(65);
    const heal = engine.beginDeltaFlush().events.find((event) => event.type === "HEAL");
    expect(heal).toMatchObject({ sourceEntityId: "healer", targetEntityId: "hurt", amount: 25, currentHealth: 65 });
  });

  it("caps at max health and sends no HEAL for a full-health player", () => {
    const { engine } = createEngine();
    addPlayer(engine, "hurt", origin, 95);
    engine.beginDeltaFlush();
    expect(engine.healEntity("hurt", 25, "healer")).toBe(5);
    expect(engine.healEntity("hurt", 25, "healer")).toBe(0);
    expect(engine.beginDeltaFlush().events.filter((event) => event.type === "HEAL").map((event) => event.amount)).toEqual([5]);
  });

  it("delivers the HEAL event to a nearby player's delta", () => {
    const { engine } = createEngine();
    addPlayer(engine, "healer");
    addPlayer(engine, "hurt", at(20), 40);
    engine.tick();
    engine.healEntity("hurt", 10, "healer");
    engine.tick();
    const frame = engine.beginDeltaFlush();
    const delta = engine.deltaForPlayer("hurt", frame);
    expect(delta?.events.some((event) => event.type === "HEAL" && event.targetEntityId === "hurt")).toBe(true);
  });
});
