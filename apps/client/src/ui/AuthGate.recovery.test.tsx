// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTH_CLIENT_CONTRACT_VERSION } from "@ash-atlas/shared";

import { AuthGate } from "./AuthGate.js";

const authenticatedSession = {
  authenticated: true,
  csrfToken: "csrf",
  developmentAuthEnabled: true,
  developerCapabilities: [],
  testAccessStatus: "approved" as const,
  account: { id: "account-1", status: "active" as const, trustTier: "standard" as const },
  player: { id: "player-1", displayName: "Scout", personalFlagColor: "blue" as const },
  onboardingRequired: false
};

describe("authentication recovery states", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("blocks login, onboarding, and gameplay when the server requires a newer client", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      authenticated: false,
      requiredClientContractVersion: AUTH_CLIENT_CONTRACT_VERSION + 1,
      csrfToken: "",
      developmentAuthEnabled: true,
      developerCapabilities: []
    })));
    const renderGame = vi.fn(() => <div>World</div>);
    render(<AuthGate renderGame={renderGame} />);

    expect(await screen.findByText("Updating Ash Atlas")).toBeTruthy();
    expect(screen.getByText(/refresh the cached game files to continue/i)).toBeTruthy();
    expect(screen.getByText(/existing player and progress are safe/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh Game" })).toBeTruthy();
    expect(screen.queryByText("Create your player")).toBeNull();
    expect(screen.queryByText("Sign in with Google")).toBeNull();
    expect(renderGame).not.toHaveBeenCalled();
  });

  it("leaves stale onboarding for session-expired recovery after authentication is rejected", async () => {
    const onboardingSession = {
      ...authenticatedSession,
      player: undefined,
      onboardingRequired: true,
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(onboardingSession))
      .mockResolvedValueOnce(errorResponse(401, "AUTHENTICATION_REQUIRED"));
    vi.stubGlobal("fetch", fetcher);
    render(<AuthGate renderGame={() => <div>World</div>} />);

    expect(await screen.findByText("Create your player")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Scout" } });
    fireEvent.click(screen.getByRole("radio", { name: "Blue" }));
    fireEvent.click(screen.getByRole("button", { name: "Create Player" }));

    expect(await screen.findByText("Session Expired")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign In" })).toBeTruthy();
    expect(screen.queryByText("Create your player")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps authentication and presents Reconnect Here when another device replaces gameplay", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(authenticatedSession)));
    render(
      <AuthGate renderGame={({ onSessionEnded }) => (
        <button type="button" onClick={() => onSessionEnded("SESSION_REPLACED")}>Displace</button>
      )} />
    );

    fireEvent.click(await screen.findByRole("button", { name: "Displace" }));
    expect(await screen.findByText("Session Moved")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect Here" })).toBeTruthy();
    expect(screen.queryByText(/sign in again/i)).toBeNull();
  });

  it("shows Sign In only after the authentication endpoint confirms expiration", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(authenticatedSession))
      .mockResolvedValueOnce(response({
        authenticated: false,
        csrfToken: "",
        developmentAuthEnabled: true,
        developerCapabilities: []
      }));
    vi.stubGlobal("fetch", fetcher);
    render(
      <AuthGate renderGame={({ onSessionEnded }) => (
        <button type="button" onClick={() => onSessionEnded("SESSION_EXPIRED")}>Expire</button>
      )} />
    );

    fireEvent.click(await screen.findByRole("button", { name: "Expire" }));
    expect(await screen.findByText("Session Expired")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign In" })).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps a pending user restricted and transitions to onboarding after approval", async () => {
    const pending = {
      authenticated: true,
      csrfToken: "csrf",
      developmentAuthEnabled: false,
      developerCapabilities: [],
      testAccessStatus: "pending",
      verifiedEmail: "pending@example.com",
      account: { id: "account-1", status: "active", trustTier: "new" },
      onboardingRequired: true
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(pending))
      .mockResolvedValueOnce(response({ ...pending, testAccessStatus: "approved" }));
    vi.stubGlobal("fetch", fetcher);
    const renderGame = vi.fn(() => <div>World</div>);
    render(<AuthGate renderGame={renderGame} />);

    expect(await screen.findByText("Test Access Pending")).toBeTruthy();
    expect(screen.getByText("pending@example.com")).toBeTruthy();
    expect(screen.queryByLabelText("Display name")).toBeNull();
    expect(renderGame).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Check Access" }));
    expect(await screen.findByText("Create your player")).toBeTruthy();
    expect(screen.getByLabelText("Display name")).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("signs in with an email code only when the server enables it, then enters the game", async () => {
    const signedOut = {
      authenticated: false,
      csrfToken: "",
      developmentAuthEnabled: false,
      emailSignInEnabled: true,
      developerCapabilities: []
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(signedOut))
      .mockResolvedValueOnce(response({ ok: true, resendAvailableAt: Date.now() + 60_000, codeTtlSeconds: 600 }))
      .mockResolvedValueOnce(errorResponse(409, "ACCOUNT_LINK_REQUIRED"))
      .mockResolvedValueOnce(response({ ...authenticatedSession, linkedProviders: ["email"] }));
    vi.stubGlobal("fetch", fetcher);
    const renderGame = vi.fn(() => <div>World</div>);
    render(<AuthGate renderGame={renderGame} />);

    fireEvent.click(await screen.findByRole("button", { name: "Continue with email" }));
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "player@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    fireEvent.change(await screen.findByLabelText("6-digit code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "This email is already used by an account that signs in another way. Sign in that way, then link email from Account settings."
    );
    expect(renderGame).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("6-digit code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText("World")).toBeTruthy();

    expect(String(fetcher.mock.calls[1]?.[0])).toContain("/api/auth/email/start");
    expect(String(fetcher.mock.calls[3]?.[0])).toContain("/api/auth/email/verify");
    expect(JSON.parse(String(fetcher.mock.calls[3]?.[1]?.body))).toEqual({
      email: "player@example.com",
      code: "123456"
    });
  });

  it("hides the email option when the server has not enabled it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({
      authenticated: false,
      csrfToken: "",
      developmentAuthEnabled: false,
      developerCapabilities: []
    })));
    render(<AuthGate renderGame={() => <div>World</div>} />);
    await screen.findByText("Enter the atlas");
    expect(screen.queryByRole("button", { name: "Continue with email" })).toBeNull();
  });

  it("leaves gameplay immediately for the server-authoritative revoked screen", async () => {
    const revoked = {
      ...authenticatedSession,
      testAccessStatus: "revoked",
      verifiedEmail: "revoked@example.com",
      player: undefined,
      onboardingRequired: true
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(authenticatedSession))
      .mockResolvedValueOnce(response(revoked));
    vi.stubGlobal("fetch", fetcher);
    render(
      <AuthGate renderGame={({ onSessionEnded }) => (
        <button type="button" onClick={() => onSessionEnded("TEST_ACCESS_REVOKED")}>
          Revoke
        </button>
      )} />
    );

    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    expect(await screen.findByText("Test Access Removed")).toBeTruthy();
    expect(screen.getByText("revoked@example.com")).toBeTruthy();
  });
});

function response(body: unknown): Pick<Response, "ok" | "status" | "json"> {
  return { ok: true, status: 200, json: async () => body };
}

function errorResponse(
  status: number,
  code: string
): Pick<Response, "ok" | "status" | "json"> {
  return {
    ok: false,
    status,
    json: async () => ({ error: { code, message: "Authentication required" } })
  };
}
