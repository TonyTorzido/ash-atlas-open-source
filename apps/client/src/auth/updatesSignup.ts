import type { AuthSessionResponse } from "@ash-atlas/shared";

import type { ClientAuthView } from "./authState.js";

/** "signed_out": no session while the server is developer-only; "dev_only": a non-dev account is signed in. */
export type UpdatesPanelMode = "signed_out" | "dev_only";

export type UpdatesSignupSource = "app-ios" | "app-android" | "web-play";

export type UpdatesSignupResult = Readonly<{ ok: boolean; message: string }>;

export const UPDATES_SIGNUP_SUCCESS = "You're on the list. We'll email you when Ash Atlas is back.";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/**
 * The update sign-up replaces sign-in only while the server reports dev access mode, so switching
 * the mode back to open removes it without a client release. Developers reach sign-in on request,
 * and the browser half of a native app sign-in always gets the real sign-in screen.
 */
export function updatesPanelMode(input: {
  status: ClientAuthView["status"];
  session: AuthSessionResponse | null;
  developerSignInRequested: boolean;
  nativeAuthorizationPending: boolean;
}): UpdatesPanelMode | null {
  if (input.nativeAuthorizationPending) return null;
  if (input.status === "test_access_dev_only") return "dev_only";
  if (
    input.status === "unauthenticated" &&
    input.session?.authenticated === false &&
    input.session.testAccessMode === "dev" &&
    !input.developerSignInRequested
  ) {
    return "signed_out";
  }
  return null;
}

export function updatesSignupSource(platform: "ios" | "android" | null): UpdatesSignupSource {
  return platform === "ios" ? "app-ios" : platform === "android" ? "app-android" : "web-play";
}

export function validUpdatesEmail(value: string): boolean {
  const email = value.trim();
  return email.length <= 254 && EMAIL_PATTERN.test(email);
}

export async function subscribeToUpdates(
  serverHttpBase: string,
  email: string,
  source: UpdatesSignupSource,
  fetchImpl: typeof fetch = fetch
): Promise<UpdatesSignupResult> {
  try {
    const response = await fetchImpl(new URL("/api/updates/subscribe", serverHttpBase).toString(), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ email: email.trim(), source, website: "" })
    });
    if (response.ok) return { ok: true, message: UPDATES_SIGNUP_SUCCESS };
    if (response.status === 429) {
      return { ok: false, message: "Too many tries. Please wait a minute and try again." };
    }
    const payload = await response.json().catch(() => null) as { error?: { message?: unknown } } | null;
    const message = payload?.error?.message;
    return {
      ok: false,
      message: typeof message === "string" && message.length > 0
        ? message
        : "That didn't go through. Please try again in a moment."
    };
  } catch {
    return { ok: false, message: "Couldn't reach the server. Check your connection and try again." };
  }
}
