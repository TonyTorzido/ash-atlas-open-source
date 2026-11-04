import { describe, expect, it } from "vitest";

import { ProfessionSkillV3Service } from "./professionSkillService.js";

describe("ProfessionSkillV3Service", () => {
  it("exposes the intentionally empty Alchemy recipe seam", () => {
    const service = new ProfessionSkillV3Service();

    expect(service.alchemyRecipes()).toEqual([]);
    expect(Object.isFrozen(service.alchemyRecipes())).toBe(true);
  });
});
