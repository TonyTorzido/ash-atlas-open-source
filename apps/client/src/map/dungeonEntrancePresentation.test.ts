import { describe, expect, it } from "vitest";

import type { DungeonEntranceSnapshot } from "@ash-atlas/shared";

import { dungeonEntranceAssetUrl, dungeonEntrancesSignature } from "./pixiOverlay.js";

describe("dungeon entrance presentation", () => {
  it("serves Studio-authored public assets from their client URL", () => {
    expect(dungeonEntranceAssetUrl(
      "apps/client/public/assets/dungeons/shared/orc-cave-entrance.png"
    )).toBe("/assets/dungeons/shared/orc-cave-entrance.png");
    expect(dungeonEntranceAssetUrl(
      "apps\\client\\public\\assets\\dungeons\\shared\\orc-cave-entrance.png"
    )).toBe("/assets/dungeons/shared/orc-cave-entrance.png");
  });

  it("rejects asset keys outside the client public asset tree", () => {
    expect(dungeonEntranceAssetUrl("apps/server/private.png")).toBeNull();
    expect(dungeonEntranceAssetUrl(null)).toBeNull();
  });

  it("invalidates entrance rendering when authoritative presentation changes", () => {
    const entrance = {
      entranceId: "orc-cave",
      dungeonId: "orc_cave",
      name: "Grimfang Cavern",
      description: "An occupied cavern.",
      portalId: "orc-cave:world-to-entry",
      portalRevision: "1",
      interactionLabel: "Enter",
      regionCode: "NM",
      lat: 35,
      lon: -106,
      interactionRadiusM: 18,
      footprintRadiusM: 14,
      presentation: "cave",
      assetKey: "apps/client/public/assets/dungeons/shared/orc-cave-entrance.png"
    } satisfies DungeonEntranceSnapshot;
    const original = dungeonEntrancesSignature([entrance]);

    expect(dungeonEntrancesSignature([{ ...entrance, assetKey: "/assets/dungeons/custom.png" }]))
      .not.toBe(original);
    expect(dungeonEntrancesSignature([{ ...entrance, interactionLabel: "Descend" }]))
      .not.toBe(original);
    expect(dungeonEntrancesSignature([{ ...entrance, portalRevision: "2" }]))
      .not.toBe(original);
  });
});
