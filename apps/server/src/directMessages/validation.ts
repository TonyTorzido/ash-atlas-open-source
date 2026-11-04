import { DIRECT_MESSAGE_BODY_MAX_LENGTH } from "@ash-atlas/shared";

import { DirectMessageError } from "./types.js";

export const DIRECT_MESSAGE_MAX_CHARACTERS = DIRECT_MESSAGE_BODY_MAX_LENGTH;

export function normalizeDirectMessageBody(
  input: string,
  maximumCharacters = DIRECT_MESSAGE_MAX_CHARACTERS
): string {
  if (typeof input !== "string") {
    throw new DirectMessageError("invalid_request", "Private messaging request was invalid.");
  }
  const normalized = input.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  for (const character of normalized) {
    const code = character.codePointAt(0) ?? 0;
    const allowedWhitespace = code === 9 || code === 10;
    if ((UNICODE_CONTROL.test(character) && !allowedWhitespace) || UNSAFE_BIDI_CONTROL.test(character)) {
      throw new DirectMessageError(
        "message_invalid",
        "Message contains unsupported text."
      );
    }
  }
  if (![...normalized].some((character) =>
    !/\s/u.test(character) && !DEFAULT_IGNORABLE.test(character)
  )) {
    throw new DirectMessageError("invalid_request", "Private messaging request was invalid.");
  }
  if (Array.from(normalized).length > maximumCharacters) {
    throw new DirectMessageError(
      "message_too_long",
      "Message is too long."
    );
  }
  return normalized;
}

export function assertDirectMessageUuid(value: string, label = "Client message id"): void {
  void label;
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new DirectMessageError("invalid_request", "Private messaging request was invalid.");
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNICODE_CONTROL = /\p{Cc}/u;
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const UNSAFE_BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
