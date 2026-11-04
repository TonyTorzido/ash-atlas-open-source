import { describe, expect, it } from "vitest";

import {
  GATHER_REACTION_TUNING,
  GatherTargetReactions,
  collectibleAtGatherTarget,
  gatherReactionKind,
  sampleGatherReaction,
  type GatherReactionPose
} from "./gatherTargetReactions.js";

const pose = (): GatherReactionPose => ({ skewX: 0, scaleY: 1, offsetX: 0 });
const marker = () => ({ destroyed: false, skew: { x: 0 }, scale: { y: 1 }, pivot: { x: 0 } });

describe("gather target reactions", () => {
  it("maps actions to reactions: trees shake, rocks jolt, plants rustle, nothing else", () => {
    expect(gatherReactionKind("chop")).toBe("tree");
    expect(gatherReactionKind("mine")).toBe("rock");
    expect(gatherReactionKind("harvest")).toBe("plant");
    expect(gatherReactionKind("fish")).toBeNull();
    expect(gatherReactionKind("flag")).toBeNull();
  });

  it("moves on the impact frame, away from the strike, and settles to the untouched art", () => {
    const out = pose();
    sampleGatherReaction("tree", 0, 1, out);
    // Negative skew leans the top to the right (away from a player on the left).
    expect(out.skewX).toBeLessThan(0);
    sampleGatherReaction("rock", 0, -1, out);
    expect(out.offsetX).toBeLessThan(0);
    expect(out.skewX).toBe(0);
    expect(sampleGatherReaction("plant", 0, 1, out)).toBe(true);
    expect(out.scaleY).toBeLessThan(1);
    for (const kind of ["tree", "plant", "rock"] as const) {
      expect(sampleGatherReaction(kind, GATHER_REACTION_TUNING[kind].durationMs, 1, out)).toBe(false);
      expect(out).toEqual(pose());
      // Continuous into the end: the last running frame is already nearly still.
      sampleGatherReaction(kind, GATHER_REACTION_TUNING[kind].durationMs - 1, 1, out);
      expect(Math.abs(out.skewX)).toBeLessThan(0.002);
      expect(Math.abs(out.offsetX)).toBeLessThan(0.05);
    }
  });

  it("keeps the rock tight and quick, and the plant lighter and quicker than the tree", () => {
    const out = pose();
    let maxRock = 0;
    for (let t = 0; t < GATHER_REACTION_TUNING.rock.durationMs; t += 4) {
      sampleGatherReaction("rock", t, 1, out);
      maxRock = Math.max(maxRock, Math.abs(out.offsetX));
    }
    expect(maxRock).toBeLessThanOrEqual(2);
    expect(GATHER_REACTION_TUNING.rock.durationMs).toBeLessThanOrEqual(150);
    expect(GATHER_REACTION_TUNING.plant.durationMs).toBeLessThan(GATHER_REACTION_TUNING.tree.durationMs);
    expect(GATHER_REACTION_TUNING.plant.hz).toBeGreaterThan(GATHER_REACTION_TUNING.tree.hz);
  });

  it("transforms only the struck marker and restores it exactly", () => {
    const reactions = new GatherTargetReactions();
    const struck = marker();
    const other = marker();
    const markers = new Map([["tree-1", struck], ["tree-2", other]]);
    let lookups = 0;
    const lookup = (id: string) => {
      lookups += 1;
      return markers.get(id);
    };
    reactions.update(0, lookup);
    expect(lookups).toBe(0);
    reactions.trigger("tree-1", "tree", 1, 1000);
    reactions.update(1000, lookup);
    expect(struck.skew.x).not.toBe(0);
    expect(other).toEqual(marker());
    reactions.update(1000 + GATHER_REACTION_TUNING.tree.durationMs, lookup);
    expect(struck).toEqual(marker());
    expect(reactions.size).toBe(0);
  });

  it("restores a marker that was replaced mid-reaction", () => {
    const reactions = new GatherTargetReactions();
    const first = marker();
    const second = marker();
    let current = first;
    reactions.trigger("rock-1", "rock", 1, 0);
    reactions.update(0, () => current);
    expect(first.pivot.x).not.toBe(0);
    current = second;
    reactions.update(10, () => current);
    expect(first).toEqual(marker());
    reactions.clear();
    expect(second).toEqual(marker());
  });

  it("finds the worked collectible at a remote gathering target", () => {
    const collectibles = [
      { id: "a", lat: 10, lon: 20 },
      { id: "b", lat: 10.000001, lon: 20.000001 }
    ];
    expect(collectibleAtGatherTarget(collectibles, { lat: 10, lon: 20 })).toBe("a");
    expect(collectibleAtGatherTarget(collectibles, { lat: 10.0000012, lon: 20.0000011 })).toBe("b");
    expect(collectibleAtGatherTarget(collectibles, { lat: 11, lon: 20 })).toBeNull();
  });
});
