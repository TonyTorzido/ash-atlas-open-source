import type { MilitaryBomberChannelSnapshot, MilitaryUnitGroupSnapshot } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { militaryWorldArtSlot, militaryWorldCountdownLabel } from "./militaryWorldPresentation.js";

const now = Date.parse("2026-01-01T00:00:00.000Z");

describe("military world countdown presentation", () => {
  it("uses server packing deadlines and preserves Finalizing at local zero", () => {
    const group = makeGroup({
      locationState: "PACKING_UP",
      packingCompletesAt: new Date(now + 2_100).toISOString()
    });
    expect(militaryWorldCountdownLabel(group, null, now)).toBe("Packing up · 2.1s");
    expect(militaryWorldCountdownLabel(group, null, now + 2_100)).toBe("Finalizing…");
  });

  it("uses the matching Bomber planting channel only", () => {
    const group = makeGroup({ unitType: "bomber", locationState: "DEPLOYED_FIELD" });
    const channel: MilitaryBomberChannelSnapshot = {
      requestId: "request-1",
      groupId: group.groupId,
      targetFlagId: "flag-1",
      startedAt: new Date(now).toISOString(),
      completesAt: new Date(now + 5_000).toISOString()
    };
    expect(militaryWorldCountdownLabel(group, channel, now)).toBe("Planting Bomb · 5.0s");
    expect(militaryWorldCountdownLabel({ ...group, groupId: "other" }, channel, now)).toBeNull();
  });
});

describe("military world art state", () => {
  it("selects the five independently editable authoritative states", () => {
    const siege = makeGroup({ unitType: "field_ballista" });
    expect(militaryWorldArtSlot({ ...siege, locationState: "PACKED_FIELD" }, null)).toBe("military-siege-packed");
    expect(militaryWorldArtSlot(siege, null)).toBe("military-siege-deployed");
    expect(militaryWorldArtSlot(siege, null, [
      { groupId: siege.groupId, occurredAt: now - 250 }
    ], now)).toBe("military-siege-launch");
    expect(militaryWorldArtSlot(siege, null, [
      { groupId: siege.groupId, occurredAt: now - 999 }
    ], now)).toBe("military-siege-launch");
    expect(militaryWorldArtSlot(siege, null, [
      { groupId: siege.groupId, occurredAt: now - 1000 }
    ], now)).toBe("military-siege-deployed");
    expect(militaryWorldArtSlot(siege, null, [
      { groupId: "other", occurredAt: now - 250 }
    ], now)).toBe("military-siege-deployed");

    const bomber = makeGroup({ unitType: "bomber" });
    expect(militaryWorldArtSlot(bomber, null)).toBe("military-bomber-idle");
    expect(militaryWorldArtSlot(bomber, {
      requestId: "request-1",
      groupId: bomber.groupId,
      targetFlagId: "flag-1",
      startedAt: new Date(now).toISOString(),
      completesAt: new Date(now + 5_000).toISOString()
    })).toBe("military-bomber-planting");
    expect(militaryWorldArtSlot({ ...bomber, groupId: "other" }, {
      requestId: "request-1",
      groupId: bomber.groupId,
      targetFlagId: "flag-1",
      startedAt: new Date(now).toISOString(),
      completesAt: new Date(now + 5_000).toISOString()
    })).toBe("military-bomber-idle");
  });
});

function makeGroup(
  overrides: Partial<MilitaryUnitGroupSnapshot> = {}
): MilitaryUnitGroupSnapshot {
  return {
    groupId: "group-1",
    ownerPlayerId: "player-1",
    unitType: "field_ballista",
    memberUnitIds: ["unit-1"],
    memberCount: 1,
    currentHp: 100,
    maxHp: 100,
    locationState: "DEPLOYED_FIELD",
    stationCityId: null,
    warCampId: null,
    lat: 0,
    lon: 0,
    targetFlagId: null,
    nextFireAt: null,
    packingCompletesAt: null,
    revision: "1",
    ...overrides
  };
}
