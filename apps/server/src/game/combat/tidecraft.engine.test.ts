import { destinationPoint, distanceMeters, type LatLon } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { CombatEngine } from "./combatEngine.js";

const origin = { lat: 35.0844, lon: -106.6504 };
type Internal = Map<string, {
  currentHealth: number; maxHealth: number; position: LatLon; lifeState: string;
  classRuntime?: { effects: Array<{ kind: string; endTick: number }> } | null;
}>;

function setup(options: Readonly<{
  rank?: number;
  party?: boolean;
  pvpBlocked?: boolean;
  onTidewaterLost?: (playerId: string) => void;
}> = {}) {
  const positions = new Map<string, LatLon>();
  const repositionPlayer = vi.fn((playerId: string, target: LatLon) => {
    positions.set(playerId, target);
    return true;
  });
  const engine = new CombatEngine({
    tickRateHz: 20,
    playerMovementSpeedMps: 40,
    isPlayerAuthorityActive: () => true,
    tidecraftRank: (playerId) => (playerId === "p1" ? options.rank ?? 1 : 0),
    partyAuthority: { sameParty: () => options.party === true } as never,
    isPvpBlocked: () => options.pvpBlocked === true,
    repositionPlayer,
    ...(options.onTidewaterLost ? { onTidewaterLost: options.onTidewaterLost } : {})
  });
  for (const id of ["p1", "p2"]) {
    engine.connectPlayer({
      playerId: id, name: id, regionCode: "NM", zoneId: "world:NM",
      position: id === "p1" ? origin : destinationPoint(origin, 4, 0),
      accountId: `account-${id}`, connectionId: `connection-${id}`,
      profile: { playerId: id, maxHealth: 100, currentHealth: 100, baseAttackDamage: 10 }
    });
  }
  const spawn = (entityId: string, archetype: string, distanceM: number) =>
    engine.spawnMob({ entityId, archetype: archetype as never, position: destinationPoint(origin, distanceM, 90), regionCode: "NM", zoneId: "world:NM" }).entityId;
  const internals = (engine as unknown as { entities: Internal }).entities;
  return { engine, internals, spawn, repositionPlayer };
}

const effects = (internals: Internal, id: string) =>
  internals.get(id)!.classRuntime?.effects.map((effect) => effect.kind) ?? [];

describe("Tidecraft items on the combat engine", () => {
  it("Stillwater Orb roots everything hostile in reach for 15 s; heal block only when thrown at rank 2+", () => {
    const rankOne = setup({ rank: 1 });
    const near = rankOne.spawn("mob:near", "wolf", 3);
    const far = rankOne.spawn("mob:far", "wolf", 30);
    const boss = rankOne.spawn("mob:boss", "slime_miniboss", 2);
    const outcome = rankOne.engine.applyFieldConsumable("p1", "stillwater_orb", null);
    expect(outcome).toMatchObject({ itemId: "stillwater_orb", radiusM: 7 });
    expect(effects(rankOne.internals, near)).toContain("rooted");
    expect(effects(rankOne.internals, near)).not.toContain("gloom");
    expect(effects(rankOne.internals, far)).not.toContain("rooted");
    expect(effects(rankOne.internals, boss)).not.toContain("rooted");

    const rankTwo = setup({ rank: 2 });
    const wolf = rankTwo.spawn("mob:wolf", "wolf", 3);
    rankTwo.engine.applyFieldConsumable("p1", "stillwater_orb", null);
    expect(effects(rankTwo.internals, wolf)).toEqual(expect.arrayContaining(["rooted", "gloom"]));
    const root = rankTwo.internals.get(wolf)!.classRuntime!.effects.find((effect) => effect.kind === "rooted")!;
    expect(root.endTick).toBe(13 * 20);
  });

  it("Stillwater Orb holds a PvP-valid player in place and spares a shielded one", () => {
    const open = setup({ rank: 2 });
    open.engine.applyFieldConsumable("p1", "stillwater_orb", "p2");
    expect(effects(open.internals, "p2")).toEqual(expect.arrayContaining(["rooted", "immobilized", "gloom"]));
    expect(open.engine.isPlayerImmobilized("p2")).toBe(true);
    expect(effects(open.internals, "p1")).not.toContain("rooted");

    const shielded = setup({ rank: 2, pvpBlocked: true });
    shielded.engine.applyFieldConsumable("p1", "stillwater_orb", "p2");
    expect(effects(shielded.internals, "p2")).toEqual([]);
    expect(shielded.engine.checkFieldConsumable("p1", "stillwater_orb", "mob:none")?.code).toBe("STILLWATER_ORB_TARGET_INVALID");
  });

  it("Free-Step Ward stops roots, nets and traps inside it; at rank 3 it shields only allies", () => {
    const open = setup({ rank: 2 });
    const wolf = open.spawn("mob:wolf", "wolf", 3);
    expect(open.engine.applyFieldConsumable("p1", "free_step_ward", null)).toMatchObject({ radiusM: 500 });
    expect(open.engine.checkFieldConsumable("p1", "free_step_ward", null)?.code).toBe("FREE_STEP_WARD_ALREADY_SET");
    open.engine.applyFieldConsumable("p1", "field_net", wolf);
    expect(effects(open.internals, wolf)).not.toContain("rooted");
    open.engine.applyFieldConsumable("p1", "stillwater_orb", "p2");
    expect(effects(open.internals, "p2")).not.toContain("rooted");
    expect(effects(open.internals, "p2")).not.toContain("immobilized");
    // The ward stops holds, not the heal block of a rank 2 orb.
    expect(effects(open.internals, "p2")).toContain("gloom");

    const alliesOnly = setup({ rank: 3 });
    const target = alliesOnly.spawn("mob:wolf", "wolf", 3);
    alliesOnly.engine.applyFieldConsumable("p1", "free_step_ward", null, { allyPlayerIds: [] });
    alliesOnly.engine.applyFieldConsumable("p1", "field_net", target);
    expect(effects(alliesOnly.internals, target)).toContain("rooted");
    alliesOnly.engine.applyFieldConsumable("p1", "stillwater_orb", "p2");
    expect(effects(alliesOnly.internals, "p2")).toContain("rooted");

    const kingdomAlly = setup({ rank: 3 });
    kingdomAlly.engine.applyFieldConsumable("p1", "free_step_ward", null, { allyPlayerIds: ["p2"] });
    // p2 throws at nothing; a mob root aimed at the ally inside the ward is refused.
    const internalsP2 = kingdomAlly.internals.get("p2")!;
    expect(kingdomAlly.engine.isFreeStepProtected(internalsP2 as never)).toBe(true);
  });

  it("Undertow Snare pulls creatures and players toward it for 5 minutes, and spares allies at rank 3", () => {
    const open = setup({ rank: 1 });
    const wolf = open.spawn("mob:wolf", "wolf", 15);
    open.internals.get("p2")!.position = destinationPoint(origin, 12, 0);
    expect(open.engine.applyFieldConsumable("p1", "undertow_snare", null)).toMatchObject({ radiusM: 28 });
    expect(open.engine.checkFieldConsumable("p1", "undertow_snare", null)?.code).toBe("UNDERTOW_SNARE_ALREADY_SET");
    open.engine.beginTick();
    expect(distanceMeters(open.internals.get(wolf)!.position, origin)).toBeLessThan(15);
    expect(open.repositionPlayer).toHaveBeenCalledWith("p2", expect.anything(), expect.any(Number), true);
    expect(distanceMeters(open.internals.get("p2")!.position, origin)).toBeLessThan(12);

    const spared = setup({ rank: 3, party: true });
    spared.internals.get("p2")!.position = destinationPoint(origin, 12, 0);
    const mob = spared.spawn("mob:wolf", "wolf", 15);
    spared.engine.applyFieldConsumable("p1", "undertow_snare", null, { allyPlayerIds: [] });
    spared.engine.beginTick();
    expect(spared.repositionPlayer).not.toHaveBeenCalled();
    expect(distanceMeters(spared.internals.get(mob)!.position, origin)).toBeLessThan(15);

    // A Free-Step Ward protects from the pull too.
    const warded = setup({ rank: 1 });
    warded.internals.get("p2")!.position = destinationPoint(origin, 12, 0);
    (warded.engine as unknown as { freeStepWards: Map<string, unknown> }).freeStepWards.set("p2", {
      position: origin, zoneId: "world:NM", expiresAtMs: Date.now() + 60_000, alliesOnly: false,
      allyPlayerIds: new Set(), nextPullAtMs: 0
    });
    warded.engine.applyFieldConsumable("p1", "undertow_snare", null);
    warded.engine.beginTick();
    expect(warded.repositionPlayer).not.toHaveBeenCalled();
  });

  it("Tidewater Draught is staged from the buff and lost on death", () => {
    const lost = vi.fn();
    const { engine, internals } = setup({ onTidewaterLost: lost });
    engine.stageFieldBuffs("p1", [{ buffId: "tidewater", startedAt: Date.now(), endsAt: Date.now() + 60_000 }]);
    expect(engine.hasTidewaterDraught("p1")).toBe(true);
    engine.beginTick();
    expect(lost).not.toHaveBeenCalled();
    internals.get("p1")!.lifeState = "defeated";
    engine.beginTick();
    expect(lost).toHaveBeenCalledWith("p1");
    expect(engine.hasTidewaterDraught("p1")).toBe(false);
  });

  it("+2 Defense from rank 1 and +2 Attack from rank 2 against Tide Wraiths and Drowned Citizens only", () => {
    const bonus = (rank: number, archetype: string, stat: "attack" | "defense") => {
      const { engine, internals, spawn } = setup({ rank });
      const mob = spawn(`mob:${archetype}`, archetype, 10);
      return (engine as unknown as {
        tidecraftMatchupBonus(player: unknown, target: unknown, kind: string): number;
      }).tidecraftMatchupBonus(internals.get("p1"), internals.get(mob), stat);
    };
    expect(bonus(1, "tide_wraith", "defense")).toBe(2);
    expect(bonus(1, "tide_wraith", "attack")).toBe(0);
    expect(bonus(2, "drowned_citizen", "attack")).toBe(2);
    expect(bonus(3, "tide_wraith", "defense")).toBe(3);
    expect(bonus(3, "wolf", "attack")).toBe(0);
    expect(bonus(0, "tide_wraith", "defense")).toBe(0);
  });
});
