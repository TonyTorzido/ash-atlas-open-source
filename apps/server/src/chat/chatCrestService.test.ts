import { describe, expect, it, vi } from "vitest";

import { ChatCrestService } from "./chatCrestService.js";

describe("ChatCrestService", () => {
  it("normalizes missing and legacy profile values to the registered fallback", async () => {
    const query = vi.fn(async () => ({ rows: [{ equipped_chat_crest_id: "legacy" }] }));
    const service = new ChatCrestService({ query } as never);
    const selection = await service.selectionFor("player-a");
    expect(selection.equippedCrestId).toBe("leaf");
    expect(selection.crests.map(({ id }) => id)).toEqual(["lion", "leaf", "stag", "cross"]);
  });

  it("persists only an entitled registered crest and leaves a future entitlement seam", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO player_profiles")) return { rows: [] };
      return { rows: [{ equipped_chat_crest_id: "stag" }] };
    });
    const isEntitled = vi.fn(async (_playerId: string, crestId: string) => crestId === "stag");
    const service = new ChatCrestService({ query } as never, { isEntitled });
    await expect(service.equip("player-a", "lion")).rejects.toMatchObject({
      code: "CHAT_CREST_NOT_AVAILABLE"
    });
    await expect(service.equip("player-a", "stag")).resolves.toMatchObject({
      equippedCrestId: "stag",
      crests: [{ id: "stag" }]
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO player_profiles"),
      ["player-a", "stag"]
    );
  });
});
