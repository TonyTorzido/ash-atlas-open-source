import { createHash } from "node:crypto";

import {
  AUTH_SERVER_REQUIRED_CLIENT_CONTRACT_VERSION,
  type AuthSessionResponse,
  type DeveloperCapability,
  type TestAccessMode,
  type TrustAttestationSessionConfig
} from "@ash-atlas/shared";

import type { AppConfig } from "../config.js";
import type { AppLogger } from "../logger.js";
import { isExactGmailAddress, type GoogleIdentityVerifier } from "./googleIdentity.js";
import { developmentProfile, type DevelopmentProfileKey } from "./developmentProfiles.js";
import {
  developerAuditMetadata,
  developerCapabilitiesForSession,
  DeveloperAuthorizationError,
  hasDeveloperCapability,
  isDeveloperAccessSession,
  type DeveloperCommandAudit
} from "./developerAuthorization.js";
import { NetworkTelemetryHasher, type NetworkTelemetry } from "./networkTelemetry.js";
import { AccountRiskService, RISK_WEIGHTS } from "./riskService.js";
import type { AuthStore, EmailLoginStore } from "./authStore.js";
import {
  generateEmailLoginCode,
  hashEmailLoginCode,
  normalizeEmailLoginCode
} from "./email/loginCodes.js";
import {
  canonicalEmail,
  isEmailDomainAllowed,
  normalizeEmailAddress
} from "./email/emailDomainPolicy.js";
import { loginCodeEmail, type EmailSender } from "./email/emailSender.js";
import {
  csrfTokenForSession,
  csrfTokensMatch,
  generateSecureToken,
  hashAuthToken,
  isSecureToken
} from "./tokens.js";
import {
  AuthError,
  type AuthAccountRecord,
  type AuthEventInput,
  type AuthenticatedSession,
  type AuthIdentityProvider,
  type AuthPlayerRecord,
  type EmailLoginCodePurpose,
  type IssuedAuthSession,
  type LoginRequestContext,
  type LoginResult,
  type VerifiedAppleIdentity,
  type VerifiedEmailIdentity,
  type VerifiedGoogleIdentity
} from "./types.js";
import { broadClientProfile } from "./userAgent.js";
import type { TestAccessModeReader } from "./testAccessService.js";
import { isCapacitorNativeOrigin } from "./nativeAppAuthorization.js";

const LOGIN_WINDOW_MS = 10 * 60_000;
const NEW_ACCOUNT_WINDOW_MS = 24 * 60 * 60_000;
const SESSION_TOUCH_INTERVAL_MS = 5 * 60_000;
const RAPID_SWITCH_WINDOW_MS = 30 * 60_000;
const LOGIN_SUCCESS_EVENT_TYPES = [
  "google_login_success",
  "apple_login_success",
  "email_login_success"
];
const RESERVED_PLAYER_NAMES = new Set([
  "admin",
  "administrator",
  "moderator",
  "system",
  "server",
  "ashatlas",
  "ash_atlas"
]);

const CLOSED_ACCESS_MODE_READER: TestAccessModeReader = {
  getAccessMode: async () => "closed"
};

export class AuthService {
  private readonly networkHasher: NetworkTelemetryHasher;
  private readonly risk: AccountRiskService;
  private loginTrustHook: ((accountId: string) => Promise<void>) | null = null;
  private settlementStatusHook: ((accountId: string) => Promise<boolean>) | null = null;
  private attestationSessionConfig: (() => TrustAttestationSessionConfig | undefined) | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly store: AuthStore,
    private readonly googleVerifier: GoogleIdentityVerifier,
    private readonly logger: Pick<AppLogger, "warn">,
    private readonly now: () => Date = () => new Date(),
    private readonly accessMode: TestAccessModeReader = CLOSED_ACCESS_MODE_READER,
    private readonly emailSender: EmailSender | null = null
  ) {
    this.networkHasher = new NetworkTelemetryHasher(
      config.AUTH_NETWORK_HMAC_KEY,
      config.AUTH_NETWORK_HMAC_KEY_VERSION
    );
    this.risk = new AccountRiskService(store);
  }

  get developmentAuthEnabled(): boolean {
    return (
      this.config.AUTH_DEV_LOGIN_ENABLED &&
      this.config.AUTH_MODE === "dev" &&
      this.config.AUTH_RUNTIME_MODE !== "public" &&
      this.config.NODE_ENV === "development"
    );
  }

  /** Email codes need the flag, a sender, and the store's email support. */
  get emailSignInEnabled(): boolean {
    return (
      this.config.AUTH_EMAIL_LOGIN_ENABLED &&
      this.emailSender !== null &&
      typeof this.store.consumeEmailLoginCode === "function"
    );
  }

  get sessionCookieName(): string {
    return this.config.NODE_ENV === "production"
      ? "__Host-aa_session"
      : `aa_session_dev${this.developmentCookieSuffix}`;
  }

  get deviceCookieName(): string {
    return this.config.NODE_ENV === "production"
      ? "__Host-aa_device"
      : `aa_device_dev${this.developmentCookieSuffix}`;
  }

  private get developmentCookieSuffix(): string {
    const runtimeLabel = this.config.RUNTIME_LABEL;
    if (!runtimeLabel) return "";
    return `_${createHash("sha256").update(runtimeLabel).digest("hex").slice(0, 12)}`;
  }

  async ensureDeviceForRequest(input: {
    ip: string;
    userAgent: string | undefined;
    deviceToken: string | null;
  }): Promise<{ deviceToken: string; deviceInstallationId: string; created: boolean }> {
    const prepared = await this.prepareLoginContext({
      ...input,
      existingSessionToken: null
    });
    return {
      deviceToken: prepared.device.rawToken,
      deviceInstallationId: prepared.device.id,
      created: prepared.device.createdToken
    };
  }

  networkHashForRequest(ip: string): string {
    return this.networkHasher.derive(ip).networkHash;
  }

  networkTelemetryForRequest(ip: string): NetworkTelemetry {
    return this.networkHasher.derive(ip);
  }

  // Settled status for the session's action-fix flag (a boolean only: targets
  // and progress never leave the server).
  setSettlementStatusHook(hook: ((accountId: string) => Promise<boolean>) | null): void {
    this.settlementStatusHook = hook;
  }

  // Device attestation settings for native sessions (absent when disabled).
  setAttestationSessionConfig(provider: (() => TrustAttestationSessionConfig | undefined) | null): void {
    this.attestationSessionConfig = provider;
  }

  // True only while unsettled, on the native app, with passive fixes enabled.
  private async trustActionFixes(accountId: string, nativeClient: boolean): Promise<boolean> {
    if (!nativeClient || !this.config.TRUST_PASSIVE_FIX_ENABLED || !this.settlementStatusHook) return false;
    try {
      return !(await this.settlementStatusHook(accountId));
    } catch (error) {
      this.logger.warn({ err: error, accountId }, "Settled status could not be loaded for the session");
      return false;
    }
  }

  private trustAttestationField(nativeClient: boolean): { trustAttestation?: TrustAttestationSessionConfig } {
    const trustAttestation = nativeClient ? this.attestationSessionConfig?.() : undefined;
    return trustAttestation ? { trustAttestation } : {};
  }

  // Account trust refresh after a successful login; never fails the login.
  setLoginTrustHook(hook: ((accountId: string) => Promise<void>) | null): void {
    this.loginTrustHook = hook;
  }

  private async runLoginTrustHook(accountId: string): Promise<void> {
    if (!this.loginTrustHook) return;
    try {
      await this.loginTrustHook(accountId);
    } catch (error) {
      this.logger.warn({ err: error, accountId }, "Login trust hook failed");
    }
  }

  async loginWithGoogle(
    credential: string,
    context: LoginRequestContext
  ): Promise<LoginResult> {
    if (this.config.AUTH_MODE !== "google") {
      throw new AuthError("ACCOUNT_UNAVAILABLE", "Google login is not enabled", 404);
    }
    const prepared = await this.prepareLoginContext(context);
    await this.enforceLoginLimits(prepared.device.id, prepared.network);
    let identity: VerifiedGoogleIdentity;
    try {
      identity = await this.googleVerifier.verifyCredential(credential);
      this.requireAllowedIdentity(identity);
      const consumed = await this.store.consumeGoogleCredential({
        credentialHash: hashAuthToken(
          credential,
          this.config.AUTH_SESSION_TOKEN_HMAC_KEY,
          "google-credential"
        ),
        deviceInstallationId: prepared.device.id,
        now: this.now(),
        expiresAt: identity.expiresAt
      });
      if (!consumed) {
        throw new AuthError("INVALID_GOOGLE_LOGIN", "Invalid Google login", 401);
      }
    } catch (error) {
      const authError = error instanceof AuthError
        ? error
        : new AuthError("INVALID_GOOGLE_LOGIN", "Invalid Google login", 401);
      await this.recordEvent({
        deviceInstallationId: prepared.device.id,
        eventType: "google_login_failure",
        networkHash: prepared.network.networkHash,
        networkPrefixHash: prepared.network.networkPrefixHash,
        networkKeyVersion: prepared.network.keyVersion,
        metadata: { code: authError.code }
      });
      throw authError;
    }
    return this.completeIdentityLogin(identity, context, prepared);
  }

  async loginAsDeveloper(
    profileKey: DevelopmentProfileKey,
    context: LoginRequestContext
  ): Promise<LoginResult> {
    if (!this.developmentAuthEnabled) {
      throw new AuthError("ACCOUNT_UNAVAILABLE", "Developer login is unavailable", 404);
    }
    const prepared = await this.prepareLoginContext(context);
    const profile = developmentProfile(
      profileKey,
      this.config.AUTH_DEV_ACCOUNT_EMAIL,
      this.config.AUTH_DEV_PLAYER_NAME
    );
    return this.completeIdentityLogin(
      {
        subject: profile.subject,
        email: profile.email,
        emailVerified: true,
        authTime: this.now(),
        authMethods: ["dev"],
        expiresAt: new Date(this.now().getTime() + 5 * 60_000)
      },
      context,
      prepared
    );
  }

  async createNativeSession(
    sourceSession: AuthenticatedSession,
    context: LoginRequestContext
  ): Promise<LoginResult> {
    this.requireActiveAccount(sourceSession.account);
    if (!sourceSession.identityId) {
      throw new AuthError("ACCOUNT_UNAVAILABLE", "Verified provider session required", 403);
    }
    const prepared = await this.prepareLoginContext(context);
    const now = this.now();
    const link = await this.store.linkAccountDevice(
      sourceSession.account.id,
      prepared.device.id,
      now
    );
    await this.store.updateLastLogin(sourceSession.account.id, now);
    await this.recordEvent({
      accountId: sourceSession.account.id,
      deviceInstallationId: prepared.device.id,
      eventType: "native_login_success",
      networkHash: prepared.network.networkHash,
      networkPrefixHash: prepared.network.networkPrefixHash,
      networkKeyVersion: prepared.network.keyVersion,
      metadata: { platform: "ios" }
    });
    await this.recordDeviceRisk(sourceSession.account.id, prepared.device.id, link);
    const session = await this.issueSession(
      sourceSession.account,
      sourceSession.player,
      prepared.device.id,
      now,
      sourceSession.verifiedGoogleSubject ?? null,
      sourceSession.verifiedEmail,
      sourceSession.identityId,
      sourceSession.identityProvider ?? "google"
    );
    return {
      session,
      deviceToken: prepared.device.rawToken,
      deviceTokenCreated: prepared.device.createdToken,
      accountCreated: false
    };
  }

  async authenticateSession(rawToken: string | null): Promise<AuthenticatedSession | null> {
    if (!rawToken || !isSecureToken(rawToken)) {
      return null;
    }
    const tokenHash = this.sessionTokenHash(rawToken);
    const session = await this.store.findSessionByTokenHash(tokenHash);
    if (!session) {
      return null;
    }
    this.requireActiveAccount(session.account);
    if (
      session.revokedAt ||
      session.sessionAccountVersion !== session.accountSessionVersion
    ) {
      return null;
    }
    const now = this.now();
    if (session.expiresAt.getTime() <= now.getTime()) {
      await this.store.revokeSessionByTokenHash(tokenHash, "absolute_expiration", now);
      await this.recordEvent({
        accountId: session.account.id,
        deviceInstallationId: session.deviceInstallationId,
        eventType: "session_expired",
        metadata: { reason: "absolute" }
      });
      return null;
    }
    const inactivityMs = this.config.AUTH_SESSION_INACTIVITY_DAYS * 24 * 60 * 60_000;
    if (session.lastSeenAt.getTime() + inactivityMs <= now.getTime()) {
      await this.store.revokeSessionByTokenHash(tokenHash, "inactivity_expiration", now);
      await this.recordEvent({
        accountId: session.account.id,
        deviceInstallationId: session.deviceInstallationId,
        eventType: "session_expired",
        metadata: { reason: "inactivity" }
      });
      return null;
    }
    if (now.getTime() - session.lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
      await this.store.touchSession(session.id, now);
    }
    return {
      sessionId: session.id,
      identityId: session.identityId ?? null,
      identityProvider: session.identityProvider ?? null,
      verifiedGoogleSubject: session.verifiedGoogleSubject ?? null,
      verifiedEmail: session.verifiedEmail,
      account: session.account,
      player: session.player,
      deviceInstallationId: session.deviceInstallationId,
      csrfToken: csrfTokenForSession(rawToken, this.config.AUTH_SESSION_TOKEN_HMAC_KEY)
    };
  }

  async sessionResponse(
    session: AuthenticatedSession | null,
    options: Readonly<{ nativeClient?: boolean }> = {}
  ): Promise<AuthSessionResponse> {
    if (!session) {
      return {
        authenticated: false,
        requiredClientContractVersion: AUTH_SERVER_REQUIRED_CLIENT_CONTRACT_VERSION,
        csrfToken: "",
        developmentAuthEnabled: this.developmentAuthEnabled,
        appleSignInEnabled: this.config.APPLE_SIGN_IN_ENABLED,
        emailSignInEnabled: this.emailSignInEnabled,
        developerCapabilities: [],
        ...(await this.publicTestAccessModeField())
      };
    }
    const linkedProviders = this.store.listActiveIdentityProviders
      ? await this.store.listActiveIdentityProviders(session.account.id)
      : undefined;
    return {
      authenticated: true,
      requiredClientContractVersion: AUTH_SERVER_REQUIRED_CLIENT_CONTRACT_VERSION,
      csrfToken: session.csrfToken,
      developmentAuthEnabled: this.developmentAuthEnabled,
      appleSignInEnabled: this.config.APPLE_SIGN_IN_ENABLED,
      emailSignInEnabled: this.emailSignInEnabled,
      ...(linkedProviders ? { linkedProviders } : {}),
      developerCapabilities: this.developerCapabilities(session),
      trustPassiveFixEnabled: this.config.TRUST_PASSIVE_FIX_ENABLED,
      trustPassiveFixMinSeconds: this.config.TRUST_PASSIVE_FIX_MIN_SECONDS,
      trustPassiveFixMaxSeconds: this.config.TRUST_PASSIVE_FIX_MAX_SECONDS,
      trustNativeSignalsAccepted: true,
      trustActionFixes: await this.trustActionFixes(session.account.id, options.nativeClient === true),
      ...this.trustAttestationField(options.nativeClient === true),
      // Web while phone-only relocation is enforced: the client shows the phone-app state.
      ...(this.config.TRUST_RELOCATION_NATIVE_ONLY_MODE === "enforce" && options.nativeClient !== true
        ? { trustRelocationPhoneOnly: true }
        : {}),
      testAccessStatus: session.account.testAccessStatus,
      ...(await this.testAccessSessionFields(session)),
      verifiedEmail: session.verifiedEmail,
      account: {
        id: session.account.id,
        status: session.account.status === "suspended" ? "suspended" : "active",
        trustTier: session.account.trustTier
      },
      ...(session.player
        ? {
            player: {
              id: session.player.id,
              displayName: session.player.displayName,
              personalFlagColor: session.player.personalFlagColor
            },
            onboardingRequired: false
          }
        : {
            onboardingRequired: true
          })
    };
  }

  /**
   * Signed-out clients show the update sign-up panel instead of sign-in while the server is in
   * dev access mode. Only the mode is exposed; a failed read omits it so sign-in still works.
   */
  private async publicTestAccessModeField(): Promise<{ testAccessMode?: TestAccessMode }> {
    try {
      return { testAccessMode: await this.accessMode.getAccessMode() };
    } catch (error) {
      this.logger.warn({ err: error }, "test access mode could not be read for the session response");
      return {};
    }
  }

  developerCapabilities(
    session: AuthenticatedSession | null
  ): DeveloperCapability[] {
    return developerCapabilitiesForSession(this.config, session);
  }

  hasDeveloperCapability(
    session: AuthenticatedSession | null,
    capability: DeveloperCapability
  ): boolean {
    return hasDeveloperCapability(this.config, session, capability);
  }

  async requireApprovedTestAccess(session: AuthenticatedSession): Promise<void> {
    this.requireActiveAccount(session.account);
    const decision = await this.testAccessDecision(session);
    if (decision.allowed) return;
    if (decision.devOnly) {
      await this.recordDevAccessRequest(session);
      throw new AuthError(
        "TEST_ACCESS_DEV_ONLY",
        "Only developer accounts can enter Ash Atlas",
        403
      );
    }
    switch (session.account.testAccessStatus) {
      case "approved":
        throw new Error("approved test-access account was unexpectedly rejected");
      case "pending":
        throw new AuthError("TEST_ACCESS_PENDING", "Test access is pending", 403);
      case "denied":
        throw new AuthError("TEST_ACCESS_DENIED", "Test access was not approved", 403);
      case "revoked":
        throw new AuthError("TEST_ACCESS_REVOKED", "Test access was removed", 403);
    }
  }

  async requireGameplayReady(session: AuthenticatedSession): Promise<void> {
    await this.requireApprovedTestAccess(session);
    if (!session.player || !session.player.onboardingCompletedAt) {
      throw new AuthError("ACCOUNT_UNAVAILABLE", "Player onboarding is required", 409);
    }
  }

  private async testAccessSessionFields(
    session: AuthenticatedSession
  ): Promise<{ testAccessAllowed: boolean; testAccessDevOnly?: true }> {
    const decision = await this.testAccessDecision(session);
    if (decision.devOnly) {
      await this.recordDevAccessRequest(session);
      return { testAccessAllowed: false, testAccessDevOnly: true };
    }
    return { testAccessAllowed: decision.allowed };
  }

  /**
   * open: approved, or pending; closed: approved only; dev: developer/admin
   * Google subjects, or approved accounts the admin placed on the dev list.
   * Denied and revoked accounts keep their own block reason in every mode.
   */
  private async testAccessDecision(
    session: AuthenticatedSession
  ): Promise<{ allowed: boolean; devOnly: boolean }> {
    const account = session.account;
    const mode = await this.accessMode.getAccessMode();
    if (mode === "dev") {
      if (isDeveloperAccessSession(this.config, session)) {
        return { allowed: true, devOnly: false };
      }
      if (account.testAccessStatus === "denied" || account.testAccessStatus === "revoked") {
        return { allowed: false, devOnly: false };
      }
      const allowed = account.testAccessStatus === "approved" &&
        (await this.accessMode.hasDevAccess?.(account.id)) === true;
      return { allowed, devOnly: !allowed };
    }
    if (account.testAccessStatus === "approved") return { allowed: true, devOnly: false };
    if (account.testAccessStatus === "denied" || account.testAccessStatus === "revoked") {
      return { allowed: false, devOnly: false };
    }
    return { allowed: mode === "open", devOnly: false };
  }

  private async recordDevAccessRequest(session: AuthenticatedSession): Promise<void> {
    if (session.account.testAccessStatus !== "approved") return;
    try {
      await this.accessMode.recordDevAccessRequest?.(session.account.id);
    } catch (error) {
      this.logger.warn(
        { err: error, accountId: session.account.id },
        "dev access request could not be recorded"
      );
    }
  }

  async authorizeDeveloperCommand(
    session: AuthenticatedSession | null,
    input: Omit<DeveloperCommandAudit, "outcome">
  ): Promise<void> {
    const allowed = this.hasDeveloperCapability(session, input.capability);
    const audit: DeveloperCommandAudit = {
      ...input,
      outcome: allowed ? "authorized" : "rejected",
      ...(!allowed ? { reason: "capability_denied" } : {})
    };
    try {
      await this.recordEvent({
        accountId: session?.account.id ?? null,
        deviceInstallationId: session?.deviceInstallationId ?? null,
        eventType: "developer_command_authorization",
        metadata: developerAuditMetadata(this.config, audit)
      });
    } catch (error) {
      if (allowed) throw error;
      this.logger.warn(
        { command: input.command, capability: input.capability },
        "rejected developer command audit could not be recorded"
      );
    }
    if (!allowed) throw new DeveloperAuthorizationError();
  }

  async recordDeveloperCommandResult(
    session: AuthenticatedSession,
    input: Omit<DeveloperCommandAudit, "outcome"> & {
      outcome: "succeeded" | "failed";
    }
  ): Promise<void> {
    await this.recordEventBestEffort({
      accountId: session.account.id,
      deviceInstallationId: session.deviceInstallationId,
      eventType: "developer_command_result",
      metadata: developerAuditMetadata(this.config, input)
    });
  }

  async logout(rawToken: string, session: AuthenticatedSession): Promise<void> {
    await this.store.revokeSessionByTokenHash(this.sessionTokenHash(rawToken), "logout", this.now());
    await this.recordEventBestEffort({
      accountId: session.account.id,
      deviceInstallationId: session.deviceInstallationId,
      eventType: "logout"
    });
  }

  async logoutAll(session: AuthenticatedSession): Promise<void> {
    await this.store.revokeAllSessions(session.account.id, "logout_all", this.now());
    await this.recordEventBestEffort({
      accountId: session.account.id,
      deviceInstallationId: session.deviceInstallationId,
      eventType: "session_revoked",
      metadata: { scope: "all" }
    });
  }

  assertOrigin(origin: string | undefined, trustedNativeClient = false): void {
    if (
      isCapacitorNativeOrigin(origin) ||
      (origin !== undefined && this.config.AUTH_ALLOWED_ORIGINS.includes(origin)) ||
      (origin === undefined && trustedNativeClient)
    ) {
      return;
    }
    throw new AuthError("ORIGIN_FORBIDDEN", "Request origin is not allowed", 403);
  }

  assertCsrf(session: AuthenticatedSession, supplied: string | undefined): void {
    if (!csrfTokensMatch(session.csrfToken, supplied)) {
      throw new AuthError("CSRF_INVALID", "Invalid CSRF token", 403);
    }
  }

  async recordConnectionEvent(
    session: AuthenticatedSession,
    eventType: "game_connection_opened" | "game_connection_closed" | "game_connection_replaced"
  ): Promise<void> {
    await this.recordEvent({
      accountId: session.account.id,
      deviceInstallationId: session.deviceInstallationId,
      eventType
    });
  }

  async cleanupExpiredData(now = this.now()): Promise<{
    sessionsDeleted: number;
    authEventsDeleted: number;
    credentialUsesDeleted: number;
    emailLoginCodesDeleted?: number;
  }> {
    return this.store.cleanup({
      sessionExpiry: new Date(now.getTime() - 90 * 24 * 60 * 60_000),
      telemetryCreatedAt: new Date(now.getTime() - 90 * 24 * 60 * 60_000),
      credentialExpiry: now,
      emailLoginCodeExpiry: new Date(now.getTime() - 7 * 24 * 60 * 60_000)
    });
  }

  /**
   * Issues a sign-in code. The response is identical for new and existing
   * addresses; only syntax/domain and throttling are observable.
   */
  async startEmailLogin(
    email: string,
    context: LoginRequestContext
  ): Promise<{ resendAvailableAt: Date }> {
    const store = this.requireEmailStore();
    const address = this.requireAllowedEmail(email);
    const prepared = await this.prepareLoginContext(context);
    return this.issueEmailCode(store, {
      ...address,
      purpose: "signin",
      deviceInstallationId: prepared.device.id,
      network: prepared.network
    });
  }

  async verifyEmailLogin(
    input: { email: string; code: string },
    context: LoginRequestContext
  ): Promise<LoginResult> {
    const store = this.requireEmailStore();
    const prepared = await this.prepareLoginContext(context);
    await this.enforceLoginLimits(prepared.device.id, prepared.network);
    let identity: VerifiedEmailIdentity;
    try {
      const address = this.requireAllowedEmail(input.email);
      await this.consumeEmailCode(store, address.emailCanonical, "signin", input.code, null);
      identity = {
        provider: "email",
        subject: address.emailCanonical,
        email: address.deliverTo,
        emailVerified: true,
        authTime: this.now()
      };
    } catch (error) {
      // Only verdicts are failures; storage errors propagate as 503, never as "invalid code".
      if (!(error instanceof AuthError)) throw error;
      await this.recordEvent({
        deviceInstallationId: prepared.device.id,
        eventType: "email_login_failure",
        networkHash: prepared.network.networkHash,
        networkPrefixHash: prepared.network.networkPrefixHash,
        networkKeyVersion: prepared.network.keyVersion,
        metadata: { code: error.code }
      });
      throw error;
    }

    const existing = await store.findAccountByEmailIdentity(identity.subject);
    if (!existing) {
      await this.enforceNewAccountLimits(prepared.device.id, prepared.network, {
        deviceMax: this.config.AUTH_NEW_ACCOUNT_EMAIL_DEVICE_MAX,
        networkMax: this.config.AUTH_NEW_ACCOUNT_EMAIL_NETWORK_MAX
      });
    }
    let identityResult;
    try {
      identityResult = await store.createOrLoadEmailAccount(identity);
    } catch (error) {
      if (objectCode(error) === "ACCOUNT_LINK_REQUIRED") {
        throw new AuthError(
          "ACCOUNT_LINK_REQUIRED",
          "This email already belongs to an account. Sign in with Google or Apple, then link email from Account settings.",
          409
        );
      }
      if (objectCode(error) === "ACCOUNT_UNAVAILABLE") {
        throw new AuthError("ACCOUNT_UNAVAILABLE", "Account unavailable", 403);
      }
      throw error;
    }
    this.requireActiveAccount(identityResult.account);
    const now = this.now();
    const link = await this.store.linkAccountDevice(identityResult.account.id, prepared.device.id, now);
    if (identityResult.created) {
      await this.recordEvent({
        accountId: identityResult.account.id,
        deviceInstallationId: prepared.device.id,
        eventType: "account_created",
        networkHash: prepared.network.networkHash,
        networkPrefixHash: prepared.network.networkPrefixHash,
        networkKeyVersion: prepared.network.keyVersion,
        metadata: { provider: "email" }
      });
    }
    await this.store.updateLastLogin(identityResult.account.id, now);
    await this.recordEvent({
      accountId: identityResult.account.id,
      deviceInstallationId: prepared.device.id,
      eventType: "email_login_success",
      networkHash: prepared.network.networkHash,
      networkPrefixHash: prepared.network.networkPrefixHash,
      networkKeyVersion: prepared.network.keyVersion,
      metadata: { mode: "email" }
    });
    await this.recordDeviceRisk(identityResult.account.id, prepared.device.id, link);
    await this.runLoginTrustHook(identityResult.account.id);
    if (identityResult.created) {
      await this.recordNetworkCreationRisk(
        identityResult.account.id,
        prepared.device.id,
        prepared.network.networkPrefixHash
      );
    }
    if (context.existingSessionToken) {
      await this.store.revokeSessionByTokenHash(
        this.sessionTokenHash(context.existingSessionToken),
        "login_rotation",
        now
      );
    }
    const player = await this.store.findPlayerByAccountId(identityResult.account.id);
    const session = await this.issueSession(
      identityResult.account,
      player,
      prepared.device.id,
      now,
      null,
      identity.email,
      identityResult.identityId ?? null,
      "email"
    );
    return {
      session,
      deviceToken: prepared.device.rawToken,
      deviceTokenCreated: prepared.device.createdToken,
      accountCreated: identityResult.created,
      identityId: identityResult.identityId ?? null
    };
  }

  async startEmailLink(
    session: AuthenticatedSession,
    email: string,
    context: LoginRequestContext
  ): Promise<{ resendAvailableAt: Date }> {
    const store = this.requireEmailStore();
    this.requireActiveAccount(session.account);
    const address = this.requireAllowedEmail(email);
    const prepared = await this.prepareLoginContext(context);
    return this.issueEmailCode(store, {
      ...address,
      purpose: "link",
      accountId: session.account.id,
      sessionId: session.sessionId,
      deviceInstallationId: prepared.device.id,
      network: prepared.network
    });
  }

  async verifyEmailLink(
    session: AuthenticatedSession,
    input: { email: string; code: string },
    context: LoginRequestContext
  ): Promise<void> {
    const store = this.requireEmailStore();
    this.requireActiveAccount(session.account);
    const prepared = await this.prepareLoginContext(context);
    await this.enforceLoginLimits(prepared.device.id, prepared.network);
    const address = this.requireAllowedEmail(input.email);
    await this.consumeEmailCode(store, address.emailCanonical, "link", input.code, session.account.id);
    try {
      await store.linkEmailIdentity({
        accountId: session.account.id,
        sessionId: session.sessionId,
        identity: {
          provider: "email",
          subject: address.emailCanonical,
          email: address.deliverTo,
          emailVerified: true,
          authTime: this.now()
        },
        now: this.now()
      });
    } catch (error) {
      throw this.linkError(error, "That email is already linked to another account.");
    }
    await this.recordEvent({
      accountId: session.account.id,
      deviceInstallationId: prepared.device.id,
      eventType: "identity_linked",
      metadata: { provider: "email" }
    });
  }

  /** Links Google to the signed-in account; the Google email must already be verified there. */
  async linkGoogleIdentity(
    session: AuthenticatedSession,
    credential: string,
    context: LoginRequestContext
  ): Promise<void> {
    if (this.config.AUTH_MODE !== "google" || !this.store.linkGoogleIdentity) {
      throw new AuthError("ACCOUNT_UNAVAILABLE", "Google linking is not enabled", 404);
    }
    this.requireActiveAccount(session.account);
    const prepared = await this.prepareLoginContext(context);
    await this.enforceLoginLimits(prepared.device.id, prepared.network);
    let identity: VerifiedGoogleIdentity;
    try {
      identity = await this.googleVerifier.verifyCredential(credential);
      this.requireAllowedIdentity(identity);
      const consumed = await this.store.consumeGoogleCredential({
        credentialHash: hashAuthToken(
          credential,
          this.config.AUTH_SESSION_TOKEN_HMAC_KEY,
          "google-credential"
        ),
        deviceInstallationId: prepared.device.id,
        now: this.now(),
        expiresAt: identity.expiresAt
      });
      if (!consumed) {
        throw new AuthError("INVALID_GOOGLE_LOGIN", "Invalid Google login", 401);
      }
    } catch (error) {
      throw error instanceof AuthError
        ? error
        : new AuthError("INVALID_GOOGLE_LOGIN", "Invalid Google login", 401);
    }
    try {
      await this.store.linkGoogleIdentity({
        accountId: session.account.id,
        identity,
        now: this.now()
      });
    } catch (error) {
      throw this.linkError(
        error,
        "That Google account cannot be linked. Its email must match this account and must not belong to another account."
      );
    }
    await this.recordEvent({
      accountId: session.account.id,
      deviceInstallationId: prepared.device.id,
      eventType: "identity_linked",
      metadata: { provider: "google" }
    });
  }

  private requireEmailStore(): EmailLoginStore {
    if (!this.emailSignInEnabled) {
      throw new AuthError("ACCOUNT_UNAVAILABLE", "Email sign-in is not enabled", 404);
    }
    return this.store as AuthStore & EmailLoginStore;
  }

  /**
   * deliverTo is the address as typed (trimmed, lowercased): codes are sent
   * there and it is displayed. emailCanonical (aliases collapsed) keys the
   * identity, code lookup, per-email limits, and cross-provider checks.
   */
  private requireAllowedEmail(email: string): { deliverTo: string; emailCanonical: string } {
    const normalized = normalizeEmailAddress(email);
    const emailCanonical = normalized ? canonicalEmail(normalized) : "";
    if (!normalized || emailCanonical.startsWith("@")) {
      throw new AuthError("EMAIL_INVALID", "Enter a valid email address", 400);
    }
    if (!isEmailDomainAllowed(normalized, {
      mode: this.config.AUTH_EMAIL_DOMAIN_POLICY,
      allowlist: this.config.AUTH_EMAIL_DOMAIN_ALLOWLIST,
      blocklistExtra: this.config.AUTH_EMAIL_DOMAIN_BLOCKLIST_EXTRA
    })) {
      throw new AuthError(
        "EMAIL_DOMAIN_NOT_ALLOWED",
        this.config.AUTH_EMAIL_DOMAIN_POLICY === "allowlist"
          ? "Email sign-in supports Gmail, Outlook/Hotmail, Yahoo, iCloud, AOL and GMX. You can also continue with Google or Apple."
          : "That email provider is not supported. Use a different address.",
        400
      );
    }
    return { deliverTo: normalized, emailCanonical };
  }

  private async issueEmailCode(
    store: EmailLoginStore,
    input: {
      deliverTo: string;
      emailCanonical: string;
      purpose: EmailLoginCodePurpose;
      accountId?: string;
      sessionId?: string;
      deviceInstallationId: string;
      network: NetworkTelemetry;
    }
  ): Promise<{ resendAvailableAt: Date }> {
    const now = this.now();
    const reservation = await store.reserveEmailCodeRequest({
      deviceInstallationId: input.deviceInstallationId,
      networkHash: input.network.networkHash,
      networkPrefixHash: input.network.networkPrefixHash,
      networkKeyVersion: input.network.keyVersion,
      since: new Date(now.getTime() - LOGIN_WINDOW_MS),
      now,
      deviceMax: this.config.AUTH_LOGIN_DEVICE_MAX,
      networkMax: this.config.AUTH_LOGIN_IP_MAX
    });
    if (!reservation.allowed) {
      throw new AuthError("TOO_MANY_LOGIN_ATTEMPTS", "Too many sign-in attempts", 429);
    }
    const code = generateEmailLoginCode();
    const codeId = crypto.randomUUID();
    const created = await store.createEmailLoginCode({
      id: codeId,
      emailNormalized: input.emailCanonical,
      codeHash: hashEmailLoginCode(
        this.config.AUTH_EMAIL_CODE_HMAC_KEY,
        input.emailCanonical,
        code
      ),
      purpose: input.purpose,
      accountId: input.accountId ?? null,
      sessionId: input.sessionId ?? null,
      deviceInstallationId: input.deviceInstallationId,
      networkHash: input.network.networkHash,
      now,
      expiresAt: new Date(now.getTime() + this.config.AUTH_EMAIL_CODE_TTL_SECONDS * 1_000),
      limits: {
        resendAfterSeconds: this.config.AUTH_EMAIL_CODE_RESEND_SECONDS,
        perTenMinutes: this.config.AUTH_EMAIL_CODE_PER_EMAIL_10MIN,
        perDay: this.config.AUTH_EMAIL_CODE_PER_EMAIL_DAY
      }
    });
    if (created.status === "throttled") {
      throw new AuthError(
        "TOO_MANY_EMAIL_CODE_REQUESTS",
        "Too many codes requested for this email. Try again later.",
        429
      );
    }
    // The code row is committed before delivery; a failed send is recorded and
    // the caller still sees the same success body (no delivery oracle).
    const sender = this.emailSender!;
    try {
      const sent = await sender.send({
        to: input.deliverTo,
        category: "login_code",
        ...loginCodeEmail(code, Math.round(this.config.AUTH_EMAIL_CODE_TTL_SECONDS / 60)),
        diagnostics: { codeId, code }
      });
      await store.markEmailLoginCodeSent(codeId, {
        status: sent.provider === "log" ? "logged" : "sent",
        provider: sent.provider,
        messageId: sent.messageId
      });
    } catch (error) {
      this.logger.warn({ codeId, provider: sender.provider }, "email sign-in code delivery failed");
      await store.markEmailLoginCodeSent(codeId, {
        status: "failed",
        provider: sender.provider,
        error: error instanceof Error ? error.message : "delivery failed"
      }).catch(() => undefined);
    }
    return {
      resendAvailableAt: new Date(now.getTime() + this.config.AUTH_EMAIL_CODE_RESEND_SECONDS * 1_000)
    };
  }

  private async consumeEmailCode(
    store: EmailLoginStore,
    emailCanonical: string,
    purpose: EmailLoginCodePurpose,
    rawCode: string,
    accountId: string | null
  ): Promise<void> {
    const code = normalizeEmailLoginCode(rawCode);
    const result = code
      ? await store.consumeEmailLoginCode({
          emailNormalized: emailCanonical,
          purpose,
          codeHash: hashEmailLoginCode(this.config.AUTH_EMAIL_CODE_HMAC_KEY, emailCanonical, code),
          accountId,
          now: this.now()
        })
      : "invalid";
    if (result !== "consumed") {
      throw new AuthError("EMAIL_CODE_INVALID", "That code is invalid or has expired", 401);
    }
  }

  private linkError(error: unknown, conflictMessage: string): unknown {
    const code = objectCode(error);
    if (code === "ACCOUNT_LINK_CONFLICT") {
      return new AuthError("ACCOUNT_LINK_CONFLICT", conflictMessage, 409);
    }
    if (code === "AUTHENTICATION_REQUIRED") {
      return new AuthError("AUTHENTICATION_REQUIRED", "Authentication required", 401);
    }
    if (code === "ACCOUNT_UNAVAILABLE") {
      return new AuthError("ACCOUNT_UNAVAILABLE", "Account unavailable", 403);
    }
    return error;
  }

  /**
   * Completes a server-verified Apple login.  The Apple verifier and state
   * transaction live in appleAuth.ts; this method deliberately accepts only
   * the already verified claim set and keeps the existing account/device/risk
   * lifecycle in one place.
   */
  async loginWithAppleIdentity(
    identity: VerifiedAppleIdentity,
    context: LoginRequestContext
  ): Promise<LoginResult> {
    if (!this.config.APPLE_SIGN_IN_ENABLED || !this.store.createOrLoadAppleAccount) {
      throw new AuthError("ACCOUNT_UNAVAILABLE", "Apple login is not enabled", 404);
    }
    if (
      !identity.subject ||
      !Number.isFinite(identity.expiresAt.getTime()) ||
      identity.expiresAt.getTime() <= this.now().getTime()
    ) {
      throw new AuthError("INVALID_APPLE_LOGIN", "Invalid Apple login", 401);
    }
    const prepared = await this.prepareLoginContext(context);
    await this.enforceLoginLimits(prepared.device.id, prepared.network);
    const existing = this.store.findAccountByAppleSubject
      ? await this.store.findAccountByAppleSubject(identity.subject)
      : null;
    if (!existing) {
      await this.enforceNewAccountLimits(prepared.device.id, prepared.network);
    }
    let identityResult;
    try {
      identityResult = await this.store.createOrLoadAppleAccount(identity);
    } catch (error) {
      const code = objectCode(error);
      if (code === "ACCOUNT_LINK_REQUIRED" || code === "APPLE_IDENTITY_REVOKED") {
        throw new AuthError(code, code === "ACCOUNT_LINK_REQUIRED"
          ? "Sign in with Google first, then link Apple from Account settings."
          : "This Apple identity has been revoked.", code === "ACCOUNT_LINK_REQUIRED" ? 409 : 403);
      }
      throw error;
    }
    this.requireActiveAccount(identityResult.account);
    const now = this.now();
    const link = await this.store.linkAccountDevice(identityResult.account.id, prepared.device.id, now);
    if (identityResult.created) {
      await this.recordEvent({
        accountId: identityResult.account.id,
        deviceInstallationId: prepared.device.id,
        eventType: "account_created",
        networkHash: prepared.network.networkHash,
        networkPrefixHash: prepared.network.networkPrefixHash,
        networkKeyVersion: prepared.network.keyVersion,
        metadata: { provider: "apple" }
      });
      await this.recordNetworkCreationRisk(
        identityResult.account.id,
        prepared.device.id,
        prepared.network.networkPrefixHash
      );
    }
    await this.store.updateLastLogin(identityResult.account.id, now);
    await this.recordEvent({
      accountId: identityResult.account.id,
      deviceInstallationId: prepared.device.id,
      eventType: "apple_login_success",
      networkHash: prepared.network.networkHash,
      networkPrefixHash: prepared.network.networkPrefixHash,
      networkKeyVersion: prepared.network.keyVersion,
      metadata: { mode: "apple" }
    });
    await this.recordDeviceRisk(identityResult.account.id, prepared.device.id, link);
    await this.runLoginTrustHook(identityResult.account.id);
    if (context.existingSessionToken) {
      await this.store.revokeSessionByTokenHash(
        this.sessionTokenHash(context.existingSessionToken),
        "login_rotation",
        now
      );
    }
    const player = await this.store.findPlayerByAccountId(identityResult.account.id);
    const session = await this.issueSession(
      identityResult.account,
      player,
      prepared.device.id,
      now,
      null,
      identity.email ?? "",
      identityResult.identityId ?? null,
      "apple"
    );
    return {
      session,
      deviceToken: prepared.device.rawToken,
      deviceTokenCreated: prepared.device.createdToken,
      accountCreated: identityResult.created,
      identityId: identityResult.identityId ?? null
    };
  }

  async linkAppleIdentity(input: {
    session: AuthenticatedSession;
    identity: VerifiedAppleIdentity;
  }): Promise<void> {
    if (!this.config.APPLE_SIGN_IN_ENABLED || !this.store.linkAppleIdentity) {
      throw new AuthError("ACCOUNT_UNAVAILABLE", "Apple linking is not enabled", 404);
    }
    this.requireActiveAccount(input.session.account);
    try {
      await this.store.linkAppleIdentity({
        accountId: input.session.account.id,
        sessionId: input.session.sessionId,
        identity: input.identity,
        now: this.now()
      });
    } catch (error) {
      const code = objectCode(error);
      if (code === "ACCOUNT_LINK_CONFLICT" || code === "APPLE_IDENTITY_REVOKED") {
        throw new AuthError(code, code === "ACCOUNT_LINK_CONFLICT"
          ? "That Apple identity is already linked to another account."
          : "This Apple identity has been revoked.", 409);
      }
      throw error;
    }
  }

  async linkAppleIdentityForAccount(input: {
    accountId: string;
    sessionId: string;
    identity: VerifiedAppleIdentity;
  }): Promise<void> {
    if (!this.config.APPLE_SIGN_IN_ENABLED || !this.store.linkAppleIdentity) {
      throw new AuthError("ACCOUNT_UNAVAILABLE", "Apple linking is not enabled", 404);
    }
    try {
      await this.store.linkAppleIdentity({
        accountId: input.accountId,
        sessionId: input.sessionId,
        identity: input.identity,
        now: this.now()
      });
    } catch (error) {
      const code = objectCode(error);
      if (code === "ACCOUNT_LINK_CONFLICT" || code === "APPLE_IDENTITY_REVOKED") {
        throw new AuthError(code, "Apple identity cannot be linked to this account", 409);
      }
      throw error;
    }
  }

  private async completeIdentityLogin(
    identity: VerifiedGoogleIdentity,
    context: LoginRequestContext,
    prepared: Awaited<ReturnType<AuthService["prepareLoginContext"]>>
  ): Promise<LoginResult> {
    this.requireAllowedIdentity(identity);
    const existing = await this.store.findAccountByGoogleSubject(identity.subject);
    if (!existing) {
      await this.enforceNewAccountLimits(
        prepared.device.id,
        prepared.network
      );
    }
    let identityResult;
    try {
      identityResult = await this.store.createOrLoadGoogleAccount(identity);
    } catch (error) {
      if (objectCode(error) === "ACCOUNT_LINK_REQUIRED") {
        throw new AuthError(
          "ACCOUNT_LINK_REQUIRED",
          "This email already uses email sign-in. Sign in with email, then link Google from Account settings.",
          409
        );
      }
      throw error;
    }
    this.requireActiveAccount(identityResult.account);
    const now = this.now();
    const link = await this.store.linkAccountDevice(
      identityResult.account.id,
      prepared.device.id,
      now
    );
    if (identityResult.created) {
      await this.recordEvent({
        accountId: identityResult.account.id,
        deviceInstallationId: prepared.device.id,
        eventType: "account_created",
        networkHash: prepared.network.networkHash,
        networkPrefixHash: prepared.network.networkPrefixHash,
        networkKeyVersion: prepared.network.keyVersion,
        metadata: { provider: identity.authMethods?.includes("dev") ? "development" : "google" }
      });
    }
    await this.store.updateLastLogin(identityResult.account.id, now);
    await this.recordEvent({
      accountId: identityResult.account.id,
      deviceInstallationId: prepared.device.id,
      eventType: "google_login_success",
      networkHash: prepared.network.networkHash,
      networkPrefixHash: prepared.network.networkPrefixHash,
      networkKeyVersion: prepared.network.keyVersion,
      metadata: { mode: identity.authMethods?.includes("dev") ? "dev" : "google" }
    });
    await this.recordDeviceRisk(identityResult.account.id, prepared.device.id, link);
    await this.runLoginTrustHook(identityResult.account.id);
    if (identityResult.created) {
      await this.recordNetworkCreationRisk(
        identityResult.account.id,
        prepared.device.id,
        prepared.network.networkPrefixHash
      );
    }
    if (context.existingSessionToken) {
      await this.store.revokeSessionByTokenHash(
        this.sessionTokenHash(context.existingSessionToken),
        "login_rotation",
        now
      );
    }
    const player = await this.store.findPlayerByAccountId(identityResult.account.id);
    const session = await this.issueSession(
      identityResult.account,
      player,
      prepared.device.id,
      now,
      identity.subject,
      identity.email,
      identityResult.identityId ?? null,
      "google"
    );
    return {
      session,
      deviceToken: prepared.device.rawToken,
      deviceTokenCreated: prepared.device.createdToken,
      accountCreated: identityResult.created,
      identityId: identityResult.identityId ?? null
    };
  }

  private async prepareLoginContext(context: LoginRequestContext) {
    const suppliedToken = context.deviceToken;
    const rawToken = suppliedToken && isSecureToken(suppliedToken)
      ? suppliedToken
      : generateSecureToken();
    const profile = broadClientProfile(context.userAgent);
    const device = await this.store.ensureDevice({
      tokenHash: hashAuthToken(rawToken, this.config.AUTH_DEVICE_TOKEN_HMAC_KEY, "device"),
      browserFamily: profile.browserFamily,
      osFamily: profile.osFamily,
      now: this.now()
    });
    const network = this.networkHasher.derive(context.ip);
    if (device.created) {
      await this.recordEvent({
        deviceInstallationId: device.id,
        eventType: "new_device",
        networkHash: network.networkHash,
        networkPrefixHash: network.networkPrefixHash,
        networkKeyVersion: network.keyVersion,
        metadata: profile
      });
    }
    return {
      device: {
        id: device.id,
        rawToken,
        createdToken: rawToken !== suppliedToken
      },
      network
    };
  }

  private async issueSession(
    account: AuthAccountRecord,
    player: AuthPlayerRecord | null,
    deviceInstallationId: string,
    now: Date,
    verifiedGoogleSubject: string | null,
    verifiedEmail: string,
    identityId: string | null = null,
    identityProvider: AuthIdentityProvider = "google"
  ): Promise<IssuedAuthSession> {
    const rawToken = generateSecureToken();
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(
      now.getTime() + this.config.AUTH_SESSION_ABSOLUTE_DAYS * 24 * 60 * 60_000
    );
    try {
      await this.store.createSession({
        id: sessionId,
        accountId: account.id,
        identityId,
        tokenHash: this.sessionTokenHash(rawToken),
        deviceInstallationId,
        createdAt: now,
        expiresAt
      });
    } catch (error) {
      if (objectCode(error) === "ACCOUNT_UNAVAILABLE") {
        throw new AuthError("ACCOUNT_UNAVAILABLE", "Account unavailable", 403);
      }
      throw error;
    }
    return {
      sessionId,
      identityId,
      identityProvider,
      verifiedGoogleSubject,
      verifiedEmail,
      account,
      player,
      deviceInstallationId,
      rawToken,
      expiresAt,
      csrfToken: csrfTokenForSession(rawToken, this.config.AUTH_SESSION_TOKEN_HMAC_KEY)
    };
  }

  private async enforceLoginLimits(
    deviceId: string,
    network: NetworkTelemetry
  ): Promise<void> {
    const since = new Date(this.now().getTime() - LOGIN_WINDOW_MS);
    const reservation = await this.store.reserveLoginAttempt({
      deviceInstallationId: deviceId,
      networkHash: network.networkHash,
      networkPrefixHash: network.networkPrefixHash,
      networkKeyVersion: network.keyVersion,
      since,
      now: this.now(),
      deviceMax: this.config.AUTH_LOGIN_DEVICE_MAX,
      networkMax: this.config.AUTH_LOGIN_IP_MAX
    });
    if (!reservation.allowed) {
      throw new AuthError("TOO_MANY_LOGIN_ATTEMPTS", "Too many login attempts", 429);
    }
  }

  private async enforceNewAccountLimits(
    deviceInstallationId: string,
    network: NetworkTelemetry,
    limits: { deviceMax: number; networkMax: number } = {
      deviceMax: this.config.AUTH_NEW_ACCOUNT_DEVICE_MAX,
      networkMax: this.config.AUTH_NEW_ACCOUNT_NETWORK_MAX
    }
  ): Promise<void> {
    const since = new Date(this.now().getTime() - NEW_ACCOUNT_WINDOW_MS);
    const reservation = await this.store.reserveAccountCreationAttempt({
      deviceInstallationId,
      networkHash: network.networkHash,
      networkPrefixHash: network.networkPrefixHash,
      networkKeyVersion: network.keyVersion,
      since,
      now: this.now(),
      deviceMax: limits.deviceMax,
      networkMax: limits.networkMax
    });
    if (!reservation.allowed) {
      await this.recordEvent({
        deviceInstallationId,
        eventType: "account_creation_rate_limited",
        networkPrefixHash: network.networkPrefixHash,
        networkKeyVersion: network.keyVersion,
        metadata: {
          deviceLimitReached:
            reservation.deviceCount >= limits.deviceMax
        }
      });
      throw new AuthError(
        "TOO_MANY_ACCOUNT_CREATION_ATTEMPTS",
        "Too many account-creation attempts",
        429
      );
    }
  }

  private requireAllowedIdentity(identity: VerifiedGoogleIdentity): void {
    if (
      !identity.subject ||
      !identity.email ||
      identity.emailVerified !== true ||
      !Number.isFinite(identity.expiresAt.getTime()) ||
      identity.expiresAt.getTime() <= this.now().getTime()
    ) {
      throw new AuthError("INVALID_GOOGLE_LOGIN", "Invalid Google login", 401);
    }
    if (this.config.AUTH_REQUIRE_GMAIL && !isExactGmailAddress(identity.email)) {
      throw new AuthError("VERIFIED_GMAIL_REQUIRED", "Verified Gmail required", 403);
    }
  }

  private requireActiveAccount(account: AuthAccountRecord): void {
    if (account.status === "suspended") {
      throw new AuthError("ACCOUNT_SUSPENDED", "Account suspended", 403);
    }
    if (account.status !== "active") {
      throw new AuthError("ACCOUNT_UNAVAILABLE", "Account unavailable", 403);
    }
  }

  private async recordDeviceRisk(
    accountId: string,
    deviceId: string,
    link: { created: boolean; distinctAccountCount: number }
  ): Promise<void> {
    if (link.created && link.distinctAccountCount >= 2) {
      const weight =
        link.distinctAccountCount === 2
          ? RISK_WEIGHTS.secondAccountSameDevice
          : RISK_WEIGHTS.additionalAccountSameDevice;
      await this.risk.record({
        accountId,
        deviceInstallationId: deviceId,
        eventType: "multiple_accounts_same_device",
        weight,
        dedupeKey: `multiple-accounts:${deviceId}:${accountId}`,
        metadata: { distinctAccountCount: link.distinctAccountCount }
      });
    }
    const recentAccountCount = await this.store.countRecentDistinctAccounts({
      eventTypes: LOGIN_SUCCESS_EVENT_TYPES,
      since: new Date(this.now().getTime() - RAPID_SWITCH_WINDOW_MS),
      deviceInstallationId: deviceId
    });
    if (recentAccountCount >= 3) {
      const bucket = Math.floor(this.now().getTime() / RAPID_SWITCH_WINDOW_MS);
      await this.risk.record({
        accountId,
        deviceInstallationId: deviceId,
        eventType: "rapid_account_switching",
        weight: RISK_WEIGHTS.rapidAccountSwitching,
        dedupeKey: `rapid-switch:${deviceId}:${accountId}:${bucket}`,
        metadata: { distinctAccountCount: recentAccountCount }
      });
    }
  }

  private async recordNetworkCreationRisk(
    accountId: string,
    deviceId: string,
    networkPrefixHash: string
  ): Promise<void> {
    const count = await this.store.countRecentAuthEvents({
      eventTypes: ["account_created"],
      since: new Date(this.now().getTime() - NEW_ACCOUNT_WINDOW_MS),
      networkPrefixHash
    });
    if (count < 3) {
      return;
    }
    const threshold = count >= 5 ? 5 : 3;
    const weight =
      threshold === 5
        ? RISK_WEIGHTS.fiveNewAccountsNetwork
        : RISK_WEIGHTS.threeNewAccountsNetwork;
    const bucket = Math.floor(this.now().getTime() / NEW_ACCOUNT_WINDOW_MS);
    await this.risk.record({
      accountId,
      deviceInstallationId: deviceId,
      eventType: "account_creation_network_burst",
      weight,
      dedupeKey: `network-burst:${networkPrefixHash}:${accountId}:${threshold}:${bucket}`,
      metadata: { accountCount: count, threshold }
    });
  }

  private sessionTokenHash(rawToken: string): string {
    return hashAuthToken(rawToken, this.config.AUTH_SESSION_TOKEN_HMAC_KEY, "session");
  }

  private async recordEvent(input: AuthEventInput): Promise<void> {
    await this.store.insertAuthEvent(input, this.now());
  }

  private async recordEventBestEffort(input: AuthEventInput): Promise<void> {
    try {
      await this.recordEvent(input);
    } catch {
      this.logger.warn(
        { eventType: input.eventType },
        "authentication telemetry event could not be recorded"
      );
    }
  }
}

export function validatePlayerName(value: string): {
  displayName: string;
  normalizedName: string;
} {
  const displayName = value;
  const normalizedName = displayName.toLowerCase();
  if (
    displayName.length < 3 ||
    displayName.length > 20 ||
    !/^[A-Za-z]{3,20}$/.test(displayName) ||
    RESERVED_PLAYER_NAMES.has(normalizedName)
  ) {
    throw new AuthError(
      "PLAYER_NAME_INVALID",
      "Use 3-20 English letters only",
      400
    );
  }
  return { displayName, normalizedName };
}

function objectCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : null;
}
