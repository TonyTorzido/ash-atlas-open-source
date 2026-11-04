import { describe, expect, it } from "vitest";

import {
  decodePersistedHotbarSlots,
  hotbarBindingSchema,
  preserveHotbarActionBindings,
  stripHotbarActionBindings,
  type HotbarSettings,
  fitHotbarLayoutGeometry,
  HOTBAR_LEGACY_PLAYER_SLOT_IDS,
  HOTBAR_PLAYER_SLOT_IDS,
  hotbarRowAnchorConstraints,
  defaultHotbarSettings,
  hotbarUpdateSchema,
  normalizeHotbarLayout,
  normalizeHotbarLayoutForPersistence,
  normalizeHotbarRowPositionUpdate,
  normalizeHotbarRowPositions
} from "./hotbar.js";

function slots() {
  return HOTBAR_PLAYER_SLOT_IDS.map((slotId) => ({ slotId, binding: null }));
}

describe("hotbar shared contract", () => {
  it("defaults to ten player slots with builder and heal in the bottom row, never core", () => {
    const settings = defaultHotbarSettings();
    expect(settings.revision).toBe(0);
    expect(settings.slots).toHaveLength(10);
    expect(settings.slots.map((slot) => slot.slotId)).toEqual([...HOTBAR_PLAYER_SLOT_IDS]);
    expect(settings.slots.some((slot) => (slot.slotId as string) === "core")).toBe(false);
    expect(settings.rowCount).toBe(4);
    expect(settings.rowPositions).toEqual([44, 58, 72, 86, 100]);
    expect(settings.slots.filter((slot) => slot.binding !== null)).toEqual([
      { slotId: "left-4", binding: { kind: "action", actionId: "anchor_build" } },
      { slotId: "right-4", binding: { kind: "consumable", itemId: "giving_berry", variant: null } }
    ]);
  });

  it("rejects reserved, duplicate, incomplete, and unsafe revision updates", () => {
    expect(hotbarUpdateSchema.safeParse({ revision: 0, slots: [
      ...slots().slice(0, 5),
      { slotId: "core", binding: null }
    ] }).success).toBe(false);
    expect(hotbarUpdateSchema.safeParse({ revision: 0, slots: [
      ...slots().slice(0, 5),
      { slotId: "left-1", binding: null }
    ] }).success).toBe(false);
    expect(hotbarUpdateSchema.safeParse({
      revision: 0,
      slots: HOTBAR_LEGACY_PLAYER_SLOT_IDS.map((slotId) => ({ slotId, binding: null }))
    }).success).toBe(false);
    expect(hotbarUpdateSchema.safeParse({ revision: Number.MAX_SAFE_INTEGER + 1, slots: slots() }).success).toBe(false);
  });

  it("accepts generic consumable, fishing rod, and future gear-scroll bindings", () => {
    const result = hotbarUpdateSchema.safeParse({
      revision: 3,
      slots: [
        { slotId: "left-1", binding: { kind: "consumable", itemId: "simple_food", variant: "default" } },
        { slotId: "left-2", binding: { kind: "fishing_rod", rodId: "rod-1" } },
        { slotId: "left-3", binding: { kind: "gear_scroll", scrollId: "scroll-1" } },
        ...slots().slice(3)
      ]
    });
    expect(result.success).toBe(true);
  });

  it("normalizes the legacy six-slot persisted shape only while decoding", () => {
    const legacy = HOTBAR_LEGACY_PLAYER_SLOT_IDS.map((slotId) => ({
      slotId,
      binding: slotId === "left-1"
        ? { kind: "consumable" as const, itemId: "simple_food", variant: "default" }
        : null
    }));
    expect(decodePersistedHotbarSlots(legacy)).toEqual([
      legacy[0], legacy[1], legacy[2],
      { slotId: "left-4", binding: null },
      { slotId: "left-5", binding: null },
      legacy[3], legacy[4], legacy[5],
      { slotId: "right-4", binding: null },
      { slotId: "right-5", binding: null }
    ]);
    expect(decodePersistedHotbarSlots([
      ...legacy.slice(0, 5),
      { slotId: "left-1", binding: null }
    ])).toBeNull();
  });

  it("normalizes visible row count and keeps persisted row anchors separated", () => {
    expect(normalizeHotbarLayout(0, [90, 90, 90, 90, 90])).toEqual({
      rowCount: 0,
      rowPositions: [90, 90, 90, 90, 90]
    });
    expect(normalizeHotbarLayout(5, [0, 0, 0, 0, 0]).rowPositions).toEqual([0, 17.5, 35, 52.5, 70]);
    expect(normalizeHotbarLayout(99, [-20, 0, 4, 200, Number.NaN]).rowCount).toBe(5);
  });

  it("sanitizes durable anchors without applying a stale fallback geometry", () => {
    expect(normalizeHotbarLayoutForPersistence(5, [60, 68, 76, 85, 93])).toEqual({
      rowCount: 5,
      rowPositions: [60, 68, 76, 85, 93]
    });
  });

  it("normalizes one moved row immediately without allowing a rendered overlap", () => {
    const next = normalizeHotbarRowPositionUpdate(4, [0, 21, 42, 63, 84], 3, 10);

    expect(next).toEqual([0, 17.5, 35, 52.5, 84]);
    expect(next.slice(0, 4).every((position, index, visible) =>
      index === 0 || position - visible[index - 1]! >= 17.5
    )).toBe(true);
  });

  it("derives anchor separation from the rendered tile footprint and bottom track", () => {
    const geometry = { trackHeight: 250, rowHeight: 48, rowGap: 8 };
    const constraints = hotbarRowAnchorConstraints(geometry, 4);
    const positions = normalizeHotbarLayout(4, [0, 52, 64, 76, 84], geometry).rowPositions;
    const tops = positions.slice(0, 4).map((position) => position / 100 * geometry.trackHeight);

    expect(constraints.minAnchorGap).toBeCloseTo(22.4);
    expect(positions).toEqual([0, 36, 58.4, 80.8, 84]);
    expect(tops.every((top, index) => index === 0 || top - tops[index - 1]! >= geometry.rowHeight + geometry.rowGap - 0.01)).toBe(true);
    expect(tops[tops.length - 1]! + geometry.rowHeight).toBeLessThanOrEqual(geometry.trackHeight + 0.01);
  });

  it("lets a moved row keep its requested anchor by shifting neighbors inside the track", () => {
    const geometry = { trackHeight: 250, rowHeight: 48, rowGap: 8 };
    const next = normalizeHotbarRowPositionUpdate(4, [0, 52, 64, 76, 84], 3, 70, geometry);

    expect(next).toEqual([0, 25.2, 47.6, 70, 84]);
    expect(next.slice(0, 4).every((position, index, visible) =>
      index === 0 || position - visible[index - 1]! >= 22.4
    )).toBe(true);
  });

  it("fits every supported visible row count inside an adequate usable track", () => {
    const geometry = { trackHeight: 320, rowHeight: 48, rowGap: 8 };
    for (let count = 1; count <= 5; count += 1) {
      const positions = normalizeHotbarRowPositions(count, [0, 0, 0, 0, 0], geometry).slice(0, count);
      const tops = positions.map((position) => position / 100 * geometry.trackHeight);
      expect(tops[tops.length - 1]! + geometry.rowHeight).toBeLessThanOrEqual(geometry.trackHeight + 0.01);
      expect(tops.every((top, index) => index === 0 || top - tops[index - 1]! >= geometry.rowHeight + geometry.rowGap - 0.01)).toBe(true);
    }
  });

  it("keeps a short five-row mobile track separated by fitting the measured footprint", () => {
    const fitted = fitHotbarLayoutGeometry({ trackHeight: 250, rowHeight: 48, rowGap: 8 }, 5);
    const positions = normalizeHotbarRowPositions(5, [0, 0, 0, 0, 0], fitted).slice(0, 5);
    const tops = positions.map((position) => position / 100 * fitted.trackHeight);

    expect(fitted.rowHeight).toBeCloseTo(46.8);
    expect(fitted.rowGap).toBe(4);
    expect(tops.every((top, index) => index === 0 || top - tops[index - 1]! >= fitted.rowHeight + (fitted.rowGap ?? 0) - 0.01)).toBe(true);
    expect(tops.at(-1)! + fitted.rowHeight).toBeLessThanOrEqual(fitted.trackHeight + 0.01);
  });

  it("keeps tall desktop anchors in a compact footprint while preserving the rendered gap", () => {
    const geometry = {
      trackHeight: 640,
      rowHeight: 64,
      rowGap: 8,
      compactTrackHeight: 384
    };
    const positions = normalizeHotbarRowPositions(5, [0, 21, 42, 63, 84], geometry).slice(0, 5);
    const tops = positions.map((position) => position / 100 * geometry.trackHeight);

    expect(hotbarRowAnchorConstraints(geometry, 5)).toEqual({
      maxAnchor: 50,
      minAnchorGap: 11.25
    });
    expect(positions).toEqual([0, 11.25, 22.5, 33.75, 45]);
    expect(tops.at(-1)! - tops[0]!).toBe(288);
    expect(tops.every((top, index) => index === 0 || top - tops[index - 1]! >= geometry.rowHeight + geometry.rowGap - 0.01)).toBe(true);
    expect(tops.at(-1)! + geometry.rowHeight).toBeLessThanOrEqual(geometry.trackHeight + 0.01);
  });

  it("keeps pathological desktop movement bounded without overlapping neighboring rows", () => {
    const geometry = {
      trackHeight: 640,
      rowHeight: 64,
      rowGap: 8,
      compactTrackHeight: 384
    };
    const positions = normalizeHotbarRowPositionUpdate(4, [0, 52, 64, 76, 84], 3, 70, geometry).slice(0, 4);
    const tops = positions.map((position) => position / 100 * geometry.trackHeight);

    expect(positions).toEqual([0, 26, 37.25, 50]);
    expect(tops.every((top, index) => index === 0 || top - tops[index - 1]! >= geometry.rowHeight + geometry.rowGap - 0.01)).toBe(true);
    expect(tops.at(-1)! + geometry.rowHeight).toBeLessThanOrEqual(geometry.trackHeight + 0.01);
  });
});

describe("hotbar action bindings", () => {
  const withBuild = (): HotbarSettings => ({
    ...defaultHotbarSettings(),
    slots: HOTBAR_PLAYER_SLOT_IDS.map((slotId) => ({
      slotId,
      binding: slotId === "right-5" ? { kind: "action", actionId: "anchor_build" } as const : null
    }))
  });

  it("accepts the anchor_build action and rejects unknown actions", () => {
    expect(hotbarBindingSchema.safeParse({ kind: "action", actionId: "anchor_build" }).success).toBe(true);
    expect(hotbarBindingSchema.safeParse({ kind: "action", actionId: "teleport" }).success).toBe(false);
  });

  it("strips actions for older clients and preserves them across their saves", () => {
    const stripped = stripHotbarActionBindings(withBuild());
    expect(stripped.slots.every((slot) => slot.binding === null)).toBe(true);
    const preserved = preserveHotbarActionBindings({ revision: 0, slots: stripped.slots }, withBuild());
    expect(preserved.slots.find((slot) => slot.slotId === "right-5")?.binding).toEqual({ kind: "action", actionId: "anchor_build" });
  });
});
