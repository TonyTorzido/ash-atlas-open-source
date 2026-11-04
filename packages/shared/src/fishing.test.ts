import { describe, expect, it } from "vitest";

import {
  FISHING_BASE_CAST_RANGE_M,
  FISHING_BEHAVIOR_PROFILES,
  FISHING_HUT_BUILD_DURATION_MS,
  FISHING_HUT_MAX_WATER_DISTANCE_M,
  FISHING_HUT_PASSIVE_CAPACITY,
  FISHING_HUT_PASSIVE_INTERVAL_MS,
  FISHING_MAX_CAST_RANGE_M,
  FISHING_UPGRADE_EFFECTS,
  FISHING_STAMINA_LANDING_THRESHOLD,
  FISHING_STAMINA_MAX,
  fishingStaminaPercent,
  activeFoodAccumulatorContribution,
  activeFoodFromAccumulator,
  advanceFishingFight,
  fishingBiteEventAt,
  fishingBiteTimeline,
  fishingBehaviorAt,
  fishingCatchScore,
  fishingFightCanLand,
  fishingFightSnapped,
  fishingHookTiming,
  fishingRodMarketIdentity,
  passiveFishProducedSince,
  parseFishingRodMarketIdentity,
  passiveFishNextTimestampMs,
  selectFreshwaterWaterbody,
  selectFishingWaterbody,
  type FishingFightState
} from "./fishing.js";

describe("Fishing Rod market identities", () => {
  it("keeps the durable rod UUID in the canonical market identity", () => {
    const rodId = "00000000-0000-4000-8000-000000000840";
    expect(fishingRodMarketIdentity(rodId)).toBe(`fishing_rod:${rodId}`);
    expect(parseFishingRodMarketIdentity(`fishing_rod:${rodId.toUpperCase()}`)).toBe(rodId);
    expect(parseFishingRodMarketIdentity("fishing_rod")).toBeNull();
    expect(() => fishingRodMarketIdentity("default")).toThrow(/UUID/);
  });
});

describe("Freshwater Fishing V1 shared contract", () => {
  it("uses a 300m base cast and an exact 600m maximum at max range rank", () => {
    expect(FISHING_BASE_CAST_RANGE_M).toBe(300);
    expect(FISHING_MAX_CAST_RANGE_M).toBe(600);
    expect(FISHING_BASE_CAST_RANGE_M + FISHING_UPGRADE_EFFECTS.cast_range_m[3]!).toBe(FISHING_MAX_CAST_RANGE_M);
  });

  it("accepts an exact universal waterbody candidate through the upgraded range", () => {
    expect(selectFishingWaterbody({
      kind: "ocean",
      sourceId: "ocean-1",
      sourceName: "Atlantic Ocean",
      distanceM: 600,
      searchComplete: true,
      resolutionStatus: "resolved",
      sourceRevision: "world-r1"
    }, FISHING_MAX_CAST_RANGE_M)).toMatchObject({
      kind: "ocean",
      sourceId: "ocean-1",
      displayName: "Atlantic Ocean",
      distanceM: 600
    });
    expect(selectFishingWaterbody({
      kind: "ocean",
      sourceId: "too-far",
      sourceName: "Atlantic Ocean",
      distanceM: FISHING_MAX_CAST_RANGE_M + 0.01,
      searchComplete: true,
      resolutionStatus: "resolved"
    }, FISHING_MAX_CAST_RANGE_M)).toBeNull();
    expect(selectFishingWaterbody({
      kind: "river",
      sourceId: "base-too-far",
      sourceName: "River",
      distanceM: FISHING_BASE_CAST_RANGE_M + 0.01,
      searchComplete: true,
      resolutionStatus: "resolved"
    })).toBeNull();
  });

  it("accepts resolved and unresolved authoritative water classes without inventing identity", () => {
    expect(selectFishingWaterbody({
      kind: "river",
      sourceId: "river-1",
      sourceName: "Rio Grande",
      distanceM: 0,
      searchComplete: true,
      resolutionStatus: "resolved"
    })).toEqual({
      kind: "river",
      sourceId: "river-1",
      displayName: "Rio Grande",
      distanceM: 0,
      sourceRevision: null
    });

    const unresolved = [
      ["river", "Unnamed River"],
      ["lake", "Unnamed Lake"],
      ["ocean", "Open Ocean"]
    ] as const;
    for (const [kind, displayName] of unresolved) {
      expect(selectFishingWaterbody({
        kind,
        sourceId: null,
        sourceName: null,
        distanceM: 0,
        searchComplete: true,
        resolutionStatus: "unresolved"
      })).toEqual({ kind, sourceId: null, displayName, distanceM: 0, sourceRevision: null });
    }

    expect(selectFishingWaterbody({
      kind: "river",
      sourceId: null,
      sourceName: null,
      distanceM: 12,
      searchComplete: true,
      resolutionStatus: "unresolved",
      waterNameFallback: {
        name: "Grand River",
        referenceId: "river-name-1",
        waterClass: "river",
        distanceM: 12,
        authority: "water-names-v1"
      }
    })).toMatchObject({ kind: "river", sourceId: null, displayName: "Near Grand River" });

    expect(selectFishingWaterbody({
      kind: "lake",
      sourceId: "legacy-lake",
      sourceName: "Legacy Lake",
      distanceM: 0,
      searchComplete: true,
      resolutionStatus: "unresolved"
    })).toBeNull();
    expect(selectFishingWaterbody({
      kind: "lake",
      sourceId: null,
      sourceName: "Legacy Lake",
      distanceM: 0,
      searchComplete: true,
      resolutionStatus: "unresolved"
    })).toMatchObject({ kind: "lake", sourceId: null, displayName: "Unnamed Lake" });
    expect(selectFishingWaterbody({
      kind: "river",
      sourceId: null,
      sourceName: null,
      distanceM: 0,
      searchComplete: true,
      resolutionStatus: "invalid"
    })).toBeNull();
    expect(selectFishingWaterbody({
      kind: "inland_water",
      sourceId: null,
      sourceName: null,
      distanceM: 0,
      searchComplete: true,
      resolutionStatus: "unresolved"
    })).toBeNull();
    expect(selectFishingWaterbody({
      kind: "river",
      sourceId: null,
      sourceName: null,
      distanceM: 0,
      searchComplete: false,
      resolutionStatus: "unresolved"
    })).toBeNull();
  });

  it("uses a 30-second authoritative Fishing Hut build", () => {
    expect(FISHING_HUT_BUILD_DURATION_MS).toBe(30_000);
  });

  it("requires complete World freshwater identity and chooses the nearest source", () => {
    expect(selectFreshwaterWaterbody({
      isLand: true,
      isSaltwater: false,
      insideMajorLake: false,
      majorLakeId: "lake-far",
      majorLakeName: "Far Lake",
      majorLakeDistanceM: 400,
      majorLakeSearchComplete: true,
      namedRiverId: "river-near",
      namedRiverName: "Near River",
      riverDistanceM: 120,
      namedRiverSearchComplete: true,
      sourceRevision: "world-1"
    })).toMatchObject({
      kind: "river",
      sourceId: "river-near",
      displayName: "Near River",
      distanceM: 120,
      sourceRevision: "world-1"
    });
    expect(selectFreshwaterWaterbody({
      isLand: false,
      isSaltwater: false,
      insideMajorLake: true,
      majorLakeId: "lake-1",
      majorLakeName: "Lake",
      majorLakeDistanceM: 0,
      majorLakeSearchComplete: true,
      namedRiverId: null,
      namedRiverName: null,
      riverDistanceM: null,
      namedRiverSearchComplete: true
    })).toBeNull();
    expect(selectFreshwaterWaterbody({
      isLand: true,
      isSaltwater: true,
      insideMajorLake: true,
      majorLakeId: "lake-1",
      majorLakeName: "Lake",
      majorLakeDistanceM: 0,
      majorLakeSearchComplete: true,
      namedRiverId: null,
      namedRiverName: null,
      riverDistanceM: null,
      namedRiverSearchComplete: true
    })).toBeNull();
    expect(selectFreshwaterWaterbody({
      isLand: true,
      isSaltwater: false,
      insideMajorLake: false,
      majorLakeId: null,
      majorLakeName: null,
      majorLakeDistanceM: null,
      majorLakeSearchComplete: false,
      namedRiverId: "river-1",
      namedRiverName: "River",
      riverDistanceM: FISHING_HUT_MAX_WATER_DISTANCE_M + 0.01,
      namedRiverSearchComplete: true
    })).toBeNull();
    expect(selectFreshwaterWaterbody({
      isLand: true,
      isSaltwater: false,
      insideMajorLake: true,
      majorLakeId: "lake-unnamed",
      majorLakeName: "  ",
      majorLakeDistanceM: 0,
      majorLakeSearchComplete: true,
      namedRiverId: null,
      namedRiverName: null,
      riverDistanceM: null,
      namedRiverSearchComplete: true
    })).toMatchObject({ kind: "lake", sourceId: "lake-unnamed", displayName: "Unnamed Lake" });
  });

  it("lets the completed final grid decide adjacency, kind, and distance", () => {
    expect(selectFreshwaterWaterbody({
      isLand: false,
      isSaltwater: true,
      insideMajorLake: true,
      majorLakeId: "legacy-lake",
      majorLakeName: "Legacy Lake",
      majorLakeDistanceM: 1,
      majorLakeSearchComplete: true,
      namedRiverId: "legacy-river",
      namedRiverName: "Legacy River",
      riverDistanceM: 5_000,
      namedRiverSearchComplete: true,
      canonicalWaterbody: {
        kind: "river",
        sourceId: "river-grid-1",
        sourceName: "Rio Grande",
        distanceM: 90,
        searchComplete: true,
        resolutionStatus: "resolved",
        sourceRevision: "grid-r1"
      }
    })).toMatchObject({ kind: "river", sourceId: "river-grid-1", displayName: "Rio Grande", distanceM: 90 });
    expect(selectFreshwaterWaterbody({
      isLand: true,
      isSaltwater: false,
      insideMajorLake: false,
      majorLakeId: "legacy-lake",
      majorLakeName: "Legacy Lake",
      majorLakeDistanceM: 20,
      majorLakeSearchComplete: true,
      namedRiverId: "legacy-river",
      namedRiverName: "Legacy River",
      riverDistanceM: 20,
      namedRiverSearchComplete: true,
      canonicalWaterbody: {
        kind: "lake",
        sourceId: "lake-grid-1",
        sourceName: null,
        distanceM: 500,
        searchComplete: true,
        resolutionStatus: "resolved"
      }
    })).toMatchObject({ kind: "lake", sourceId: "lake-grid-1", displayName: "Unnamed Lake", distanceM: 500 });
    for (const kind of ["ocean", "inland_water", "unknown", null] as const) {
      expect(selectFreshwaterWaterbody({
        isLand: true,
        isSaltwater: false,
        insideMajorLake: true,
        majorLakeId: "legacy-lake",
        majorLakeName: "Legacy Lake",
        majorLakeDistanceM: 1,
        majorLakeSearchComplete: true,
        namedRiverId: "legacy-river",
        namedRiverName: "Legacy River",
        riverDistanceM: 1,
        namedRiverSearchComplete: true,
        canonicalWaterbody: {
          kind,
          sourceId: "blocked-grid",
          sourceName: null,
          distanceM: 1,
          searchComplete: true,
          resolutionStatus: "resolved"
        }
      })).toBeNull();
    }
    expect(selectFreshwaterWaterbody({
      isLand: true,
      isSaltwater: false,
      insideMajorLake: false,
      majorLakeId: null,
      majorLakeName: null,
      majorLakeDistanceM: null,
      majorLakeSearchComplete: false,
      namedRiverId: null,
      namedRiverName: null,
      riverDistanceM: null,
      namedRiverSearchComplete: false,
      canonicalWaterbody: {
        kind: "river",
        sourceId: "too-far",
        sourceName: "River",
        distanceM: FISHING_HUT_MAX_WATER_DISTANCE_M + 0.01,
        searchComplete: true,
        resolutionStatus: "resolved"
      }
    })).toBeNull();
  });

  it("fails closed for unresolved canonical identities, including ocean metadata", () => {
    for (const resolutionStatus of ["unresolved", "ambiguous", "invalid"] as const) {
      expect(selectFreshwaterWaterbody({
        isLand: true,
        isSaltwater: false,
        insideMajorLake: false,
        majorLakeId: null,
        majorLakeName: null,
        majorLakeDistanceM: null,
        majorLakeSearchComplete: false,
        namedRiverId: null,
        namedRiverName: null,
        riverDistanceM: null,
        namedRiverSearchComplete: false,
        canonicalWaterbody: {
          kind: "lake",
          sourceId: resolutionStatus === "invalid" ? null : "lake-ambiguous",
          sourceName: "Lake",
          distanceM: 0,
          searchComplete: true,
          resolutionStatus
        }
      })).toBeNull();
    }
    expect(selectFreshwaterWaterbody({
      isLand: false,
      isSaltwater: true,
      insideMajorLake: false,
      majorLakeId: null,
      majorLakeName: null,
      majorLakeDistanceM: null,
      majorLakeSearchComplete: false,
      namedRiverId: null,
      namedRiverName: null,
      riverDistanceM: null,
      namedRiverSearchComplete: false,
      canonicalWaterbody: {
        kind: "ocean",
        sourceId: "ocean-1",
        sourceName: "Atlantic Ocean",
        distanceM: 0,
        searchComplete: true,
        resolutionStatus: "resolved"
      }
    })).toBeNull();
  });

  it("caps passive production and advances the production cursor", () => {
    const last = 10_000;
    expect(passiveFishProducedSince(
      last,
      last + 20 * FISHING_HUT_PASSIVE_INTERVAL_MS,
      0
    )).toBe(FISHING_HUT_PASSIVE_CAPACITY);
    expect(passiveFishProducedSince(
      last,
      last + 4 * FISHING_HUT_PASSIVE_INTERVAL_MS,
      FISHING_HUT_PASSIVE_CAPACITY - 1
    )).toBe(1);
    expect(passiveFishNextTimestampMs(last, 3)).toBe(
      last + 3 * FISHING_HUT_PASSIVE_INTERVAL_MS
    );
  });

  it("gives active fish fractional food credit", () => {
    expect(activeFoodAccumulatorContribution(2.5)).toBe(63);
    expect(activeFoodFromAccumulator(1_240)).toEqual({ fish: 1, remainderMilli: 240 });
  });

  it("uses the expanded stamina pool while exposing a normalized meter value", () => {
    expect(FISHING_STAMINA_MAX).toBe(150);
    expect(FISHING_STAMINA_LANDING_THRESHOLD).toBe(25);
    expect(fishingStaminaPercent(FISHING_STAMINA_MAX)).toBe(100);
    expect(fishingStaminaPercent(FISHING_STAMINA_LANDING_THRESHOLD)).toBeCloseTo(16.6667, 3);
    expect(fishingStaminaPercent(0)).toBe(0);
  });

  it("uses deterministic fight state for landing and snap boundaries", () => {
    const safe = advanceFishingFight({
      distance: 13,
      stamina: 25,
      tension: 40,
      slackMs: 0,
      criticalMs: 0,
      fishDirection: "left",
      fishPull: 0.9
    }, { direction: "right", reeling: true, elapsedMs: 50 });
    expect(safe.distance).toBeLessThan(13);
    expect(safe.tension).toBeGreaterThan(40);
    const risky = advanceFishingFight({
      distance: 13,
      stamina: 25,
      tension: 40,
      slackMs: 0,
      criticalMs: 0,
      fishDirection: "left",
      fishPull: 0.9
    }, { direction: "left", reeling: true, elapsedMs: 50 });
    expect(risky.distance).toBeGreaterThan(13);
    expect(risky.tension).toBeGreaterThan(40);
    expect(safe.stamina).toBeLessThan(risky.stamina);
    const neutralReel = advanceFishingFight({
      distance: 50,
      stamina: FISHING_STAMINA_MAX,
      tension: 55,
      slackMs: 0,
      criticalMs: 0,
      fishDirection: "right",
      fishPull: 1
    }, { direction: "neutral", reeling: true, elapsedMs: 100 });
    expect(neutralReel.distance).toBeLessThan(50);
    const neutralFish = advanceFishingFight({
      distance: 50,
      stamina: 60,
      tension: 55,
      slackMs: 0,
      criticalMs: 0,
      fishDirection: "neutral",
      fishPull: 1
    }, { direction: "neutral", reeling: false, elapsedMs: 100 });
    expect(neutralFish.stamina).toBeGreaterThan(58);
    expect(fishingFightCanLand({
      distance: 10,
      stamina: 20,
      tension: 45,
      slackMs: 0,
      criticalMs: 0,
      fishDirection: "right",
      fishPull: 1
    })).toBe(true);
    expect(fishingFightCanLand({
      distance: 10,
      stamina: FISHING_STAMINA_LANDING_THRESHOLD,
      tension: 45,
      slackMs: 0,
      criticalMs: 0,
      fishDirection: "right",
      fishPull: 1
    })).toBe(true);
    expect(fishingFightCanLand({
      distance: 10,
      stamina: FISHING_STAMINA_LANDING_THRESHOLD + 0.01,
      tension: 45,
      slackMs: 0,
      criticalMs: 0,
      fishDirection: "right",
      fishPull: 1
    })).toBe(false);
    expect(fishingFightSnapped({
      distance: 10,
      stamina: 20,
      tension: 100,
      slackMs: 0,
      criticalMs: 0,
      fishDirection: "right",
      fishPull: 1
    })).toBe(false);
    expect(fishingFightSnapped({
      distance: 10,
      stamina: 20,
      tension: 100,
      slackMs: 0,
      criticalMs: 2_000,
      fishDirection: "right",
      fishPull: 1
    })).toBe(true);
    expect(fishingCatchScore({ executionQuality: 1, difficulty: 1, sizePercentile: 1 })).toBe(1_000);
  });

  it("bounds a delayed first control to one phone-sized simulation step", () => {
    const delayed = advanceFishingFight({
      distance: 40,
      stamina: 100,
      tension: 45,
      slackMs: 0,
      criticalMs: 0,
      fishDirection: "left",
      fishPull: 1.25
    }, { direction: "left", reeling: true, elapsedMs: 30_000 });

    expect(delayed.tension).toBeLessThan(100);
    expect(delayed.criticalMs).toBe(0);
    expect(delayed.distance).toBeLessThan(100);
  });

  it("uses the tuned six-input deltas for one 250ms intent interval", () => {
    const base = {
      distance: 50,
      stamina: FISHING_STAMINA_MAX,
      tension: 40,
      slackMs: 0,
      criticalMs: 0,
      fishDirection: "left" as const,
      fishPull: 1
    };
    const cases = [
      ["correct/no reel", "right" as const, false, -0.5, 3.75, -2.5],
      ["correct+reel", "right" as const, true, 1, -11.25, -2.5],
      ["neutral/no reel", "neutral" as const, false, -2, 6.25, -0.875],
      ["neutral+reel", "neutral" as const, true, 2, -5, -0.875],
      ["wrong/no reel", "left" as const, false, 3, 6.25, -0.1875],
      ["wrong+reel", "left" as const, true, 5, 13.75, -0.1875]
    ] as const;
    for (const [, direction, reeling, tensionDelta, distanceDelta, staminaDelta] of cases) {
      const next = advanceFishingFight(base, { direction, reeling, elapsedMs: 250 });
      expect(next.tension - base.tension).toBeCloseTo(tensionDelta, 8);
      expect(next.distance - base.distance).toBeCloseTo(distanceDelta, 8);
      expect(next.stamina - base.stamina).toBeCloseTo(staminaDelta, 8);
    }
  });

  it("progressively strengthens only correct counter-direction tension management", () => {
    const base = {
      distance: 50,
      tension: 45,
      slackMs: 0,
      criticalMs: 0,
      fishDirection: "left" as const,
      fishPull: 1
    };
    const noReelDeltas = [FISHING_STAMINA_MAX, 112.5, 75, 37.5, 0].map((stamina) => (
      advanceFishingFight({ ...base, stamina }, { direction: "right", reeling: false, elapsedMs: 250 }).tension - base.tension
    ));
    const reelDeltas = [FISHING_STAMINA_MAX, 112.5, 75, 37.5, 0].map((stamina) => (
      advanceFishingFight({ ...base, stamina }, { direction: "right", reeling: true, elapsedMs: 250 }).tension - base.tension
    ));
    expect(noReelDeltas).toEqual([-0.5, -0.625, -0.75, -0.875, -1]);
    expect(reelDeltas).toEqual([1, 0.75, 0.5, 0.25, 0]);

    for (const stamina of [FISHING_STAMINA_MAX, 75, 0]) {
      const neutral = advanceFishingFight({ ...base, stamina }, { direction: "neutral", reeling: false, elapsedMs: 250 });
      const wrong = advanceFishingFight({ ...base, stamina }, { direction: "left", reeling: false, elapsedMs: 250 });
      expect(neutral.tension).toBe(base.tension - 2);
      expect(wrong.tension).toBe(base.tension + 3);
      expect(neutral.distance).toBe(base.distance + 6.25);
      expect(wrong.distance).toBe(base.distance + 6.25);
    }
  });

  it("lets a sustained counter-and-reel sequence reach landing for every pull", () => {
    for (const fishPull of [0.1, 0.7, 1.25, 1.6, 1.8]) {
      let fight: FishingFightState = {
        distance: 75,
        stamina: FISHING_STAMINA_MAX,
        tension: 45,
        slackMs: 0,
        criticalMs: 0,
        fishDirection: "left" as const,
        fishPull
      };
      let landable = false;
      for (let step = 0; step < 80; step += 1) {
        const reeling = fight.distance > 12 || fight.tension < 35;
        fight = advanceFishingFight(fight, { direction: "right", reeling, elapsedMs: 250 });
        landable ||= fishingFightCanLand(fight);
        if (fishingFightSnapped(fight)) break;
      }
      expect(landable, `pull ${fishPull}`).toBe(true);
    }
  });

  it("keeps every behavior profile and the Ashen pull landable", () => {
    for (const profile of FISHING_BEHAVIOR_PROFILES) {
      for (const ashen of [false, true]) {
        let behavior = fishingBehaviorAt(profile, 2, 0);
        let fight: FishingFightState = {
          distance: 75,
          stamina: FISHING_STAMINA_MAX,
          tension: 45,
          slackMs: 0,
          criticalMs: 0,
          fishDirection: behavior.direction,
          fishPull: ashen ? 1.8 : behavior.pull
        };
        let landable = false;
        for (let step = 0; step < 80; step += 1) {
          const direction = fight.fishDirection === "left" ? "right" : "left";
          fight = advanceFishingFight(fight, {
            direction,
            reeling: fight.distance > 12 || fight.tension < 35,
            elapsedMs: 250
          });
          behavior = fishingBehaviorAt(profile, 2, (step + 1) * 250);
          fight = { ...fight, fishDirection: behavior.direction, fishPull: ashen ? 1.8 : behavior.pull };
          landable ||= fishingFightCanLand(fight);
          if (fishingFightSnapped(fight)) break;
        }
        expect(landable, `${profile} ${ashen ? "Ashen" : "normal"}`).toBe(true);
      }
    }
  });

  it("does not snap a normal fight after three ordinary taps", () => {
    let fight: FishingFightState = {
      distance: 75,
      stamina: FISHING_STAMINA_MAX,
      tension: 45,
      slackMs: 0,
      criticalMs: 0,
      fishDirection: "left" as const,
      fishPull: 1.25
    };
    for (let tap = 0; tap < 3; tap += 1) {
      fight = advanceFishingFight(fight, { direction: "left", reeling: false, elapsedMs: 250 });
    }
    expect(fight.tension).toBe(54);
    expect(fishingFightSnapped(fight)).toBe(false);
  });

  it("keeps the four behavior profiles distinct and deterministic", () => {
    expect(fishingBehaviorAt("runner", 2, 0)).toEqual({ direction: "left", pull: 1.25 });
    expect(fishingBehaviorAt("runner", 2, 1_000)).toEqual({ direction: "left", pull: 1.25 });
    expect(fishingBehaviorAt("darter", 2, 1_000).direction).toBe("left");
    expect(fishingBehaviorAt("darter", 2, 1_800).direction).toBe("right");
    expect(fishingBehaviorAt("tank", 2, 0).pull).toBeLessThan(fishingBehaviorAt("runner", 2, 0).pull);
    expect(fishingBehaviorAt("feinter", 2, 0).pull).toBeLessThan(fishingBehaviorAt("feinter", 2, 2_400).pull);
    expect(fishingBehaviorAt("feinter", 2, 2_400).direction).toBe("right");
  });

  it("keeps fake nibbles deterministic and only accepts the true-strike window", () => {
    const biteAt = 10_000;
    const timeline = fishingBiteTimeline(123, biteAt);
    expect(timeline.map((event) => event.kind)).toEqual(["nibble", "fake_nibble", "true_strike"]);
    expect(fishingBiteEventAt(123, biteAt, biteAt + 100)?.kind).toBe("nibble");
    expect(fishingBiteEventAt(123, biteAt, timeline[1]!.startedAt + 10)?.kind).toBe("fake_nibble");
    expect(fishingBiteEventAt(123, biteAt, timeline[2]!.startedAt + 10)?.kind).toBe("true_strike");
    expect(fishingHookTiming(123, biteAt, biteAt - 1)).toBe("early");
    expect(fishingHookTiming(123, biteAt, timeline[1]!.startedAt + 10)).toBe("early");
    expect(fishingHookTiming(123, biteAt, timeline[2]!.startedAt + 10)).toBe("valid");
    expect(fishingHookTiming(123, biteAt, timeline[2]!.endsAt)).toBe("late");
    expect(fishingBiteTimeline(124, biteAt).map((event) => event.kind)).toEqual(["nibble", "true_strike"]);
  });

});
