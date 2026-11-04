import type { CityActiveConstructionSnapshot } from "@ash-atlas/shared";

export function blocksClientMovement(
  construction: CityActiveConstructionSnapshot | null
): boolean {
  return construction !== null && construction.action !== "build_oil_well" &&
    construction.action !== "build_quartz_hut" &&
    construction.action !== "build_library";
}
