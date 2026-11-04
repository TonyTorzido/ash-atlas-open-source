import { MANOR_INTERIOR_SPACE, type InteriorCatalog } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import type { AuthoringView } from "./interiorAuthoring.js";
import { applyModuleEdits, effectiveManorExterior, moduleAssetKeys, setManorExterior } from "./interiorModules.js";

const interior = { spaces: [MANOR_INTERIOR_SPACE] } as unknown as InteriorCatalog;

describe("Manor type overworld building module", () => {
  it("stages an exterior edit, merges it into modules.manor and publishes its PNG", () => {
    const space = interior.spaces.find((candidate) => candidate.id === "manor_lobby")!;
    const sources = { base: interior, seeds: {} };
    const view = {} as AuthoringView;
    const assetKey = "apps/client/public/assets/manor/manor_lobby-exterior-test.png";
    setManorExterior(view, sources, space.id, { exteriorAssetKey: assetKey, exteriorScale: 1.25 });
    expect(effectiveManorExterior(view, sources, space.id)).toEqual({ exteriorAssetKey: assetKey, exteriorScale: 1.25 });
    const merged = applyModuleEdits(space, view.interiorModules?.[space.id]);
    expect(merged.modules?.manor).toEqual({ exteriorAssetKey: assetKey, exteriorScale: 1.25 });
    expect(moduleAssetKeys(merged)).toContain(assetKey);
  });
});
