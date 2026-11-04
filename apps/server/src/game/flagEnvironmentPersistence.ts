import type { WorldLookupResult } from "../world/worldTypes.js";

export type FlagEnvironmentPersistence = {
  packageId: string | null;
  elevationM: number | null;
  terrainClass: string | null;
  biome: string | null;
  ecoregion: string | null;
  snapshotJson: string;
  snapshotBytes: number;
};

export function prepareFlagEnvironmentPersistence(
  world: WorldLookupResult
): FlagEnvironmentPersistence {
  const snapshotJson = JSON.stringify(world.raw ?? {});
  return {
    packageId: world.packageId,
    elevationM: world.elevationM,
    terrainClass: world.terrainClass,
    biome: world.biome,
    ecoregion: world.ecoregion,
    snapshotJson,
    snapshotBytes: Buffer.byteLength(snapshotJson, "utf8")
  };
}
