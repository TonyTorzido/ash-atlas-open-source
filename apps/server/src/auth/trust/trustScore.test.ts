import { describe, expect, it } from "vitest";

import {
  cooldownMinutesForKm,
  decayLogodds,
  effectiveDistanceM,
  locationReportScore,
  neighborhoodCells,
  nextShadowTier,
  regionCell,
  shadowTierFor,
  speedBucket,
  staticPrior,
  trustTierPromotion
} from "./trustScore.js";

describe("speedBucket", () => {
  it.each([
    [0, "stationary"],
    [0.9, "stationary"],
    [5, "walk"],
    [9, "walk"],
    [9.01, "cycle"],
    [43, "cycle"],
    [100, "car"],
    [160, "car"],
    [300, "rail"],
    [320, "rail"],
    [850, "air"],
    [900, "air"],
    [900.1, "impossible"],
    [Number.POSITIVE_INFINITY, "impossible"]
  ] as const)("%s km/h is %s", (kmh, bucket) => {
    expect(speedBucket(kmh)).toBe(bucket);
  });
});

describe("effectiveDistanceM", () => {
  it("discounts both accuracies and never goes negative", () => {
    expect(effectiveDistanceM(1000, 100, 50)).toBe(850);
    expect(effectiveDistanceM(1000, null, undefined)).toBe(1000);
    expect(effectiveDistanceM(100, 80, 80)).toBe(0);
  });
});

describe("cooldownMinutesForKm", () => {
  it("matches the D13 table and interpolates between rows", () => {
    expect(cooldownMinutesForKm(0)).toBe(0);
    expect(cooldownMinutesForKm(0.5)).toBe(1);
    expect(cooldownMinutesForKm(1)).toBe(1);
    expect(cooldownMinutesForKm(5)).toBe(2);
    expect(cooldownMinutesForKm(7.5)).toBe(4.5);
    expect(cooldownMinutesForKm(100)).toBe(30);
    expect(cooldownMinutesForKm(175)).toBe(37.5);
    expect(cooldownMinutesForKm(1000)).toBe(90);
    expect(cooldownMinutesForKm(1500)).toBe(120);
    expect(cooldownMinutesForKm(20_000)).toBe(120);
  });
});

describe("regionCell", () => {
  it("floors to half-degree cells on both hemispheres", () => {
    expect(regionCell(40.015, -105.27)).toBe("80:-211");
    expect(regionCell(-0.1, 0.1)).toBe("-1:0");
    expect(regionCell(0, 0)).toBe("0:0");
  });
});

describe("locationReportScore", () => {
  const base = {
    bucket: "walk" as const,
    farRelocation: false,
    priorFarRelocations7d: 0,
    regionFamiliar: null as boolean | null,
    relocation: true,
    accuracyConstant: false
  };

  it("scores nothing for an ordinary fix", () => {
    expect(locationReportScore(base)).toEqual({ score: 0, signals: [] });
  });

  it("weights impossible and air speed", () => {
    expect(locationReportScore({ ...base, bucket: "impossible" }).score).toBe(4);
    expect(locationReportScore({ ...base, bucket: "air" }).score).toBe(1);
  });

  it("scores far relocations only beyond the third in 7 days", () => {
    expect(locationReportScore({ ...base, farRelocation: true, priorFarRelocations7d: 2 }).score).toBe(0);
    expect(locationReportScore({ ...base, farRelocation: true, priorFarRelocations7d: 3 }).score).toBe(2);
    expect(locationReportScore({ ...base, farRelocation: false, priorFarRelocations7d: 5 }).score).toBe(0);
  });

  it("subtracts familiarity and logs constant accuracy at zero weight", () => {
    const result = locationReportScore({
      ...base,
      bucket: "impossible",
      regionFamiliar: true,
      accuracyConstant: true
    });
    expect(result.score).toBe(3);
    expect(result.signals.map((signal) => signal.rule)).toEqual([
      "speed_impossible",
      "region_familiar",
      "accuracy_constant"
    ]);
  });

  it("adds relocation_unfamiliar only for relocations to a known-unfamiliar region", () => {
    expect(locationReportScore({ ...base, regionFamiliar: false }).score).toBe(0.5);
    expect(locationReportScore({ ...base, regionFamiliar: false, relocation: false }).score).toBe(0);
    expect(locationReportScore({ ...base, regionFamiliar: null }).score).toBe(0);
  });

  it("credits a familiar region only on relocations, never on passive fixes", () => {
    expect(locationReportScore({ ...base, regionFamiliar: true }).score).toBe(-1);
    expect(locationReportScore({ ...base, regionFamiliar: true, relocation: false }))
      .toEqual({ score: 0, signals: [] });
  });
});

const DAY_MS = 24 * 60 * 60_000;
const NOW = new Date("2026-10-01T00:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

describe("neighborhoodCells", () => {
  it("returns the 3x3 block and wraps longitude at the antimeridian", () => {
    expect(neighborhoodCells(40.2, -105.2)).toHaveLength(9);
    expect(neighborhoodCells(40.2, -105.2)).toContain("80:-211");
    const wrapped = neighborhoodCells(0.1, 179.9);
    expect(wrapped).toContain("0:359");
    expect(wrapped).toContain("0:-360");
    expect(wrapped).not.toContain("0:360");
  });
});

describe("decayLogodds", () => {
  it("halves after tau * ln 2 and never grows backwards in time", () => {
    expect(decayLogodds(8, daysAgo(7 * Math.LN2), NOW, 7)).toBeCloseTo(4, 6);
    expect(decayLogodds(8, daysAgo(7), NOW, 7)).toBeCloseTo(8 / Math.E, 9);
    expect(decayLogodds(8, new Date(NOW.getTime() + 1000), NOW, 7)).toBe(8);
  });
});

describe("staticPrior", () => {
  const base = { createdAt: daysAgo(30), riskScore: 0, now: NOW };
  it("weights providers per D12 and lets the strongest identity win", () => {
    expect(staticPrior({ ...base, providers: [{ provider: "email", email: "a@example.com" }] })).toBe(1);
    expect(staticPrior({ ...base, providers: [{ provider: "google", email: "a@school.edu" }] })).toBe(0.5);
    expect(staticPrior({ ...base, providers: [{ provider: "google", email: "a@gmail.com" }] })).toBe(0);
    expect(staticPrior({ ...base, providers: [{ provider: "apple", email: null }] })).toBe(0);
    expect(staticPrior({ ...base, providers: [] })).toBe(0);
    expect(staticPrior({
      ...base,
      providers: [{ provider: "email", email: "a@example.com" }, { provider: "google", email: "a@gmail.com" }]
    })).toBe(0);
  });

  it("adds young-account and folded risk-score priors", () => {
    expect(staticPrior({ ...base, createdAt: daysAgo(3), providers: [] })).toBe(0.5);
    expect(staticPrior({ ...base, riskScore: 50, providers: [] })).toBe(2);
  });
});

describe("shadow tiers", () => {
  const thresholds = { quarantine: 8, quarantineNew: 6, warning: 15 };
  it("maps the effective score to quarantine and warning with a lower bar for new accounts", () => {
    expect(shadowTierFor(5.9, "new", thresholds)).toBe(0);
    expect(shadowTierFor(6, "new", thresholds)).toBe(3);
    expect(shadowTierFor(7, "standard", thresholds)).toBe(0);
    expect(shadowTierFor(8, "standard", thresholds)).toBe(3);
    expect(shadowTierFor(15, "standard", thresholds)).toBe(4);
  });

  it("enters immediately and exits only after the tier's delay", () => {
    const entered = nextShadowTier({ tier: 0, enteredAt: null, exitEligibleAt: null }, 3, NOW);
    expect(entered).toMatchObject({ tier: 3, enteredAt: NOW, changed: true });
    const below = nextShadowTier(entered, 0, NOW);
    expect(below).toMatchObject({ tier: 3, changed: false });
    expect(below.exitEligibleAt?.getTime()).toBe(NOW.getTime() + DAY_MS);
    const early = new Date(NOW.getTime() + DAY_MS - 1);
    expect(nextShadowTier(below, 0, early)).toMatchObject({ tier: 3, changed: false });
    const backAbove = nextShadowTier(below, 3, early);
    expect(backAbove).toMatchObject({ tier: 3, exitEligibleAt: null, changed: false });
    expect(nextShadowTier(below, 0, new Date(NOW.getTime() + DAY_MS))).toMatchObject({ tier: 0, changed: true });
    const warningExit = nextShadowTier({ tier: 4, enteredAt: NOW, exitEligibleAt: null }, 3, NOW);
    expect(warningExit.exitEligibleAt?.getTime()).toBe(NOW.getTime() + 7 * DAY_MS);
  });
});

describe("trustTierPromotion", () => {
  const account = { trustTier: "new" as const, createdAt: daysAgo(14) };
  it("promotes new accounts after 14 days, 5 login days and a low score", () => {
    expect(trustTierPromotion(account, 5, 3.9, NOW)).toBe("standard");
    expect(trustTierPromotion({ ...account, createdAt: daysAgo(13) }, 5, 0, NOW)).toBeNull();
    expect(trustTierPromotion(account, 4, 0, NOW)).toBeNull();
    expect(trustTierPromotion(account, 5, 4, NOW)).toBeNull();
    expect(trustTierPromotion({ ...account, trustTier: "restricted" }, 9, 0, NOW)).toBeNull();
  });
});
