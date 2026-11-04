import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { AuthenticatedSession } from "./types.js";
import {
  CAPACITOR_ANDROID_ORIGIN,
  CAPACITOR_IOS_CALLBACK,
  CAPACITOR_IOS_ORIGIN,
  CAPACITOR_IOS_WEBSOCKET_PROTOCOL_PREFIX,
  NativeAppAuthorization,
  NativeAppAuthorizationError,
  isCapacitorNativeOrigin,
  isCapacitorNativeRequestHeader,
  nativePlatformFromRequest
} from "./nativeAppAuthorization.js";

describe("native app authorization", () => {
  it("exchanges a PKCE code exactly once", () => {
    const authorization = new NativeAppAuthorization();
    const verifier = "v".repeat(43);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const issued = authorization.issueCode({
      session: authenticatedSession(),
      rawSessionToken: "t".repeat(43),
      redirectUri: CAPACITOR_IOS_CALLBACK,
      codeChallenge: challenge
    });

    expect(authorization.exchange({
      code: issued.code,
      codeVerifier: verifier,
      redirectUri: CAPACITOR_IOS_CALLBACK
    })).toBe("t".repeat(43));
    expect(() => authorization.exchange({
      code: issued.code,
      codeVerifier: verifier,
      redirectUri: CAPACITOR_IOS_CALLBACK
    })).toThrow(NativeAppAuthorizationError);
  });

  it("resolves only an issued native websocket protocol", () => {
    const authorization = new NativeAppAuthorization();
    const ticket = authorization.issueWebSocketTicket("session-token");

    expect(authorization.rawSessionTokenForProtocols(
      `${CAPACITOR_IOS_WEBSOCKET_PROTOCOL_PREFIX}${ticket}`
    )).toBe("session-token");
    expect(authorization.rawSessionTokenForProtocols(
      `${CAPACITOR_IOS_WEBSOCKET_PROTOCOL_PREFIX}${"x".repeat(43)}`
    )).toBeNull();
  });

  it("admits only the exact iOS and Android origin/header pairs", () => {
    expect(isCapacitorNativeOrigin(CAPACITOR_IOS_ORIGIN)).toBe(true);
    expect(isCapacitorNativeOrigin(CAPACITOR_ANDROID_ORIGIN)).toBe(true);
    expect(isCapacitorNativeOrigin("https://localhost.example.com")).toBe(false);
    expect(isCapacitorNativeRequestHeader("capacitor-ios")).toBe(true);
    expect(isCapacitorNativeRequestHeader("capacitor-android")).toBe(true);
    expect(isCapacitorNativeRequestHeader("capacitor-web")).toBe(false);
    expect(nativePlatformFromRequest(CAPACITOR_IOS_ORIGIN, "capacitor-ios")).toBe("ios");
    expect(nativePlatformFromRequest(CAPACITOR_ANDROID_ORIGIN, "capacitor-android")).toBe("android");
    expect(nativePlatformFromRequest(CAPACITOR_ANDROID_ORIGIN, "capacitor-ios")).toBeNull();
  });
});

function authenticatedSession(): AuthenticatedSession {
  return {
    sessionId: "browser-session",
    identityId: "identity-id",
    verifiedGoogleSubject: "google-subject",
    verifiedEmail: "player@example.com",
    account: {
      id: "account-id",
      status: "active",
      trustTier: "standard",
      riskScore: 0,
      testAccessStatus: "approved",
      testAccessRequestedAt: new Date("2026-01-01T00:00:00.000Z"),
      testAccessDecidedAt: new Date("2026-01-01T00:00:00.000Z"),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      lastLoginAt: new Date("2026-01-01T00:00:00.000Z")
    },
    player: null,
    deviceInstallationId: "device-id",
    csrfToken: "csrf-token"
  };
}
