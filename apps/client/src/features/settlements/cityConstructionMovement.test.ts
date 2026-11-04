import type { CityActiveConstructionSnapshot } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { blocksClientMovement } from "./cityConstructionMovement.js";

const construction = (action: CityActiveConstructionSnapshot["action"]): CityActiveConstructionSnapshot => ({
  operationKey: "operation",
  requestId: "request",
  action,
  structureId: "00000000-0000-4000-8000-000000000001",
  anchor: { lat: 35, lon: -106 },
  constructionStartedAt: "2026-07-31T00:00:00.000Z",
  constructionCompletesAt: "2026-07-31T00:00:30.000Z"
});

describe("city construction movement policy", () => {
  it("lets Oil Well movement reach the server cancellation path", () => {
    expect(blocksClientMovement(construction("build_oil_well"))).toBe(false);
  });

  it("preserves stationary construction for other city buildings", () => {
    expect(blocksClientMovement(construction("build_house"))).toBe(true);
    expect(blocksClientMovement(null)).toBe(false);
  });
});
