import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { NativePlatform } from "@ash-atlas/shared";
import type { AuthenticatedSession } from "./types.js";

export const CAPACITOR_NATIVE_ORIGINS = Object.freeze([
  "capacitor://localhost",
  "https://localhost"
] as const);
export const CAPACITOR_IOS_ORIGIN = "capacitor://localhost";
export const CAPACITOR_ANDROID_ORIGIN = "https://localhost";
export const CAPACITOR_IOS_CALLBACK = "com.ashatlas.game://auth/callback";
export const CAPACITOR_NATIVE_CALLBACK = CAPACITOR_IOS_CALLBACK;
export const CAPACITOR_NATIVE_REQUEST_HEADER = "x-ash-atlas-native-client";
export const CAPACITOR_NATIVE_REQUEST_HEADER_VALUES = Object.freeze([
  "capacitor-ios",
  "capacitor-android"
] as const);
export const CAPACITOR_IOS_REQUEST_HEADER = "x-ash-atlas-native-client";
export const CAPACITOR_IOS_REQUEST_HEADER_VALUE = "capacitor-ios";
export const CAPACITOR_ANDROID_REQUEST_HEADER = CAPACITOR_NATIVE_REQUEST_HEADER;
export const CAPACITOR_ANDROID_REQUEST_HEADER_VALUE = "capacitor-android";
export const CAPACITOR_IOS_WEBSOCKET_PROTOCOL_PREFIX = "ash-atlas-native.";
export const CAPACITOR_NATIVE_WEBSOCKET_PROTOCOL_PREFIX = CAPACITOR_IOS_WEBSOCKET_PROTOCOL_PREFIX;

export const NATIVE_AUTH_CODE_TTL_MS = 60_000;
export const NATIVE_WEBSOCKET_TICKET_TTL_MS = 12 * 60 * 60_000;

type NativeAuthorizationCode = Readonly<{
  rawSessionToken: string;
  redirectUri: string;
  challenge: string;
  expiresAt: number;
}>;

type NativeWebSocketTicket = Readonly<{
  rawSessionToken: string;
  expiresAt: number;
}>;

export class NativeAppAuthorization {
  private readonly codes = new Map<string, NativeAuthorizationCode>();
  private readonly websocketTickets = new Map<string, NativeWebSocketTicket>();

  issueCode(input: {
    session: AuthenticatedSession;
    rawSessionToken: string;
    redirectUri: string;
    codeChallenge: string;
  }): { code: string; expiresAt: number } {
    requireNativeCallback(input.redirectUri);
    if (!/^[A-Za-z0-9_-]{43}$/u.test(input.codeChallenge)) {
      throw new NativeAppAuthorizationError(400, "PKCE challenge is invalid");
    }
    if (!input.session.identityId) {
      throw new NativeAppAuthorizationError(403, "A verified provider session is required");
    }
    if (!/^[A-Za-z0-9_-]{43}$/u.test(input.rawSessionToken)) {
      throw new NativeAppAuthorizationError(401, "Browser session is invalid");
    }
    this.prune();
    const code = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + NATIVE_AUTH_CODE_TTL_MS;
    this.codes.set(tokenHash(code), {
      rawSessionToken: input.rawSessionToken,
      redirectUri: input.redirectUri,
      challenge: input.codeChallenge,
      expiresAt
    });
    return { code, expiresAt };
  }

  exchange(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): string {
    requireNativeCallback(input.redirectUri);
    if (!/^[A-Za-z0-9_-]{43,128}$/u.test(input.codeVerifier)) {
      throw new NativeAppAuthorizationError(400, "PKCE verifier is invalid");
    }
    const key = tokenHash(input.code);
    const authorization = this.codes.get(key);
    this.codes.delete(key);
    if (
      !authorization ||
      authorization.expiresAt <= Date.now() ||
      authorization.redirectUri !== input.redirectUri
    ) {
      throw new NativeAppAuthorizationError(
        400,
        "Authorization code is invalid, expired, or already used"
      );
    }
    const challenge = createHash("sha256")
      .update(input.codeVerifier)
      .digest("base64url");
    if (!constantText(challenge, authorization.challenge)) {
      throw new NativeAppAuthorizationError(400, "PKCE verification failed");
    }
    return authorization.rawSessionToken;
  }

  issueWebSocketTicket(rawSessionToken: string): string {
    this.prune();
    const ticket = randomBytes(32).toString("base64url");
    this.websocketTickets.set(tokenHash(ticket), {
      rawSessionToken,
      expiresAt: Date.now() + NATIVE_WEBSOCKET_TICKET_TTL_MS
    });
    return ticket;
  }

  rawSessionTokenForProtocols(protocols: string | undefined): string | null {
    this.prune();
    const protocol = protocols
      ?.split(",")
      .map((value) => value.trim())
      .find((value) => value.startsWith(CAPACITOR_IOS_WEBSOCKET_PROTOCOL_PREFIX));
    if (!protocol) return null;
    const ticket = protocol.slice(CAPACITOR_IOS_WEBSOCKET_PROTOCOL_PREFIX.length);
    if (!/^[A-Za-z0-9_-]{43}$/u.test(ticket)) return null;
    const authorization = this.websocketTickets.get(tokenHash(ticket));
    return authorization && authorization.expiresAt > Date.now()
      ? authorization.rawSessionToken
      : null;
  }

  private prune(): void {
    const now = Date.now();
    for (const [code, authorization] of this.codes) {
      if (authorization.expiresAt <= now) this.codes.delete(code);
    }
    for (const [ticket, authorization] of this.websocketTickets) {
      if (authorization.expiresAt <= now) this.websocketTickets.delete(ticket);
    }
  }
}

export class NativeAppAuthorizationError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "NativeAppAuthorizationError";
  }
}

export function isCapacitorIosCallback(redirectUri: string): boolean {
  return isCapacitorNativeCallback(redirectUri);
}

export function isCapacitorNativeCallback(redirectUri: string): boolean {
  try {
    const url = new URL(redirectUri);
    return url.protocol === "com.ashatlas.game:" &&
      url.hostname === "auth" &&
      url.pathname === "/callback" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "";
  } catch {
    return false;
  }
}

export function isCapacitorIosRequestHeader(value: string | string[] | undefined): boolean {
  return isCapacitorNativeRequestHeader(value);
}

export function isCapacitorNativeRequestHeader(value: string | string[] | undefined): boolean {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate !== undefined &&
    (CAPACITOR_NATIVE_REQUEST_HEADER_VALUES as readonly string[]).includes(candidate);
}

export function nativePlatformFromRequest(
  origin: string | undefined,
  header: string | string[] | undefined
): NativePlatform | null {
  const headerValue = Array.isArray(header) ? header[0] : header;
  const headerPlatform = headerValue === "capacitor-ios"
    ? "ios"
    : headerValue === "capacitor-android"
      ? "android"
      : null;
  const originPlatform = origin === CAPACITOR_IOS_ORIGIN
    ? "ios"
    : origin === CAPACITOR_ANDROID_ORIGIN
      ? "android"
      : null;
  if (headerPlatform && originPlatform && headerPlatform !== originPlatform) return null;
  return headerPlatform ?? originPlatform;
}

export function isCapacitorNativeOrigin(origin: string | undefined): boolean {
  return origin !== undefined &&
    (CAPACITOR_NATIVE_ORIGINS as readonly string[]).includes(origin);
}

function requireNativeCallback(redirectUri: string): void {
  if (!isCapacitorNativeCallback(redirectUri)) {
    throw new NativeAppAuthorizationError(400, "Native callback is not allowlisted");
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function constantText(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}
