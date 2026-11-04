const VERSION = 2;
const LEGACY_VERSION = 1;
const MAX_SERIALIZED_BYTES = 1_024;

export type SafePresentationState = Readonly<{
  version: 2;
  map: { lat: number; lon: number; zoom: number } | null;
}>;

export function readSafePresentationState(playerId: string): SafePresentationState | null {
  try {
    const currentKey = key(playerId, VERSION);
    const currentRaw = localStorage.getItem(currentKey);
    const current = readVersionedState(currentRaw, VERSION);
    if (current) return current;
    if (currentRaw !== null) localStorage.removeItem(currentKey);

    const legacyKey = key(playerId, LEGACY_VERSION);
    const legacy = readVersionedState(localStorage.getItem(legacyKey), LEGACY_VERSION);
    localStorage.removeItem(legacyKey);
    if (!legacy) return null;

    const migrated: SafePresentationState = { version: VERSION, map: legacy.map };
    writeState(playerId, migrated);
    return migrated;
  } catch {
    return null;
  }
}

export function persistSafePresentationState(
  playerId: string,
  update: Partial<Pick<SafePresentationState, "map">>
): void {
  try {
    const current = readSafePresentationState(playerId);
    writeState(playerId, {
      version: VERSION,
      map: update.map === undefined ? current?.map ?? null : update.map
    });
  } catch {
    // Presentation persistence must never interrupt gameplay.
  }
}

export function clearSafePresentationState(playerId: string): void {
  try {
    localStorage.removeItem(key(playerId, VERSION));
    localStorage.removeItem(key(playerId, LEGACY_VERSION));
  } catch {
    // Best effort during terminal logout.
  }
}

function writeState(playerId: string, state: SafePresentationState): void {
  const serialized = JSON.stringify(state);
  if (serialized.length <= MAX_SERIALIZED_BYTES) {
    localStorage.setItem(key(playerId, VERSION), serialized);
  }
}

function readVersionedState(
  raw: string | null,
  version: typeof VERSION | typeof LEGACY_VERSION
): SafePresentationState | null {
  try {
    if (!raw || raw.length > MAX_SERIALIZED_BYTES) return null;
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.version !== version) return null;
    return { version: VERSION, map: readMap(value.map) };
  } catch {
    return null;
  }
}

function key(playerId: string, version: number): string {
  return `ash-atlas:presentation:v${version}:${playerId}`;
}

function readMap(value: unknown): SafePresentationState["map"] {
  if (!value || typeof value !== "object") return null;
  const map = value as Record<string, unknown>;
  if (
    typeof map.lat !== "number" ||
    typeof map.lon !== "number" ||
    typeof map.zoom !== "number" ||
    !Number.isFinite(map.lat) ||
    !Number.isFinite(map.lon) ||
    !Number.isFinite(map.zoom) ||
    map.lat < -90 ||
    map.lat > 90 ||
    map.lon < -180 ||
    map.lon > 180 ||
    map.zoom < 0 ||
    map.zoom > 24
  ) {
    return null;
  }
  return { lat: map.lat, lon: map.lon, zoom: map.zoom };
}
