export function packageIdForPosition(position: { lat: number; lon: number }): string {
  if (!Number.isFinite(position.lat) || position.lat < -90 || position.lat > 90) {
    throw new Error("latitude is outside WGS84 bounds");
  }
  if (!Number.isFinite(position.lon) || position.lon < -180 || position.lon > 180) {
    throw new Error("longitude is outside WGS84 bounds");
  }
  const south = Math.min(89, Math.floor(position.lat));
  const west = Math.min(179, Math.floor(position.lon));
  return `world_v1_lat${south}_lon${west}`;
}

export function zoneIdForPosition(position: { lat: number; lon: number }): string {
  return `world:${packageIdForPosition(position)}`;
}

export function adjacentZoneIdsForPosition(position: { lat: number; lon: number }): string[] {
  const packageId = packageIdForPosition(position);
  const match = /^world_v1_lat(-?\d+)_lon(-?\d+)$/.exec(packageId);
  if (!match) throw new Error(`invalid canonical package ID: ${packageId}`);
  const south = Number(match[1]);
  const west = Number(match[2]);
  const zones = new Set<string>();
  for (let latitudeOffset = -1; latitudeOffset <= 1; latitudeOffset += 1) {
    const candidateSouth = south + latitudeOffset;
    if (candidateSouth < -90 || candidateSouth > 89) continue;
    for (let longitudeOffset = -1; longitudeOffset <= 1; longitudeOffset += 1) {
      const candidateWest = ((west + longitudeOffset + 180) % 360 + 360) % 360 - 180;
      zones.add(`world:world_v1_lat${candidateSouth}_lon${candidateWest}`);
    }
  }
  return [...zones].sort();
}

const EARTH_RADIUS_M = 6_371_008.8;

export function zoneIdsIntersectingCircle(
  position: { lat: number; lon: number },
  radiusM: number
): string[] {
  packageIdForPosition(position);
  if (!Number.isFinite(radiusM) || radiusM < 0) {
    throw new Error("circle radius must be non-negative");
  }
  if (radiusM === 0) return [zoneIdForPosition(position)];

  const angularRadius = Math.min(Math.PI, radiusM / EARTH_RADIUS_M);
  const latitudeRadians = (position.lat * Math.PI) / 180;
  const latitudeRadius = (angularRadius * 180) / Math.PI;
  const minimumLatitude = Math.max(-90, position.lat - latitudeRadius);
  const maximumLatitude = Math.min(90, position.lat + latitudeRadius);
  const southernmostPackage = Math.max(-90, Math.min(89, Math.floor(minimumLatitude)));
  const northernmostPackage = Math.max(-90, Math.min(89, Math.floor(maximumLatitude)));
  const reachesPole = minimumLatitude <= -90 || maximumLatitude >= 90;
  const longitudeRadius = reachesPole
    ? 180
    : (Math.asin(Math.min(1, Math.abs(
        Math.sin(angularRadius) / Math.cos(latitudeRadians)
      ))) * 180) / Math.PI;
  const westernPackages = new Set<number>();
  if (longitudeRadius >= 180) {
    for (let west = -180; west <= 179; west += 1) westernPackages.add(west);
  } else {
    const firstWest = Math.floor(position.lon - longitudeRadius);
    const lastWest = Math.floor(position.lon + longitudeRadius);
    for (let west = firstWest; west <= lastWest; west += 1) {
      westernPackages.add(((west + 180) % 360 + 360) % 360 - 180);
    }
  }

  const zones = new Set<string>();
  for (let south = southernmostPackage; south <= northernmostPackage; south += 1) {
    for (const west of westernPackages) {
      zones.add(`world:world_v1_lat${south}_lon${west}`);
    }
  }
  zones.add(zoneIdForPosition(position));
  return [...zones].sort();
}
