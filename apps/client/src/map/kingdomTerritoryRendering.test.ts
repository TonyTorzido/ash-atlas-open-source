import { describe, expect, it } from "vitest";
import type { FlagSnapshot } from "@ash-atlas/shared";

import {
  flagAccessRenderColor,
  flagTerritoryControllerKey,
  flagTerritoryPresentationKey,
  upsertFlagSnapshot
} from "../flags/flagDisplay.js";
import {
  createCircleRing,
  mergeOwnerTerritoriesWithBoundaries,
  polygonToPathCommands,
  type TerritoryClaimShape
} from "../territory/territoryGeometry.js";

describe("Kingdom territory rendering", () => {
  it("unions an overlapping Seat and Kingdom Flag into one outside boundary", () => {
    const groups = renderGroups([
      flag("seat", "kingdom_seat", "founder", "kingdom-a", [0, 0]),
      flag("banner", "kingdom", "contributor", "kingdom-a", [7, 0])
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.ownerId).toBe("kingdom:kingdom-a");
    expect(groups[0]?.polygons).toHaveLength(1);
    expect(groups[0]?.zoneCells).toHaveLength(2);
    expect(polygonToPathCommands(groups[0]!.polygons[0]!).filter(({ type }) => type === "moveTo"))
      .toHaveLength(1);
  });

  it("merges multiple connected flags by controlling Kingdom rather than contributor", () => {
    const groups = renderGroups([
      flag("seat", "kingdom_seat", "founder", "kingdom-a", [0, 0]),
      flag("banner-a", "kingdom", "contributor-a", "kingdom-a", [7, 0]),
      flag("banner-b", "kingdom", "contributor-b", "kingdom-a", [14, 0])
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.ownerId).toBe("kingdom:kingdom-a");
    expect(groups[0]?.polygons).toHaveLength(1);
  });

  it("keeps an overlapping personal flag visually separate from contributed flags by the same owner", () => {
    const groups = renderGroups([
      flag("seat", "kingdom_seat", "owner-a", "kingdom-a", [0, 0]),
      flag("banner", "kingdom", "owner-a", "kingdom-a", [7, 0]),
      flag("personal", "personal", "owner-a", null, [10, 0])
    ]);

    expect(groups.map(({ ownerId }) => ownerId).sort()).toEqual([
      "kingdom:kingdom-a",
      "player:owner-a"
    ]);
  });

  it("keeps another Kingdom in a separate territory group", () => {
    const groups = renderGroups([
      flag("seat-a", "kingdom_seat", "owner-a", "kingdom-a", [0, 0]),
      flag("banner-a", "kingdom", "owner-a", "kingdom-a", [7, 0]),
      flag("seat-b", "kingdom_seat", "owner-b", "kingdom-b", [15, 0])
    ]);

    expect(groups.map(({ ownerId }) => ownerId).sort()).toEqual([
      "kingdom:kingdom-a",
      "kingdom:kingdom-b"
    ]);
  });

  it("renders one player's mixed-access territories as distinct shaded groups", () => {
    const privateFlag = {
      ...flag("private", "personal", "owner-a", null, [0, 0]).snapshot,
      accessMode: "private" as const
    };
    const publicShrine = {
      ...flag("shrine", "personal", "owner-a", null, [7, 0]).snapshot,
      accessMode: "public" as const,
      upgradeTier: "atlas_shrine" as const
    };
    const groups = mergeOwnerTerritoriesWithBoundaries([
      { id: privateFlag.id, ownerId: flagTerritoryPresentationKey(privateFlag),
        ownerColor: flagAccessRenderColor(privateFlag), center: [0, 0], radius: 10,
        ring: createCircleRing([0, 0], 10, 64) },
      { id: publicShrine.id, ownerId: flagTerritoryPresentationKey(publicShrine),
        ownerColor: flagAccessRenderColor(publicShrine), center: [7, 0], radius: 10,
        ring: createCircleRing([7, 0], 10, 64) }
    ]);

    expect(groups.map(({ ownerColor }) => ownerColor).sort()).toEqual(["#1b5b77", "#9fdffc"]);
    expect(groups.map(({ ownerId }) => ownerId).sort()).toEqual([
      "player:owner-a:access:private",
      "player:owner-a:access:public"
    ]);
  });

  it("removes a released flag from the union on the next realtime snapshot", () => {
    const seat = flag("seat", "kingdom_seat", "owner-a", "kingdom-a", [0, 0]);
    const contributed = flag("banner", "kingdom", "owner-a", "kingdom-a", [7, 0]);
    const before = renderGroups([seat, contributed]);
    const released = flag("banner", "personal", "owner-a", null, [7, 0]);
    const after = renderGroups(upsertFlagSnapshot(
      [seat.snapshot, contributed.snapshot], released.snapshot
    ).map(fromSnapshot));

    expect(before).toHaveLength(1);
    expect(after.map(({ ownerId }) => ownerId).sort()).toEqual([
      "kingdom:kingdom-a",
      "player:owner-a"
    ]);
  });

  it("produces the same merged grouping for realtime updates and a fresh reconnect snapshot", () => {
    const seat = flag("seat", "kingdom_seat", "owner-a", "kingdom-a", [0, 0]);
    const personal = flag("banner", "personal", "owner-a", null, [7, 0]);
    const contributed = flag("banner", "kingdom", "owner-a", "kingdom-a", [7, 0]);
    const realtime = upsertFlagSnapshot(
      [seat.snapshot, personal.snapshot], contributed.snapshot
    ).map(fromSnapshot);
    const reconnect = [seat, contributed];

    expect(renderGroups(realtime)).toEqual(renderGroups(reconnect));
    expect(renderGroups(reconnect)).toHaveLength(1);
  });

  it("unions only Avery's Seat and absorbed A-overlaps across realtime and reconnect", () => {
    const a = flag("a", "kingdom_seat", "avery", "kingdom-a", [0, 0]);
    const b = flag("b", "kingdom", "avery", "kingdom-a", [7, 0]);
    const c = flag("c", "kingdom", "avery", "kingdom-a", [-7, 0]);
    const d = flag("d", "personal", "avery", null, [40, 0]);
    const other = flag("other", "personal", "other-player", null, [0, 7]);
    const before = [
      flag("a", "personal", "avery", null, [0, 0]),
      flag("b", "personal", "avery", null, [7, 0]),
      flag("c", "personal", "avery", null, [-7, 0]),
      d,
      other
    ];
    const realtimeSnapshots = [a, b, c].reduce(
      (flags, converted) => upsertFlagSnapshot(flags, converted.snapshot),
      before.map(({ snapshot }) => snapshot)
    );
    const realtime = realtimeSnapshots.map((snapshot) => {
      const geometry = [a, b, c, d, other].find(({ id }) => id === snapshot.id)!;
      return { ...geometry, snapshot };
    });
    const reconnect = [a, b, c, d, other];

    expect(renderGroups(realtime)).toEqual(renderGroups(reconnect));
    const groups = renderGroups(reconnect);
    expect(groups.map(({ ownerId }) => ownerId).sort()).toEqual([
      "kingdom:kingdom-a",
      "player:avery",
      "player:other-player"
    ]);
    const kingdom = groups.find(({ ownerId }) => ownerId === "kingdom:kingdom-a")!;
    expect(kingdom.polygons).toHaveLength(1);
    expect(polygonToPathCommands(kingdom.polygons[0]!).filter(({ type }) => type === "moveTo"))
      .toHaveLength(1);
  });
});

type RenderFlag = {
  id: string;
  controlType: FlagSnapshot["controlType"];
  ownerId: string;
  kingdomId: string | null;
  center: [number, number];
  snapshot: FlagSnapshot;
};

function flag(
  id: string,
  controlType: FlagSnapshot["controlType"],
  ownerId: string,
  kingdomId: string | null,
  center: [number, number]
): RenderFlag {
  const snapshot = {
    id, controlType, ownerId, kingdomId, cityId: null, ownerColor: "#38bdf8",
    kingdomColor: kingdomId ? "#22c55e" : null
  } as FlagSnapshot;
  return { id, controlType, ownerId, kingdomId, center, snapshot };
}

function fromSnapshot(snapshot: FlagSnapshot): RenderFlag {
  return {
    id: snapshot.id,
    controlType: snapshot.controlType,
    ownerId: snapshot.ownerId,
    kingdomId: snapshot.kingdomId ?? null,
    center: snapshot.id === "seat" ? [0, 0] : [7, 0],
    snapshot
  };
}

function renderGroups(flags: RenderFlag[]) {
  return mergeOwnerTerritoriesWithBoundaries(flags.map((flag): TerritoryClaimShape => ({
    id: flag.id,
    ownerId: flagTerritoryControllerKey(flag.snapshot),
    ownerColor: flag.kingdomId ? "#22c55e" : "#38bdf8",
    center: flag.center,
    radius: 10,
    ring: createCircleRing(flag.center, 10, 64)
  })));
}
