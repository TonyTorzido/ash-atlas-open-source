import { destinationPoint } from "@ash-atlas/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AuthService } from "../auth/authService.js";
import {
  FallenPrisonCrashError,
  type FallenPrisonCrashService
} from "../game/fallenPrisonCrash.js";
import type { DeveloperSpawnedDungeonService } from "../game/developerSpawnedDungeons.js";
import { packageIdForPosition } from "../game/spatialZones.js";
import type { GameState } from "../game/state.js";
import type { ConnectionRegistry } from "../realtime/connectionRegistry.js";
import { sendError } from "./errors.js";
import { authorizeDeveloperHttp, recordDeveloperHttpResult } from "./routes/routeAuthentication.js";

const CAPABILITY = "developer:world-mutate" as const;
const COMMAND = "fallen-prison.crash";
const crashSchema = z.object({
  /** The crash lands this far north of the target player (metres). */
  playerId: z.string().min(1).max(128),
  offsetM: z.number().min(50).max(5_000).default(400),
  operationKey: z.string().uuid()
}).strict();

export function registerFallenPrisonRoutes(
  app: FastifyInstance,
  auth: AuthService,
  crash: FallenPrisonCrashService,
  placements: DeveloperSpawnedDungeonService,
  gameState: GameState,
  registry: ConnectionRegistry
): void {
  // Developer: land the prison near a player. Entering still follows the dungeon's normal rules.
  app.post("/api/dev/fallen-prison/crash", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = crashSchema.safeParse(request.body);
    const target = parsed.success ? parsed.data.playerId : null;
    const operationKey = parsed.success ? parsed.data.operationKey : null;
    const session = await authorizeDeveloperHttp(request, reply, auth, CAPABILITY, COMMAND, target, operationKey);
    if (!session) return;
    const record = (outcome: "succeeded" | "failed") =>
      recordDeveloperHttpResult(auth, session, { capability: CAPABILITY, command: COMMAND, target, operationKey, outcome });
    if (!parsed.success) {
      await record("failed");
      return sendError(reply, 400, "INVALID_FALLEN_PRISON_CRASH", "Fallen Prison crash request is invalid");
    }
    const player = gameState.getPlayer(parsed.data.playerId);
    if (!player) {
      await record("failed");
      return sendError(reply, 404, "PLAYER_NOT_ONLINE", "That player is not online");
    }
    try {
      const position = destinationPoint(player.position, parsed.data.offsetM, 0);
      const result = await crash.trigger({
        creatorPlayerId: session.player!.id,
        requestId: parsed.data.operationKey,
        regionCode: packageIdForPosition(position),
        position
      });
      const entrance = placements.snapshotFor(result.placement);
      if (!result.replayed) {
        registry.broadcast({ type: "DUNGEON_ENTRANCE_UPSERTED", entrance });
      }
      await record("succeeded");
      return { entrance, expiresAt: result.placement.expiresAt, replayed: result.replayed };
    } catch (error) {
      await record("failed");
      if (error instanceof FallenPrisonCrashError) return sendError(reply, error.statusCode, error.code, error.message);
      return sendError(reply, 503, "FALLEN_PRISON_CRASH_UNAVAILABLE", "The crash event is temporarily unavailable");
    }
  });
  // Players find the crash by the hunt hint and the smoke (FALLEN_PRISON_HUNT), not by a precise trail.
}
