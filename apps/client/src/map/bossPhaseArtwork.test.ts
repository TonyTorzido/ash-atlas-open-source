import { describe, expect, it } from "vitest";

import { bossPhaseArtworkKey, mobArtworkKey } from "./mobArtwork.js";

describe("boss phase art", () => {
  it("maps (archetype, phase) to the phase sprite and falls back to the base art", () => {
    expect(bossPhaseArtworkKey("the_watcher", "second_watch_shielded")).toBe("theWatcherShielded");
    expect(bossPhaseArtworkKey("the_watcher", "second_watch")).toBeNull();
    expect(bossPhaseArtworkKey("tidemaw", "submerged")).toBe("tidemawSubmerged");
    expect(bossPhaseArtworkKey("tidemaw", "surfaced")).toBeNull();
    expect(bossPhaseArtworkKey("drowned_admiral", "harpoon")).toBe("drownedAdmiralHarpoon");
    expect(bossPhaseArtworkKey("drowned_admiral", "anchor")).toBe("drownedAdmiralAnchor");
    expect(bossPhaseArtworkKey("drowned_admiral", "cutlass")).toBeNull();
    expect(bossPhaseArtworkKey("abyssal_one", "weakened")).toBe("abyssalOneWeakened");
    expect(bossPhaseArtworkKey("hollow_elder", "weakened")).toBeNull();
    expect(bossPhaseArtworkKey("tidemaw", null)).toBeNull();
    // The fallback is the archetype's base art.
    expect(mobArtworkKey("drowned_admiral")).toBe("drownedAdmiral");
    expect(mobArtworkKey("tidemaw")).toBe("tidemaw");
  });
});
