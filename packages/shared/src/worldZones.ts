/**
 * Player-facing world zones: one friendly biome name, a height or depth word, shore tags, and the
 * local season for any point on Earth.
 *
 * The cooked ~20 km lookup is the presentation source and the land-biome source. Water (lake,
 * coast, open ocean, river) and shore tags are World-authoritative: the server resolves them with
 * `resolveWorldZone` from its gameplay-environment lookup at the player's authoritative position,
 * and falls back to the cooked lookup only when World is unavailable.
 *
 * Zone codes come from `world-zone-lookup-v1.bin` (tools/world-map/generate-world-zone-lookup.py):
 * 0 unknown, 1..75 land (1 + (RESOLVE biome class - 1) * 5 + elevation band index; class 15 is
 * "Rock and Ice"; bands Lowland, Upland, Highland, Peaks, Summit), 97..100 ocean (96 + depth band),
 * 112 large lake. The file format is version 2; version 1 (4 bands) is rejected.
 */

/** Biomes a player can discover; "wilds" is only the unknown fallback. */
export const WORLD_ZONE_DISCOVERABLE_BIOMES = [
  "jungle",
  "pinewild",
  "greenwood",
  "frostwood",
  "plains",
  "savanna",
  "marsh",
  "highmeadow",
  "scrubland",
  "badlands",
  "steppe",
  "tundra",
  "frozen_waste",
  "coast",
  "open_ocean",
  "lake"
] as const;
export type WorldZoneDiscoverableBiome = (typeof WORLD_ZONE_DISCOVERABLE_BIOMES)[number];

export const WORLD_ZONE_BIOMES = [...WORLD_ZONE_DISCOVERABLE_BIOMES, "wilds"] as const;
export type WorldZoneBiome = (typeof WORLD_ZONE_BIOMES)[number];

export function isWorldZoneDiscoverableBiome(value: unknown): value is WorldZoneDiscoverableBiome {
  return typeof value === "string"
    && (WORLD_ZONE_DISCOVERABLE_BIOMES as readonly string[]).includes(value);
}

export const WORLD_ZONE_BIOME_NAMES: Readonly<Record<WorldZoneBiome, string>> = {
  jungle: "Jungle",
  pinewild: "Pinewild",
  greenwood: "Greenwood",
  frostwood: "Frostwood",
  plains: "Plains",
  savanna: "Savanna",
  marsh: "Marsh",
  highmeadow: "Highmeadow",
  scrubland: "Scrubland",
  badlands: "Badlands",
  steppe: "Steppe",
  tundra: "Tundra",
  frozen_waste: "Frozen Waste",
  coast: "Coast",
  open_ocean: "Open Ocean",
  lake: "Lake",
  wilds: "Wilds"
};

/** Point queries against the run-length world zone grid (see generate-world-zone-lookup.py). */
export type WorldZoneLookup = Readonly<{
  codeAt(latitude: number, longitude: number): number;
  /** Closest accepted code within `radiusPx` grid pixels (square rings), or null. */
  nearestCodeAt(
    latitude: number,
    longitude: number,
    accept: (code: number) => boolean,
    radiusPx: number
  ): number | null;
}>;

const LOOKUP_HEADER_BYTES = 12;
const MAX_MERCATOR_LATITUDE = 85.05112878;

/**
 * Parses `world-zone-lookup-v1.bin`: "AAZL", u16 version 2, u16 width, u16 height, u16 reserved,
 * then u32 row starts (height + 1), u16 run ends, and u8 run codes, all little-endian.
 */
export function parseWorldZoneLookup(buffer: ArrayBuffer): WorldZoneLookup {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3)
  );
  if (magic !== "AAZL" || view.getUint16(4, true) !== 2) {
    throw new Error("unsupported world zone lookup");
  }
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  const rowStart = new Uint32Array(buffer, LOOKUP_HEADER_BYTES, height + 1);
  const runCount = rowStart[height]!;
  const runEndOffset = LOOKUP_HEADER_BYTES + (height + 1) * 4;
  const runEnd = new Uint16Array(buffer, runEndOffset, runCount);
  const runCode = new Uint8Array(buffer, runEndOffset + runCount * 2, runCount);

  const pixelAt = (latitude: number, longitude: number): readonly [number, number] | null => {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    const lat = Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, latitude));
    const radians = (lat * Math.PI) / 180;
    const mercatorY = (1 - Math.log(Math.tan(Math.PI / 4 + radians / 2)) / Math.PI) / 2;
    const y = Math.min(height - 1, Math.max(0, Math.floor(mercatorY * height)));
    const wrappedLon = ((((longitude + 180) % 360) + 360) % 360);
    const x = Math.min(width - 1, Math.floor((wrappedLon / 360) * width));
    return [x, y];
  };
  const codeAtPixel = (x: number, y: number): number => {
    let low = rowStart[y]!;
    let high = rowStart[y + 1]! - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (runEnd[middle]! > x) high = middle;
      else low = middle + 1;
    }
    return runCode[low] ?? 0;
  };

  return {
    codeAt(latitude, longitude) {
      const pixel = pixelAt(latitude, longitude);
      return pixel ? codeAtPixel(pixel[0], pixel[1]) : 0;
    },
    nearestCodeAt(latitude, longitude, accept, radiusPx) {
      const pixel = pixelAt(latitude, longitude);
      if (!pixel) return null;
      const [cx, cy] = pixel;
      for (let radius = 0; radius <= radiusPx; radius += 1) {
        for (let dy = -radius; dy <= radius; dy += 1) {
          const y = cy + dy;
          if (y < 0 || y >= height) continue;
          const edgeRow = Math.abs(dy) === radius;
          for (let dx = -radius; dx <= radius; dx += edgeRow ? 1 : radius * 2 || 1) {
            const code = codeAtPixel((((cx + dx) % width) + width) % width, y);
            if (accept(code)) return code;
          }
        }
      }
      return null;
    }
  };
}

export type WorldZoneKind = "land" | "ocean" | "lake" | "unknown";

export type WorldZone = Readonly<{
  kind: WorldZoneKind;
  biome: WorldZoneBiome;
  name: string;
  /** Lowland/Upland/Highland/Peaks/Summit on land, Shallows…The Abyss at sea, Freshwater on lakes. */
  heightWord: string | null;
  /** 0 low … 4 summit on land; null elsewhere. */
  elevationBand: 0 | 1 | 2 | 3 | 4 | null;
}>;

/** RESOLVE Ecoregions 2017 BIOME_NUM 1..14, then class 15 for the "Rock and Ice" ecoregion. */
export const RESOLVE_BIOME_CLASSES = [
  "jungle", // 1 tropical & subtropical moist broadleaf forests
  "jungle", // 2 tropical & subtropical dry broadleaf forests
  "pinewild", // 3 tropical & subtropical coniferous forests
  "greenwood", // 4 temperate broadleaf & mixed forests
  "pinewild", // 5 temperate conifer forests
  "frostwood", // 6 boreal forests / taiga
  "savanna", // 7 tropical & subtropical grasslands, savannas & shrublands
  "plains", // 8 temperate grasslands, savannas & shrublands
  "marsh", // 9 flooded grasslands & savannas
  "highmeadow", // 10 montane grasslands & shrublands
  "tundra", // 11 tundra
  "scrubland", // 12 Mediterranean forests, woodlands & scrub
  "badlands", // 13 deserts & xeric shrublands (Steppe outside the warm belt)
  "marsh", // 14 mangroves
  "frozen_waste" // 15 Rock and Ice
] as const satisfies readonly WorldZoneBiome[];

export const WORLD_ZONE_TAGS = ["shoreline", "lakeshore", "riverside", "river"] as const;
export type WorldZoneTag = (typeof WORLD_ZONE_TAGS)[number];
export const WORLD_ZONE_TAG_NAMES: Readonly<Record<WorldZoneTag, string>> = {
  shoreline: "Shoreline",
  lakeshore: "Lakeshore",
  riverside: "Riverside",
  river: "River"
};

const LAND_HEIGHT_WORDS = ["Lowland", "Upland", "Highland", "Peaks", "Summit"] as const;
const ELEVATION_BANDS = LAND_HEIGHT_WORDS.length;

/**
 * Metres at which the Moderate (Upland), High (Highland), Alpine (Peaks) and Summit bands begin.
 * Mirrors `elevationThresholdsM` in data/world-environment-overlay-v1.json (asserted by a test).
 */
export const WORLD_ZONE_ELEVATION_THRESHOLDS_M = [500, 1500, 2500, 5000] as const;

/** Land elevation band (0 Lowland … 4 Summit) for a point elevation in metres. */
export function worldZoneElevationBandFromMeters(elevationM: number): 0 | 1 | 2 | 3 | 4 {
  let band = 0;
  for (const threshold of WORLD_ZONE_ELEVATION_THRESHOLDS_M) if (elevationM >= threshold) band += 1;
  return band as 0 | 1 | 2 | 3 | 4;
}
const OCEAN_DEPTH_WORDS = ["Shallows", "Open Water", "The Deep", "The Abyss"] as const;
/** Stable ids of the ocean depth bands, in OCEAN_DEPTH_WORDS order (Shallows is the Coast biome). */
export const WORLD_ZONE_OCEAN_DEPTHS = ["shallows", "open_water", "the_deep", "the_abyss"] as const;
export type WorldZoneOceanDepth = (typeof WORLD_ZONE_OCEAN_DEPTHS)[number];
const LAND_BASE = 1;
const OCEAN_BASE = 96;
const LAKE_CODE = 112;
export const BADLANDS_MAX_ABS_LATITUDE = 35;

/** The cooked lookup's ocean depth band at a point, or null where the lookup is not ocean. */
export function worldZoneOceanDepthAt(
  lookup: WorldZoneLookup,
  position: Readonly<{ lat: number; lon: number }>
): WorldZoneOceanDepth | null {
  const depth = lookup.codeAt(position.lat, position.lon) - OCEAN_BASE;
  return depth >= 1 && depth <= WORLD_ZONE_OCEAN_DEPTHS.length ? WORLD_ZONE_OCEAN_DEPTHS[depth - 1]! : null;
}

export function worldZoneFromCode(code: number, latitude: number): WorldZone {
  const landIndex = code - LAND_BASE;
  if (landIndex >= 0 && landIndex < RESOLVE_BIOME_CLASSES.length * ELEVATION_BANDS) {
    const elevationBand = (landIndex % ELEVATION_BANDS) as 0 | 1 | 2 | 3 | 4;
    let biome: WorldZoneBiome = RESOLVE_BIOME_CLASSES[Math.floor(landIndex / ELEVATION_BANDS)]!;
    if (biome === "badlands" && Math.abs(latitude) >= BADLANDS_MAX_ABS_LATITUDE) biome = "steppe";
    return zone("land", biome, LAND_HEIGHT_WORDS[elevationBand], elevationBand);
  }
  const depth = code - OCEAN_BASE;
  if (depth >= 1 && depth <= OCEAN_DEPTH_WORDS.length) {
    return zone("ocean", depth === 1 ? "coast" : "open_ocean", OCEAN_DEPTH_WORDS[depth - 1]!, null);
  }
  if (code === LAKE_CODE) return zone("lake", "lake", "Freshwater", null);
  return zone("unknown", "wilds", null, null);
}

/** RESOLVE ECO_ID of the "Rock and Ice" ecoregion (BIOME_NUM 11), which reads as Frozen Waste. */
export const RESOLVE_ROCK_AND_ICE_ECOREGION_ID = 0;

function resolveIdNumber(value: string | null | undefined): number | null {
  const match = typeof value === "string" ? /^\s*(\d+)(?:\.0+)?\s*$/u.exec(value) : null;
  return match ? Number(match[1]) : null;
}

/**
 * Land biome for World's RESOLVE identifiers (BIOME_NUM and ECO_ID as decimal strings) with the
 * cooked lookup's rules: Rock and Ice is Frozen Waste, and desert biome 13 is Steppe at or beyond
 * 35 degrees latitude. Null when the identifiers are not a RESOLVE land biome.
 */
export function worldZoneBiomeFromResolveIds(
  biomeId: string | null | undefined,
  ecoregionId: string | null | undefined,
  latitude: number
): WorldZoneBiome | null {
  const biomeNumber = resolveIdNumber(biomeId);
  if (biomeNumber === null || biomeNumber < 1 || biomeNumber > RESOLVE_BIOME_CLASSES.length - 1) return null;
  if (biomeNumber === 11 && resolveIdNumber(ecoregionId) === RESOLVE_ROCK_AND_ICE_ECOREGION_ID) {
    return "frozen_waste";
  }
  const biome: WorldZoneBiome = RESOLVE_BIOME_CLASSES[biomeNumber - 1]!;
  return biome === "badlands" && Math.abs(latitude) >= BADLANDS_MAX_ABS_LATITUDE ? "steppe" : biome;
}

export function isWorldZoneLandCode(code: number): boolean {
  return code >= LAND_BASE && code < LAND_BASE + RESOLVE_BIOME_CLASSES.length * ELEVATION_BANDS;
}

/** A zone rebuilt from a biome and height word (for example the server's resolved zone). */
export function worldZoneFromParts(biome: WorldZoneBiome, heightWord: string | null): WorldZone {
  const band = (LAND_HEIGHT_WORDS as readonly string[]).indexOf(heightWord ?? "");
  const kind: WorldZoneKind = biome === "lake"
    ? "lake"
    : biome === "coast" || biome === "open_ocean"
      ? "ocean"
      : biome === "wilds" ? "unknown" : "land";
  return zone(kind, biome, heightWord, kind === "land" && band >= 0 ? band as 0 | 1 | 2 | 3 | 4 : null);
}

/** The validated World gameplay-environment facts `resolveWorldZone` reads. */
export type WorldZoneEnvironmentFacts = Readonly<{
  ok: boolean;
  surfaceKind?: "land" | "water" | null;
  waterKind?: "ocean" | "lake" | "river" | "inland_water" | null;
  isLand?: boolean | null;
  isSaltwater?: boolean | null;
  insideMajorLake?: boolean | null;
  isCoastalLand?: boolean | null;
  isRiverbank?: boolean | null;
  isLakeshore?: boolean | null;
  oceanCoastSurface?: Readonly<{ isOceanCoast: boolean }> | null;
  /** Point elevation in metres (~1 km GMTED); picks the land height word when finite. */
  elevationM?: number | null;
}>;

export type WorldZoneResolution = Readonly<{
  biome: WorldZoneBiome;
  tags: WorldZoneTag[];
  heightWord: string | null;
  /** "world" when World classified the point; "fallback" when only the cooked lookup was used. */
  authority: "world" | "fallback";
}>;

/** How far (grid pixels, ~20 km each) to look for land when the cooked pixel is water. */
const NEAREST_LAND_RADIUS_PX = 4;

/**
 * Resolves the zone at a point. Land biomes come from the cooked lookup and the height word from
 * World's point elevation when it is finite (cooked pixel band otherwise); water and
 * shore tags come from World. Precedence follows World's surfaces: river > lake > ocean > land.
 * - River water keeps the surrounding land biome and adds "river".
 * - Lake water (inside a major lake, or other fresh inland water) is Lake; ocean water is Coast inside the ocean-coast band,
 *   otherwise Open Ocean (depth word from the cooked ocean band when the pixel is ocean).
 * - On land, isCoastalLand adds "shoreline"; isLakeshore adds "lakeshore"; isRiverbank adds
 *   "riverside" only when the point is not also lakeshore, since the riverbank-lakeshore release
 *   marks land near either water and one shore tag is enough.
 * - When World is unavailable (`ok: false`) or gave no surface, the cooked zone is used with no
 *   tags. `ok: false` is never treated as land.
 */
export function resolveWorldZone(
  lookup: WorldZoneLookup,
  position: Readonly<{ lat: number; lon: number }>,
  world: WorldZoneEnvironmentFacts | null
): WorldZoneResolution {
  const cooked = worldZoneFromCode(lookup.codeAt(position.lat, position.lon), position.lat);
  const fallback: WorldZoneResolution = {
    biome: cooked.biome, tags: [], heightWord: cooked.heightWord, authority: "fallback"
  };
  if (!world?.ok) return fallback;
  const land = (): WorldZone | null => {
    if (cooked.kind === "land") return cooked;
    const code = lookup.nearestCodeAt(
      position.lat, position.lon, isWorldZoneLandCode, NEAREST_LAND_RADIUS_PX
    );
    return code === null ? null : worldZoneFromCode(code, position.lat);
  };
  const onLand = (tags: WorldZoneTag[]): WorldZoneResolution => {
    const zone = land();
    const elevationM = world.elevationM;
    const heightWord = zone && typeof elevationM === "number" && Number.isFinite(elevationM)
      ? LAND_HEIGHT_WORDS[worldZoneElevationBandFromMeters(elevationM)]
      : zone?.heightWord ?? null;
    return {
      biome: zone?.biome ?? "wilds",
      tags,
      heightWord,
      authority: "world"
    };
  };
  if (world.surfaceKind === "water") {
    if (world.waterKind === "river") return onLand(["river"]);
    const lake: WorldZoneResolution = { biome: "lake", tags: [], heightWord: "Freshwater", authority: "world" };
    if (world.waterKind === "lake" || world.insideMajorLake === true) return lake;
    if (world.waterKind === "ocean" || world.isSaltwater === true) {
      if (world.oceanCoastSurface?.isOceanCoast === true) {
        return { biome: "coast", tags: [], heightWord: OCEAN_DEPTH_WORDS[0], authority: "world" };
      }
      return {
        biome: "open_ocean",
        tags: [],
        heightWord: cooked.kind === "ocean" ? cooked.heightWord : OCEAN_DEPTH_WORDS[1],
        authority: "world"
      };
    }
    // Non-canonical inland water (ponds, reservoirs) that is not saltwater reads as Lake.
    if (world.waterKind === "inland_water") return lake;
    return fallback;
  }
  if (world.surfaceKind === "land" || world.isLand === true) {
    const tags: WorldZoneTag[] = [];
    if (world.isCoastalLand === true) tags.push("shoreline");
    if (world.isLakeshore === true) tags.push("lakeshore");
    else if (world.isRiverbank === true) tags.push("riverside");
    return onLand(tags);
  }
  return fallback;
}

function zone(
  kind: WorldZoneKind,
  biome: WorldZoneBiome,
  heightWord: string | null,
  elevationBand: WorldZone["elevationBand"]
): WorldZone {
  return { kind, biome, name: WORLD_ZONE_BIOME_NAMES[biome], heightWord, elevationBand };
}

export type WorldSeason = "spring" | "summer" | "autumn" | "winter" | "wet" | "dry";
export type WorldSeasonPhase = "early" | "mid" | "late";

export type WorldSeasonState = Readonly<{
  season: WorldSeason;
  /** Null when the season lasts all year (for example Frozen Waste). */
  phase: WorldSeasonPhase | null;
  label: string;
}>;

const SEASON_NAMES: Readonly<Record<WorldSeason, string>> = {
  spring: "Spring",
  summer: "Summer",
  autumn: "Autumn",
  winter: "Winter",
  wet: "Wet Season",
  dry: "Dry Season"
};
const PHASE_NAMES: Readonly<Record<WorldSeasonPhase, string>> = {
  early: "Early",
  mid: "Mid",
  late: "Late"
};
const TROPIC_LATITUDE = 23.5;
const POLAR_LATITUDE = 66.5;

/**
 * Real-calendar season at a latitude. Temperate zones use meteorological seasons (north
 * Mar–May spring … Dec–Feb winter), flipped south of the equator. The tropics have a wet season
 * in the local summer half of the year. Polar zones only have a Jun–Aug (north) or Dec–Feb
 * (south) summer. Highland pushes the shoulder months toward winter; Peaks only keep summer; Summit is winter all
 * year outside the tropics.
 */
export function worldSeasonAt(input: {
  latitude: number;
  date: Date;
  elevationBand?: WorldZone["elevationBand"];
  biome?: WorldZoneBiome;
}): WorldSeasonState {
  if (input.biome === "frozen_waste") {
    return { season: "winter", phase: null, label: SEASON_NAMES.winter };
  }
  const month = input.date.getUTCMonth();
  const seasonForMonth = (m: number): WorldSeason => seasonForLatitudeMonth(
    input.latitude,
    ((m % 12) + 12) % 12,
    input.elevationBand ?? null
  );
  const season = seasonForMonth(month);
  let monthsBefore = 0;
  while (monthsBefore < 11 && seasonForMonth(month - monthsBefore - 1) === season) monthsBefore += 1;
  let monthsAfter = 0;
  while (monthsBefore + monthsAfter < 11 && seasonForMonth(month + monthsAfter + 1) === season) {
    monthsAfter += 1;
  }
  const runMonths = monthsBefore + monthsAfter + 1;
  if (runMonths >= 12) return { season, phase: null, label: SEASON_NAMES[season] };
  const daysInMonth = new Date(Date.UTC(input.date.getUTCFullYear(), month + 1, 0)).getUTCDate();
  const progress = (monthsBefore + (input.date.getUTCDate() - 1) / daysInMonth) / runMonths;
  const phase: WorldSeasonPhase = progress < 1 / 3 ? "early" : progress < 2 / 3 ? "mid" : "late";
  return { season, phase, label: `${PHASE_NAMES[phase]} ${SEASON_NAMES[season]}` };
}

function seasonForLatitudeMonth(
  latitude: number,
  month: number,
  elevationBand: WorldZone["elevationBand"]
): WorldSeason {
  const south = latitude < 0;
  // Shift southern months by half a year so one northern table serves both hemispheres.
  const northernMonth = south ? (month + 6) % 12 : month;
  const absLatitude = Math.abs(latitude);
  if (absLatitude < TROPIC_LATITUDE) {
    return northernMonth >= 4 && northernMonth <= 9 ? "wet" : "dry";
  }
  const summer = northernMonth >= 5 && northernMonth <= 7;
  if (elevationBand === 4) return "winter";
  if (absLatitude >= POLAR_LATITUDE || elevationBand === 3) return summer ? "summer" : "winter";
  if (northernMonth === 11 || northernMonth <= 1) return "winter";
  if (elevationBand === 2 && (northernMonth === 2 || northernMonth === 10)) return "winter";
  if (northernMonth <= 4) return "spring";
  if (summer) return "summer";
  return "autumn";
}

export type WorldZoneBannerContent = Readonly<{
  /** Stable identity: a new banner appears only when this changes. */
  key: WorldZoneBiome;
  title: string;
  detail: string;
}>;

export function worldZoneBannerContent(
  zone: WorldZone,
  season: WorldSeasonState
): WorldZoneBannerContent {
  return {
    key: zone.biome,
    title: zone.name,
    detail: zone.heightWord ? `${season.label} · ${zone.heightWord}` : season.label
  };
}
