import { describe, expect, it, vi } from "vitest";
import type { TokenPayload } from "google-auth-library";

import {
  GoogleAuthLibraryIdentityVerifier,
  isExactGmailAddress,
  verifiedGoogleIdentityFromPayload,
  type GoogleTokenVerifierClient
} from "./googleIdentity.js";

describe("Google identity verification", () => {
  it("verifies the credential with the configured audience", async () => {
    const verifyIdToken = vi.fn(async () => ({
      getPayload: () => ({
        iss: "accounts.google.com",
        aud: "client-id",
        iat: 1_700_000_000,
        exp: 1_700_003_600,
        sub: "google-sub-1",
        email: " PLAYER@GMAIL.COM ",
        email_verified: true,
        auth_time: 1_700_000_000,
        amr: ["pwd", "mfa"]
      })
    }));
    const verifier = new GoogleAuthLibraryIdentityVerifier("client-id", {
      verifyIdToken
    } as unknown as GoogleTokenVerifierClient);

    await expect(verifier.verifyCredential("signed-id-token")).resolves.toMatchObject({
      subject: "google-sub-1",
      email: "player@gmail.com",
      emailVerified: true,
      authMethods: ["pwd", "mfa"],
      expiresAt: new Date(1_700_003_600_000)
    });
    expect(verifyIdToken).toHaveBeenCalledWith({
      idToken: "signed-id-token",
      audience: "client-id"
    });
  });

  it.each([
    ["invalid signature", "INVALID_GOOGLE_LOGIN"],
    ["Wrong recipient, payload audience != requiredAudience", "INVALID_GOOGLE_LOGIN"],
    ["Token used too late, 1710000000 > 1700000000", "GOOGLE_TOKEN_EXPIRED"]
  ])("maps verifier rejection %s to a stable code", async (message, code) => {
    const verifier = rejectingVerifier(message);
    await expect(verifier.verifyCredential("bad-token")).rejects.toMatchObject({ code });
  });

  it.each([
    [tokenPayload({ sub: "", email: "player@gmail.com" }), "missing sub"],
    [tokenPayloadWithoutEmail(), "missing email"],
    [tokenPayload({ sub: "subject", email: "player@gmail.com", email_verified: false }), "unverified email"],
    [tokenPayloadWithoutExpiration(), "missing expiration"]
  ])("rejects %s (%s)", (payload, _label) => {
    expect(_label).toBeTypeOf("string");
    expect(() => verifiedGoogleIdentityFromPayload(payload as TokenPayload)).toThrowError(
      expect.objectContaining({ code: "INVALID_GOOGLE_LOGIN" })
    );
  });

  it.each([
    "user@workspace.example",
    "player@googlemail.com",
    "player@school.edu"
  ])("accepts verified non-Gmail Google address %s (policy lives in AuthService)", (email) => {
    expect(
      verifiedGoogleIdentityFromPayload(tokenPayload({ sub: "subject", email })).email
    ).toBe(email);
  });

  it("accepts only an exact Gmail domain without dot or plus rewriting", () => {
    expect(isExactGmailAddress(" PLAYER+tag@GMAIL.COM ")).toBe(true);
    expect(isExactGmailAddress("first.last@gmail.com")).toBe(true);
    expect(isExactGmailAddress("player@gmail.com.example.com")).toBe(false);
  });

  it("rejects malformed optional Google security-bundle fields", () => {
    expect(() =>
      verifiedGoogleIdentityFromPayload(
        tokenPayload({ auth_time: -1 } as Partial<TokenPayload>)
      )
    ).toThrowError(expect.objectContaining({ code: "INVALID_GOOGLE_LOGIN" }));
    expect(() =>
      verifiedGoogleIdentityFromPayload(
        tokenPayload({ amr: ["pwd", 42] } as Partial<TokenPayload>)
      )
    ).toThrowError(expect.objectContaining({ code: "INVALID_GOOGLE_LOGIN" }));
  });
});

function rejectingVerifier(message: string): GoogleAuthLibraryIdentityVerifier {
  return new GoogleAuthLibraryIdentityVerifier("client-id", {
    verifyIdToken: vi.fn(async () => {
      throw new Error(message);
    })
  });
}

function tokenPayload(overrides: Partial<TokenPayload>): TokenPayload {
  return {
    iss: "accounts.google.com",
    aud: "client-id",
    iat: 1_700_000_000,
    exp: 1_700_003_600,
    sub: "subject",
    email: "player@gmail.com",
    email_verified: true,
    ...overrides
  };
}

function tokenPayloadWithoutEmail(): TokenPayload {
  const payload = tokenPayload({ sub: "subject" });
  delete payload.email;
  return payload;
}

function tokenPayloadWithoutExpiration(): TokenPayload {
  const payload = tokenPayload({ sub: "subject" });
  Reflect.deleteProperty(payload, "exp");
  return payload;
}
