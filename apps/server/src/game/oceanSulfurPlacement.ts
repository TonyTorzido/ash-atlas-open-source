import type {
  PopulationZoneV2Habitat,
  PopulationZoneV2HabitatCandidateSite
} from "./populationV2HabitatTypes.js";
import {
  type CanonicalJsonValue,
  deterministicUuidV8,
  deterministicUnit,
  hashPartsHex
} from "./populationZonesV2Identity.js";
import {
  POPULATION_ZONE_V2_EARTH_RADIUS_M,
  parsePopulationZoneV2Id,
  populationZoneV2Geometry,
  populationZoneV2IdForPoint,
  type PopulationZoneV2Id,
  type PopulationZoneV2Point
} from "./populationZonesV2Geometry.js";

/**
 * Sulfur has its own deterministic placement family. It intentionally does
 * not participate in the Population V2 stone/coal/iron classifier.
 *
 * Density is one permanent deposit per thirty square kilometres of eligible
 * authoritative ocean. Equal-area parent domains provide one deterministic
 * owner slot per density target, so independently completing adjacent
 * one-square-kilometre plans cannot round each plan up to one deposit. The
 * exact eligibility rule is fail-closed:
 * surfaceType must be ocean, isSaltwater must be true, insideMajorLake must be
 * false, and the World ocean-surface authority snapshot must be present.
 */
export const OCEAN_SULFUR_PLACEMENT_VERSION = "ocean-sulfur-placement-v1";
export const OCEAN_SULFUR_SELECTION_VERSION =
  "ocean-sulfur-candidate-selection-v1";
export const OCEAN_SULFUR_SLOT_NAMESPACE =
  "ocean-sulfur-deposit-slot-id-v1";
export const OCEAN_SULFUR_ENTITY_NAMESPACE =
  "ocean-sulfur-deposit-entity-id-v1";
export const OCEAN_SULFUR_TARGET_AREA_KM2 = 30;
export const OCEAN_SULFUR_DOMAIN_VERSION = "ocean-sulfur-domain-v1";
export const OCEAN_SULFUR_DOMAIN_SLOT_VERSION =
  "ocean-sulfur-domain-slot-v1";

const OCEAN_SULFUR_BAND_COUNT = Math.round(
  Math.PI * POPULATION_ZONE_V2_EARTH_RADIUS_M
    / Math.sqrt(OCEAN_SULFUR_TARGET_AREA_KM2 * 1_000_000)
);
const OCEAN_SULFUR_RADIANS_PER_BAND = Math.PI / OCEAN_SULFUR_BAND_COUNT;
const OCEAN_SULFUR_DEGREES_PER_BAND =
  180 / OCEAN_SULFUR_BAND_COUNT;

export type OceanSulfurDomain = Readonly<{
  id: string;
  center: PopulationZoneV2Point;
  areaKm2: number;
  bounds: Readonly<{
    southLat: number;
    northLat: number;
    westLon: number;
    eastLon: number;
  }>;
}>;

export type OceanSulfurDeposit = Readonly<{
  candidateId: string;
  slotId: string;
  entityId: string;
  ownerZoneId: string;
  entityKind: "sulfur";
  archetype: "sulfur_mine";
  position: PopulationZoneV2Point;
  anchor: PopulationZoneV2Point;
  environmentSnapshot: Readonly<Record<string, CanonicalJsonValue>>;
  suppressionClass: "none";
}>;

export function isAuthoritativeOceanSulfurSite(
  site: PopulationZoneV2HabitatCandidateSite
): boolean {
  return site.surfaceType === "ocean"
    && site.isSaltwater
    && !site.insideMajorLake
    && site.surfaceAuthority !== null
    && site.surfaceAuthority !== undefined;
}

export function deriveOceanSulfurDeposits(input: Readonly<{
  zoneId: string;
  worldEnvironmentIdentityKey: string;
  habitat: Pick<PopulationZoneV2Habitat, "candidateSites" | "surfaceAreaKm2">;
}>): readonly OceanSulfurDeposit[] {
  const sitesByDomain = new Map<
    string,
    { domain: OceanSulfurDomain; sites: PopulationZoneV2HabitatCandidateSite[] }
  >();
  for (const site of uniqueOceanSites(input.habitat.candidateSites ?? [])) {
    const domain = oceanSulfurDomainForPoint(site.position);
    const entries = sitesByDomain.get(domain.id) ?? { domain, sites: [] };
    entries.sites.push(site);
    sitesByDomain.set(domain.id, entries);
  }

  const deposits: OceanSulfurDeposit[] = [];
  for (const { domain, sites } of [...sitesByDomain.values()].sort((left, right) =>
    left.domain.id.localeCompare(right.domain.id)
  )) {
    const ownerZoneId = populationZoneV2IdForPoint(
      stableOceanSulfurDomainSlot(domain, input.worldEnvironmentIdentityKey).position
    );
    // Test fixtures may use descriptive zone IDs, but production plans always
    // use canonical Population V2 zone IDs. Keep fixture derivation useful
    // while making the runtime owner fence strict for canonical plans.
    if (isCanonicalPopulationZoneId(input.zoneId) && ownerZoneId !== input.zoneId) {
      continue;
    }
    const site = sites
      .map((candidate) => ({
        candidate,
        rank: hashPartsHex(
          OCEAN_SULFUR_SELECTION_VERSION,
          input.worldEnvironmentIdentityKey,
          domain.id,
          candidate.siteId
        )
      }))
      .sort((left, right) =>
        left.rank.localeCompare(right.rank)
        || left.candidate.siteId.localeCompare(right.candidate.siteId)
      )[0]?.candidate;
    if (site === undefined) continue;
    deposits.push(oceanSulfurDepositForSite({
      zoneId: input.zoneId,
      worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey,
      domain,
      site
    }));
  }
  return deposits.sort((left, right) => left.entityId.localeCompare(right.entityId));
}

export function oceanSulfurDomainForPoint(
  point: PopulationZoneV2Point
): OceanSulfurDomain {
  const band = point.lat === 90
    ? OCEAN_SULFUR_BAND_COUNT - 1
    : Math.max(
      0,
      Math.min(
        OCEAN_SULFUR_BAND_COUNT - 1,
        Math.floor((point.lat + 90) / OCEAN_SULFUR_DEGREES_PER_BAND)
      )
    );
  const southRadians = -Math.PI / 2 + band * OCEAN_SULFUR_RADIANS_PER_BAND;
  const northRadians = band === OCEAN_SULFUR_BAND_COUNT - 1
    ? Math.PI / 2
    : southRadians + OCEAN_SULFUR_RADIANS_PER_BAND;
  const bandAreaM2 = 2
    * Math.PI
    * POPULATION_ZONE_V2_EARTH_RADIUS_M ** 2
    * (Math.sin(northRadians) - Math.sin(southRadians));
  const columnCount = Math.max(
    1,
    Math.round(bandAreaM2 / (OCEAN_SULFUR_TARGET_AREA_KM2 * 1_000_000))
  );
  const normalizedLongitude = normalizeLongitude(point.lon);
  const column = Math.abs(point.lat) === 90
    ? 0
    : Math.min(
      columnCount - 1,
      Math.floor(((normalizedLongitude + 180) / 360) * columnCount)
    );
  const longitudeSpan = 360 / columnCount;
  const westLon = -180 + column * longitudeSpan;
  const eastLon = column === columnCount - 1
    ? 180
    : westLon + longitudeSpan;
  return {
    id: `${OCEAN_SULFUR_DOMAIN_VERSION}/${band.toString(36)}/${column.toString(36)}`,
    center: {
      lat: toDegrees(Math.asin(
        (Math.sin(southRadians) + Math.sin(northRadians)) / 2
      )),
      lon: normalizeLongitude(westLon + longitudeSpan / 2)
    },
    areaKm2: bandAreaM2 / columnCount / 1_000_000,
    bounds: {
      southLat: toDegrees(southRadians),
      northLat: toDegrees(northRadians),
      westLon,
      eastLon
    }
  };
}

export function oceanSulfurDomainsIntersectingZone(
  zoneId: PopulationZoneV2Id
): OceanSulfurDomain[] {
  const geometry = populationZoneV2Geometry(zoneId);
  const epsilon = 1e-9;
  const domains = new Map<string, OceanSulfurDomain>();
  for (const lat of [
    geometry.bounds.southLat + epsilon,
    geometry.center.lat,
    geometry.bounds.northLat - epsilon
  ]) {
    for (const lon of [
      geometry.bounds.westLon + epsilon,
      geometry.center.lon,
      geometry.bounds.eastLon - epsilon
    ]) {
      const domain = oceanSulfurDomainForPoint({ lat, lon });
      domains.set(domain.id, domain);
    }
  }
  return [...domains.values()].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
}

export function stableOceanSulfurDomainSlot(
  domain: OceanSulfurDomain,
  worldEnvironmentIdentityKey: string
): Readonly<{ candidateId: string; position: PopulationZoneV2Point }> {
  const latitudeUnit = deterministicUnit(
    OCEAN_SULFUR_DOMAIN_SLOT_VERSION,
    worldEnvironmentIdentityKey,
    domain.id,
    "latitude"
  );
  const longitudeUnit = deterministicUnit(
    OCEAN_SULFUR_DOMAIN_SLOT_VERSION,
    worldEnvironmentIdentityKey,
    domain.id,
    "longitude"
  );
  const southSine = Math.sin(toRadians(domain.bounds.southLat));
  const northSine = Math.sin(toRadians(domain.bounds.northLat));
  return {
    candidateId: `${domain.id}/${hashPartsHex(
      OCEAN_SULFUR_DOMAIN_SLOT_VERSION,
      worldEnvironmentIdentityKey
    ).slice(0, 16)}/slot-0`,
    position: {
      lat: toDegrees(Math.asin(
        southSine + (northSine - southSine) * latitudeUnit
      )),
      lon: normalizeLongitude(
        domain.bounds.westLon
          + (domain.bounds.eastLon - domain.bounds.westLon) * longitudeUnit
      )
    }
  };
}

function uniqueOceanSites(
  sites: readonly PopulationZoneV2HabitatCandidateSite[]
): PopulationZoneV2HabitatCandidateSite[] {
  const byPosition = new Map<string, PopulationZoneV2HabitatCandidateSite>();
  for (const site of sites) {
    if (!isAuthoritativeOceanSulfurSite(site)) continue;
    const positionKey = `${site.position.lat.toFixed(9)}/${site.position.lon.toFixed(9)}`;
    const existing = byPosition.get(positionKey);
    if (existing === undefined || site.siteId.localeCompare(existing.siteId) < 0) {
      byPosition.set(positionKey, site);
    }
  }
  return [...byPosition.values()];
}

function oceanSulfurDepositForSite(input: Readonly<{
  zoneId: string;
  worldEnvironmentIdentityKey: string;
  domain: OceanSulfurDomain;
  site: PopulationZoneV2HabitatCandidateSite;
}>): OceanSulfurDeposit {
  const candidateId = `ocean-sulfur/${hashPartsHex(
    OCEAN_SULFUR_PLACEMENT_VERSION,
    input.worldEnvironmentIdentityKey,
    input.domain.id,
    input.site.siteId
  ).slice(0, 40)}`;
  const identity = {
    candidateId,
    ownerZoneId: input.zoneId,
    placementVersion: OCEAN_SULFUR_PLACEMENT_VERSION,
    worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey,
    domainId: input.domain.id
  } satisfies CanonicalJsonValue;
  const slotId = deterministicUuidV8(OCEAN_SULFUR_SLOT_NAMESPACE, identity);
  const entityId = deterministicUuidV8(
    OCEAN_SULFUR_ENTITY_NAMESPACE,
    { ...identity, slotId }
  );
  return {
    candidateId,
    slotId,
    entityId,
    ownerZoneId: input.zoneId,
    entityKind: "sulfur",
    archetype: "sulfur_mine",
    position: { ...input.site.position },
    anchor: { ...input.site.position },
    environmentSnapshot: environmentSnapshotForSite(input.site, input.domain.id),
    suppressionClass: "none"
  };
}

function environmentSnapshotForSite(
  site: PopulationZoneV2HabitatCandidateSite,
  domainId: string
): Readonly<Record<string, CanonicalJsonValue>> {
  return {
    placementVersion: OCEAN_SULFUR_PLACEMENT_VERSION,
    domainId,
    eligibilityRule: "ocean-saltwater-outside-major-lake-with-surface-authority",
    siteId: site.siteId,
    source: site.source,
    sourceSampleId: site.sourceSampleId,
    sourceCellId: site.sourceCellId,
    sourceSlotId: site.sourceSlotId,
    candidateSlotVersion: site.candidateSlotVersion,
    placementTags: site.placementTags,
    isSaltwater: site.isSaltwater,
    insideMajorLake: site.insideMajorLake,
    surfaceType: site.surfaceType ?? null,
    surfaceAuthority: site.surfaceAuthority ?? null,
    elevationBand: site.elevationBand,
    terrainClass: site.terrainClass,
    landCoverClass: site.landCoverClass,
    biomeId: site.biomeId,
    ecoregionId: site.ecoregionId,
    spawnProfileKey: site.spawnProfileKey
  };
}

function normalizeLongitude(value: number): number {
  const normalized = ((value + 180) % 360 + 360) % 360 - 180;
  return normalized === -180 && value > 0 ? 180 : normalized;
}

function toRadians(value: number): number {
  return value * Math.PI / 180;
}

function toDegrees(value: number): number {
  return value * 180 / Math.PI;
}

function isCanonicalPopulationZoneId(value: string): value is PopulationZoneV2Id {
  try {
    parsePopulationZoneV2Id(value);
    return true;
  } catch {
    return false;
  }
}
