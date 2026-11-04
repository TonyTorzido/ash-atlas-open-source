import { describe, expect, it } from "vitest";
import { destinationPoint, distanceMeters, type LatLon, type MobArchetypeKey } from "@ash-atlas/shared";

import { BossEncounter, DungeonBossHostAdapter, type BossRoomHooks } from "./bossFramework.js";
import { CORRUPTED_CORE, createCorruptedCoreController } from "./golemForgeBosses.js";

const origin: LatLon = { lat: 0.01, lon: 0.01 };
const ALCOVES = {
  husk_nw: destinationPoint(origin, 500, 315),
  husk_ne: destinationPoint(origin, 500, 45),
  husk_se: destinationPoint(origin, 500, 135),
  husk_sw: destinationPoint(origin, 500, 225)
} as const;

function coreHarness(options: { players?: Record<string, LatLon>; noHusks?: boolean } = {}) {
  const notices: string[] = [];
  const room: BossRoomHooks = {
    objectAvailable: () => true,
    objectState: () => "intact",
    setObjectAvailable: () => undefined,
    setObjectState: () => undefined,
    notify: (_player, text) => { notices.push(text); }
  };
  const players = new Map<string, LatLon>(Object.entries(options.players ?? { p1: destinationPoint(ALCOVES.husk_nw, 150, 135) }));
  const husks = new Map<string, { archetype: MobArchetypeKey; position: LatLon; possessed: boolean; spawnedAt: number }>();
  const state = {
    now: 1_000,
    ratio: 1,
    shielded: false,
    passive: false,
    bossAt: origin,
    spawnSequence: 0,
    zones: [] as { center: LatLon; radiusM: number; durationMs: number; at: number }[],
    strikes: [] as { playerId: string; damage: number }[],
    possessTargets: [] as (string | null)[]
  };
  const nearestPlayerId = (position: LatLon): string | null => {
    let best: string | null = null;
    for (const [id, at] of players) if (best === null || distanceMeters(position, at) < distanceMeters(position, players.get(best)!)) best = id;
    return best;
  };
  const encounter = new BossEncounter({
    encounterId: "enc",
    definition: { id: "corrupted_core", revision: 1, archetypeKey: "corrupted_core", controllerId: "corrupted_core", rewardPolicy: { id: "x", minimumContribution: 1 } },
    host: new DungeonBossHostAdapter({ instanceId: "i", runId: "r", roomId: "gf_containment", encounterId: "e", participantIds: [...players.keys()], room }),
    mobEntityId: "core",
    controller: createCorruptedCoreController({
      bossHealthRatio: () => state.ratio,
      bossPosition: () => state.bossAt,
      playerPosition: (id) => players.get(id) ?? null,
      anchorPosition: (_boss, anchorId) => (ALCOVES as Record<string, LatLon>)[anchorId] ?? null,
      spawnHusk: (_boss, archetype, position) => {
        if (options.noHusks) return null;
        const id = `h${++state.spawnSequence}`;
        husks.set(id, { archetype, position, possessed: false, spawnedAt: state.now });
        return id;
      },
      possessHusk: (id, target) => { husks.get(id)!.possessed = true; state.possessTargets.push(target); },
      setBossShielded: (_boss, shielded) => { state.shielded = shielded; },
      setBossPassive: (_boss, passive) => { state.passive = passive; },
      mobPosition: (id) => husks.get(id)?.position ?? null,
      moveBossTo: (_boss, position) => { state.bossAt = position; return true; },
      healBossToRatio: (_boss, ratio) => { state.ratio = Math.max(state.ratio, ratio); },
      isAlive: (id) => husks.has(id),
      despawn: (ids) => { for (const id of ids) husks.delete(id); },
      spawnDamageZone: (_boss, center, radiusM, _delay, durationMs) => { state.zones.push({ center, radiusM, durationMs, at: state.now }); },
      clearDamageZones: () => { state.zones.length = 0; },
      strikePlayer: (_boss, playerId, damage) => { state.strikes.push({ playerId, damage }); }
    }),
    initialState: "active",
    positionOfEntity: (id) => players.get(id) ?? null,
    now: () => state.now
  });
  const tick = (ms: number) => { state.now += ms; encounter.tick(state.now); };
  const tickFor = (ms: number, stepMs = 100) => { for (let elapsed = 0; elapsed < ms; elapsed += stepMs) tick(stepMs); };
  /** A player hit on the Core: nothing while shielded, doubled while exposed; reports the change to the controller. */
  const hitCore = (percent: number): void => {
    if (state.shielded) return;
    const multiplier = encounter.movementOverride?.incomingDamageMultiplier ?? 1;
    state.ratio = Math.max(0.01, state.ratio - percent / 100 * multiplier);
    encounter.notifyDamage(percent, "p1");
  };
  const killHusk = (index: number): void => {
    const id = [...husks.keys()][index]!;
    husks.delete(id);
  };
  /** The living husk the Core currently possesses. */
  const possessed = () => [...husks].filter(([, husk]) => husk.possessed);
  const phaseAfter = (ms: number) => { tickFor(ms); return encounter.phase; };
  return { encounter, state, husks, players, notices, tick, tickFor, hitCore, killHusk, possessed, phaseAfter };
}

/** Kills the possessed husk and runs the exposure to its end without hitting the Core. */
function killPossessedAndWait(h: ReturnType<typeof coreHarness>, windowMs: number): void {
  const [id] = h.possessed()[0]!;
  h.husks.delete(id);
  h.tickFor(windowMs + 200);
}

describe("The Corrupted Core: possession loop", () => {
  it("spawns four dormant husks in the alcoves (the fourth is the Gem Husk) and possesses the first at once", () => {
    const h = coreHarness();
    h.encounter.activate();
    expect(h.husks.size).toBe(4);
    const list = [...h.husks.values()];
    expect(list.map((husk) => husk.archetype)).toEqual(
      ["corrupted_husk_gf", "corrupted_husk_gf", "corrupted_husk_gf", "gem_husk_gf"]);
    expect(list.map((husk) => husk.position)).toEqual([ALCOVES.husk_nw, ALCOVES.husk_ne, ALCOVES.husk_se, ALCOVES.husk_sw]);
    expect(list.filter((husk) => husk.possessed)).toHaveLength(1);
    expect(list[0]!.possessed).toBe(true);
    expect(h.state.possessTargets).toEqual(["p1"]);
    expect(h.state.shielded).toBe(true);
    expect(h.state.passive).toBe(true);
    expect(h.encounter.phase).toBe("possessing_1");
    expect(h.encounter.movementOverride?.movementSpeedMultiplier).toBe(0);
  });

  it("throws the Core out at the dead husk's spot: unshielded, exposed, double damage, a 12 s window with a deadline", () => {
    const h = coreHarness();
    h.encounter.activate();
    h.hitCore(10);
    expect(h.state.ratio).toBe(1);
    h.killHusk(0);
    h.tick(100);
    expect(h.encounter.phase).toBe("exposed_1");
    expect(h.state.shielded).toBe(false);
    expect(h.state.bossAt).toEqual(ALCOVES.husk_nw);
    expect(h.encounter.phaseDeadlineAt).toBe(h.state.now + CORRUPTED_CORE.exposed.durationMs);
    h.hitCore(10);
    expect(h.state.ratio).toBeCloseTo(0.8, 5);
    // Not over yet just before 12 s, over just after.
    h.tickFor(CORRUPTED_CORE.exposed.durationMs - 1_000);
    expect(h.encounter.phase).toBe("exposed_1");
    h.tickFor(1_200);
    expect(h.encounter.phase).toBe("possessing_2");
    expect(h.state.shielded).toBe(true);
    expect(h.state.bossAt).toEqual(origin);
    expect(h.possessed().map(([, husk]) => husk.position)).toEqual([ALCOVES.husk_ne]);
  });

  it("spreads the husks over the health curve: the shell holds at 75, 50 and 25 percent, so husk 4 starts at 25% or less", () => {
    const h = coreHarness();
    h.encounter.activate();
    const ratios: number[] = [];
    for (let husk = 0; husk < 3; husk += 1) {
      const [id] = h.possessed()[0]!;
      h.husks.delete(id);
      h.tick(100);
      // A burst far bigger than the floor leaves: the shell holds and the window ends early.
      h.hitCore(100);
      h.tick(200);
      ratios.push(h.state.ratio);
      expect(h.encounter.phase).toBe(`possessing_${husk + 2}`);
    }
    expect(ratios[0]).toBeCloseTo(0.75, 5);
    expect(ratios[1]).toBeCloseTo(0.5, 5);
    expect(ratios[2]).toBeCloseTo(0.25, 5);
    expect([...h.husks.values()].find((husk) => husk.possessed)!.archetype).toBe("gem_husk_gf");
  });

  it("has no floor after husk 4: the Core can die in its last window", () => {
    const h = coreHarness();
    h.encounter.activate();
    for (let husk = 0; husk < 3; husk += 1) killPossessedAndWait(h, CORRUPTED_CORE.exposed.durationMs);
    h.state.ratio = 0.2;
    killPossessedAndWait(h, 0);
    expect(h.encounter.phase).toBe("exposed_4");
    h.hitCore(5);
    expect(h.state.ratio).toBeCloseTo(0.1, 5);
  });
});

describe("The Corrupted Core: no husks", () => {
  it("fails the encounter cleanly instead of idling when no husk can spawn", () => {
    const h = coreHarness({ noHusks: true });
    h.encounter.activate();
    expect(h.encounter.failureRequested).toBe("no_husks");
    expect(h.state.passive).toBe(false);
    expect(h.state.shielded).toBe(false);
  });
});

describe("The Corrupted Core: chain arc", () => {
  it("jumps to the nearest player within 80 m of the last one, never repeats a player, and hits harder each jump", () => {
    const husk = ALCOVES.husk_nw;
    const p1 = destinationPoint(husk, 150, 135);
    const p2 = destinationPoint(p1, 60, 90);
    const p3 = destinationPoint(p2, 70, 90);
    const p4 = destinationPoint(p3, 200, 90);
    // p5 is in range of p1 and p2 but closer to nobody once they are hit: it is the last link, after p3.
    const h = coreHarness({ players: { p1, p2, p3, p4 } });
    h.encounter.activate();
    h.tickFor(CORRUPTED_CORE.arc.firstDelayMs + CORRUPTED_CORE.arc.firstTelegraphMs + 3 * CORRUPTED_CORE.arc.jumpTelegraphMs + 600);
    expect(h.state.strikes.map((strike) => strike.playerId)).toEqual(["p1", "p2", "p3"]);
    const base = CORRUPTED_CORE.arc.damage;
    expect(h.state.strikes[0]!.damage).toBeCloseTo(base, 5);
    expect(h.state.strikes[1]!.damage).toBeCloseTo(base * 1.3, 5);
    expect(h.state.strikes[2]!.damage).toBeCloseTo(base * 1.6, 5);
  });

  it("does not jump past 80 m", () => {
    const p1 = destinationPoint(ALCOVES.husk_nw, 150, 135);
    const h = coreHarness({ players: { p1, p2: destinationPoint(p1, CORRUPTED_CORE.arc.chainRangeM + 20, 90) } });
    h.encounter.activate();
    h.tickFor(CORRUPTED_CORE.arc.firstDelayMs + CORRUPTED_CORE.arc.firstTelegraphMs + 1_500);
    expect(h.state.strikes.map((strike) => strike.playerId)).toEqual(["p1"]);
  });

  it("stops at the link cap even with a long line of players", () => {
    const players: Record<string, LatLon> = {};
    let at = destinationPoint(ALCOVES.husk_nw, 150, 135);
    for (let index = 1; index <= 9; index += 1) {
      players[`p${index}`] = at;
      at = destinationPoint(at, 60, 90);
    }
    const h = coreHarness({ players });
    h.encounter.activate();
    h.tickFor(CORRUPTED_CORE.arc.firstDelayMs + CORRUPTED_CORE.arc.firstTelegraphMs + 6 * CORRUPTED_CORE.arc.jumpTelegraphMs + 1_000);
    expect(h.state.strikes).toHaveLength(CORRUPTED_CORE.arc.maxLinks);
    expect(new Set(h.state.strikes.map((strike) => strike.playerId)).size).toBe(CORRUPTED_CORE.arc.maxLinks);
  });

  it("fizzles when the target leaves the telegraph ring, and fires again after 8 s", () => {
    const h = coreHarness();
    h.encounter.activate();
    h.tickFor(CORRUPTED_CORE.arc.firstDelayMs + 300);
    h.players.set("p1", destinationPoint(h.players.get("p1")!, CORRUPTED_CORE.arc.ringRadiusM + 80, 45));
    h.tickFor(CORRUPTED_CORE.arc.firstTelegraphMs + 200);
    expect(h.state.strikes).toHaveLength(0);
    h.tickFor(CORRUPTED_CORE.arc.intervalMs);
    expect(h.state.strikes.length).toBeGreaterThanOrEqual(1);
  });

  it("shows a ring on the target and a beam from the husk while telegraphing", () => {
    const h = coreHarness();
    h.encounter.activate();
    h.tickFor(CORRUPTED_CORE.arc.firstDelayMs + 300);
    const abilities = h.encounter.activeCasts.map((cast) => cast.abilityId).sort();
    expect(abilities).toEqual(["corrupted_core_arc_beam", "corrupted_core_arc_ring"]);
    const beam = h.encounter.activeCasts.find((cast) => cast.abilityId === "corrupted_core_arc_beam")!;
    expect(distanceMeters(beam.origin, ALCOVES.husk_nw)).toBeLessThan(1);
  });

  it("does not arc while the Core is exposed", () => {
    const h = coreHarness();
    h.encounter.activate();
    h.killHusk(0);
    h.tickFor(CORRUPTED_CORE.exposed.durationMs - 500);
    expect(h.encounter.activeCasts).toHaveLength(0);
    expect(h.state.strikes).toHaveLength(0);
  });
});

describe("The Corrupted Core: pools, enrage and reset", () => {
  it("leaves a 20 s corruption pool on the husk's spot", () => {
    const h = coreHarness();
    h.encounter.activate();
    h.killHusk(0);
    h.tick(100);
    expect(h.state.zones).toHaveLength(1);
    expect(h.state.zones[0]!.center).toEqual(ALCOVES.husk_nw);
    expect(h.state.zones[0]!.durationMs).toBe(20_000);
    h.tickFor(CORRUPTED_CORE.exposed.durationMs + 200);
    killPossessedAndWait(h, 0);
    expect(h.state.zones).toHaveLength(2);
    expect(h.state.zones[1]!.center).toEqual(ALCOVES.husk_ne);
  });

  it("reassembles the husks and enrages when all four are used and the Core lives", () => {
    const h = coreHarness();
    h.encounter.activate();
    for (let husk = 0; husk < 3; husk += 1) killPossessedAndWait(h, CORRUPTED_CORE.exposed.durationMs);
    killPossessedAndWait(h, 0);
    expect(h.encounter.phase).toBe("exposed_4");
    // The enraged window is shorter: not yet reassembled while the first (full) window runs.
    h.tickFor(CORRUPTED_CORE.exposed.durationMs + 200);
    expect(h.encounter.phase).toBe("enraged_possessing_1");
    expect(h.husks.size).toBe(4);
    const list = [...h.husks.values()];
    expect(list.map((husk) => husk.archetype)).toEqual(
      ["corrupted_husk_gf", "corrupted_husk_gf", "corrupted_husk_gf", "gem_husk_gf"]);
    expect(list.filter((husk) => husk.possessed)).toHaveLength(1);
    expect(list[0]!.possessed).toBe(true);
    expect(h.state.shielded).toBe(true);
    expect(h.notices.some((text) => /reassemble/i.test(text))).toBe(true);
    // Enraged loop: a shorter window and no health floor.
    h.killHusk(0);
    h.tick(100);
    expect(h.encounter.phase).toBe("enraged_exposed_1");
    expect(h.encounter.phaseDeadlineAt).toBe(h.state.now + CORRUPTED_CORE.enrage.exposedDurationMs);
    h.state.ratio = 0.2;
    h.hitCore(5);
    expect(h.state.ratio).toBeCloseTo(0.1, 5);
  });

  it("arcs faster once enraged", () => {
    const h = coreHarness();
    h.encounter.activate();
    for (let husk = 0; husk < 3; husk += 1) killPossessedAndWait(h, CORRUPTED_CORE.exposed.durationMs);
    killPossessedAndWait(h, CORRUPTED_CORE.exposed.durationMs);
    expect(h.encounter.phase).toBe("enraged_possessing_1");
    const before = h.state.strikes.length;
    // Window of enrage interval + telegraph: one strike lands, where the calm interval would not have fired yet.
    h.tickFor(CORRUPTED_CORE.enrage.arcIntervalMs + CORRUPTED_CORE.arc.firstTelegraphMs + 300);
    expect(h.state.strikes.length).toBeGreaterThan(before);
    expect(CORRUPTED_CORE.enrage.arcIntervalMs).toBeLessThan(CORRUPTED_CORE.arc.intervalMs);
  });

  it("restores everything on a wipe: husks gone, Core unshielded and back home, loop and arc state cleared", () => {
    const h = coreHarness();
    h.encounter.activate();
    h.killHusk(0);
    h.tick(100);
    expect(h.state.bossAt).toEqual(ALCOVES.husk_nw);
    expect(h.state.zones.length).toBeGreaterThan(0);
    h.encounter.reset();
    expect(h.state.zones).toHaveLength(0);
    expect(h.husks.size).toBe(0);
    expect(h.state.shielded).toBe(false);
    expect(h.state.passive).toBe(false);
    expect(h.state.bossAt).toEqual(origin);
    expect(h.encounter.movementOverride).toBeNull();
    // A fresh activation starts over from husk 1 with four fresh husks.
    h.encounter.activate();
    expect(h.husks.size).toBe(4);
    expect(h.encounter.phase).toBe("possessing_1");
    expect([...h.husks.values()].filter((husk) => husk.possessed)).toHaveLength(1);
  });
});
