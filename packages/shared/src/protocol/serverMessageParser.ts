import { z } from "zod";

import { SERVER_MESSAGE_VALIDATION_ROUTES } from "./serverMessageValidation.js";
import type { ServerMessage } from "./serverMessages.js";

export type ServerMessageParseFailureKind =
  | "malformed-json"
  | "malformed-frame"
  | "unknown-frame";

export class ServerMessageParseError extends Error {
  constructor(
    readonly kind: ServerMessageParseFailureKind,
    message: string,
    override readonly cause?: unknown
  ) {
    super(message);
    this.name = "ServerMessageParseError";
  }
}

export const MAX_SERVER_MESSAGE_BYTES = 1_048_576;

export function parseServerMessage(raw: string): ServerMessage {
  if (
    raw.length > MAX_SERVER_MESSAGE_BYTES ||
    (raw.length > MAX_SERVER_MESSAGE_BYTES / 4 &&
      new TextEncoder().encode(raw).byteLength > MAX_SERVER_MESSAGE_BYTES)
  ) {
    throw new ServerMessageParseError("malformed-frame", "Server frame exceeds the size limit");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new ServerMessageParseError("malformed-json", "Malformed server JSON", error);
  }
  const envelope = z.object({ type: z.string().min(1).max(80) }).passthrough().safeParse(decoded);
  if (!envelope.success) {
    throw new ServerMessageParseError("malformed-frame", "Malformed server frame", envelope.error);
  }
  if (!Object.prototype.hasOwnProperty.call(SERVER_MESSAGE_VALIDATION_ROUTES, envelope.data.type)) {
    throw new ServerMessageParseError(
      "unknown-frame",
      `Unknown server frame type: ${envelope.data.type}`
    );
  }
  const schema = SERVER_MESSAGE_VALIDATION_ROUTES[
    envelope.data.type as keyof typeof SERVER_MESSAGE_VALIDATION_ROUTES
  ];
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    throw new ServerMessageParseError(
      "malformed-frame",
      `Malformed ${envelope.data.type} server frame`,
      parsed.error
    );
  }
  return parsed.data as ServerMessage;
}
