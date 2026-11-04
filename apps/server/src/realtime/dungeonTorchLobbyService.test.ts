import type { DungeonTorchLobbySnapshot, ServerMessage } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { DungeonError, type DungeonTorchEntry } from "../game/dungeon.js";
import { DungeonTorchLobbyService } from "./dungeonTorchLobbyService.js";

const ENTRY: DungeonTorchEntry = {
  entranceId: "fangrock-entrance", dungeonId: "fangrock_cavern", dungeonName: "Fangrock Cavern",
  position: { lat: 35, lon: -106 }, interactionRadiusM: 8, instanceId: "dungeon:fangrock-entrance:party:party-1",
  partyId: "party-1", partyScoped: true,
  entryCost: [{ itemId: "refined_oil", quantity: 18 }, { itemId: "wood", quantity: 1 }], paid: false
};

function harness(options: { paid?: boolean; canAfford?: boolean } = {}) {
  const sent: Array<{ playerId: string; message: Extract<ServerMessage, { type: "DUNGEON_TORCH_LOBBY" }> }> = [];
  const parties = new Map<string, string>([["leader", "party-1"], ["ally", "party-1"], ["third", "party-1"]]);
  const startTorchRun = vi.fn(async (input: { members: ReadonlyArray<{ torches: number }> }) => ({
    runId: "run-1", instanceId: ENTRY.instanceId,
    torchTotal: input.members.reduce((sum, member) => sum + member.torches, 0), replayed: false
  }));
  const service = new DungeonTorchLobbyService({
    dungeon: {
      torchEntryFor: vi.fn(async () => ({ ...ENTRY, paid: options.paid ?? false })),
      startTorchRun: startTorchRun as never,
      authorizeEntryGates: vi.fn(async () => ({ entrance: null, dungeon: undefined }))
    },
    parties: {
      partyForPlayer: (playerId: string) => parties.has(playerId)
        ? { partyId: parties.get(playerId)!, leaderPlayerId: "leader" } as never
        : null
    },
    connections: { send: (playerId, message) => { sent.push({ playerId, message: message as never }); } },
    playerName: (playerId) => playerId.toUpperCase(),
    playerPosition: () => ({ lat: 35, lon: -106 }),
    canAfford: vi.fn(async () => options.canAfford ?? true)
  });
  const latest = (playerId: string): DungeonTorchLobbySnapshot | null | undefined =>
    sent.filter((entry) => entry.playerId === playerId).at(-1)?.message.lobby;
  return { service, sent, parties, startTorchRun, latest };
}

describe("dungeon torch lobby", () => {
  it("runs the ready check: everyone sees counts live, any change clears every ready state", async () => {
    const { service, latest, startTorchRun } = harness();
    await service.join("leader", ENTRY.entranceId, "j1");
    const lobbyId = latest("leader")!.lobbyId;
    await service.join("ally", ENTRY.entranceId, "j2");
    expect(latest("leader")).toMatchObject({ totalTorches: 1, members: [
      { playerId: "leader", name: "LEADER", torches: 1, ready: false }, { playerId: "ally", torches: 0, ready: false }
    ] });
    await service.setTorches("ally", lobbyId, 2, "t1");
    expect(latest("leader")).toMatchObject({ totalTorches: 3, members: [{ torches: 1 }, { torches: 2 }] });
    service.setReady("ally", lobbyId, true, "r1");
    expect(latest("leader")!.members[1]!.ready).toBe(true);
    // The leader changes their count: the ally's ready clears.
    await service.setTorches("leader", lobbyId, 2, "t2");
    expect(latest("ally")!.members.every((member) => !member.ready)).toBe(true);
    // An unready member blocks the start.
    await expect(service.start("leader", lobbyId, "s0")).rejects.toMatchObject({ code: "TORCH_LOBBY_NOT_READY" });
    expect(startTorchRun).not.toHaveBeenCalled();
    service.setReady("ally", lobbyId, true, "r2");
    await expect(service.start("ally", lobbyId, "s1")).rejects.toMatchObject({ code: "TORCH_LOBBY_NOT_LEADER" });
    await service.start("leader", lobbyId, "s2");
    expect(startTorchRun).toHaveBeenCalledWith({ entranceId: ENTRY.entranceId, members: [
      { playerId: "leader", name: "LEADER", torches: 2 }, { playerId: "ally", name: "ALLY", torches: 2 }
    ] });
    expect(latest("ally")).toMatchObject({ status: "started", totalTorches: 4 });
    // A double start (or replay) never starts or charges again.
    await service.start("leader", lobbyId, "s3");
    expect(startTorchRun).toHaveBeenCalledTimes(1);
    await expect(service.setTorches("ally", lobbyId, 1, "t3")).rejects.toMatchObject({ code: "TORCH_LOBBY_STARTED" });
    service.close();
  });

  it("enforces the 10-torch cap and the pack check", async () => {
    const { service, latest } = harness();
    await service.join("leader", ENTRY.entranceId, "j1");
    const lobbyId = latest("leader")!.lobbyId;
    await service.join("ally", ENTRY.entranceId, "j2");
    await service.setTorches("leader", lobbyId, 6, "t1");
    await expect(service.setTorches("ally", lobbyId, 5, "t2")).rejects.toMatchObject({ code: "DUNGEON_TORCHES_INVALID" });
    await service.setTorches("ally", lobbyId, 4, "t3");
    expect(latest("ally")!.totalTorches).toBe(10);
    await expect(service.setTorches("leader", lobbyId, 11, "t4")).rejects.toMatchObject({ code: "DUNGEON_TORCHES_INVALID" });
    const poor = harness({ canAfford: false });
    await poor.service.join("leader", ENTRY.entranceId, "j1");
    await expect(poor.service.setTorches("leader", poor.latest("leader")!.lobbyId, 2, "t1"))
      .rejects.toMatchObject({ code: "DUNGEON_ENTRY_COST_UNAFFORDABLE" });
  });

  it("reopens the lobby and tells everyone when a member cannot pay", async () => {
    const { service, latest, startTorchRun } = harness();
    startTorchRun.mockRejectedValueOnce(new DungeonError("DUNGEON_ENTRY_COST_UNAFFORDABLE", "ALLY cannot pay for 1 torch. Nobody was charged."));
    await service.join("leader", ENTRY.entranceId, "j1");
    const lobbyId = latest("leader")!.lobbyId;
    await service.join("ally", ENTRY.entranceId, "j2");
    await service.setTorches("ally", lobbyId, 1, "t1");
    service.setReady("ally", lobbyId, true, "r1");
    await expect(service.start("leader", lobbyId, "s1")).rejects.toMatchObject({ code: "DUNGEON_ENTRY_COST_UNAFFORDABLE" });
    expect(latest("ally")).toMatchObject({ status: "open", message: expect.stringContaining("Nobody was charged"),
      members: [{ ready: false }, { ready: false }] });
  });

  it("drops a disconnected member, clears ready, and restores a clean state on reconnect", async () => {
    const { service, latest } = harness();
    await service.join("leader", ENTRY.entranceId, "j1");
    const lobbyId = latest("leader")!.lobbyId;
    await service.join("ally", ENTRY.entranceId, "j2");
    await service.join("third", ENTRY.entranceId, "j3");
    service.setReady("third", lobbyId, true, "r1");
    // Connect: bootstrap resends the member's lobby.
    service.sendForPlayer("ally");
    expect(latest("ally")).toMatchObject({ lobbyId, members: [{}, {}, {}] });
    // Disconnect: the member leaves and everyone's ready state clears.
    service.disconnect("ally");
    expect(latest("leader")).toMatchObject({ members: [{ playerId: "leader" }, { playerId: "third", ready: false }] });
    // Reconnect: bootstrap clears the stale panel, and tapping the entrance rejoins the same lobby.
    service.sendForPlayer("ally");
    expect(latest("ally")).toBeNull();
    await service.join("ally", ENTRY.entranceId, "j4");
    expect(latest("ally")).toMatchObject({ lobbyId, members: [{ playerId: "leader" }, { playerId: "third" }, { playerId: "ally" }] });
  });

  it("lets the earliest-joined member start when the party leader is not in the lobby", async () => {
    const { service, latest, startTorchRun } = harness();
    await service.join("ally", ENTRY.entranceId, "j1");
    const lobbyId = latest("ally")!.lobbyId;
    await service.join("third", ENTRY.entranceId, "j2");
    expect(latest("third")!.leaderPlayerId).toBe("ally");
    service.setReady("third", lobbyId, true, "r1");
    await expect(service.start("third", lobbyId, "s0")).rejects.toMatchObject({ code: "TORCH_LOBBY_NOT_LEADER" });
    await service.start("ally", lobbyId, "s1");
    expect(startTorchRun).toHaveBeenCalledTimes(1);
    expect(latest("third")).toMatchObject({ status: "started" });
    service.close();
    // Once the party leader is in the lobby, they start.
    const withLeader = harness();
    await withLeader.service.join("ally", ENTRY.entranceId, "j1");
    await withLeader.service.join("leader", ENTRY.entranceId, "j2");
    expect(withLeader.latest("ally")!.leaderPlayerId).toBe("leader");
    withLeader.service.close();
  });

  it("keeps a member who disconnects while the start is charging, and shows them the started run on reconnect", async () => {
    const { service, latest, startTorchRun } = harness();
    let finish!: () => void;
    startTorchRun.mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve({ runId: "run-1", instanceId: ENTRY.instanceId, torchTotal: 1, replayed: false });
    }));
    await service.join("leader", ENTRY.entranceId, "j1");
    const lobbyId = latest("leader")!.lobbyId;
    await service.join("ally", ENTRY.entranceId, "j2");
    service.setReady("ally", lobbyId, true, "r1");
    const starting = service.start("leader", lobbyId, "s1");
    expect(latest("ally")).toMatchObject({ status: "starting" });
    service.disconnect("ally");
    finish();
    await starting;
    expect(latest("leader")).toMatchObject({ status: "started", members: [{ playerId: "leader" }, { playerId: "ally" }] });
    service.sendForPlayer("ally");
    expect(latest("ally")).toMatchObject({ lobbyId, status: "started" });
    service.close();
  });

  it("prunes a member who left the party, and sends a paid run's late joiners straight in", async () => {
    const { service, latest, parties } = harness();
    await service.join("leader", ENTRY.entranceId, "j1");
    const lobbyId = latest("leader")!.lobbyId;
    await service.join("ally", ENTRY.entranceId, "j2");
    parties.delete("ally");
    service.setReady("leader", lobbyId, true, "r1");
    expect(latest("ally")).toBeNull();
    expect(latest("leader")!.members.map((member) => member.playerId)).toEqual(["leader"]);
    const paid = harness({ paid: true });
    await paid.service.join("ally", ENTRY.entranceId, "j1");
    expect(paid.latest("ally")).toMatchObject({ status: "in_progress", members: [], totalTorches: 0 });
  });
});
