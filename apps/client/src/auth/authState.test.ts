import { describe, expect, it } from "vitest";

import { AUTH_CLIENT_CONTRACT_VERSION } from "@ash-atlas/shared";

import { AuthApiError } from "./authClient.js";
import {
  authErrorMessage,
  authViewFromError,
  authViewFromSession,
  isAuthenticatedClientSession,
  sessionEndedView
} from "./authState.js";

describe("client authentication state", () => {
  it("maps an anonymous session to unauthenticated", () => {
    expect(
      authViewFromSession({
        authenticated: false,
        csrfToken: "",
        developmentAuthEnabled: true,
        developerCapabilities: []
      })
    ).toMatchObject({ status: "unauthenticated", developmentAuthEnabled: true });
  });

  it("requires a player name before entering gameplay", () => {
    expect(
      authViewFromSession({
        authenticated: true,
        csrfToken: "csrf",
        developmentAuthEnabled: false,
        developerCapabilities: [],
        account: { id: "account-1", status: "active", trustTier: "new" },
        testAccessStatus: "approved",
        onboardingRequired: true
      }).status
    ).toBe("needs_onboarding");
  });

  it("requires a client update before any other auth state", () => {
    expect(
      authViewFromSession({
        authenticated: false,
        requiredClientContractVersion: AUTH_CLIENT_CONTRACT_VERSION + 1,
        csrfToken: "",
        developmentAuthEnabled: true,
        developerCapabilities: []
      }).status
    ).toBe("client_update_required");
  });

  it("keeps responses without a contract version backward compatible", () => {
    expect(
      authViewFromSession({
        authenticated: false,
        csrfToken: "",
        developmentAuthEnabled: true,
        developerCapabilities: []
      }).status
    ).toBe("unauthenticated");
  });

  it("enters gameplay only with an account and server-owned player", () => {
    const view = authViewFromSession({
      authenticated: true,
      csrfToken: "csrf",
      developmentAuthEnabled: false,
      developerCapabilities: [],
      account: { id: "account-1", status: "active", trustTier: "standard" },
      testAccessStatus: "approved",
      player: { id: "player-1", displayName: "Scout", personalFlagColor: "blue" },
      onboardingRequired: false
    });
    expect(view.status).toBe("authenticated");
    expect(isAuthenticatedClientSession(view.session)).toBe(true);
  });

  it("allows a pending account only when the server projects effective open access", () => {
    const openView = authViewFromSession({
      authenticated: true,
      csrfToken: "csrf",
      developmentAuthEnabled: false,
      developerCapabilities: [],
      account: { id: "account-1", status: "active", trustTier: "new" },
      testAccessStatus: "pending",
      testAccessAllowed: true,
      player: { id: "player-1", displayName: "Scout", personalFlagColor: "blue" },
      onboardingRequired: false
    });
    expect(openView.status).toBe("authenticated");
    expect(isAuthenticatedClientSession(openView.session)).toBe(true);

    expect(authViewFromSession({
      ...openView.session!,
      testAccessAllowed: false
    }).status).toBe("test_access_pending");
  });

  it.each(["denied", "revoked"] as const)(
    "never treats an explicitly %s account as gameplay-ready",
    (testAccessStatus) => {
      const session = {
        authenticated: true as const,
        csrfToken: "csrf",
        developmentAuthEnabled: false,
        developerCapabilities: [],
        account: { id: "account-1", status: "active" as const, trustTier: "new" as const },
        testAccessStatus,
        testAccessAllowed: true,
        player: { id: "player-1", displayName: "Scout", personalFlagColor: "blue" as const },
        onboardingRequired: false
      };
      expect(authViewFromSession(session).status).toBe(`test_access_${testAccessStatus}`);
      expect(isAuthenticatedClientSession(session)).toBe(false);
    }
  );

  it("maps suspended and expired sessions to neutral terminal states", () => {
    expect(authViewFromError(new AuthApiError("ACCOUNT_SUSPENDED", "details", 403))).toMatchObject({
      status: "account_suspended",
      message: "Account suspended"
    });
    expect(sessionEndedView("SESSION_REVOKED").status).toBe("session_expired");
    expect(sessionEndedView("SESSION_REPLACED")).toMatchObject({
      status: "session_replaced",
      message: expect.stringContaining("another gameplay session")
    });
  });

  it("presents stable user-facing login errors", () => {
    expect(authErrorMessage(new AuthApiError("VERIFIED_GMAIL_REQUIRED", "raw", 403))).toBe(
      "A verified Gmail account is required."
    );
    expect(authErrorMessage(new AuthApiError("TOO_MANY_LOGIN_ATTEMPTS", "raw", 429))).toContain(
      "Too many login attempts"
    );
  });
});
