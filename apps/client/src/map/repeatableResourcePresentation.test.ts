import type { CollectibleNode } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  collectiblesSignature,
  shouldRenderCollectibleMarker
} from "./pixiOverlay.js";

describe("repeatable resource presentation", () => {
  it("keeps a depleted permanent mine visible while hiding harvested ambient nodes", () => {
    expect(shouldRenderCollectibleMarker(node({
      state: "harvested",
      repeatableNodeType: "stone_mine",
      repeatableState: "depleted"
    }))).toBe(true);
    expect(shouldRenderCollectibleMarker(node({ state: "harvested" }))).toBe(false);
    expect(shouldRenderCollectibleMarker(node({ state: "available" }))).toBe(false);
  });

  it("invalidates retained markers for canonical state and revision changes", () => {
    const ready = node({
      repeatableNodeType: "stone_mine",
      repeatableState: "ready",
      repeatableRevision: 3
    });
    expect(collectiblesSignature([ready])).not.toBe(
      collectiblesSignature([{
        ...ready,
        state: "harvested",
        repeatableState: "depleted",
        repeatableRevision: 4,
        repeatableReadyAt: "2026-07-29T05:50:00.000Z"
      }])
    );
  });

  it("invalidates retained markers when claimed mine access changes", () => {
    const privateMine = node({
      repeatableNodeType: "stone_mine",
      repeatableState: "depleted",
      repeatableRevision: 4,
      repeatableOwnerPlayerId: "owner-1",
      repeatableAccessMode: "private"
    });
    expect(collectiblesSignature([privateMine])).not.toBe(
      collectiblesSignature([{
        ...privateMine,
        repeatableAccessMode: "public"
      }])
    );
    expect(collectiblesSignature([privateMine])).not.toBe(
      collectiblesSignature([{
        ...privateMine,
        repeatableOwnerPlayerId: null,
        repeatableAccessMode: null
      }])
    );
  });
});

function node(overrides: Partial<CollectibleNode>): CollectibleNode {
  return {
    id: "node",
    type: "stone",
    lat: 35,
    lon: -106,
    quantity: 1,
    state: "available",
    createdAt: "",
    harvestedAt: null,
    sourceCellId: "cell",
    waterKind: null,
    ...overrides
  };
}
