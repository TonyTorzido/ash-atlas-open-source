// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { FlagEnvironmentDetails } from "@ash-atlas/shared";
import { afterEach, describe, expect, it } from "vitest";

import { PlayerDetailsContent } from "../ui/PlayerFlagDetails.js";
import {
  coastlineDistance,
  crossSourceConflict,
  ecologyStatus,
  elevation,
  geographicCity,
  gameplayCity,
  majorLakeSummary,
  mapDataFallback,
  namedRiverSummary,
  nearestWaterSummary,
  oceanDepth
} from "./flagEnvironmentDisplay.js";

afterEach(cleanup);

describe("player flag semantic explanations", () => {
  it("formats a numeric coastline result", () => {
    const value = current();
    value.terrain.coastlineDistanceM = 42_000;
    expect(coastlineDistance(value).text).toBe("42 km from the coast");
  });

  it("explains a complete no-coast result with the configured radius", () => {
    expect(coastlineDistance(current()).text).toBe("Far inland — no coast within 100 km");
  });

  it("does not turn an incomplete coastline search into none found", () => {
    const value = current();
    value.terrain.coastlineSearchComplete = false;
    expect(coastlineDistance(value).text).toBe("Coastline search was limited in this location");
  });

  it("explains legacy coastline metadata", () => {
    const value = current();
    value.provenance.snapshotStatus = "legacy";
    value.terrain.coastlineSearchRadiusM = null;
    value.terrain.coastlineSearchComplete = null;
    expect(coastlineDistance(value).text).toBe("Coastline distance was not recorded in this older map snapshot");
  });

  it("explains a complete named-river search with no result", () => {
    expect(namedRiverSummary(current()).text).toBe("No major named river nearby");
  });

  it("explains a complete major-lake search with no result", () => {
    expect(majorLakeSummary(current()).text).toBe("No major lake nearby");

    const unnamed = current();
    unnamed.water.majorLake.id = "1325851";
    unnamed.water.majorLake.distanceM = 26_480.755;
    expect(majorLakeSummary(unnamed).text).toBe("Mapped major lake \u00b7 26.5 km");
  });

  it("explains a complete nearby-water search with no result", () => {
    expect(nearestWaterSummary(current()).text).toBe("No mapped water source within 100 km");
  });

  it("explains an incomplete nearby-water search", () => {
    const value = current();
    value.water.nearest.searchComplete = false;
    expect(nearestWaterSummary(value).text).toBe("Nearby-water search was limited here");
  });

  it("labels exact ecology", () => {
    expect(ecologyStatus(current()).text).toBe("Exact mapped ecology");
  });

  it("labels nearest-land ecology", () => {
    const value = current();
    value.ecology.resolution = "nearest_land_fallback";
    expect(ecologyStatus(value).text).toBe("Ecology estimated from nearby land");
  });

  it("explains a complete ecology fallback with no result", () => {
    const value = current();
    value.ecology.resolution = "unavailable";
    value.ecology.fallbackMaxM = 10_000;
    expect(ecologyStatus(value).text).toBe("No mapped terrestrial ecology within 10 km");
  });

  it("explains an incomplete ecology search", () => {
    const value = current();
    value.ecology.resolution = "unavailable";
    value.ecology.searchComplete = false;
    expect(ecologyStatus(value).text).toBe("Ecology search was limited in this location");
  });

  it("marks open-water ecology not applicable", () => {
    const value = current();
    value.terrain.isLand = false;
    value.terrain.isSaltwater = true;
    value.ecology.resolution = "not_applicable";
    expect(ecologyStatus(value).text).toBe("Terrestrial ecology does not apply here");
  });

  it("distinguishes a location outside mapped cities", () => {
    expect(geographicCity(current()).text).toBe("Outside mapped city boundaries");
  });

  it("distinguishes no gameplay-city association", () => {
    expect(gameplayCity(current()).text).toBe("Not associated with a player city");
  });

  it("marks ocean depth not applicable inland", () => {
    expect(oceanDepth(current()).text).toBe("Ocean depth does not apply inland");
  });

  it("marks land elevation not applicable over saltwater", () => {
    const value = current();
    value.terrain.elevationM = null;
    value.terrain.isLand = false;
    value.terrain.isSaltwater = true;
    expect(elevation(value).text).toBe("Land elevation does not apply over open water");
  });

  it("discloses a cross-source conflict", () => {
    const value = current();
    value.terrain.landCoverConflict = true;
    expect(crossSourceConflict(value).text).toBe("Map sources disagree about the surface at this location");
  });

  it("does not manufacture a conflict warning when sources agree", () => {
    expect(crossSourceConflict(current()).text).toBe("Map sources agree");
  });

  it("uses the explicit final fallback only for an unclassified failure", () => {
    expect(mapDataFallback().text).toBe("Map data could not be determined at this location.");
  });

  it("hides Data Quality when there are no useful notices", () => {
    render(<PlayerDetailsContent details={current()} />);
    expect(screen.queryByText("Data Quality")).toBeNull();
  });

  it("never renders a generic missing-data label in normal player fields", () => {
    const value = current();
    value.ecology.biomeName = "N/A";
    const view = render(<PlayerDetailsContent details={value} />);
    expect(screen.getByText("Biome is not classified in this map source")).toBeTruthy();
    const values = Array.from(view.container.querySelectorAll(".player-detail-field strong"))
      .map((element) => element.textContent?.trim() ?? "");
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value).not.toMatch(/^(Unavailable|N\/A|Unknown|—|-|)$/i);
      expect(value).not.toMatch(/ unavailable$/i);
    }
  });
});

function current(): FlagEnvironmentDetails {
  return {
    identity: {
      flagId: "11111111-1111-4111-8111-111111111111",
      flagName: "Flag 1",
      ownerId: "owner",
      ownerName: "Ash",
      ownerColor: "#38bdf8",
      createdAt: "2026-07-13T08:00:00.000Z",
      claimRadiusM: 1_000,
      cityId: null,
      cityName: null
    },
    coordinates: { latitude: 35.087035, longitude: -106.674748, packageId: "world_v1_lat35_lon-107" },
    administrative: {
      countryId: "US",
      countryName: "United States",
      countryCode: "US",
      regionId: "NM",
      regionName: "New Mexico",
      regionCode: "US-NM",
      cityId: null,
      cityName: null,
      insideCity: false,
      cityBoundaryDistanceM: null
    },
    terrain: {
      elevationM: 1_511,
      terrainClass: "flat",
      landCoverClass: "mixed_or_mosaic",
      sourceLandCoverCode: 40,
      isLand: true,
      isSaltwater: false,
      isCoastal: false,
      coastlineDistanceM: null,
      coastlineSearchRadiusM: 100_000,
      coastlineSearchComplete: true,
      coastalThresholdM: 5_000,
      landCoverConflict: false
    },
    ecology: {
      biomeId: "13",
      biomeName: "Deserts & Xeric Shrublands",
      ecoregionId: "429",
      ecoregionName: "Colorado Plateau shrublands",
      resolution: "exact",
      distanceM: 0,
      sourcePackageId: "world_v1_lat35_lon-107",
      fallbackMaxM: null,
      searchComplete: true
    },
    water: {
      nearest: {
        sourceType: null,
        sourceId: null,
        sourceName: null,
        kind: null,
        distanceM: null,
        resolution: "beyond_search_radius",
        searchRadiusM: 100_000,
        searchComplete: true
      },
      namedRiver: { id: null, name: null, riverClass: null, distanceM: null, searchRadiusM: 100_000, searchComplete: true },
      supportingRiver: { id: null, flowOrder: null, dischargeCms: null, drainageAreaSqKm: null, distanceM: null, searchRadiusM: 100_000, searchComplete: true },
      majorLake: { id: null, name: null, inside: false, distanceM: null, searchRadiusM: 100_000, searchComplete: true },
      oceanDepthClass: "not_applicable"
    },
    provenance: {
      worldReleaseId: "world-packages-v1",
      profileSetFingerprint: "a".repeat(64),
      buildContractFingerprint: "b".repeat(64),
      boundaryReleaseId: "world-boundaries-v1",
      packageCount: 64_800,
      environmentSchemaVersion: "world-profile-v2",
      sourceVersions: {},
      derivedTags: [],
      warnings: [],
      snapshotStatus: "current",
      snapshotStatusReason: "Current",
      snapshotUpdatedAt: "2026-07-13T08:00:00.000Z"
    },
    rawSnapshot: {}
  };
}
