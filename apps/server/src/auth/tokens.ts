import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function generateSecureToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isSecureToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, "base64url").length === 32;
}

export function hashAuthToken(token: string, key: string, purpose: string): string {
  return `v1:${createHmac("sha256", key).update(`${purpose}\0${token}`).digest("hex")}`;
}

export function csrfTokenForSession(sessionToken: string, key: string): string {
  return createHmac("sha256", key)
    .update(`csrf\0${sessionToken}`)
    .digest("base64url");
}

export function csrfTokensMatch(expected: string, supplied: string | undefined): boolean {
  if (!supplied) {
    return false;
  }
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}
