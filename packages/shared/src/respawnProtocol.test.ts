import { describe, expect, it } from "vitest";

import { combatEntitySnapshotSchema } from "./protocol/combatEquipmentServerSchemas.js";
import { CURRENT_LEVEL_CAP } from "./progression.js";
import { clientMessageSchema } from "./protocol.js";

describe("RESPAWN_PLAYER protocol", () => {
  it("accepts only the request-scoped command shape", () => {
    expect(clientMessageSchema.parse({ type: "RESPAWN_PLAYER", requestId: "respawn-1" }))
      .toEqual({ type: "RESPAWN_PLAYER", requestId: "respawn-1" });
    expect(clientMessageSchema.safeParse({ type: "RESPAWN_PLAYER" }).success).toBe(false);
    expect(clientMessageSchema.safeParse({
      type: "RESPAWN_PLAYER",
      requestId: "respawn-1",
      playerId: "another-player"
    }).success).toBe(false);
  });

  it("accepts the optional nullable private respawn deadline projection", () => {
    const entity = {
      entityId: "player-1",
      kind: "player",
      archetypeKey: null,
      name: "Player",
      level: 2,
      regionCode: "NM",
      zoneId: "world:NM",
      lat: 35,
      lon: -106,
      maxHealth: 100,
      currentHealth: 0,
      respawnAvailableAt: 110_000,
      lifeState: "respawning",
      activityState: "idle",
      targetEntityId: null,
      revision: 2
    };
    expect(combatEntitySnapshotSchema.parse(entity)).toEqual(entity);
    expect(combatEntitySnapshotSchema.parse({ ...entity, respawnAvailableAt: null }))
      .toMatchObject({ respawnAvailableAt: null });
    expect(combatEntitySnapshotSchema.safeParse({ ...entity, respawnAvailableAt: -1 }).success)
      .toBe(false);
    // Character levels above the gear cap (25) must not be rejected as malformed frames.
    expect(combatEntitySnapshotSchema.safeParse({ ...entity, level: CURRENT_LEVEL_CAP }).success)
      .toBe(true);
  });
});
