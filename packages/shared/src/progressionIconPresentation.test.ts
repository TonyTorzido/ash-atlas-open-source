import { describe, expect, it } from "vitest";

import {
  PROGRESSION_ICON_PRESENTATION_CATALOG,
  PROGRESSION_ICON_REGISTRY,
  parseProgressionIconPresentationCatalog,
  progressionIconRegistryEntry,
  progressionIconTransformCss
} from "./progressionIconPresentation.js";

describe("progression icon presentation", () => {
  it("covers the canonical registry exactly and rejects key drift", () => {
    expect(Object.keys(PROGRESSION_ICON_PRESENTATION_CATALOG.transforms).sort())
      .toEqual(PROGRESSION_ICON_REGISTRY.map((entry) => entry.key).sort());
    const invalid = structuredClone(PROGRESSION_ICON_PRESENTATION_CATALOG);
    delete invalid.transforms[PROGRESSION_ICON_REGISTRY[0]!.key];
    expect(() => parseProgressionIconPresentationCatalog(invalid)).toThrow(/key set/u);
  });

  it("owns atlas placement and shared render math", () => {
    expect(progressionIconRegistryEntry("general", "archery")).toMatchObject({ index: 8, columns: 5 });
    expect(progressionIconTransformCss({ offsetX: 0.1, offsetY: -0.2, scale: 1.25 }, 40, 100))
      .toBe("translate(4px, -8px) scale(0.5)");
  });
});
