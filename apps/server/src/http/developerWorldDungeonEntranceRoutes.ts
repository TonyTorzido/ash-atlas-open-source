import { distanceMeters } from "@ash-atlas/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AuthService } from "../auth/authService.js";
import type { GameState } from "../game/state.js";
import type { WorldDungeonEntranceService } from "../game/worldDungeonEntrances.js";
import { sendError } from "./errors.js";
import { authorizeDeveloperHttp, recordDeveloperHttpResult } from "./routes/routeAuthentication.js";

const CAPABILITY = "developer:observe" as const;
const COMMAND = "world-dungeon-entrances.near";
const querySchema = z.object({
  playerId: z.string().min(1).max(128),
  radiusM: z.coerce.number().min(1_000).max(100_000).default(25_000)
}).strict();

/**
 * Developer readout: the rolled ladder-dungeon entrances standing around an online player, hidden
 * ones included (with when they show), nearest first. Read-only; entering follows the normal rules.
 */
export function registerDeveloperWorldDungeonEntranceRoutes(
  app: FastifyInstance,
  auth: AuthService,
  entrances: Pick<WorldDungeonEntranceService, "sitesNear">,
  gameState: Pick<GameState, "getPlayer">
): void {
  app.get("/api/dev/world-dungeon-entrances", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    const target = parsed.success ? parsed.data.playerId : null;
    const session = await authorizeDeveloperHttp(request, reply, auth, CAPABILITY, COMMAND, target);
    if (!session) return;
    const record = (outcome: "succeeded" | "failed") =>
      recordDeveloperHttpResult(auth, session, { capability: CAPABILITY, command: COMMAND, target, outcome });
    if (!parsed.success) {
      await record("failed");
      return sendError(reply, 400, "INVALID_WORLD_DUNGEON_ENTRANCE_QUERY", "World dungeon entrance query is invalid");
    }
    const player = gameState.getPlayer(parsed.data.playerId);
    if (!player) {
      await record("failed");
      return sendError(reply, 404, "PLAYER_NOT_ONLINE", "That player is not online");
    }
    try {
      const sites = await entrances.sitesNear(player.position, parsed.data.radiusM);
      await record("succeeded");
      return {
        position: player.position,
        entrances: sites
          .map((site) => ({
            entranceId: site.entranceId,
            dungeonId: site.dungeonId,
            lat: site.position.lat,
            lon: site.position.lon,
            distanceM: Math.round(distanceMeters(player.position, site.position)),
            visible: site.visible,
            spawnedAt: new Date(site.spawnAt).toISOString(),
            expiresAt: new Date(site.expiresAt).toISOString()
          }))
          .sort((left, right) => left.distanceM - right.distanceM)
      };
    } catch {
      await record("failed");
      return sendError(reply, 503, "WORLD_DUNGEON_ENTRANCES_UNAVAILABLE", "World dungeon entrances are temporarily unavailable");
    }
  });
}
