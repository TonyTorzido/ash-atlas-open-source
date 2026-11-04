import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  APPEARANCE_STUDIO_CALLBACK,
  AppearanceStudioAuthorization,
  isAppearanceStudioCallback
} from "./appearanceStudioAuthorization.js";
import type { AuthenticatedSession } from "./types.js";

describe("Appearance Studio remote authorization", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("issues single-use PKCE codes and stores only scoped expiring sessions", () => {
    const service = new AppearanceStudioAuthorization();
    const verifier = "v".repeat(48);
    const issued = service.issueCode({
      session: developerSession(),
      redirectUri: APPEARANCE_STUDIO_CALLBACK,
      codeChallenge: createHash("sha256").update(verifier).digest("base64url")
    });
    const exchanged = service.exchange({
      code: issued.code,
      codeVerifier: verifier,
      redirectUri: APPEARANCE_STUDIO_CALLBACK
    });

    expect(service.authenticate(exchanged.token)).toMatchObject({
      accountId: "account-1",
      playerId: "player-1",
      verifiedGoogleSubject: "subject-1"
    });
    expect(() => service.exchange({
      code: issued.code,
      codeVerifier: verifier,
      redirectUri: APPEARANCE_STUDIO_CALLBACK
    })).toThrow(/already used/u);
    expect(service.revoke(exchanged.token)).toBe(true);
    expect(() => service.authenticate(exchanged.token)).toThrow(/revoked/u);
  });

  it("rejects callback substitution, ordinary sessions, and incorrect PKCE proof", () => {
    const service = new AppearanceStudioAuthorization();
    const verifier = "a".repeat(48);
    expect(() => service.issueCode({
      session: { ...developerSession(), player: null },
      redirectUri: APPEARANCE_STUDIO_CALLBACK,
      codeChallenge: createHash("sha256").update(verifier).digest("base64url")
    })).toThrow(/developer player/u);
    expect(() => service.issueCode({
      session: developerSession(),
      redirectUri: "https://attacker.example/callback",
      codeChallenge: createHash("sha256").update(verifier).digest("base64url")
    })).toThrow(/allowlisted/u);

    const issued = service.issueCode({
      session: developerSession(),
      redirectUri: APPEARANCE_STUDIO_CALLBACK,
      codeChallenge: createHash("sha256").update(verifier).digest("base64url")
    });
    expect(() => service.exchange({
      code: issued.code,
      codeVerifier: "b".repeat(48),
      redirectUri: APPEARANCE_STUDIO_CALLBACK
    })).toThrow(/PKCE/u);
  });

  it("allows only official or deterministic feature loopback callbacks", () => {
    expect(isAppearanceStudioCallback(APPEARANCE_STUDIO_CALLBACK)).toBe(true);
    expect(isAppearanceStudioCallback(
      "http://127.0.0.1:30123/auth/callback"
    )).toBe(true);
    expect(isAppearanceStudioCallback(
      "http://0.0.0.0:30123/auth/callback"
    )).toBe(false);
    expect(isAppearanceStudioCallback(
      "http://localhost:30123/auth/callback"
    )).toBe(false);
    expect(isAppearanceStudioCallback(
      "http://127.0.0.1:5286/auth/callback"
    )).toBe(false);
  });

  it("expires authorization codes and studio sessions", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T00:00:00.000Z"));
    const verifier = "z".repeat(48);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const service = new AppearanceStudioAuthorization();
    const expiredCode = service.issueCode({
      session: developerSession(),
      redirectUri: APPEARANCE_STUDIO_CALLBACK,
      codeChallenge: challenge
    });
    vi.advanceTimersByTime(60_001);
    expect(() => service.exchange({
      code: expiredCode.code,
      codeVerifier: verifier,
      redirectUri: APPEARANCE_STUDIO_CALLBACK
    })).toThrow(/expired/u);

    const liveCode = service.issueCode({
      session: developerSession(),
      redirectUri: APPEARANCE_STUDIO_CALLBACK,
      codeChallenge: challenge
    });
    const token = service.exchange({
      code: liveCode.code,
      codeVerifier: verifier,
      redirectUri: APPEARANCE_STUDIO_CALLBACK
    }).token;
    vi.advanceTimersByTime(30 * 60_000 + 1);
    expect(() => service.authenticate(token)).toThrow(/expired/u);
  });
});

function developerSession(): AuthenticatedSession {
  const now = new Date();
  return {
    sessionId: "session-1",
    verifiedGoogleSubject: "subject-1",
    verifiedEmail: "owner@example.com",
    account: {
      id: "account-1",
      status: "active",
      trustTier: "new",
      riskScore: 0,
      testAccessStatus: "approved",
      testAccessRequestedAt: now,
      testAccessDecidedAt: now,
      createdAt: now,
      lastLoginAt: now
    },
    player: {
      id: "player-1",
      accountId: "account-1",
      displayName: "Owner",
      personalFlagColor: "blue",
      onboardingCompletedAt: now
    },
    deviceInstallationId: "device-1",
    csrfToken: "csrf-1"
  };
}
