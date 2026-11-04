import { describe, expect, it } from "vitest";

import { DUNGEON_TORCH_TOTAL_MAX } from "../dungeonCatalog.js";
import { clientMessageSchema } from "./clientMessages.js";
import { dungeonServerMessageSchemas } from "./dungeonServerSchemas.js";

const lobby = {
  lobbyId: "lobby-1", entranceId: "fangrock-entrance", dungeonId: "fangrock_cavern",
  dungeonName: "Fangrock Cavern", partyId: "party-1", leaderPlayerId: "leader",
  status: "open" as const, revision: 3,
  torchCost: [{ itemId: "refined_oil", quantity: 18 }, { itemId: "wood", quantity: 1 }],
  minTotalTorches: 1, maxTotalTorches: DUNGEON_TORCH_TOTAL_MAX, totalTorches: 3,
  members: [
    { playerId: "leader", name: "Leader", torches: 2, ready: false },
    { playerId: "member", name: "Member", torches: 1, ready: true }
  ],
  message: null
};

describe("dungeon torch lobby protocol", () => {
  it("accepts every lobby command and bounds the torch count", () => {
    for (const message of [
      { type: "DUNGEON_TORCH_LOBBY_JOIN", requestId: "r1", entranceId: "fangrock-entrance" },
      { type: "DUNGEON_TORCH_LOBBY_SET_TORCHES", requestId: "r2", lobbyId: "lobby-1", torches: 0 },
      { type: "DUNGEON_TORCH_LOBBY_SET_TORCHES", requestId: "r3", lobbyId: "lobby-1", torches: DUNGEON_TORCH_TOTAL_MAX },
      { type: "DUNGEON_TORCH_LOBBY_READY", requestId: "r4", lobbyId: "lobby-1", ready: true },
      { type: "DUNGEON_TORCH_LOBBY_READY", requestId: "r5", lobbyId: "lobby-1", ready: false },
      { type: "DUNGEON_TORCH_LOBBY_START", requestId: "r6", lobbyId: "lobby-1" },
      { type: "DUNGEON_TORCH_LOBBY_LEAVE", requestId: "r7", lobbyId: "lobby-1" }
    ]) {
      expect(clientMessageSchema.safeParse(message).success, message.type).toBe(true);
    }
    for (const torches of [-1, DUNGEON_TORCH_TOTAL_MAX + 1, 1.5]) {
      expect(clientMessageSchema.safeParse({
        type: "DUNGEON_TORCH_LOBBY_SET_TORCHES", requestId: "r", lobbyId: "lobby-1", torches
      }).success).toBe(false);
    }
    expect(clientMessageSchema.safeParse({
      type: "DUNGEON_TORCH_LOBBY_START", requestId: "r", lobbyId: "lobby-1", torches: 3
    }).success).toBe(false);
  });

  it("validates the lobby broadcast and the cleared lobby", () => {
    expect(dungeonServerMessageSchemas.DUNGEON_TORCH_LOBBY.parse({ type: "DUNGEON_TORCH_LOBBY", requestId: "r1", lobby }))
      .toMatchObject({ lobby: { totalTorches: 3, members: [{ playerId: "leader" }, { playerId: "member", ready: true }] } });
    expect(dungeonServerMessageSchemas.DUNGEON_TORCH_LOBBY.parse({ type: "DUNGEON_TORCH_LOBBY", lobby: null }).lobby).toBeNull();
    expect(dungeonServerMessageSchemas.DUNGEON_TORCH_LOBBY.safeParse({
      type: "DUNGEON_TORCH_LOBBY", lobby: { ...lobby, totalTorches: DUNGEON_TORCH_TOTAL_MAX + 1 }
    }).success).toBe(false);
    expect(dungeonServerMessageSchemas.DUNGEON_TORCH_LOBBY.safeParse({
      type: "DUNGEON_TORCH_LOBBY", lobby: { ...lobby, status: "paid" }
    }).success).toBe(false);
  });
});
