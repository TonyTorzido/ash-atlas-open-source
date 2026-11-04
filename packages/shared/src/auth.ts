import type { PersonalFlagColor } from "./personalFlagColors.js";
import type { TrustAttestationSessionConfig } from "./deviceTrust.js";

export const AUTH_CLIENT_CONTRACT_VERSION = 1;
export const AUTH_SERVER_REQUIRED_CLIENT_CONTRACT_VERSION = AUTH_CLIENT_CONTRACT_VERSION;

export const ACCOUNT_STATUSES = ["active", "suspended", "deleted"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const ACCOUNT_TRUST_TIERS = ["new", "standard", "trusted", "restricted"] as const;
export type AccountTrustTier = (typeof ACCOUNT_TRUST_TIERS)[number];

export const TEST_ACCESS_STATUSES = ["pending", "approved", "denied", "revoked"] as const;
export type TestAccessStatus = (typeof TEST_ACCESS_STATUSES)[number];

export const TEST_ACCESS_MODES = ["open", "closed", "dev"] as const;
export type TestAccessMode = (typeof TEST_ACCESS_MODES)[number];

export const DEV_ACCESS_STATUSES = ["pending", "approved", "denied", "revoked"] as const;
export type DevAccessStatus = (typeof DEV_ACCESS_STATUSES)[number];

export const DEVELOPER_CAPABILITIES = [
  "developer:observe",
  "developer:appearance-studio",
  "developer:world-mutate",
  "developer:assets-grant",
  "developer:packages-send",
  "developer:economy-mutate",
  "developer:leaderboards-private",
  "developer:test-access-manage",
  "developer:announcements-manage",
  "developer:wiki-manage"
] as const;
export type DeveloperCapability = (typeof DEVELOPER_CAPABILITIES)[number];

export type AuthAccountView = {
  id: string;
  status: "active" | "suspended";
  trustTier: AccountTrustTier;
};

export type AuthPlayerView = {
  id: string;
  displayName: string;
  personalFlagColor: PersonalFlagColor;
};

export type AuthIdentityProviderName = "google" | "apple" | "email";

export type AuthSessionResponse = {
  authenticated: boolean;
  requiredClientContractVersion?: number;
  csrfToken: string;
  developmentAuthEnabled: boolean;
  /** Server capability only; credentials and Apple identifiers never cross this boundary. */
  appleSignInEnabled?: boolean;
  /** Email one-time-code sign-in is configured and enabled on this server. */
  emailSignInEnabled?: boolean;
  /** Authenticated only: active sign-in providers on this account (for link UI). */
  linkedProviders?: AuthIdentityProviderName[];
  /** Location trust: the client sends foreground passive LOCATION_FIX messages. */
  trustPassiveFixEnabled?: boolean;
  /** Periodic passive fixes fire at a random delay, uniform in [min, max] seconds (min >= 60). */
  trustPassiveFixMinSeconds?: number;
  trustPassiveFixMaxSeconds?: number;
  /** The server accepts the optional `native` / `attestationRef` fields on location messages. */
  trustNativeSignalsAccepted?: boolean;
  /** Native only: send fire-and-forget action fixes beside land actions (status, never thresholds). */
  trustActionFixes?: boolean;
  /**
   * True when this client may not relocate here (web while phone-only
   * relocation is enforced): show "Relocate from the Ash Atlas app on your phone".
   */
  trustRelocationPhoneOnly?: boolean;
  /** Present only when device attestation is configured on this server. */
  trustAttestation?: TrustAttestationSessionConfig;
  developerCapabilities: DeveloperCapability[];
  account?: AuthAccountView;
  player?: AuthPlayerView;
  testAccessStatus?: TestAccessStatus;
  testAccessAllowed?: boolean;
  /** True when dev access mode is what keeps this account out. */
  testAccessDevOnly?: boolean;
  /** Signed-out only: the server's test access mode (the client shows the update sign-up in dev). */
  testAccessMode?: TestAccessMode;
  verifiedEmail?: string;
  onboardingRequired?: boolean;
  /** Present only for the authenticated Capacitor client. */
  webSocketTicket?: string;
};

export type TestAccessModeResponse = {
  mode: TestAccessMode;
  updatedAt: string;
};

export type TestAccessAccountAdminView = {
  kind: "account";
  accountId: string;
  verifiedEmail: string;
  status: TestAccessStatus;
  createdAt: string;
  lastLoginAt: string | null;
  requestedAt: string;
  decidedAt: string | null;
  playerName: string | null;
  /** Dev-list entry status, when the account has one. */
  devAccessStatus?: DevAccessStatus | null;
};

export type TestAccessEmailGrantAdminView = {
  kind: "grant";
  grantId: string;
  email: string;
  status: "active" | "claimed" | "revoked";
  createdAt: string;
  claimedAccountId: string | null;
  claimedAt: string | null;
};

export type DevAccessAccountAdminView = {
  kind: "dev";
  accountId: string;
  verifiedEmail: string;
  devAccessStatus: DevAccessStatus;
  testAccessStatus: TestAccessStatus;
  requestedAt: string | null;
  decidedAt: string | null;
  lastLoginAt: string | null;
  playerName: string | null;
};

export type TestAccessAdminListResponse = {
  items: Array<
    TestAccessAccountAdminView | TestAccessEmailGrantAdminView | DevAccessAccountAdminView
  >;
  page: number;
  pageSize: number;
  total: number;
  queryDurationMs: number;
};

export type ClientAuthState =
  | "checking_session"
  | "unauthenticated"
  | "authenticating"
  | "test_access_pending"
  | "test_access_denied"
  | "test_access_revoked"
  | "test_access_dev_only"
  | "needs_onboarding"
  | "client_update_required"
  | "authenticated"
  | "session_expired"
  | "account_suspended"
  | "auth_error";
