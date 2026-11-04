import { describe, expect, it } from "vitest";
import type { FlagSnapshot, KingdomStateSnapshot } from "@ash-atlas/shared";

import {
  flagAccessRenderColor,
  flagInteractionDetail,
  flagInteractionHeading,
  flagInteractionDisplayName,
  flagOwnerIndicatorColor,
  flagRenderColor,
  flagSpriteKind,
  isFlagDemolishablePresentationTarget,
  isFlagAttackablePresentationTarget,
  isFlagBurnablePresentationTarget,
  isFlagSiegeTargetPresentationTarget,
  flagTerritoryControllerKey,
  flagTerritoryPresentationKey,
  mapFlagSelection,
  ordinaryFlagListEntries,
  synchronizeKingdomSeatPresentation,
  updateFlagAccessPresentation,
  upsertFlagSnapshot
} from "./flagDisplay.js";

describe("flagRenderColor", () => {
  it("keeps burn presentation independent from passage access", () => {
    const target = {
      ownerId: "owner-1",
      controlType: "personal" as const,
      cityId: null,
      kingdomId: null,
      anchorKind: "flag" as const,
      upgradeTier: "base" as const,
      burning: false,
      systemControlled: false,
      health: 50,
      maximumHealth: 220
    };

    expect(isFlagBurnablePresentationTarget(target, "burner-1")).toBe(true);
    expect(isFlagBurnablePresentationTarget(target, "owner-1")).toBe(false);
    // Buoys (220 HP soft profile) and Atlas Shrines (3,300 HP) are attackable.
    expect(isFlagBurnablePresentationTarget({ ...target, anchorKind: "buoy" }, "burner-1"))
      .toBe(true);
    expect(isFlagBurnablePresentationTarget({ ...target, upgradeTier: "atlas_shrine", health: 1_650, maximumHealth: 3_300 }, "burner-1"))
      .toBe(true);
    expect(isFlagAttackablePresentationTarget({ ...target, upgradeTier: "atlas_shrine", health: 3_300, maximumHealth: 3_300 }, "burner-1"))
      .toBe(true);
    expect(isFlagAttackablePresentationTarget({ ...target, upgradeTier: "atlas_shrine", health: 3_300, maximumHealth: 3_300 }, "owner-1"))
      .toBe(false);
    expect(isFlagBurnablePresentationTarget({ ...target, upgradeTier: "stone", health: 220 }, "burner-1"))
      .toBe(false);
    expect(isFlagBurnablePresentationTarget({ ...target, upgradeTier: "stone", health: 110, maximumHealth: 220 }, "burner-1"))
      .toBe(true);
    expect(isFlagBurnablePresentationTarget({ ...target, upgradeTier: "tower", health: 400, maximumHealth: 2_700 }, "burner-1"))
      .toBe(true);
    expect(isFlagAttackablePresentationTarget({ ...target, upgradeTier: "stone", health: 220, maximumHealth: 220 }, "burner-1"))
      .toBe(true);
    expect(isFlagAttackablePresentationTarget({ ...target, upgradeTier: "stone", health: 110, maximumHealth: 220 }, "burner-1"))
      .toBe(false);
    expect(isFlagDemolishablePresentationTarget({ ...target, upgradeTier: "base", health: 220 }, "burner-1"))
      .toBe(true);
    expect(isFlagDemolishablePresentationTarget({ ...target, upgradeTier: "tower", health: 1_350, maximumHealth: 2_700 }, "burner-1"))
      .toBe(true);
    expect(isFlagDemolishablePresentationTarget({ ...target, upgradeTier: "tower", health: 1_351, maximumHealth: 2_700 }, "burner-1"))
      .toBe(true);
    expect(isFlagDemolishablePresentationTarget({ ...target, upgradeTier: "tower", health: 375, maximumHealth: 2_700 }, "burner-1"))
      .toBe(true);
    expect(isFlagDemolishablePresentationTarget({ ...target, upgradeTier: "tower", health: 375, maximumHealth: 2_700, burning: true }, "burner-1"))
      .toBe(false);
    expect(isFlagDemolishablePresentationTarget({ ...target, ownerId: "burner-1", developerTestTarget: true, health: 110 }, "burner-1"))
      .toBe(true);
    expect(isFlagDemolishablePresentationTarget({ ...target, ownerId: "burner-1", developerTestTarget: false }, "burner-1"))
      .toBe(false);
    expect(isFlagDemolishablePresentationTarget({ ...target, cityId: "city-1" }, "burner-1"))
      .toBe(false);
    expect(isFlagSiegeTargetPresentationTarget({ ...target, upgradeTier: "tower", health: 1_351, maximumHealth: 2_700 }, "burner-1"))
      .toBe(true);
    expect(isFlagSiegeTargetPresentationTarget({ ...target, upgradeTier: "tower", health: 375, maximumHealth: 2_700, burning: true }, "burner-1"))
      .toBe(true);
    expect(isFlagBurnablePresentationTarget({ ...target, upgradeTier: "tower", health: 375, maximumHealth: 2_700, burning: true }, "burner-1"))
      .toBe(false);
    expect(isFlagBurnablePresentationTarget({ ...target, health: 0 }, "burner-1"))
      .toBe(false);
    const targetWithoutTier = { ...target };
    Reflect.deleteProperty(targetWithoutTier, "upgradeTier");
    expect(isFlagSiegeTargetPresentationTarget({ ...targetWithoutTier, reinforcementLevel: 3, health: 1_351, maximumHealth: 2_700 }, "burner-1"))
      .toBe(true);
    expect(isFlagSiegeTargetPresentationTarget({ ...target, upgradeTier: "stone", health: 220, maximumHealth: 220 }, "burner-1"))
      .toBe(false);
  });

  it("names a personal tower without changing Shrine or Buoy copy", () => {
    expect(flagInteractionDisplayName({ ownerUsername: "Ada", upgradeTier: "tower" }))
      .toBe("Ada's Tower");
    expect(flagInteractionDisplayName({ ownerUsername: "Ada", upgradeTier: "atlas_shrine" }))
      .toBe("Ada's Shrine");
    expect(flagInteractionDisplayName({ ownerUsername: "Ada", anchorKind: "buoy" }))
      .toBe("Ada's Buoy");
  });

  it("keeps developer warfare fixture names instead of adding an owner prefix", () => {
    expect(flagInteractionDisplayName({
      developerTestTarget: true,
      name: "Test Tower",
      ownerUsername: "Developer Test Enemy",
      upgradeTier: "tower"
    })).toBe("Test Tower");
  });
  it("uses a distinct buoy sprite while preserving personal access presentation", () => {
    const buoy = {
      controlType: "personal",
      anchorKind: "buoy",
      cityId: null,
      accessMode: "public",
      ownerColor: "#38bdf8",
      kingdomColor: null,
      upgradeTier: "base"
    } as const;
    expect(flagSpriteKind(buoy)).toBe("personal_buoy");
    expect(flagAccessRenderColor(buoy)).not.toBe(buoy.ownerColor);
  });
  it("renders city-affiliated flags with their authoritative owner color", () => {
    const flag = { controlType: "personal" as const, cityId: "city-1", ownerColor: "#38bdf8" };
    expect(flagRenderColor(flag)).toBe("#38bdf8");
    expect(flag.ownerColor).toBe("#38bdf8");
    expect(flagRenderColor({ ...flag, ownerColor: "#174f2a" })).toBe("#174f2a");
  });

  it("keeps personal owner colors for unaffiliated flags", () => {
    expect(flagRenderColor({ controlType: "personal", cityId: null, ownerColor: "#38BDF8" })).toBe("#38bdf8");
  });

  it("uses Kingdom presentation without overwriting the owner color", () => {
    const flag = { controlType: "kingdom" as const, cityId: null, kingdomColor: "#22C55E", ownerColor: "#38bdf8" };
    expect(flagRenderColor(flag)).toBe("#22c55e");
    expect(flag.ownerColor).toBe("#38bdf8");
    expect(flagOwnerIndicatorColor(flag)).toBe("#38bdf8");
  });

  it("isolates one contributed flag from the same player's personal flags", () => {
    const personal = {
      id: "personal-a",
      controlType: "personal" as const,
      ownerId: "avery",
      cityId: null,
      kingdomId: null,
      ownerColor: "#38bdf8"
    };
    const contributed = {
      id: "kingdom-a",
      controlType: "kingdom" as const,
      ownerId: "avery",
      cityId: null,
      kingdomId: "kingdom-a",
      ownerColor: "#38bdf8",
      kingdomColor: "#22c55e"
    };

    expect([personal, contributed, personal].map(flagRenderColor)).toEqual([
      "#38bdf8", "#22c55e", "#38bdf8"
    ]);
    expect([personal, contributed, personal].map(flagSpriteKind)).toEqual([
      "personal_flag", "kingdom_banner", "personal_flag"
    ]);
    expect(flagTerritoryControllerKey(personal)).toBe("player:avery");
    expect(flagTerritoryControllerKey(contributed)).toBe("kingdom:kingdom-a");
  });

  it("renders a Castle as one source-flag-owned castle claim", () => {
    const seat = {
      id: "source-flag",
      controlType: "kingdom_seat" as const,
      ownerId: "founder",
      cityId: null,
      kingdomId: "kingdom-a",
      kingdomColor: "#22C55E",
      ownerColor: "#38bdf8"
    };

    expect(flagRenderColor(seat)).toBe("#22c55e");
    expect(flagSpriteKind(seat)).toBe("kingdom_seat");
    expect(flagTerritoryControllerKey(seat)).toBe("kingdom:kingdom-a");
    expect(mapFlagSelection(seat as FlagSnapshot)).toEqual({
      kind: "kingdom_seat",
      sourceFlagId: "source-flag",
      kingdomId: "kingdom-a"
    });
    expect(ordinaryFlagListEntries([seat as FlagSnapshot])).toEqual([seat]);
  });

  it("updates only the converted flag in the realtime cache", () => {
    const personalA = { id: "personal-a", controlType: "personal" } as FlagSnapshot;
    const target = { id: "target", controlType: "personal" } as FlagSnapshot;
    const personalB = { id: "personal-b", controlType: "personal" } as FlagSnapshot;
    const converted = {
      ...target,
      controlType: "kingdom",
      kingdomId: "kingdom-a",
      kingdomColor: "#22c55e"
    } as FlagSnapshot;

    const updated = upsertFlagSnapshot([personalA, target, personalB], converted);

    expect(updated).toEqual([personalA, converted, personalB]);
    expect(updated[0]).toBe(personalA);
    expect(updated[2]).toBe(personalB);
  });

  it("applies incremental flag replication idempotently and reconciles with a full snapshot", () => {
    const original = { id: "flag-a", name: "Original", controlType: "personal" } as FlagSnapshot;
    const incremental = { ...original, name: "Incremental" };
    const once = upsertFlagSnapshot([original], incremental);
    const twice = upsertFlagSnapshot(once, incremental);

    expect(twice).toEqual([incremental]);
    expect(twice).toHaveLength(1);

    const fullSnapshot = [{ ...incremental, name: "Authoritative snapshot" }] as FlagSnapshot[];
    expect(fullSnapshot).toEqual([
      expect.objectContaining({ id: "flag-a", name: "Authoritative snapshot" })
    ]);
  });

  it("refreshes pending Seat presentation in place from Kingdom state", () => {
    const source = {
      id: "source-flag",
      controlType: "kingdom_seat",
      kingdomId: "kingdom-a",
      kingdomSeatId: "seat-a",
      kingdomSeatConstructionState: "under_construction",
      kingdomSeatLat: 35,
      kingdomSeatLon: -106,
      claimRadiusM: 200
    } as FlagSnapshot;
    const state = {
      kingdom: {
        id: "kingdom-a",
        displayName: "Green Realm",
        displayColor: "#22c55e",
        emblemKey: "oak",
        seat: {
          id: "seat-a",
          sourceFlagId: "source-flag",
          constructionState: "complete",
          lat: 35.003,
          lon: -106.004,
          territoryRadiusM: 200
        }
      },
      nearbyKingdoms: []
    } as unknown as KingdomStateSnapshot;

    const updated = synchronizeKingdomSeatPresentation([source], state);

    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({
      id: "source-flag",
      kingdomName: "Green Realm",
      kingdomColor: "#22c55e",
      kingdomSeatConstructionState: "complete",
      kingdomSeatLat: 35.003,
      kingdomSeatLon: -106.004
    });
    expect(synchronizeKingdomSeatPresentation(updated, state)).toBe(updated);
  });
});

describe("flagAccessRenderColor", () => {
  const personal = {
    controlType: "personal" as const,
    cityId: null,
    ownerColor: "#38BDF8",
    upgradeTier: "base" as const
  };

  it("keeps normal owner colors exact and shades private or public banners by 52%", () => {
    expect(flagAccessRenderColor({ ...personal, accessMode: "normal" })).toBe("#38bdf8");
    expect(flagAccessRenderColor({ ...personal, accessMode: "private" })).toBe("#1b5b77");
    expect(flagAccessRenderColor({ ...personal, accessMode: "public" })).toBe("#9fdffc");
  });

  it("treats a missing mode as private and preserves the canonical color fallback", () => {
    expect(flagAccessRenderColor({ ...personal, ownerColor: "invalid" })).toBe("#681c1c");
  });

  it("shades Atlas Shrine access while preserving city and Kingdom presentation", () => {
    expect(flagAccessRenderColor({ ...personal, accessMode: "public", upgradeTier: "atlas_shrine" }))
      .toBe("#9fdffc");
    expect(flagAccessRenderColor({ ...personal, accessMode: "private", upgradeTier: "atlas_shrine" }))
      .toBe("#1b5b77");
    expect(flagAccessRenderColor({ ...personal, accessMode: "public", cityId: "city-1" }))
      .toBe("#38bdf8");
    expect(flagAccessRenderColor({ ...personal, accessMode: "public", controlType: "kingdom",
      kingdomColor: "#22C55E" })).toBe("#22c55e");
    expect(flagAccessRenderColor({ ...personal, accessMode: "private", controlType: "kingdom_seat",
      kingdomColor: "#22C55E" })).toBe("#22c55e");
  });

  it("separates one player's territory by access mode without splitting matching modes", () => {
    const base = { ...personal, id: "flag-1", ownerId: "avery", kingdomId: null };
    expect(flagTerritoryPresentationKey({ ...base, accessMode: "normal" }))
      .toBe("player:avery:access:normal");
    expect(flagTerritoryPresentationKey({ ...base, accessMode: "private" }))
      .not.toBe(flagTerritoryPresentationKey({ ...base, accessMode: "public" }));
    expect(flagTerritoryPresentationKey({ ...base, id: "shrine-1", accessMode: "public" }))
      .toBe(flagTerritoryPresentationKey({ ...base, accessMode: "public" }));
  });
});

describe("personal flag access presentation", () => {
  const flag = {
    id: "flag-1",
    controlType: "personal" as const,
    cityId: null,
    ownerUsername: "Wren",
    upgradeTier: "base" as const
  };

  it("formats authoritative mode and configured toll in the interaction heading", () => {
    expect(flagInteractionHeading(flag, { mode: "private", jumpTollGold: "0" }))
      .toBe("Wren's Flag (Private)");
    expect(flagInteractionHeading(flag, { mode: "normal", jumpTollGold: "0" }))
      .toBe("Wren's Flag (Normal) · Free");
    expect(flagInteractionHeading(flag, { mode: "public", jumpTollGold: "8" }))
      .toBe("Wren's Flag (Public) · 8 Gold");
  });

  it("keeps developer warfare names exact even when access data is present", () => {
    expect(flagInteractionHeading({
      ...flag,
      developerTestTarget: true,
      name: "Test Tower",
      ownerUsername: "Developer Test Enemy"
    }, { mode: "normal", jumpTollGold: "0" })).toBe("Test Tower");
  });

  it("formats one concise picker detail only for personal flags with access data", () => {
    expect(flagInteractionDetail({ ...flag, accessMode: "private", jumpTollGold: "0" }))
      .toBe("Private");
    expect(flagInteractionDetail({ ...flag, accessMode: "public", jumpTollGold: "8" }))
      .toBe("Public · 8 Gold");
    expect(flagInteractionDetail({ ...flag, accessMode: "normal", jumpTollGold: "0" }))
      .toBe("Normal · Free");
    expect(flagInteractionDetail({
      ...flag,
      cityId: "city-1",
      accessMode: "public",
      jumpTollGold: "8"
    })).toBeNull();
  });

  it("formats Atlas Shrine headings with the same authoritative access layout", () => {
    const shrine = { ...flag, upgradeTier: "atlas_shrine" as const };
    expect(flagInteractionHeading(shrine, { mode: "private", jumpTollGold: "0" }))
      .toBe("Wren's Shrine (Private)");
    expect(flagInteractionHeading(shrine, { mode: "normal", jumpTollGold: "0" }))
      .toBe("Wren's Shrine (Normal) · Free");
    expect(flagInteractionHeading(shrine, { mode: "public", jumpTollGold: "8" }))
      .toBe("Wren's Shrine (Public) · 8 Gold");
  });

  it("patches only the matching flag from an authoritative access response", () => {
    const target = {
      ...flag,
      accessMode: "private" as const,
      jumpTollGold: "0",
      accessRevision: "1"
    } as FlagSnapshot;
    const other = { ...target, id: "flag-2" };
    const updated = updateFlagAccessPresentation([target, other], {
      flagId: target.id,
      mode: "public",
      jumpTollGold: "8",
      accessRevision: "2"
    });

    expect(updated[0]).toMatchObject({
      accessMode: "public",
      jumpTollGold: "8",
      accessRevision: "2"
    });
    expect(updated[1]).toBe(other);
  });
});

describe("city flag presentation", () => {
  it("uses the authoritative city-owned name without former owner identity", () => {
    expect(flagInteractionHeading({
      anchorKind: "flag",
      cityId: "city-1",
      controlType: "personal",
      name: "Ciudad de Mexico's Flag",
      ownerUsername: null,
      upgradeTier: "base"
    }, null)).toBe("Ciudad de Mexico's Flag");
  });
});
