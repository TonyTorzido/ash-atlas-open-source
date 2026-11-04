import type { AuthSessionResponse } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import {
  subscribeToUpdates,
  updatesPanelMode,
  updatesSignupSource,
  UPDATES_SIGNUP_SUCCESS,
  validUpdatesEmail
} from "./updatesSignup.js";

const signedOut = (mode?: "open" | "closed" | "dev"): AuthSessionResponse => ({
  authenticated: false,
  csrfToken: "",
  developmentAuthEnabled: false,
  developerCapabilities: [],
  ...(mode ? { testAccessMode: mode } : {})
});

describe("updates panel gate", () => {
  const base = { developerSignInRequested: false, nativeAuthorizationPending: false };

  it("replaces sign-in only while a signed-out client sees dev mode", () => {
    expect(updatesPanelMode({ ...base, status: "unauthenticated", session: signedOut("dev") })).toBe("signed_out");
    expect(updatesPanelMode({ ...base, status: "unauthenticated", session: signedOut("open") })).toBeNull();
    expect(updatesPanelMode({ ...base, status: "unauthenticated", session: signedOut("closed") })).toBeNull();
    // An older server without the field keeps normal sign-in.
    expect(updatesPanelMode({ ...base, status: "unauthenticated", session: signedOut() })).toBeNull();
  });

  it("steps aside for developer sign-in and its progress", () => {
    expect(updatesPanelMode({ ...base, developerSignInRequested: true, status: "unauthenticated", session: signedOut("dev") })).toBeNull();
    expect(updatesPanelMode({ ...base, status: "authenticating", session: signedOut("dev") })).toBeNull();
  });

  it("never blocks the browser half of a native app sign-in", () => {
    expect(updatesPanelMode({ ...base, nativeAuthorizationPending: true, status: "unauthenticated", session: signedOut("dev") })).toBeNull();
    expect(updatesPanelMode({ ...base, nativeAuthorizationPending: true, status: "test_access_dev_only", session: null })).toBeNull();
  });

  it("shows the panel to a signed-in non-developer held out by dev mode, never to an admitted session", () => {
    expect(updatesPanelMode({ ...base, status: "test_access_dev_only", session: null })).toBe("dev_only");
    expect(updatesPanelMode({ ...base, status: "authenticated", session: { ...signedOut("dev"), authenticated: true } })).toBeNull();
    expect(updatesPanelMode({ ...base, status: "test_access_pending", session: null })).toBeNull();
  });
});

describe("updates sign-up request", () => {
  it("tags the source by platform", () => {
    expect(updatesSignupSource("ios")).toBe("app-ios");
    expect(updatesSignupSource("android")).toBe("app-android");
    expect(updatesSignupSource(null)).toBe("web-play");
  });

  it("validates the email before sending", () => {
    expect(validUpdatesEmail(" player@example.com ")).toBe(true);
    expect(validUpdatesEmail("player")).toBe(false);
    expect(validUpdatesEmail(`${"a".repeat(250)}@example.com`)).toBe(false);
  });

  it("posts the trimmed email and source to the service base", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(subscribeToUpdates("https://playashatlas.com", " a@example.com ", "app-ios", fetchImpl))
      .resolves.toEqual({ ok: true, message: UPDATES_SIGNUP_SUCCESS });
    expect(fetchImpl).toHaveBeenCalledWith("https://playashatlas.com/api/updates/subscribe", expect.objectContaining({
      method: "POST",
      credentials: "include",
      body: JSON.stringify({ email: "a@example.com", source: "app-ios", website: "" })
    }));
  });

  it("reports server, rate-limit, and network failures inline", async () => {
    const invalid = vi.fn(async () => new Response(JSON.stringify({ error: { message: "Enter a valid email address." } }), { status: 400 }));
    await expect(subscribeToUpdates("https://x.test", "a@example.com", "web-play", invalid))
      .resolves.toEqual({ ok: false, message: "Enter a valid email address." });
    const limited = vi.fn(async () => new Response("", { status: 429 }));
    await expect(subscribeToUpdates("https://x.test", "a@example.com", "web-play", limited))
      .resolves.toMatchObject({ ok: false, message: expect.stringContaining("Too many tries") });
    const offline = vi.fn(async () => { throw new TypeError("offline"); });
    await expect(subscribeToUpdates("https://x.test", "a@example.com", "web-play", offline))
      .resolves.toMatchObject({ ok: false, message: expect.stringContaining("Couldn't reach") });
  });
});
