import {
  AUTH_CLIENT_CONTRACT_VERSION,
  type AuthAccountView,
  type AuthPlayerView,
  type AuthSessionResponse,
  type ClientAuthState
} from "@ash-atlas/shared";

import { AuthApiError } from "./authClient.js";

export type AuthenticatedClientSession = AuthSessionResponse & {
  authenticated: true;
  account: AuthAccountView;
  player: AuthPlayerView;
  onboardingRequired: false;
} & (
  | { testAccessStatus: "approved"; testAccessAllowed?: true }
  | { testAccessStatus: "pending"; testAccessAllowed: true }
);

export type ClientAuthView = {
  status: ClientAuthState | "session_replaced";
  session: AuthSessionResponse | null;
  developmentAuthEnabled: boolean;
  message: string | null;
};

export function authViewFromSession(session: AuthSessionResponse): ClientAuthView {
  const common = {
    session,
    developmentAuthEnabled: session.developmentAuthEnabled,
    message: null
  };
  if (
    session.requiredClientContractVersion !== undefined &&
    session.requiredClientContractVersion > AUTH_CLIENT_CONTRACT_VERSION
  ) {
    return { status: "client_update_required", ...common };
  }
  if (!session.authenticated) {
    return { status: "unauthenticated", ...common };
  }
  if (session.account?.status === "suspended") {
    return { status: "account_suspended", ...common, message: "Account suspended" };
  }
  if (session.testAccessDevOnly === true && session.testAccessAllowed === false) {
    return { status: "test_access_dev_only", ...common };
  }
  if (session.testAccessStatus === "pending" && session.testAccessAllowed !== true) {
    return { status: "test_access_pending", ...common };
  }
  if (session.testAccessStatus === "denied") {
    return { status: "test_access_denied", ...common };
  }
  if (session.testAccessStatus === "revoked") {
    return { status: "test_access_revoked", ...common };
  }
  if (!session.player) {
    return { status: "needs_onboarding", ...common };
  }
  if (session.onboardingRequired) {
    return { status: "needs_onboarding", ...common };
  }
  if (!session.account) {
    return {
      status: "auth_error",
      ...common,
      message: "Account session is incomplete"
    };
  }
  return { status: "authenticated", ...common };
}

export function authViewFromError(
  error: unknown,
  developmentAuthEnabled = false
): ClientAuthView {
  const code = error instanceof AuthApiError ? error.code : "SERVER_UNAVAILABLE";
  if (code === "ACCOUNT_SUSPENDED") {
    return emptyView("account_suspended", "Account suspended", developmentAuthEnabled);
  }
  if (code === "AUTHENTICATION_REQUIRED") {
    return emptyView("session_expired", "Session expired", developmentAuthEnabled);
  }
  if (code === "TEST_ACCESS_PENDING") {
    return emptyView("test_access_pending", "Test access is pending", developmentAuthEnabled);
  }
  if (code === "TEST_ACCESS_DENIED") {
    return emptyView("test_access_denied", "Test access was not approved", developmentAuthEnabled);
  }
  if (code === "TEST_ACCESS_REVOKED") {
    return emptyView("test_access_revoked", "Test access was removed", developmentAuthEnabled);
  }
  if (code === "TEST_ACCESS_DEV_ONLY") {
    return emptyView(
      "test_access_dev_only",
      "Only developer accounts can enter Ash Atlas",
      developmentAuthEnabled
    );
  }
  return emptyView(
    "auth_error",
    error instanceof AuthApiError ? error.message : "Server unavailable",
    developmentAuthEnabled
  );
}

export function sessionEndedView(
  reason: "SESSION_EXPIRED" | "SESSION_REVOKED" | "SESSION_REPLACED" | "ACCOUNT_SUSPENDED",
  message?: string,
  developmentAuthEnabled = false
): ClientAuthView {
  if (reason === "ACCOUNT_SUSPENDED") {
    return emptyView("account_suspended", "Account suspended", developmentAuthEnabled);
  }
  const defaultMessage =
    reason === "SESSION_REPLACED"
      ? "This account was opened in another gameplay session."
      : "Session expired. Sign in again to continue.";
  return emptyView(
    reason === "SESSION_REPLACED" ? "session_replaced" : "session_expired",
    message || defaultMessage,
    developmentAuthEnabled
  );
}

export function isAuthenticatedClientSession(
  session: AuthSessionResponse | null
): session is AuthenticatedClientSession {
  return Boolean(
    session?.authenticated &&
      session.account &&
      session.player &&
      session.testAccessAllowed !== false &&
      (
        session.testAccessStatus === "approved" ||
        (session.testAccessStatus === "pending" && session.testAccessAllowed === true)
      ) &&
      session.onboardingRequired === false
  );
}

export function authErrorMessage(error: unknown): string {
  if (!(error instanceof AuthApiError)) {
    return "Server unavailable";
  }
  switch (error.code) {
    case "INVALID_GOOGLE_LOGIN":
      return "Invalid or expired Google login.";
    case "VERIFIED_GMAIL_REQUIRED":
      return "A verified Gmail account is required.";
    case "ACCOUNT_SUSPENDED":
      return "Account suspended.";
    case "ACCOUNT_UNAVAILABLE":
      return "Account unavailable.";
    case "TEST_ACCESS_PENDING":
      return "Test access is pending.";
    case "TEST_ACCESS_DENIED":
      return "Test access was not approved.";
    case "TEST_ACCESS_REVOKED":
      return "Test access was removed.";
    case "TEST_ACCESS_DEV_ONLY":
      return "Only developer accounts can enter Ash Atlas.";
    case "PLAYER_NAME_INVALID":
      return "Use 3-20 English letters only.";
    case "PLAYER_NAME_TAKEN":
      return "That name is already taken.";
    case "PERSONAL_FLAG_COLOR_INVALID":
      return "Choose red, blue, green, gold, or purple.";
    case "TOO_MANY_ACCOUNT_CREATION_ATTEMPTS":
      return "Too many account-creation attempts. Try again later.";
    case "TOO_MANY_LOGIN_ATTEMPTS":
      return "Too many login attempts. Try again later.";
    case "EMAIL_INVALID":
      return "Enter a valid email address.";
    case "EMAIL_DOMAIN_NOT_ALLOWED":
      return "Email sign-in supports Gmail, Outlook/Hotmail, Yahoo, iCloud, AOL and GMX. You can also continue with Google or Apple.";
    case "EMAIL_CODE_INVALID":
      return "That code is invalid or has expired.";
    case "TOO_MANY_EMAIL_CODE_REQUESTS":
      return "Too many code requests. Try again later.";
    case "ACCOUNT_LINK_REQUIRED":
      return "This email is already used by an account that signs in another way. Sign in that way, then link email from Account settings.";
    case "ACCOUNT_LINK_CONFLICT":
      return "That sign-in method can't be linked to this account.";
    default:
      return error.message || "Server unavailable";
  }
}

function emptyView(
  status: ClientAuthView["status"],
  message: string,
  developmentAuthEnabled: boolean
): ClientAuthView {
  return {
    status,
    session: null,
    developmentAuthEnabled,
    message
  };
}
