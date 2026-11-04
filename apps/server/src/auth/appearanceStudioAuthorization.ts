import { createHash, randomBytes } from "node:crypto";

import type { AuthenticatedSession } from "./types.js";

export const APPEARANCE_STUDIO_CALLBACK =
  "http://127.0.0.1:5285/auth/callback";
export const APPEARANCE_STUDIO_FEATURE_PORT_MIN = 25_285;
export const APPEARANCE_STUDIO_FEATURE_PORT_MAX = 45_284;
export const APPEARANCE_STUDIO_CODE_TTL_MS = 60_000;
export const APPEARANCE_STUDIO_SESSION_TTL_MS = 30 * 60_000;

type AuthorizationCode = {
  accountId: string;
  playerId: string;
  verifiedGoogleSubject: string;
  redirectUri: string;
  challenge: string;
  expiresAt: number;
};

export type AppearanceStudioTokenSession = {
  accountId: string;
  playerId: string;
  verifiedGoogleSubject: string;
  expiresAt: number;
};

export class AppearanceStudioAuthorization {
  private readonly codes = new Map<string, AuthorizationCode>();
  private readonly sessions = new Map<string, AppearanceStudioTokenSession>();

  issueCode(input: {
    session: AuthenticatedSession;
    redirectUri: string;
    codeChallenge: string;
  }): { code: string; expiresAt: number } {
    const subject = input.session.verifiedGoogleSubject;
    const player = input.session.player;
    if (!subject || !player) {
      throw new AppearanceStudioAuthorizationError(
        403,
        "A verified developer player session is required"
      );
    }
    requireCallback(input.redirectUri);
    if (!/^[a-zA-Z0-9_-]{43}$/u.test(input.codeChallenge)) {
      throw new AppearanceStudioAuthorizationError(400, "PKCE challenge is invalid");
    }
    this.prune();
    const code = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + APPEARANCE_STUDIO_CODE_TTL_MS;
    this.codes.set(code, {
      accountId: input.session.account.id,
      playerId: player.id,
      verifiedGoogleSubject: subject,
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
  }): { token: string; expiresAt: number } {
    requireCallback(input.redirectUri);
    if (!/^[a-zA-Z0-9_-]{43,128}$/u.test(input.codeVerifier)) {
      throw new AppearanceStudioAuthorizationError(400, "PKCE verifier is invalid");
    }
    const authorization = this.codes.get(input.code);
    this.codes.delete(input.code);
    if (
      !authorization ||
      authorization.expiresAt <= Date.now() ||
      authorization.redirectUri !== input.redirectUri
    ) {
      throw new AppearanceStudioAuthorizationError(
        400,
        "Authorization code is invalid, expired, or already used"
      );
    }
    const challenge = createHash("sha256")
      .update(input.codeVerifier)
      .digest("base64url");
    if (!constantText(challenge, authorization.challenge)) {
      throw new AppearanceStudioAuthorizationError(400, "PKCE verification failed");
    }
    const token = randomBytes(40).toString("base64url");
    const expiresAt = Date.now() + APPEARANCE_STUDIO_SESSION_TTL_MS;
    this.sessions.set(tokenHash(token), {
      accountId: authorization.accountId,
      playerId: authorization.playerId,
      verifiedGoogleSubject: authorization.verifiedGoogleSubject,
      expiresAt
    });
    return { token, expiresAt };
  }

  authenticate(rawToken: string | null): AppearanceStudioTokenSession {
    this.prune();
    if (!rawToken) {
      throw new AppearanceStudioAuthorizationError(401, "Studio token is required");
    }
    const session = this.sessions.get(tokenHash(rawToken));
    if (!session || session.expiresAt <= Date.now()) {
      throw new AppearanceStudioAuthorizationError(
        401,
        "Studio token is invalid, expired, or revoked"
      );
    }
    return { ...session };
  }

  revoke(rawToken: string | null): boolean {
    if (!rawToken) return false;
    return this.sessions.delete(tokenHash(rawToken));
  }

  private prune(): void {
    const now = Date.now();
    for (const [code, authorization] of this.codes) {
      if (authorization.expiresAt <= now) this.codes.delete(code);
    }
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }
}

export class AppearanceStudioAuthorizationError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "AppearanceStudioAuthorizationError";
  }
}

function requireCallback(redirectUri: string): void {
  if (!isAppearanceStudioCallback(redirectUri)) {
    throw new AppearanceStudioAuthorizationError(
      400,
      "Appearance Studio callback is not allowlisted"
    );
  }
}

export function isAppearanceStudioCallback(redirectUri: string): boolean {
  try {
    const url = new URL(redirectUri);
    const port = Number(url.port || "80");
    return url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/auth/callback" &&
      url.search === "" &&
      url.hash === "" &&
      (
        port === 5285 ||
        (
          port >= APPEARANCE_STUDIO_FEATURE_PORT_MIN &&
          port <= APPEARANCE_STUDIO_FEATURE_PORT_MAX
        )
      );
  } catch {
    return false;
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function constantText(left: string, right: string): boolean {
  return Buffer.from(createHash("sha256").update(left).digest())
    .equals(createHash("sha256").update(right).digest());
}
