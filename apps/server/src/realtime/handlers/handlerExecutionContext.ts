export type RealtimeConnectionState = {
  playerId: string | null;
  connectionId: string | null;
  connectionGeneration: number | null;
  greenhouseCropCatalogVersion?: number;
  greenhouseCropPackId?: string | null;
};

export function requireHello(playerId: string | null): asserts playerId is string {
  if (!playerId) {
    throw new Error("HELLO is required before game messages");
  }
}

export function sendCombatError(
  socket: SocketLike,
  requestId: string,
  code: string,
  message: string,
  details?: {
    retryAfterMs?: number;
    retryable?: boolean;
    currentTollGold?: string;
    requiredGold?: string;
    targetEntityId?: string;
    relocationRevision?: number;
    resourceVisionRevision?: number;
    gameplayViewGeneration?: number;
  }
): void {
  safeSendServerMessage(socket, {
    type: "ERROR",
    requestId,
    code,
    message,
    ...(details?.retryable === undefined ? {} : { retryable: details.retryable }),
    ...(!details || (
      details.retryAfterMs === undefined &&
      details.currentTollGold === undefined &&
      details.requiredGold === undefined &&
      details.targetEntityId === undefined &&
      details.relocationRevision === undefined &&
      details.resourceVisionRevision === undefined &&
      details.gameplayViewGeneration === undefined
    ) ? {} : {
      details: {
        ...(details.retryAfterMs === undefined ? {} : { retryAfterMs: details.retryAfterMs }),
        ...(details.currentTollGold === undefined ? {} : { currentTollGold: details.currentTollGold }),
        ...(details.requiredGold === undefined ? {} : { requiredGold: details.requiredGold }),
        ...(details.targetEntityId === undefined
          ? {}
          : { targetEntityId: details.targetEntityId }),
        ...(details.relocationRevision === undefined
          ? {}
          : { relocationRevision: details.relocationRevision }),
        ...(details.resourceVisionRevision === undefined
          ? {}
          : { resourceVisionRevision: details.resourceVisionRevision }),
        ...(details.gameplayViewGeneration === undefined
          ? {}
          : { gameplayViewGeneration: details.gameplayViewGeneration })
      }
    })
  });
}

export function safeSendServerMessage(
  socket: SocketLike,
  message: ServerMessage,
  logger?: Pick<AppLogger, "warn">,
  context: Record<string, unknown> = {}
): boolean {
  try {
    let sendFailure: unknown;
    const result = publishDirectServerMessage(socket, message, (error) => {
      sendFailure = error;
    });
    if (result === "sent") return true;
    if (sendFailure !== undefined) {
      logger?.warn(
        { err: sendFailure, readyState: socket.readyState, ...context },
        "websocket send failed"
      );
    }
    return false;
  } catch (error) {
    logger?.warn(
      { err: error, readyState: socket.readyState, ...context },
      "websocket send failed"
    );
    return false;
  }
}
import type { ServerMessage } from "@ash-atlas/shared";

import type { AppLogger } from "../../logger.js";
import type { SocketLike } from "../connectionRegistry.js";
import { publishDirectServerMessage } from "../realtimePublisher.js";
