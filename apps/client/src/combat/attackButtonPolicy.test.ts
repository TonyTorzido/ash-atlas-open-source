import { describe, expect, it } from "vitest";

import { attackButtonAllowedIn } from "./attackButtonPolicy.js";

describe("attack button policy", () => {
  it("hides the attack button in the manor, salon and greenhouse and keeps it in the world and dungeons", () => {
    expect(attackButtonAllowedIn("manor")).toBe(false);
    expect(attackButtonAllowedIn("salon")).toBe(false);
    expect(attackButtonAllowedIn("greenhouse")).toBe(false);
    expect(attackButtonAllowedIn("world")).toBe(true);
    expect(attackButtonAllowedIn("dungeon")).toBe(true);
    expect(attackButtonAllowedIn("cistern_warrens")).toBe(true);
  });
});
