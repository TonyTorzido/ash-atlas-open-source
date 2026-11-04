import { createHmac, randomInt } from "node:crypto";

export const EMAIL_LOGIN_CODE_LENGTH = 6;
export const EMAIL_LOGIN_CODE_MAX_ATTEMPTS = 5;

/** Uniform 6-digit code from the CSPRNG (leading zeros kept). */
export function generateEmailLoginCode(): string {
  return randomInt(0, 10 ** EMAIL_LOGIN_CODE_LENGTH)
    .toString()
    .padStart(EMAIL_LOGIN_CODE_LENGTH, "0");
}

/**
 * The only stored form of a code. Binding the normalized email means a code hash
 * leaked for one mailbox cannot be replayed against another.
 */
export function hashEmailLoginCode(key: string, emailNormalized: string, code: string): string {
  return createHmac("sha256", key)
    .update(`email-code:${emailNormalized}:${code}`, "utf8")
    .digest("hex");
}

/** Accepts "123456", "123 456", or "123-456"; anything else is not a code. */
export function normalizeEmailLoginCode(input: string): string | null {
  const compact = input.replace(/[\s-]/g, "");
  return new RegExp(`^[0-9]{${EMAIL_LOGIN_CODE_LENGTH}}$`).test(compact) ? compact : null;
}
