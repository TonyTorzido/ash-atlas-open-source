export const POPULATION_V2_ENCOUNTER_SURFACES = [
  "land",
  "lake",
  "river",
  "ocean"
] as const;

export type PopulationV2EncounterSurface =
  (typeof POPULATION_V2_ENCOUNTER_SURFACES)[number];

export type PopulationV2SurfaceAuthority = Readonly<{
  releaseId: string;
  manifestSha256: string;
  cellSizeM: number;
  rowId: number;
  columnId: number;
}>;

export function populationV2EncounterSurface(input: Readonly<{
  isLand: boolean;
  isSaltwater: boolean;
  insideMajorLake: boolean;
  waterKind?: "ocean" | "lake" | "river" | "inland_water" | null;
}>): PopulationV2EncounterSurface | null {
  if (input.waterKind === "river") return "river";
  if (input.insideMajorLake || input.waterKind === "lake") return "lake";
  if (input.isSaltwater || input.waterKind === "ocean") return "ocean";
  if (input.isLand && input.waterKind !== "inland_water") return "land";
  return null;
}
