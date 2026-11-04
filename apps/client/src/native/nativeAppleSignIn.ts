import { Capacitor, registerPlugin } from "@capacitor/core";

/**
 * Native Sign in with Apple (iOS only, "AppleSignIn" plugin). Today's linking
 * flow (nativeAppleLink.ts) uses the web Services ID in the in-app browser and
 * keeps working; this native path is dormant until the server enables it.
 * Server note: a native identity token's `aud` is the bundle id
 * (com.ashatlas.game), not APPLE_SERVICES_ID, and the token embeds `nonce` verbatim.
 */

export type AppleSignInScope = "email" | "fullName";

export type AppleSignInResult = Readonly<{
  /** Stable Apple user identifier (team-scoped). */
  user: string;
  identityToken?: string;
  authorizationCode?: string;
  state?: string;
  /** Only on the first authorization of this app by this Apple ID. */
  email?: string;
  givenName?: string;
  familyName?: string;
  /** ASUserDetectionStatus: 0 unsupported, 1 unknown, 2 likely real. */
  realUserStatus: number;
}>;

export interface AppleSignInPlugin {
  /** Rejects with code USER_CANCELLED when the user dismisses the sheet. */
  authorize(options: { nonce?: string; state?: string; scopes?: AppleSignInScope[] }): Promise<AppleSignInResult>;
  getCredentialState(options: { user: string }): Promise<{ state: "authorized" | "revoked" | "notFound" | "transferred" | "unknown" }>;
}

export const AppleSignIn = registerPlugin<AppleSignInPlugin>("AppleSignIn");

export function nativeAppleSignInAvailable(): boolean {
  return Capacitor.getPlatform() === "ios" && Capacitor.isPluginAvailable("AppleSignIn");
}
