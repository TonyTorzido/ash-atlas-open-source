import type { CitySnapshot } from "@ash-atlas/shared";

export function reconcileCitySnapshot(
  current: CitySnapshot[],
  snapshot: CitySnapshot[]
): CitySnapshot[] {
  const byId = new Map(current.map((city) => [city.id, city]));
  for (const city of snapshot) {
    const existing = byId.get(city.id);
    if (!existing || revision(city) >= revision(existing)) {
      byId.set(city.id, city);
    }
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function applyCityUpdate(
  current: CitySnapshot[],
  city: CitySnapshot
): CitySnapshot[] {
  return reconcileCitySnapshot(current, [city]);
}

function revision(city: CitySnapshot): bigint {
  try {
    return BigInt(city.spatialRevision);
  } catch {
    return 0n;
  }
}
