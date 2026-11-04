import { describe, expect, it } from "vitest";

import {
  INITIAL_CELEBRATION_QUEUE,
  achievementCard,
  celebrationAnnouncement,
  celebrationCardsFor,
  enqueueCelebrations,
  finishCelebration,
  interruptCelebration,
  startNextCelebration
} from "./celebrationQueue.js";

const celebration = {
  biome: "plains" as const,
  achievements: [
    { id: "legend_region_plains", title: "Endless Horizon", points: 10 },
    { id: "legend_regions_3", title: "New Horizons", points: 10, honor: "Trailblazer" }
  ]
};

describe("celebration queue", () => {
  it("builds a region card from the region achievement, then a card per tier unlock", () => {
    const cards = celebrationCardsFor(celebration);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      key: "region:plains", eyebrow: "NEW REGION DISCOVERED", title: "Endless Horizon", points: 10, honor: null
    });
    expect(cards[1]).toMatchObject({
      eyebrow: "ACHIEVEMENT UNLOCKED", title: "New Horizons", points: 10, honor: "Trailblazer"
    });
  });

  it("still celebrates a region that completed no achievement", () => {
    const [card] = celebrationCardsFor({ biome: "tundra", achievements: [] });
    expect(card).toMatchObject({ eyebrow: "NEW REGION DISCOVERED", title: "Tundra", points: null });
  });

  it("plays cards one at a time, in order, and never twice", () => {
    let state = enqueueCelebrations(INITIAL_CELEBRATION_QUEUE, celebrationCardsFor(celebration));
    state = startNextCelebration(state);
    expect(state.current?.key).toBe("region:plains");
    expect(startNextCelebration(state)).toBe(state);
    state = startNextCelebration(finishCelebration(state));
    expect(state.current?.key).toBe("achievement:legend_regions_3");
    state = finishCelebration(state);
    expect(enqueueCelebrations(state, celebrationCardsFor(celebration))).toBe(state);
    expect(startNextCelebration(state)).toBe(state);
  });

  it("returns an interrupted card to the front of the queue", () => {
    let state = enqueueCelebrations(INITIAL_CELEBRATION_QUEUE, celebrationCardsFor(celebration));
    state = interruptCelebration(startNextCelebration(state));
    expect(state.current).toBeNull();
    expect(state.queue.map((card) => card.key)).toEqual(["region:plains", "achievement:legend_regions_3"]);
    expect(interruptCelebration(state)).toBe(state);
  });

  it("announces one sentence per card", () => {
    const [region, tier] = celebrationCardsFor(celebration);
    expect(celebrationAnnouncement(region!)).toBe("New region discovered. Endless Horizon. Plus 10 points.");
    expect(celebrationAnnouncement(tier!)).toBe(
      "Achievement unlocked. New Horizons. Plus 10 points. Honor: Trailblazer."
    );
    expect(celebrationAnnouncement(achievementCard("bitter_blood", "Bitter Blood")))
      .toBe("Achievement unlocked. Bitter Blood.");
  });
});
