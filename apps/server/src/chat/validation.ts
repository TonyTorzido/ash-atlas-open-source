import { CHAT_MESSAGE_MAX_LENGTH } from "@ash-atlas/shared";

export type ChatValidationErrorCode =
  | "CHAT_BODY_EMPTY"
  | "CHAT_BODY_TOO_LONG"
  | "CHAT_BODY_INVALID"
  | "CHAT_SENDER_NAME_INVALID";

export class ChatValidationError extends Error {
  constructor(readonly code: ChatValidationErrorCode, message: string) {
    super(message);
    this.name = "ChatValidationError";
  }
}

export function normalizeChatBody(input: string, maximumCharacters = CHAT_MESSAGE_MAX_LENGTH): string {
  const normalized = input.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  rejectControlCharacters(normalized, true);
  if (!hasVisibleContent(normalized)) {
    throw new ChatValidationError("CHAT_BODY_EMPTY", "Chat message cannot be blank");
  }
  if (Array.from(normalized).length > maximumCharacters) {
    throw new ChatValidationError(
      "CHAT_BODY_TOO_LONG",
      `Chat message must be at most ${maximumCharacters} characters`
    );
  }
  return normalized;
}

export function normalizeChatSenderDisplayName(input: string): string {
  const normalized = input.normalize("NFC").trim().replace(/\s+/gu, " ");
  rejectControlCharacters(normalized, false);
  if (!normalized || Array.from(normalized).length > 64) {
    throw new ChatValidationError(
      "CHAT_SENDER_NAME_INVALID",
      "Chat sender display name must contain 1 to 64 characters"
    );
  }
  return normalized;
}

function rejectControlCharacters(value: string, allowLineFeed: boolean): void {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const allowedWhitespaceControl = allowLineFeed && (code === 9 || code === 10);
    if (
      (UNICODE_CONTROL.test(character) && !allowedWhitespaceControl) ||
      UNSAFE_BIDI_CONTROL.test(character)
    ) {
      throw new ChatValidationError("CHAT_BODY_INVALID", "Chat text contains unsupported control characters");
    }
  }
}

function hasVisibleContent(value: string): boolean {
  for (const character of value) {
    if (!/\s/u.test(character) && !DEFAULT_IGNORABLE.test(character)) return true;
  }
  return false;
}

const UNICODE_CONTROL = /\p{Cc}/u;
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const UNSAFE_BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
