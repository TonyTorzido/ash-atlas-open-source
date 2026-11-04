export const WORLD_PRESENTATION_CLIENT_TIMEOUT_MS = 30_000;
export const POPULATION_VISIBLE_PREPARATION_TERMINAL_MS = 25_000;

export type WorldViewAuthority = Readonly<{
  playerId: string;
  connectionId: string;
  connectionGeneration: number;
  relocationRevision: number;
  resourceVisionRevision: number;
  gameplayViewGeneration: number;
  populationPreparationGeneration: number;
}>;

export type WorldViewEpoch = WorldViewAuthority & Readonly<{
  resourceSnapshotGeneration: number;
  combatSnapshotGeneration: number;
}>;
