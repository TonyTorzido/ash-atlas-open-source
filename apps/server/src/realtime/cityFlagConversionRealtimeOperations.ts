import type { AppConfig } from "../config.js";
import {
  CityFlagConversionCoordinator,
  type CityFlagConversionSession
} from "../game/cityFlagConversionCoordinator.js";
import {
  CityFoundingError,
  type CityFlagConversionResult,
  type CityService
} from "../game/cities.js";
import { flagSetRevisionMetadata, type FlagService } from "../game/flags.js";
import type { AppLogger } from "../logger.js";
import type { ConnectionRegistry } from "./connectionRegistry.js";

export function createCityFlagConversionRealtimeOperations(context: Readonly<{
  config?: AppConfig | undefined;
  logger: AppLogger;
  registry: ConnectionRegistry;
  cities?: CityService | undefined;
  flagService: FlagService;
}>): CityFlagConversionCoordinator | null {
  const { config, logger, registry, cities, flagService } = context;
  if (!config || !cities) return null;

  const publishConverted = async (
    session: CityFlagConversionSession,
    result: CityFlagConversionResult,
    replayed: boolean
  ): Promise<void> => {
    const flag = await flagService.getMapFlag(result.flagId);
    if (!flag) throw new Error("converted city flag snapshot is unavailable");
    registry.send(session.playerId, {
      type: "CITY_FLAG_CONVERTED",
      conversionId: session.conversionId,
      requestId: session.requestId,
      flag,
      expansionFlagCount: result.expansionFlagCount,
      expansionFlagLimit: result.expansionFlagLimit,
      replayed
    });
    if (replayed || result.replayed) return;
    registry.broadcast({
      type: "FLAG_UPDATED",
      flag,
      ...(await flagSetRevisionMetadata(flagService))
    });
    registry.broadcast({
      type: "CITY_MEMBERSHIP_UPDATED",
      cityId: result.cityId,
      playerId: session.playerId,
      memberCount: result.memberCount,
      expansionFlagCount: result.expansionFlagCount,
      expansionFlagLimit: result.expansionFlagLimit,
      action: "flag_converted"
    });
  };

  return new CityFlagConversionCoordinator(
    config.CITY_FLAG_CONVERSION_DURATION_MS,
    cities,
    logger,
    {
      sendStarted: (session) => {
        registry.send(session.playerId, {
          type: "CITY_FLAG_CONVERSION_STARTED",
          conversionId: session.conversionId,
          requestId: session.requestId,
          flagId: session.flagId,
          flagName: session.flagName,
          cityId: session.cityId,
          cityName: session.cityName,
          position: session.position,
          startedAt: session.startedAt,
          completesAt: session.completesAt,
          durationMs: session.completesAt - session.startedAt,
          serverTime: Date.now()
        });
      },
      sendError: (session, error) => {
        registry.send(session.playerId, {
          type: "ERROR",
          requestId: session.requestId,
          code: error instanceof CityFoundingError
            ? error.code
            : "CITY_FLAG_CONVERSION_FAILED",
          message: error instanceof Error
            ? error.message
            : "City flag contribution failed"
        });
      },
      cancelled: (session) => {
        registry.send(session.playerId, {
          type: "ERROR",
          requestId: session.requestId,
          code: "CITY_FLAG_CONVERSION_CANCELLED",
          message: "City flag contribution canceled because you moved."
        });
      },
      completed: (session, result) => publishConverted(session, result, false),
      replayCompleted: (session, result) => publishConverted(session, result, true)
    }
  );
}
