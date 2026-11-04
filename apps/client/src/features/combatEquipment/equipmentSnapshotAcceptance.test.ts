import type { EquipmentSnapshotV2 } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { acceptEquipmentSnapshot } from "./equipmentSnapshotAcceptance.js";

const snapshot = (playerId: string, inventory: number, active: number, checkpoint: number) => ({
  playerId,
  inventoryRevision: inventory,
  activeRevision: active,
  checkpointRevision: checkpoint
} as EquipmentSnapshotV2);

describe("acceptEquipmentSnapshot", () => {
  it("rejects stale revisions and snapshots belonging to another player", () => {
    const current = snapshot("player-1", 4, 3, 2);
    expect(acceptEquipmentSnapshot("player-1", current, snapshot("player-1", 3, 4, 3)))
      .toBe(current);
    expect(acceptEquipmentSnapshot("player-1", current, snapshot("player-2", 5, 4, 3)))
      .toBe(current);
  });

  it("accepts a matching player's monotonic snapshot", () => {
    const next = snapshot("player-1", 5, 3, 3);
    expect(acceptEquipmentSnapshot("player-1", snapshot("player-1", 4, 3, 2), next))
      .toBe(next);
  });
});
