import type { ServerMessage } from "@ash-atlas/shared";

import {
  PlayerPackageError,
  type PlayerPackageService
} from "../../game/playerPackages.js";
import type { SocketLike } from "../connectionRegistry.js";
import type {
  RealtimeFamilyHandler,
  RealtimeMessageRouter
} from "../messageRouter.js";
import {
  requireHello,
  type RealtimeConnectionState
} from "./handlerExecutionContext.js";

export function createPlayerPackageHandler(context: Readonly<{
  state: Pick<RealtimeConnectionState, "playerId">;
  socket: SocketLike;
  packages: PlayerPackageService;
  enforcePlayerClassRate(key: string, maximum: number, windowMs: number): void;
  safeSendServerMessage(socket: SocketLike, message: ServerMessage): boolean;
}>): RealtimeFamilyHandler<"packages"> {
  return async (message) => {
    requireHello(context.state.playerId);
    const playerId = context.state.playerId;
    switch (message.type) {
      case "REQUEST_PLAYER_PACKAGES":
        context.enforcePlayerClassRate("player-packages-list", 12, 10_000);
        context.safeSendServerMessage(context.socket, {
          type: "PLAYER_PACKAGES_SNAPSHOT",
          requestId: message.requestId,
          packages: await context.packages.inbox(playerId)
        });
        return;
      case "CLAIM_PLAYER_PACKAGE":
        context.enforcePlayerClassRate("player-package-claim", 8, 10_000);
        try {
          const result = await context.packages.claim(
            playerId,
            message.packageId,
            message.requestId,
            message.expectedRevision
          );
          context.safeSendServerMessage(context.socket, {
            type: "PLAYER_PACKAGE_CLAIM_RESULT",
            ...result
          });
        } catch (error) {
          const packageError = error instanceof PlayerPackageError
            ? error
            : null;
          context.safeSendServerMessage(context.socket, {
            type: "PLAYER_PACKAGE_ERROR",
            requestId: message.requestId,
            code: packageError?.code ?? "PLAYER_PACKAGE_CLAIM_FAILED",
            message: packageError?.message ?? "Package could not be opened",
            packageId: message.packageId,
            ...(packageError?.currentPackage
              ? { currentPackage: packageError.currentPackage }
              : {})
          });
        }
        return;
    }
  };
}

export function registerPlayerPackageHandler(
  router: RealtimeMessageRouter,
  handler: RealtimeFamilyHandler<"packages">
): void {
  router.register("packages", handler);
}
