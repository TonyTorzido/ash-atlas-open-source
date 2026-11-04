import type {
  AccountStatus,
  AccountTrustTier,
  PersonalFlagColor,
  TestAccessStatus
} from "@ash-atlas/shared";

export type VerifiedGoogleIdentity = {
  subject: string;
  email: string;
  emailVerified: true;
  authTime: Date | null;
  authMethods: string[] | null;
  expiresAt: Date;
};

export type VerifiedAppleIdentity = {
  provider: "apple";
  subject: string;
  email: string | null;
  emailVerified: boolean;
  isPrivateEmail: boolean | null;
  authTime: Date | null;
  expiresAt: Date;
};

/** Mailbox control proven by a consumed one-time code; subject = normalized email. */
export type VerifiedEmailIdentity = {
  provider: "email";
  subject: string;
  email: string;
  emailVerified: true;
  authTime: Date;
};

export type AuthIdentityProvider = "google" | "apple" | "email";

export type AuthAccountRecord = {
  id: string;
  status: AccountStatus;
  trustTier: AccountTrustTier;
  riskScore: number;
  testAccessStatus: TestAccessStatus;
  testAccessRequestedAt: Date;
  testAccessDecidedAt: Date | null;
  createdAt: Date;
  lastLoginAt: Date | null;
};

export type AuthPlayerRecord = {
  id: string;
  accountId: string;
  displayName: string;
  personalFlagColor: PersonalFlagColor;
  onboardingCompletedAt: Date;
};

export type AccountIdentityResult = {
  account: AuthAccountRecord;
  created: boolean;
  identityId?: string;
};

export type AppleAccountIdentityResult = AccountIdentityResult & {
  provider: "apple";
};

export type EmailAccountIdentityResult = AccountIdentityResult & {
  provider: "email";
};

export type EmailLoginCodePurpose = "signin" | "link";

export type DeviceInstallationRecord = {
  id: string;
  created: boolean;
};

export type AccountDeviceLinkResult = {
  created: boolean;
  distinctAccountCount: number;
};

export type StoredAuthSession = {
  id: string;
  identityId?: string | null;
  identityProvider?: AuthIdentityProvider | null;
  verifiedGoogleSubject?: string | null;
  verifiedEmail: string;
  account: AuthAccountRecord;
  player: AuthPlayerRecord | null;
  deviceInstallationId: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokeReason: string | null;
  accountSessionVersion: number;
  sessionAccountVersion: number;
};

export type AuthenticatedSession = {
  sessionId: string;
  identityId?: string | null;
  identityProvider?: AuthIdentityProvider | null;
  verifiedGoogleSubject?: string | null;
  verifiedEmail: string;
  account: AuthAccountRecord;
  player: AuthPlayerRecord | null;
  deviceInstallationId: string | null;
  csrfToken: string;
};

export type IssuedAuthSession = AuthenticatedSession & {
  rawToken: string;
  expiresAt: Date;
};

export type AuthTelemetryContext = {
  deviceInstallationId: string;
  networkHash: string;
  networkPrefixHash: string;
  networkKeyVersion: string;
};

export type AuthEventInput = {
  accountId?: string | null;
  deviceInstallationId?: string | null;
  eventType: string;
  networkHash?: string | null;
  networkPrefixHash?: string | null;
  networkKeyVersion?: string | null;
  metadata?: Record<string, unknown>;
};

export type RiskEventInput = {
  accountId: string;
  deviceInstallationId?: string | null;
  eventType: string;
  weight: number;
  dedupeKey?: string | null;
  metadata?: Record<string, unknown>;
};

export type LoginRequestContext = {
  ip: string;
  userAgent: string | undefined;
  deviceToken: string | null;
  existingSessionToken: string | null;
};

export type LoginResult = {
  session: IssuedAuthSession;
  deviceToken: string;
  deviceTokenCreated: boolean;
  accountCreated: boolean;
  identityId?: string | null;
};

export type AuthFailureCode =
  | "INVALID_GOOGLE_LOGIN"
  | "INVALID_APPLE_LOGIN"
  | "APPLE_IDENTITY_REVOKED"
  | "ACCOUNT_LINK_REQUIRED"
  | "ACCOUNT_LINK_CONFLICT"
  | "INVALID_DEV_LOGIN"
  | "GOOGLE_TOKEN_EXPIRED"
  | "VERIFIED_GMAIL_REQUIRED"
  | "EMAIL_INVALID"
  | "EMAIL_DOMAIN_NOT_ALLOWED"
  | "EMAIL_CODE_INVALID"
  | "TOO_MANY_EMAIL_CODE_REQUESTS"
  | "ACCOUNT_SUSPENDED"
  | "ACCOUNT_UNAVAILABLE"
  | "TOO_MANY_LOGIN_ATTEMPTS"
  | "TOO_MANY_ACCOUNT_CREATION_ATTEMPTS"
  | "SESSION_EXPIRED"
  | "SESSION_REVOKED"
  | "AUTHENTICATION_REQUIRED"
  | "CSRF_INVALID"
  | "ORIGIN_FORBIDDEN"
  | "PLAYER_NAME_INVALID"
  | "PLAYER_NAME_TAKEN"
  | "PLAYER_ALREADY_EXISTS"
  | "PERSONAL_FLAG_COLOR_INVALID"
  | "TEST_ACCESS_PENDING"
  | "TEST_ACCESS_DENIED"
  | "TEST_ACCESS_REVOKED"
  | "TEST_ACCESS_DEV_ONLY"
  | "TEST_ACCESS_ADMIN_FORBIDDEN"
  | "TEST_ACCESS_INVALID_TRANSITION"
  | "TEST_ACCESS_GRANT_NOT_REVOCABLE"
  | "ONBOARDING_FAILED"
  | "DELETION_REQUEST_NOT_FOUND"
  | "DELETION_REQUEST_CLOSED"
  | "DELETION_OWNERSHIP_MISMATCH"
  | "DELETION_OWNERSHIP_REQUIRED"
  | "APPLE_REVOCATION_PENDING";

export class AuthError extends Error {
  constructor(
    readonly code: AuthFailureCode,
    message: string,
    readonly statusCode = 401
  ) {
    super(message);
    this.name = "AuthError";
  }
}
