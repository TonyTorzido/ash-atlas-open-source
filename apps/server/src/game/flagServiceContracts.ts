import type { FlagSnapshot } from "@ash-atlas/shared";
import type pg from "pg";

export type BurnFlagDeletionResult = Readonly<{
  flagId: string;
  affectedFlagIds: readonly string[];
  notificationPlayerIds: readonly string[];
}>;

export type FlagWarfareService = Readonly<{
  databasePool: pg.Pool;
  getFlag(flagId: string): Promise<FlagSnapshot | null>;
  getMapFlag(flagId: string): Promise<FlagSnapshot | null>;
  currentFlagSetRevision(): Promise<number>;
  deleteFlagForBurnInTransaction(client: pg.PoolClient, flagId: string, burnerPlayerId: string | null): Promise<BurnFlagDeletionResult>;
  deleteFlagForBomberInTransaction(client: pg.PoolClient, flagId: string, bomberPlayerId: string): Promise<BurnFlagDeletionResult>;
}>;

export type CityFlagService = Pick<FlagWarfareService, "deleteFlagForBomberInTransaction" | "deleteFlagForBurnInTransaction">;
export type PersonalFlagWarfareFlagService = Pick<FlagWarfareService, "databasePool" | "getMapFlag" | "deleteFlagForBurnInTransaction">;
export type LegendaryFlagService = Pick<FlagWarfareService, "getFlag" | "currentFlagSetRevision" | "deleteFlagForBurnInTransaction">;
