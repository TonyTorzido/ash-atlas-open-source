import { find as findTimeZones } from "geo-tz";

import { ZONE_COUNTRIES } from "./zoneCountries.js";

// GPS -> IANA zone(s) -> countries and current UTC offsets (NATIVE_ANTISPOOF_BUILD_PLAN.md
// section 5). Pure lookups against bundled data; no network, no raw coordinates kept.

export type GeoZoneLookup = Readonly<{
  zonesAt(lat: number, lon: number): readonly string[];
  countriesForZones(zones: readonly string[]): ReadonlySet<string>;
}>;

export function zonesAt(lat: number, lon: number): readonly string[] {
  try {
    return findTimeZones(lat, lon);
  } catch {
    return [];
  }
}

/** Countries that share any of the zones (a multi-country zone passes for each of them). */
export function countriesForZones(zones: readonly string[]): ReadonlySet<string> {
  const countries = new Set<string>();
  for (const zone of zones) {
    const listed = ZONE_COUNTRIES[zone];
    if (!listed) continue;
    for (const country of listed.split(" ")) countries.add(country);
  }
  return countries;
}

export const defaultGeoZoneLookup: GeoZoneLookup = { zonesAt, countriesForZones };

const OFFSET_PATTERN = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/u;
const formatters = new Map<string, Intl.DateTimeFormat | null>();

/** Current UTC offset of an IANA zone in minutes, or null when the zone is unknown. */
export function utcOffsetMinutes(zone: string, at: Date): number | null {
  let formatter = formatters.get(zone);
  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" });
    } catch {
      formatter = null;
    }
    if (formatters.size > 512) formatters.clear();
    formatters.set(zone, formatter);
  }
  if (!formatter) return null;
  const part = formatter.formatToParts(at).find((entry) => entry.type === "timeZoneName")?.value;
  const match = part ? OFFSET_PATTERN.exec(part) : null;
  if (!match) return null;
  if (!match[1]) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return match[1] === "-" ? -minutes : minutes;
}
