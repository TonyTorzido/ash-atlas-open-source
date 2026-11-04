import { OAuth2Client, type TokenPayload } from "google-auth-library";

import { AuthError, type VerifiedGoogleIdentity } from "./types.js";

export type GoogleTokenVerifierClient = {
  verifyIdToken(input: { idToken: string; audience: string }): Promise<{
    getPayload(): TokenPayload | undefined;
  }>;
};

export interface GoogleIdentityVerifier {
  verifyCredential(credential: string): Promise<VerifiedGoogleIdentity>;
}

export class GoogleAuthLibraryIdentityVerifier implements GoogleIdentityVerifier {
  private readonly client: GoogleTokenVerifierClient;

  constructor(
    private readonly audience: string,
    client: GoogleTokenVerifierClient = new OAuth2Client()
  ) {
    this.client = client;
  }

  async verifyCredential(credential: string): Promise<VerifiedGoogleIdentity> {
    if (!credential || credential.length > 16_384) {
      throw new AuthError("INVALID_GOOGLE_LOGIN", "Invalid Google login", 401);
    }
    try {
      const ticket = await this.client.verifyIdToken({
        idToken: credential,
        audience: this.audience
      });
      return verifiedGoogleIdentityFromPayload(ticket.getPayload());
    } catch (error) {
      if (error instanceof AuthError) {
        throw error;
      }
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (message.includes("expired") || message.includes("used too late")) {
        throw new AuthError("GOOGLE_TOKEN_EXPIRED", "Google token expired", 401);
      }
      throw new AuthError("INVALID_GOOGLE_LOGIN", "Invalid Google login", 401);
    }
  }
}

export class FakeGoogleIdentityVerifier implements GoogleIdentityVerifier {
  constructor(private readonly identities: ReadonlyMap<string, VerifiedGoogleIdentity>) {}

  async verifyCredential(credential: string): Promise<VerifiedGoogleIdentity> {
    const identity = this.identities.get(credential);
    if (!identity) {
      throw new AuthError("INVALID_GOOGLE_LOGIN", "Invalid Google login", 401);
    }
    return identity;
  }
}

export function verifiedGoogleIdentityFromPayload(
  payload: TokenPayload | undefined
): VerifiedGoogleIdentity {
  const subject = payload?.sub?.trim();
  const email = payload?.email?.trim().toLowerCase();
  const expiresAtSeconds = payload?.exp;
  if (
    !subject ||
    subject.length > 255 ||
    !email ||
    email.length > 320 ||
    payload?.email_verified !== true ||
    !Number.isFinite(expiresAtSeconds) ||
    Number(expiresAtSeconds) <= 0
  ) {
    throw new AuthError("INVALID_GOOGLE_LOGIN", "Invalid Google login", 401);
  }
  const optional = payload as TokenPayload & { auth_time?: number; amr?: unknown };
  if (
    optional.auth_time !== undefined &&
    (!Number.isFinite(optional.auth_time) || optional.auth_time <= 0)
  ) {
    throw new AuthError("INVALID_GOOGLE_LOGIN", "Invalid Google login", 401);
  }
  if (
    optional.amr !== undefined &&
    (!Array.isArray(optional.amr) ||
      optional.amr.length > 20 ||
      optional.amr.some(
        (method) => typeof method !== "string" || method.length === 0 || method.length > 64
      ))
  ) {
    throw new AuthError("INVALID_GOOGLE_LOGIN", "Invalid Google login", 401);
  }
  return {
    subject,
    email,
    emailVerified: true,
    authTime:
      typeof optional.auth_time === "number" && Number.isFinite(optional.auth_time)
        ? new Date(optional.auth_time * 1_000)
        : null,
    authMethods: Array.isArray(optional.amr) ? optional.amr : null,
    expiresAt: new Date(Number(expiresAtSeconds) * 1_000)
  };
}

export function isExactGmailAddress(email: string): boolean {
  const parts = email.trim().toLowerCase().split("@");
  return parts.length === 2 && Boolean(parts[0]) && parts[1] === "gmail.com";
}
