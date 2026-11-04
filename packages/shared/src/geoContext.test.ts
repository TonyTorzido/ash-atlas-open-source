import { describe, expect, it } from "vitest";

import {
  admin1Is,
  allOf,
  anyOf,
  countryIs,
  evaluateGeoPredicate,
  marineParentIs,
  nearestNamedWaterbody,
  nearestNamedWaterbodyIs,
  not,
  resolveGeoWaterbodyReference,
  waterTypeIs,
  waterbodyIs,
  withinDistanceOfWaterbody,
  type GeoContext,
  type GeoWaterType
} from "./geoContext.js";

const RIO_GRANDE_ID = "4bdb931c-d880-5cb0-b8b2-e9c8c220e83a";
const UNITED_STATES_ID = "world-country-united-states";
const NEW_MEXICO_ID = "world-admin1-new-mexico";

function context(input: Readonly<{
  countryId?: string | null;
  countryName?: string | null;
  admin1Id?: string | null;
  admin1Name?: string | null;
  waterType?: GeoWaterType | null;
  waterbodyId?: string | null;
  waterbodyName?: string | null;
  resolutionState?: GeoContext["water"]["resolutionState"];
  presentationName?: string | null;
  presentationRelation?: GeoContext["water"]["presentationRelation"];
  presentationDistanceM?: number | null;
  marineParentId?: string | null;
  proximities?: GeoContext["water"]["proximities"];
}> = {}): GeoContext {
  const waterType = input.waterType ?? null;
  const canonicalName = input.waterbodyName ?? null;
  const resolutionState = input.resolutionState ?? (
    input.waterbodyId ? "resolved" : waterType ? "unresolved" : "not_applicable"
  );
  return {
    latitude: 35.0844,
    longitude: -106.6504,
    country: {
      id: input.countryId ?? null,
      name: input.countryName ?? null,
      resolutionState: input.countryId ? "resolved" : "unresolved"
    },
    admin1: {
      id: input.admin1Id ?? null,
      name: input.admin1Name ?? null,
      resolutionState: input.admin1Id ? "resolved" : "unresolved"
    },
    locality: null,
    water: {
      gameplayWaterType: waterType,
      canonicalWaterbodyId: resolutionState === "resolved" ? input.waterbodyId ?? null : null,
      canonicalDisplayName: resolutionState === "resolved" ? canonicalName : null,
      resolutionState,
      marineParentId: input.marineParentId ?? null,
      marineParentName: null,
      presentationName: input.presentationName ?? canonicalName ?? null,
      presentationRelation: input.presentationRelation ?? (canonicalName ? "exact" : null),
      presentationDistanceM: input.presentationDistanceM ?? (canonicalName ? 0 : null),
      ...(input.proximities ? { proximities: input.proximities } : {})
    }
  };
}

describe("GeoContext predicates", () => {
  it("evaluates a canonical Rio Grande/New Mexico event and the same river across regions", () => {
    const albuquerque = context({
      countryId: UNITED_STATES_ID,
      countryName: "United States",
      admin1Id: NEW_MEXICO_ID,
      admin1Name: "New Mexico",
      waterType: "river",
      waterbodyId: RIO_GRANDE_ID,
      waterbodyName: "Rio Grande"
    });
    const downstream = context({
      countryId: UNITED_STATES_ID,
      countryName: "United States",
      admin1Id: "world-admin1-texas",
      admin1Name: "Texas",
      waterType: "river",
      waterbodyId: RIO_GRANDE_ID,
      waterbodyName: "Rio Grande"
    });
    expect(evaluateGeoPredicate(albuquerque, allOf(
      waterTypeIs("river"),
      waterbodyIs(RIO_GRANDE_ID),
      admin1Is(NEW_MEXICO_ID),
      countryIs(UNITED_STATES_ID)
    ))).toBe(true);
    expect(evaluateGeoPredicate(downstream, waterbodyIs(RIO_GRANDE_ID))).toBe(true);
    expect(evaluateGeoPredicate(downstream, admin1Is(NEW_MEXICO_ID))).toBe(false);
  });

  it("keeps Romey unresolved while preserving a typed Near Grand River fallback", () => {
    const romey = context({
      countryId: UNITED_STATES_ID,
      countryName: "United States",
      admin1Id: NEW_MEXICO_ID,
      admin1Name: "New Mexico",
      waterType: "river",
      resolutionState: "unresolved",
      presentationName: "Grand River",
      presentationRelation: "near",
      presentationDistanceM: 8
    });
    expect(romey.water.canonicalWaterbodyId).toBeNull();
    expect(evaluateGeoPredicate(romey, waterbodyIs("grand-river-id"))).toBe(false);
    expect(evaluateGeoPredicate(romey, nearestNamedWaterbodyIs("river", 8))).toBe(true);
    expect(nearestNamedWaterbody(romey, "river", 8)).toMatchObject({
      canonicalWaterbodyId: null,
      presentationName: "Grand River",
      relation: "near",
      distanceM: 8
    });
  });

  it("covers named/unnamed lakes, mapped/open ocean, and independent marine identity", () => {
    const namedLake = context({
      countryId: UNITED_STATES_ID,
      admin1Id: "world-admin1-nevada",
      waterType: "lake",
      waterbodyId: "lake-tahoe-canonical",
      waterbodyName: "Lake Tahoe"
    });
    const unnamedLake = context({
      countryId: UNITED_STATES_ID,
      admin1Id: "world-admin1-colorado",
      waterType: "lake",
      resolutionState: "unresolved",
      presentationName: "Spring Lake",
      presentationRelation: "near",
      presentationDistanceM: 42
    });
    const mappedOcean = context({
      waterType: "ocean",
      waterbodyId: "gulf-of-mexico-canonical",
      waterbodyName: "Gulf of Mexico",
      marineParentId: "north-atlantic-canonical"
    });
    const openOcean = context({
      waterType: "ocean",
      resolutionState: "unresolved",
      presentationName: "Open Ocean",
      presentationRelation: "open_ocean",
      countryId: null,
      admin1Id: null
    });
    expect(evaluateGeoPredicate(namedLake, waterTypeIs("lake"))).toBe(true);
    expect(evaluateGeoPredicate(namedLake, nearestNamedWaterbodyIs("lake", 0))).toBe(true);
    expect(evaluateGeoPredicate(unnamedLake, nearestNamedWaterbodyIs("lake", 42))).toBe(true);
    expect(evaluateGeoPredicate(mappedOcean, marineParentIs("north-atlantic-canonical"))).toBe(true);
    expect(evaluateGeoPredicate(openOcean, countryIs(UNITED_STATES_ID))).toBe(false);
    expect(evaluateGeoPredicate(openOcean, admin1Is("world-admin1-florida"))).toBe(false);
    expect(evaluateGeoPredicate(openOcean, waterTypeIs("ocean"))).toBe(true);
  });

  it("uses canonical indexed distance, including the exact threshold, and rejects wrong class", () => {
    const point = context({
      countryId: UNITED_STATES_ID,
      admin1Id: NEW_MEXICO_ID,
      waterType: "lake",
      resolutionState: "unresolved",
      proximities: [
        {
          canonicalWaterbodyId: RIO_GRANDE_ID,
          waterType: "river",
          distanceM: 5_000,
          canonicalDisplayName: "Rio Grande"
        },
        {
          canonicalWaterbodyId: "wrong-lake",
          waterType: "lake",
          distanceM: 5_001,
          canonicalDisplayName: "Wrong Lake"
        }
      ]
    });
    expect(evaluateGeoPredicate(point, withinDistanceOfWaterbody(RIO_GRANDE_ID, 5_000))).toBe(true);
    expect(evaluateGeoPredicate(point, withinDistanceOfWaterbody(RIO_GRANDE_ID, 4_999))).toBe(false);
    expect(evaluateGeoPredicate(point, nearestNamedWaterbodyIs("river", 5_000))).toBe(true);
    expect(evaluateGeoPredicate(point, nearestNamedWaterbodyIs("lake", 5_000))).toBe(false);
  });

  it("keeps country/state borders and confluences separate from nearest-name presentation", () => {
    const stateBorderWest = context({
      countryId: UNITED_STATES_ID,
      admin1Id: NEW_MEXICO_ID,
      waterType: "river",
      waterbodyId: RIO_GRANDE_ID,
      waterbodyName: "Rio Grande"
    });
    const stateBorderEast = context({
      countryId: "world-country-mexico",
      admin1Id: "world-admin1-chihuahua",
      waterType: "river",
      waterbodyId: RIO_GRANDE_ID,
      waterbodyName: "Rio Grande"
    });
    expect(evaluateGeoPredicate(stateBorderWest, waterbodyIs(RIO_GRANDE_ID))).toBe(true);
    expect(evaluateGeoPredicate(stateBorderEast, waterbodyIs(RIO_GRANDE_ID))).toBe(true);
    expect(evaluateGeoPredicate(stateBorderWest, countryIs("world-country-mexico"))).toBe(false);
    expect(evaluateGeoPredicate(stateBorderEast, admin1Is(NEW_MEXICO_ID))).toBe(false);

    const confluence = context({
      countryId: UNITED_STATES_ID,
      admin1Id: NEW_MEXICO_ID,
      waterType: "river",
      resolutionState: "ambiguous",
      presentationName: "Grand River",
      presentationRelation: "near",
      presentationDistanceM: 500,
      proximities: [
        { canonicalWaterbodyId: RIO_GRANDE_ID, waterType: "river", distanceM: 4_000, canonicalDisplayName: "Rio Grande" },
        { canonicalWaterbodyId: "neosho-river-id", waterType: "river", distanceM: 100, canonicalDisplayName: "Neosho River" }
      ]
    });
    expect(evaluateGeoPredicate(confluence, waterbodyIs(RIO_GRANDE_ID))).toBe(false);
    expect(evaluateGeoPredicate(confluence, withinDistanceOfWaterbody(RIO_GRANDE_ID, 4_000))).toBe(true);
    expect(nearestNamedWaterbody(confluence, "river", 100)).toMatchObject({
      canonicalWaterbodyId: "neosho-river-id",
      presentationName: "Neosho River",
      relation: "near"
    });

    const wrongClass = context({
      waterType: "river",
      resolutionState: "unresolved",
      proximities: [
        { canonicalWaterbodyId: "spring-lake-id", waterType: "lake", distanceM: 1, canonicalDisplayName: "Spring Lake" }
      ]
    });
    expect(evaluateGeoPredicate(wrongClass, nearestNamedWaterbodyIs("river", 10))).toBe(false);
    expect(evaluateGeoPredicate(wrongClass, nearestNamedWaterbodyIs("lake", 10))).toBe(true);
  });

  it("composes ALL/ANY/NOT without coupling location evaluation to event targets", () => {
    const eventLocation = context({
      countryId: UNITED_STATES_ID,
      admin1Id: NEW_MEXICO_ID,
      waterType: "river",
      waterbodyId: RIO_GRANDE_ID,
      waterbodyName: "Rio Grande"
    });
    expect(evaluateGeoPredicate(eventLocation, allOf(
      admin1Is(NEW_MEXICO_ID),
      anyOf(waterTypeIs("lake"), waterTypeIs("river")),
      not(waterbodyIs("neighbouring-river"))
    ))).toBe(true);
    expect(evaluateGeoPredicate(eventLocation, allOf(
      admin1Is(NEW_MEXICO_ID),
      not(countryIs(UNITED_STATES_ID))
    ))).toBe(false);
  });
});

describe("GeoContext authoring resolution", () => {
  const catalog = [
    {
      canonicalId: RIO_GRANDE_ID,
      waterType: "river" as const,
      canonicalName: "Rio Grande",
      countryIds: [UNITED_STATES_ID],
      admin1Ids: [NEW_MEXICO_ID]
    },
    {
      canonicalId: "spring-lake-colorado",
      waterType: "lake" as const,
      canonicalName: "Spring Lake",
      countryIds: [UNITED_STATES_ID],
      admin1Ids: ["world-admin1-colorado"]
    },
    {
      canonicalId: "spring-lake-vermont",
      waterType: "lake" as const,
      canonicalName: "Spring Lake",
      countryIds: [UNITED_STATES_ID],
      admin1Ids: ["world-admin1-vermont"]
    }
  ];

  it("resolves names to stable IDs and requires region disambiguation", () => {
    expect(resolveGeoWaterbodyReference({ type: "river", name: "Rio Grande" }, catalog)).toEqual({
      canonicalId: RIO_GRANDE_ID,
      waterType: "river",
      canonicalName: "Rio Grande"
    });
    expect(resolveGeoWaterbodyReference({
      type: "lake",
      name: "Spring Lake",
      admin1Id: "world-admin1-colorado"
    }, catalog).canonicalId).toBe("spring-lake-colorado");
    expect(() => resolveGeoWaterbodyReference({ type: "lake", name: "Spring Lake" }, catalog))
      .toThrow(/ambiguous/i);
  });

  it("rejects a wrong class or mismatched canonical ID instead of silently assigning identity", () => {
    expect(() => resolveGeoWaterbodyReference({
      type: "lake",
      name: "Rio Grande",
      canonicalId: RIO_GRANDE_ID
    }, catalog)).toThrow(/does not match/i);
    expect(() => resolveGeoWaterbodyReference({
      type: "river",
      name: "Rio Grande",
      canonicalId: "missing"
    }, catalog)).toThrow(/not present/i);
  });
});
