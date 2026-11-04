import { DEFAULT_PLAYER_APPEARANCE_CATALOG, isElderFern, playerOverallScale, treeVarietyForStableId } from "@ash-atlas/shared";
import { FLAG_BUILD_TUNING } from "@ash-atlas/player-renderer";
import { Texture } from "pixi.js";
import { describe, expect, it } from "vitest";

import {
  equippedGatheringToolAssetKey,
  flagBuildArtFromTextures,
  gatheringToolAssetKeyForDefinition,
  harvestGatherKind,
  localGatheringPresentation,
  remoteGatheringPresentation
} from "./gatheringPresentation.js";

describe("gathering tool presentation", () => {
  it("resolves held art through the appearance catalog", () => {
    expect(gatheringToolAssetKeyForDefinition("wooden_axe")).toBe("tools/wooden-axe.png");
    expect(gatheringToolAssetKeyForDefinition("sword")).toBeNull();
  });

  it("uses the tool in the slot of the action's kind", () => {
    const all = {
      tool_axe: { definitionId: "stone_axe" },
      tool_pickaxe: { definitionId: "wooden_pickaxe" },
      tool_fishing_pole: { definitionId: "starter_fishing_pole" }
    };
    expect(equippedGatheringToolAssetKey("chop", all)).toBe("tools/stone-axe.png");
    expect(equippedGatheringToolAssetKey("mine", all)).toBe("tools/wooden-pickaxe.png");
    expect(equippedGatheringToolAssetKey("fish", all)).toBe("tools/starter-fishing-pole.png");
    expect(equippedGatheringToolAssetKey("mine", { tool_axe: { definitionId: "stone_axe" } })).toBeNull();
    expect(equippedGatheringToolAssetKey("chop", null)).toBeNull();
  });

  it("always shows a pole when fishing", () => {
    expect(equippedGatheringToolAssetKey("fish", null)).toBe("tools/starter-fishing-pole.png");
    expect(equippedGatheringToolAssetKey("fish", { tool_axe: { definitionId: "wooden_axe" } }))
      .toBe("tools/starter-fishing-pole.png");
  });

  it("picks plants, berries and tree produce bare-handed; chops trees and mines nodes with the slot tool", () => {
    expect(harvestGatherKind({ type: "wood" }, "primary")).toBe("chop");
    expect(harvestGatherKind({ type: "wood" }, "resin")).toBe("harvest");
    expect(harvestGatherKind({ type: "berries", repeatableNodeType: "stone_mine" } as never, "primary")).toBe("mine");
    expect(harvestGatherKind({ type: "berries" } as never, "primary")).toBe("harvest");
    const presentation = localGatheringPresentation({
      harvestTask: { phase: "harvesting", nodeId: "n1", action: "primary", startedAtMs: 5 } as never,
      harvestTarget: { id: "n1", type: "berries", lat: 1, lon: 2 } as never,
      fishingEncounter: null,
      playerPosition: { lat: 1, lon: 2 },
      toolAssetKeyFor: () => "tools/stone-axe.png"
    });
    expect(presentation).toMatchObject({ kind: "harvest", toolAssetKey: null });
  });

  describe("picking stops the moment the produce is gone", () => {
    const idOf = (match: (id: string) => boolean): string => {
      for (let i = 0; ; i++) if (match(`tree-${i}`)) return `tree-${i}`;
    };
    const berryTree = { id: idOf((id) => treeVarietyForStableId(id) === "giving_tree"), type: "wood", lat: 1, lon: 2, berryAvailable: true };
    const fern = { id: idOf(isElderFern), type: "wood", lat: 1, lon: 2, sapReadyAt: null as string | null };
    const base = { fishingEncounter: null, playerPosition: { lat: 1, lon: 2 }, toolAssetKeyFor: () => "tools/stone-axe.png", nowMs: 1_000_000 };
    const task = (nodeId: string, phase: "harvesting" | "completing", action: "primary" | "resin" = "resin") =>
      ({ phase, nodeId, action, sessionId: "s1", startedAtMs: 5, completesAtMs: 605, startRequestedAtMs: 1 }) as never;

    it("berries: picks while they hang, stands once the harvest completes or they are gone", () => {
      expect(localGatheringPresentation({ ...base, harvestTask: task(berryTree.id, "harvesting"), harvestTarget: berryTree as never }))
        .toMatchObject({ kind: "harvest" });
      expect(localGatheringPresentation({ ...base, harvestTask: task(berryTree.id, "completing"), harvestTarget: berryTree as never }))
        .toBeNull();
      expect(localGatheringPresentation({ ...base, harvestTask: task(berryTree.id, "harvesting"), harvestTarget: { ...berryTree, berryAvailable: false } as never }))
        .toBeNull();
    });

    it("frond sap: taps while the sap is ready, stands once tapped or the harvest completes", () => {
      expect(localGatheringPresentation({ ...base, harvestTask: task(fern.id, "harvesting"), harvestTarget: fern as never }))
        .toMatchObject({ kind: "harvest" });
      expect(localGatheringPresentation({ ...base, harvestTask: task(fern.id, "completing"), harvestTarget: fern as never }))
        .toBeNull();
      const tapped = { ...fern, sapReadyAt: new Date(base.nowMs + 60_000).toISOString() };
      expect(localGatheringPresentation({ ...base, harvestTask: task(fern.id, "harvesting"), harvestTarget: tapped as never }))
        .toBeNull();
    });

    it("plants stop on completion; chopping and mining keep playing through it", () => {
      const plant = { id: "p1", type: "berries", lat: 1, lon: 2 };
      expect(localGatheringPresentation({ ...base, harvestTask: task("p1", "completing", "primary"), harvestTarget: plant as never })).toBeNull();
      expect(localGatheringPresentation({ ...base, harvestTask: task(berryTree.id, "completing", "primary"), harvestTarget: berryTree as never }))
        .toMatchObject({ kind: "chop" });
      const rock = { id: "m1", type: "stone", repeatableNodeType: "stone_mine", lat: 1, lon: 2 };
      expect(localGatheringPresentation({ ...base, harvestTask: task("m1", "completing", "primary"), harvestTarget: rock as never }))
        .toMatchObject({ kind: "mine" });
    });
  });

  it("maps remote snapshots, with the starter pole for fishing", () => {
    const snapshot = { kind: "fish", toolDefinitionId: null, targetLat: 1, targetLon: 2, startedAt: "t", completesAt: null } as const;
    expect(remoteGatheringPresentation(snapshot, gatheringToolAssetKeyForDefinition)?.toolAssetKey)
      .toBe("tools/starter-fishing-pole.png");
    expect(remoteGatheringPresentation({ ...snapshot, kind: "chop" }, gatheringToolAssetKeyForDefinition)?.toolAssetKey)
      .toBeNull();
  });
});

describe("flag building presentation", () => {
  const idle = {
    harvestTask: null,
    harvestTarget: null,
    fishingEncounter: null,
    playerPosition: { lat: 1, lon: 2 },
    toolAssetKeyFor: () => null
  };

  it("shows the flag-building action while a flag build runs, not for buoys", () => {
    const flagBuild = { buildId: "b1", position: { lat: 1, lon: 2 }, anchorKind: "flag" as const };
    expect(localGatheringPresentation({ ...idle, flagBuild })).toEqual({
      kind: "flag",
      toolAssetKey: null,
      target: { lat: 1, lon: 2 },
      actionKey: "flag:b1"
    });
    expect(localGatheringPresentation({ ...idle, flagBuild: { ...flagBuild, anchorKind: "buoy" } })).toBeNull();
    expect(localGatheringPresentation({ ...idle, flagBuild: null })).toBeNull();
  });

  it("holds the Soft Flag art with the cloth in the player's colour", () => {
    const texture = Texture.WHITE;
    const art = flagBuildArtFromTextures(() => texture, 0x3366cc);
    expect(art).toMatchObject({ pole: texture, cloth: texture, clothTint: 0x3366cc });
    expect(art!.baseY).toBeGreaterThan(0.9);
    expect(flagBuildArtFromTextures(() => undefined, 0x3366cc)).toBeNull();
  });

  it("falls back to the stock placed-flag size when the art gives none", () => {
    const art = flagBuildArtFromTextures(() => Texture.WHITE, 0x3366cc)!;
    const overallScale = playerOverallScale(DEFAULT_PLAYER_APPEARANCE_CATALOG, "default");
    expect(Math.abs(FLAG_BUILD_TUNING.flag.canvasUnits * overallScale - art.heightUnits!)).toBeLessThan(1);
  });
});
