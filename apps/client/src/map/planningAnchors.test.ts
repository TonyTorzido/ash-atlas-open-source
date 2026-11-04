import { describe, expect, it } from "vitest";

import {
  addPlanningAnchor,
  addPlanningAnchorLayer,
  EMPTY_PLANNING_ANCHORS,
  readPlanningAnchors,
  removePlanningAnchor,
  selectPlanningAnchorLayer,
  setPlanningAnchorLayerVisibility,
  validatePlanningAnchorDistance,
  writePlanningAnchors,
  type PlanningAnchorSource
} from "./planningAnchors.js";

const source: PlanningAnchorSource = {
  kind: "flag",
  id: "flag-1",
  label: "Test Tower",
  position: { lat: 35, lon: -106 }
};

describe("device-local planning anchors", () => {
  it("accepts only positive bounded distances and keeps meter precision", () => {
    expect(validatePlanningAnchorDistance(0)).toBeNull();
    expect(validatePlanningAnchorDistance(-1)).toBeNull();
    expect(validatePlanningAnchorDistance(Number.POSITIVE_INFINITY)).toBeNull();
    expect(validatePlanningAnchorDistance(12.345)).toBe(12.35);
    expect(validatePlanningAnchorDistance(100_001)).toBeNull();
  });

  it("persists selected layer and visibility with saved anchors", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string): string | null => values.get(key) ?? null,
      setItem: (key: string, value: string): void => { values.set(key, value); }
    };
    const settings = addPlanningAnchorLayer(EMPTY_PLANNING_ANCHORS, "Siege plan", "siege");
    const selected = selectPlanningAnchorLayer(settings, "siege");
    const hidden = setPlanningAnchorLayerVisibility(selected, "main", false);
    const saved = addPlanningAnchor(hidden, {
      id: "anchor-1",
      source,
      distanceM: 575,
      position: { lat: 35.005, lon: -106 },
      createdAt: 123
    });
    writePlanningAnchors(storage, "planning", saved);

    expect(readPlanningAnchors(storage, "planning")).toEqual(saved);
    expect(readPlanningAnchors(storage, "planning").selectedLayerId).toBe("siege");
    expect(readPlanningAnchors(storage, "planning").layers.find((layer) => layer.id === "main")?.visible).toBe(false);
  });

  it("removes only the selected anchor", () => {
    const first = addPlanningAnchor(EMPTY_PLANNING_ANCHORS, {
      id: "anchor-1",
      source,
      distanceM: 575,
      position: { lat: 35.005, lon: -106 }
    });
    const both = addPlanningAnchor(first, {
      id: "anchor-2",
      source: { ...source, id: "flag-2", label: "Test Soft Flag" },
      distanceM: 100,
      position: { lat: 35.001, lon: -106 }
    });

    expect(removePlanningAnchor(both, "anchor-1").anchors.map((anchor) => anchor.id)).toEqual(["anchor-2"]);
    expect(removePlanningAnchor(both, "unknown")).toBe(both);
  });

  it("keeps stable layer numbers and enforces the three-layer device cap", () => {
    const first = addPlanningAnchor(EMPTY_PLANNING_ANCHORS, {
      id: "anchor-1",
      source,
      distanceM: 575,
      position: { lat: 35.005, lon: -106 }
    });
    const second = addPlanningAnchor(first, {
      id: "anchor-2",
      source,
      distanceM: 100,
      position: { lat: 35.001, lon: -106 }
    });
    expect(second.anchors.map((anchor) => anchor.number)).toEqual([1, 2]);
    const removed = removePlanningAnchor(second, "anchor-1");
    const third = addPlanningAnchor(removed, {
      id: "anchor-3",
      source,
      distanceM: 200,
      position: { lat: 35.002, lon: -106 }
    });
    expect(third.anchors.find((anchor) => anchor.id === "anchor-2")?.number).toBe(2);
    expect(third.anchors.find((anchor) => anchor.id === "anchor-3")?.number).toBe(3);

    const withSecondLayer = addPlanningAnchorLayer(second, "Second", "second");
    const withThirdLayer = addPlanningAnchorLayer(withSecondLayer, "Third", "third");
    expect(withThirdLayer.layers).toHaveLength(3);
    expect(addPlanningAnchorLayer(withThirdLayer, "Fourth", "fourth")).toBe(withThirdLayer);
    expect(withThirdLayer.layers.find((layer) => layer.id === "main")?.visible).toBe(false);
  });
});
