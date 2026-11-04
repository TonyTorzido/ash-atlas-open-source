import { DUNGEON_CATALOG, dungeonRewardRollSeed, resolveDungeonChestLoot } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { createDungeonHandler, type DungeonHandlerContext } from "../realtime/handlers/dungeonHandler.js";
import { CisternWarrensRuntime } from "./dungeon.js";
import { dungeonRewardAnnouncement, dungeonRewardSnapshot } from "./dungeonRewards.js";

/** Opens the Fangrock den chest through the real realtime handler and dungeon runtime. */
async function openChestHarness(options: Readonly<{ structureId?: string; spaceId?: string; position?: { x: number; y: number }; objectId?: string }> = {}) {
  const structureId = options.structureId ?? "sewer-1";
  const dungeon = DUNGEON_CATALOG.dungeons.find((candidate) => candidate.id === "fangrock_cavern")!;
  const queries = vi.fn(async (sql: string) => {
    if (sql.startsWith("SELECT") && sql.includes("FROM cistern_warrens_presence WHERE player_id=$1")) {
      return { rows: [{ sewer_structure_id: structureId, session_id: "session-1", local_x: 67.2, local_y: 57.6,
        return_region_code: "world", return_lat: 35, return_lon: -106 }], rowCount: 1 };
    }
    if (sql.includes("FROM city_structures structure")) {
      return { rows: [{ structure_id: structureId, city_id: "city-1", city_name: "T", region_code: "world",
        placement_revision: "1", lat: 35, lon: -106 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  const combat = { syncPlayer: vi.fn(), cancelCombat: vi.fn(), isPlayerReserved: vi.fn(() => false),
    entity: vi.fn(() => ({ targetEntityId: null, currentHealth: 100, maxHealth: 100 })),
    // Rolled fights may spawn elites, which read the spawned position and scale fresh stats.
    spawnMob: vi.fn((input: { position: { lat: number; lon: number } }) => ({ lat: input.position.lat, lon: input.position.lon })),
    scaleFreshMobStats: vi.fn(() => true), despawnMob: vi.fn(), generalSkillRank: vi.fn(() => 0), playerMovementMultiplier: vi.fn(() => 1) };
  // Stand-in for the durable reward service: one claim per (run, player, source), items and gold applied once.
  const wallet = { gold: 0 };
  const inventory = new Map<string, number>();
  const claims = new Set<string>();
  const sent: Array<{ playerId: string; message: any }> = [];
  let runtime: CisternWarrensRuntime;
  const grantReward = vi.fn(async (playerId: string | undefined, rewardTableId: string,
    context: { runId: string; rewardSourceId: string; requestId?: string }) => {
    const key = `${context.runId}:${playerId}:${context.rewardSourceId}`;
    const table = DUNGEON_CATALOG.rewardTables.find((candidate) => candidate.id === rewardTableId)!;
    const applied = !claims.has(key);
    claims.add(key);
    const loot = resolveDungeonChestLoot(table, dungeonRewardRollSeed(context.runId, context.rewardSourceId, table));
    if (applied) {
      wallet.gold += table.gold ?? 0;
      for (const item of loot.items) inventory.set(item.itemId, (inventory.get(item.itemId) ?? 0) + item.quantity);
    }
    const result = { applied, items: applied ? loot.items : [], gold: applied ? table.gold ?? 0 : 0 };
    sent.push({ playerId: playerId!, message: { type: "DUNGEON_REWARD_GRANTED", ...result } });
    const inside = runtime.get(playerId!)!;
    sent.push({ playerId: playerId!, message: { type: "DUNGEON_SNAPSHOT",
      snapshot: dungeonRewardSnapshot(runtime, playerId!, inside.sessionId, result) } });
  });
  runtime = new CisternWarrensRuntime({ query: queries } as never, combat as never,
    { persistInteriorPosition: vi.fn() } as never, dungeon, { grantReward } as never, DUNGEON_CATALOG,
    { recordCompletion: vi.fn(), authorizeEntry: vi.fn() } as never);
  const snapshot = (await runtime.restore(
    { playerId: "player-1", username: "P", displayColor: null, movementRevision: 4, regionCode: "world",
      position: { lat: 35, lon: -106 } } as never,
    { sewerId: structureId, spaceId: options.spaceId ?? "raptor_den", position: options.position ?? { x: 150, y: 650 } } as never))!;
  const handler = createDungeonHandler({
    state: { playerId: "player-1", connectionId: "c1" }, authenticatedSession: null, gameState: {},
    registry: { send: (playerId: string, message: unknown) => sent.push({ playerId, message }) }, dungeon: runtime
  } as unknown as DungeonHandlerContext);
  const interact = (requestId: string) => handler({
    type: "DUNGEON_INTERACT", requestId, sessionId: snapshot.sessionId, objectId: options.objectId ?? "den_chest"
  } as never);
  return { interact, grantReward, wallet, inventory, sent, snapshot };
}

describe("dungeon chest open through the realtime handler", () => {
  it("grants the table's gold and items exactly once and tells the player what was inside", async () => {
    const harness = await openChestHarness();
    await harness.interact("open-1");
    await Promise.resolve();
    expect(harness.grantReward).toHaveBeenCalledTimes(1);
    const granted = new Map(harness.inventory);
    expect(harness.wallet.gold).toBe(55);
    expect(granted.size).toBeGreaterThan(0);
    const notices = JSON.stringify(harness.sent.map((entry) => entry.message));
    // A granted claim is shown by the client as a loot card, so there is no "You found" text notice.
    expect(notices).not.toContain("You found");
    expect(harness.sent.some((entry) => entry.message.type === "DUNGEON_REWARD_GRANTED" && entry.message.gold === 55)).toBe(true);
    // The claiming player's snapshot shows the chest as looted.
    const snapshots = harness.sent.map((entry) => entry.message).filter((message) => message.type === "DUNGEON_SNAPSHOT");
    const chestState = (snapshots.at(-1)?.snapshot.objects as Array<{ id: string; state: string }>).find((object) => object.id === "den_chest")?.state;
    expect(chestState).toBe("looted");
    // Opening again (new request) never pays twice and explains why nothing happened.
    await harness.interact("open-2");
    await Promise.resolve();
    expect(harness.grantReward).toHaveBeenCalledTimes(1);
    expect(harness.wallet.gold).toBe(55);
    expect(harness.inventory).toEqual(granted);
    expect(JSON.stringify(harness.sent.map((entry) => entry.message))).toContain("You have already looted this chest.");
    // Replaying the same request id is idempotent too.
    await harness.interact("open-1");
    expect(harness.wallet.gold).toBe(55);
  });
});

describe("random small chests", () => {
  const SMALL_CHEST = "fangrock-small-chest-den-se";
  const open = (structureId: string) => openChestHarness({
    structureId, spaceId: "raptor_den", position: { x: 890, y: 680 }, objectId: SMALL_CHEST });
  const present = (harness: Awaited<ReturnType<typeof open>>) =>
    harness.snapshot.objects.find((object) => object.id === SMALL_CHEST)?.available === true;

  it("is present in some runs and absent in others, the same way every time for one run", async () => {
    const outcomes = new Set<boolean>();
    for (let run = 0; run < 24; run += 1) {
      const first = present(await open(`run-${run}`));
      expect(present(await open(`run-${run}`))).toBe(first);
      outcomes.add(first);
    }
    expect(outcomes.size).toBe(2);
  });

  it("is claimed once per player through the shared reward path", async () => {
    let harness = await open("run-0");
    for (let run = 1; !present(harness) && run < 100; run += 1) harness = await open(`run-${run}`);
    expect(present(harness)).toBe(true);
    await harness.interact("small-1");
    await Promise.resolve();
    expect(harness.grantReward).toHaveBeenCalledTimes(1);
    expect(harness.grantReward.mock.calls[0]![1]).toBe("fangrock_cavern_baby_chest");
    expect(harness.wallet.gold).toBe(25);
    const granted = new Map(harness.inventory);
    expect(granted.size).toBeGreaterThan(0);
    await harness.interact("small-2");
    await harness.interact("small-1");
    await Promise.resolve();
    expect(harness.grantReward).toHaveBeenCalledTimes(1);
    expect(harness.wallet.gold).toBe(25);
    expect(harness.inventory).toEqual(granted);
    expect(JSON.stringify(harness.sent.map((entry) => entry.message))).toContain("You have already looted this chest.");
  });

  it("cannot be opened in a run where it did not spawn", async () => {
    let harness = await open("run-0");
    for (let run = 1; present(harness) && run < 100; run += 1) harness = await open(`run-${run}`);
    expect(present(harness)).toBe(false);
    await harness.interact("absent-1");
    expect(JSON.stringify(harness.sent.map((entry) => entry.message))).toContain("OBJECT_UNAVAILABLE");
    expect(harness.grantReward).not.toHaveBeenCalled();
  });
});

describe("dungeonRewardAnnouncement", () => {
  it("is silent for a granted claim (the loot card shows it) and explains replays and empty claims", () => {
    expect(dungeonRewardAnnouncement({ applied: true, gold: 400, items: [{ itemId: "coal", quantity: 8 }] })).toBeNull();
    expect(dungeonRewardAnnouncement({ applied: false, gold: 0, items: [] })).toBe("You have already claimed this reward.");
    expect(dungeonRewardAnnouncement({ applied: true, gold: 0, items: [] })).toBe("The chest is empty.");
  });
});
