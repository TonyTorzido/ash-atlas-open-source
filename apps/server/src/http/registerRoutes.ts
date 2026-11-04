import type { FastifyInstance } from "fastify";
import type pg from "pg";

import type { AuthService } from "../auth/authService.js";
import type { AppConfig } from "../config.js";
import type { CombatEngine } from "../game/combat/combatEngine.js";
import type { WorldRuntime } from "../game/worldRuntime.js";
import type { MarketReconciliationSupervisor } from "../game/marketReconciliationSupervisor.js";
import type { CollectibleService } from "../game/collectibles.js";
import type { FlagService } from "../game/flags.js";
import type { CityService } from "../game/cities.js";
import type { PlayerService } from "../game/players.js";
import type { ResourceVisionJobQueue } from "../game/resourceVisionJobs.js";
import type { RepeatableResourceService } from "../game/repeatableResources.js";
import type { GameState } from "../game/state.js";
import type { WorldMapService } from "../game/worldMap.js";
import type { AppLogger } from "../logger.js";
import type { ConnectionRegistry } from "../realtime/connectionRegistry.js";
import type { PresenceService } from "../realtime/presenceService.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import type { LandActionGate } from "../auth/trust/trustService.js";
import { HttpAdmissionController } from "./admission.js";
import { httpAdmissionPolicies } from "./routePolicyRegistry.js";
import { createCollectibleRoutes } from "./routes/collectibleRoutes.js";
import { createDiagnosticRoutes } from "./routes/diagnosticRoutes.js";
import { createFlagRoutes } from "./routes/flagRoutes.js";
import { createPlayerRoutes, type DevTeleportThroughTravel } from "./routes/playerRoutes.js";
export { publicPlayerPresence } from "./routes/playerRoutes.js";
import {
  createSystemRoutes,
  type RouteOperationalDependencies
} from "./routes/systemRoutes.js";
export { populationV2AuthorityHealth } from "./routes/systemRoutes.js";
import { createWorldRoutes } from "./routes/worldRoutes.js";
export { authoritativePlayerId } from "./routes/routeAuthentication.js";

type RouteOptional<T> = Readonly<{
  [Property in keyof T]?: T[Property] | undefined;
}>;

export type RouteDependencies = Readonly<{
  infrastructure: Readonly<{
    app: FastifyInstance;
    pool: pg.Pool;
    worldLookup: WorldLookupClient;
    config: AppConfig;
    registry: ConnectionRegistry;
    presence?: PresenceService | undefined;
    logger: AppLogger;
  }>;
  authority: Readonly<{
    flags: FlagService;
    players: PlayerService;
    gameState: GameState;
    auth?: AuthService | undefined;
  }>;
  capabilities?: RouteOptional<{
    collectibles?: CollectibleService;
    resourceVisionJobs?: ResourceVisionJobQueue;
    combat?: CombatEngine;
    worldRuntime?: WorldRuntime;
    marketReconciliation?: MarketReconciliationSupervisor;
    marketMetrics?: () => unknown;
    repeatableResources?: Pick<RepeatableResourceService, "listDeveloperMines"> &
      Partial<Pick<RepeatableResourceService, "listInVision">>;
    schedulePopulationV2Relocation?: (playerId: string) => void;
    devTeleport?: DevTeleportThroughTravel;
    cities?: Pick<CityService, "listCitiesNear">;
    worldMap?: Pick<WorldMapService, "strategicLandmarks">;
    landActions?: LandActionGate;
  }>;
  operational?: RouteOperationalDependencies;
}>;

export function registerRoutes(dependencies: RouteDependencies): void {
  const {
    infrastructure: { app, pool, worldLookup, config, registry, presence, logger },
    authority: { flags, players, gameState, auth },
    capabilities: {
      collectibles,
      resourceVisionJobs,
      combat,
      worldRuntime,
      marketReconciliation,
      marketMetrics,
      repeatableResources,
      schedulePopulationV2Relocation,
      devTeleport,
      cities,
      worldMap,
      landActions
    } = {},
    operational = {}
  } = dependencies;
  const admission = new HttpAdmissionController(config);
  admission.install(app, httpAdmissionPolicies());
  createCollectibleRoutes({
    app,
    collectibles,
    gameState,
    registry,
    auth,
    repeatableResources
  });
  createDiagnosticRoutes({
    app,
    logger,
    registry,
    gameState,
    auth,
    collectibles,
    combat,
    worldRuntime,
    admission,
    operational,
    config
  });
  createPlayerRoutes({
    app,
    players,
    flags,
    gameState,
    auth,
    collectibles,
    registry,
    presence,
    logger,
    worldLookup,
    combat,
    worldRuntime,
    schedulePopulationV2Relocation,
    devTeleport
  });
  createWorldRoutes({ app, worldLookup, admission });
  createFlagRoutes({
    app,
    worldLookup,
    logger,
    registry,
    flags,
    gameState,
    auth,
    resourceVisionJobs,
    admission,
    cities,
    worldMap,
    combat,
    landActions
  });
  createSystemRoutes({
    app,
    pool,
    worldLookup,
    config,
    flags,
    collectibles,
    resourceVisionJobs,
    marketReconciliation,
    marketMetrics,
    admission,
    operational
  });
}
