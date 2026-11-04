import type { DeveloperCapability } from "@ash-atlas/shared";
import type { FastifyRequest } from "fastify";

import type { AuthService } from "../../auth/authService.js";
import type { AuthenticatedSession } from "../../auth/types.js";
import { sendError } from "../errors.js";

export function authoritativePlayerId(
  request: FastifyRequest,
  clientSuppliedId: string
): string {
  return request.authSession?.player?.id ?? clientSuppliedId;
}

export async function authorizeDeveloperHttp(
  request: FastifyRequest,
  reply: Parameters<typeof sendError>[0],
  auth: AuthService | undefined,
  capability: DeveloperCapability,
  command: string,
  target: string | null = null,
  operationKey: string | null = null
): Promise<AuthenticatedSession | null> {
  const session = request.authSession;
  if (!auth || !session?.player) {
    sendError(reply, 403, "DEVELOPER_COMMAND_FORBIDDEN", "Developer command is unavailable");
    return null;
  }
  try {
    await auth.authorizeDeveloperCommand(session, {
      capability,
      command,
      transport: "http",
      target,
      operationKey
    });
    return session;
  } catch {
    sendError(reply, 403, "DEVELOPER_COMMAND_FORBIDDEN", "Developer command is unavailable");
    return null;
  }
}

export async function recordDeveloperHttpResult(
  auth: AuthService | undefined,
  session: AuthenticatedSession,
  input: {
    capability: DeveloperCapability;
    command: string;
    target?: string | null;
    operationKey?: string | null;
    outcome: "succeeded" | "failed";
  }
): Promise<void> {
  await auth?.recordDeveloperCommandResult(session, { ...input, transport: "http" });
}
