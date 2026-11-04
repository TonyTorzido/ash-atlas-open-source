import { describe, expect, it } from "vitest";
import { mobArtworkKeysForBiome } from "./mobArtworkPrefetch.js";

describe("mob artwork prefetch roster", () => {
  it("lists the artwork of the mobs that spawn in a biome", () => {
    const savanna = mobArtworkKeysForBiome("savanna");
    expect(savanna.length).toBeGreaterThan(2);
    expect(new Set(savanna).size).toBe(savanna.length);
  });

  it("is empty for an unknown biome", () => {
    expect(mobArtworkKeysForBiome("nowhere")).toEqual([]);
  });
});
