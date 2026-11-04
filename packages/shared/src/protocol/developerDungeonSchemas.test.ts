import { describe, expect, it } from "vitest";

import { clientMessageSchema } from "./clientMessages.js";

const REQUEST_ID = "00000000-0000-4000-8000-000000900017";

describe("developer dungeon run reset message", () => {
  it("parses DEV_RESET_DUNGEON_RUN with only a request id", () => {
    expect(clientMessageSchema.safeParse({ type: "DEV_RESET_DUNGEON_RUN", requestId: REQUEST_ID }).success).toBe(true);
  });

  it("rejects extra fields and a missing request id", () => {
    expect(clientMessageSchema.safeParse({ type: "DEV_RESET_DUNGEON_RUN", requestId: REQUEST_ID, dungeonId: "tilted_vault" }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ type: "DEV_RESET_DUNGEON_RUN" }).success).toBe(false);
  });
});

describe("Ash Heart puzzle start/quit message", () => {
  it("parses DUNGEON_PUZZLE_ACTIVE start and quit", () => {
    for (const active of [true, false]) {
      expect(clientMessageSchema.safeParse({
        type: "DUNGEON_PUZZLE_ACTIVE", requestId: REQUEST_ID, sessionId: "session-1", roomId: "vault_r1", active
      }).success).toBe(true);
    }
  });

  it("rejects a non-boolean active flag", () => {
    expect(clientMessageSchema.safeParse({
      type: "DUNGEON_PUZZLE_ACTIVE", requestId: REQUEST_ID, sessionId: "session-1", roomId: "vault_r1", active: "yes"
    }).success).toBe(false);
  });
});
