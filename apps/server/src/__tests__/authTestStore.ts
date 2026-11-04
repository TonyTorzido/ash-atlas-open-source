import type {
  AuthStore,
  RateLimitReservation,
  RecentAuthEventFilter
} from "../auth/authStore.js";
import type {
  AccountDeviceLinkResult,
  AccountIdentityResult,
  AppleAccountIdentityResult,
  AuthAccountRecord,
  AuthEventInput,
  AuthPlayerRecord,
  DeviceInstallationRecord,
  RiskEventInput,
  StoredAuthSession,
  VerifiedGoogleIdentity,
  VerifiedAppleIdentity
} from "../auth/types.js";
import type { TestAccessStatus } from "@ash-atlas/shared";

type StoredEvent = AuthEventInput & { createdAt: Date };

type ReservationInput = {
  deviceInstallationId: string;
  networkHash: string;
  networkPrefixHash: string;
  networkKeyVersion: string;
  since: Date;
  now: Date;
  deviceMax: number;
  networkMax: number;
};

type SessionData = {
  id: string;
  accountId: string;
  tokenHash: string;
  deviceInstallationId: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokeReason: string | null;
  accountSessionVersion: number;
  identityId: string | null;
  identityProvider: "google" | "apple";
};

export class InMemoryAuthStore implements AuthStore {
  readonly accountsBySubject = new Map<string, AuthAccountRecord>();
  readonly accountsByAppleSubject = new Map<string, AuthAccountRecord>();
  readonly subjectByAccountId = new Map<string, string>();
  readonly identityByAccountId = new Map<string, string>();
  readonly emailByAccountId = new Map<string, string>();
  readonly accountsById = new Map<string, AuthAccountRecord>();
  readonly playersByAccount = new Map<string, AuthPlayerRecord>();
  readonly devicesByHash = new Map<string, string>();
  readonly sessionsByHash = new Map<string, SessionData>();
  readonly authEvents: StoredEvent[] = [];
  readonly riskEvents: Array<RiskEventInput & { insertedAt: Date }> = [];
  readonly deviceAccounts = new Map<string, Set<string>>();
  readonly linkedAccountDevices = new Set<string>();
  readonly normalizedPlayerNames = new Map<string, string>();
  readonly credentialUses = new Map<string, Date>();
  readonly accountSessionVersions = new Map<string, number>();
  touchCount = 0;
  findSessionCount = 0;
  newAccountTestAccessStatus: TestAccessStatus = "approved";
  private readonly riskDedupeKeys = new Set<string>();

  async findAccountByGoogleSubject(subject: string): Promise<AuthAccountRecord | null> {
    return this.accountsBySubject.get(subject) ?? null;
  }

  async createOrLoadGoogleAccount(
    identity: VerifiedGoogleIdentity
  ): Promise<AccountIdentityResult> {
    const existing = this.accountsBySubject.get(identity.subject);
    if (existing) {
      this.subjectByAccountId.set(existing.id, identity.subject);
      this.emailByAccountId.set(existing.id, identity.email);
      this.identityByAccountId.set(existing.id, `google:${existing.id}`);
      return { account: existing, created: false };
    }
    const now = new Date();
    const account: AuthAccountRecord = {
      id: crypto.randomUUID(),
      status: "active",
      trustTier: "new",
      riskScore: 0,
      testAccessStatus: this.newAccountTestAccessStatus,
      testAccessRequestedAt: now,
      testAccessDecidedAt: this.newAccountTestAccessStatus === "approved" ? now : null,
      createdAt: now,
      lastLoginAt: null
    };
    this.accountsBySubject.set(identity.subject, account);
    this.subjectByAccountId.set(account.id, identity.subject);
    this.emailByAccountId.set(account.id, identity.email);
    this.identityByAccountId.set(account.id, `google:${account.id}`);
    this.accountsById.set(account.id, account);
    this.accountSessionVersions.set(account.id, 0);
    return { account, created: true };
  }

  async findAccountByAppleSubject(subject: string): Promise<AuthAccountRecord | null> {
    return this.accountsByAppleSubject.get(subject) ?? null;
  }

  async createOrLoadAppleAccount(
    identity: VerifiedAppleIdentity
  ): Promise<AppleAccountIdentityResult> {
    const existing = this.accountsByAppleSubject.get(identity.subject);
    if (existing) {
      this.emailByAccountId.set(existing.id, identity.email ?? this.emailByAccountId.get(existing.id) ?? "");
      return {
        account: existing,
        created: false,
        provider: "apple",
        identityId: `apple:${identity.subject}`
      };
    }
    const normalized = identity.email?.trim().toLowerCase();
    if (normalized && [...this.emailByAccountId.values()].some((value) => value.toLowerCase() === normalized)) {
      throw codedError("ACCOUNT_LINK_REQUIRED");
    }
    const now = new Date();
    const account: AuthAccountRecord = {
      id: crypto.randomUUID(),
      status: "active",
      trustTier: "new",
      riskScore: 0,
      testAccessStatus: this.newAccountTestAccessStatus,
      testAccessRequestedAt: now,
      testAccessDecidedAt: this.newAccountTestAccessStatus === "approved" ? now : null,
      createdAt: now,
      lastLoginAt: null
    };
    const identityId = `apple:${account.id}`;
    this.accountsByAppleSubject.set(identity.subject, account);
    this.emailByAccountId.set(account.id, identity.email ?? "");
    this.identityByAccountId.set(account.id, identityId);
    this.accountsById.set(account.id, account);
    this.accountSessionVersions.set(account.id, 0);
    return { account, created: true, provider: "apple", identityId };
  }

  async linkAppleIdentity(input: {
    accountId: string;
    sessionId: string;
    identity: VerifiedAppleIdentity;
    now: Date;
  }): Promise<{ identityId: string }> {
    const account = this.requireAccount(input.accountId);
    const session = [...this.sessionsByHash.values()].find((candidate) => candidate.id === input.sessionId);
    if (account.status !== "active" || !session || session.accountId !== input.accountId || !!session.revokedAt || session.expiresAt <= input.now) {
      throw codedError("AUTHENTICATION_REQUIRED");
    }
    const existing = this.accountsByAppleSubject.get(input.identity.subject);
    if (existing && existing.id !== input.accountId) throw codedError("ACCOUNT_LINK_CONFLICT");
    const normalized = input.identity.email?.trim().toLowerCase();
    if (normalized && [...this.emailByAccountId.entries()].some(([id, email]) => id !== input.accountId && email.toLowerCase() === normalized)) {
      throw codedError("ACCOUNT_LINK_CONFLICT");
    }
    const identityId = `apple:${input.identity.subject}`;
    this.accountsByAppleSubject.set(input.identity.subject, account);
    if (input.identity.email) this.emailByAccountId.set(input.accountId, input.identity.email);
    return { identityId };
  }

  async updateLastLogin(accountId: string, now: Date): Promise<void> {
    const account = this.requireAccount(accountId);
    account.lastLoginAt = now;
  }

  async findPlayerByAccountId(accountId: string): Promise<AuthPlayerRecord | null> {
    return this.playersByAccount.get(accountId) ?? null;
  }

  async ensureDevice(input: {
    tokenHash: string;
    browserFamily: string;
    osFamily: string;
    now: Date;
  }): Promise<DeviceInstallationRecord> {
    const existing = this.devicesByHash.get(input.tokenHash);
    if (existing) {
      return { id: existing, created: false };
    }
    const id = crypto.randomUUID();
    this.devicesByHash.set(input.tokenHash, id);
    return { id, created: true };
  }

  async linkAccountDevice(
    accountId: string,
    deviceInstallationId: string
  ): Promise<AccountDeviceLinkResult> {
    const accounts = this.deviceAccounts.get(deviceInstallationId) ?? new Set<string>();
    const key = `${accountId}:${deviceInstallationId}`;
    const created = !this.linkedAccountDevices.has(key);
    accounts.add(accountId);
    this.deviceAccounts.set(deviceInstallationId, accounts);
    this.linkedAccountDevices.add(key);
    return { created, distinctAccountCount: accounts.size };
  }

  async countRecentAuthEvents(filter: RecentAuthEventFilter): Promise<number> {
    return this.authEvents.filter((event) => {
      return (
        filter.eventTypes.includes(event.eventType) &&
        event.createdAt >= filter.since &&
        (!filter.deviceInstallationId ||
          event.deviceInstallationId === filter.deviceInstallationId) &&
        (!filter.networkHash || event.networkHash === filter.networkHash) &&
        (!filter.networkPrefixHash ||
          event.networkPrefixHash === filter.networkPrefixHash) &&
        (!filter.accountId || event.accountId === filter.accountId)
      );
    }).length;
  }

  async countRecentDistinctAccounts(input: {
    eventTypes: string[];
    since: Date;
    deviceInstallationId: string;
  }): Promise<number> {
    return new Set(
      this.authEvents
        .filter(
          (event) =>
            input.eventTypes.includes(event.eventType) &&
            event.createdAt >= input.since &&
            event.deviceInstallationId === input.deviceInstallationId &&
            event.accountId
        )
        .map((event) => event.accountId as string)
    ).size;
  }

  async reserveLoginAttempt(input: ReservationInput): Promise<RateLimitReservation> {
    return this.reserveAttempt(input, "google_login_attempt", "networkHash");
  }

  async reserveAccountCreationAttempt(
    input: ReservationInput
  ): Promise<RateLimitReservation> {
    return this.reserveAttempt(input, "account_creation_attempt", "networkPrefixHash");
  }

  async insertAuthEvent(input: AuthEventInput, now = new Date()): Promise<void> {
    this.authEvents.push({ ...input, createdAt: now });
  }

  async consumeGoogleCredential(input: {
    credentialHash: string;
    deviceInstallationId: string;
    now: Date;
    expiresAt: Date;
  }): Promise<boolean> {
    if (this.credentialUses.has(input.credentialHash)) {
      return false;
    }
    this.credentialUses.set(input.credentialHash, input.expiresAt);
    return true;
  }

  async createSession(input: {
    id: string;
    accountId: string;
    identityId?: string | null;
    tokenHash: string;
    deviceInstallationId: string | null;
    createdAt: Date;
    expiresAt: Date;
  }): Promise<void> {
    const account = this.requireAccount(input.accountId);
    if (account.status !== "active") {
      throw codedError("ACCOUNT_UNAVAILABLE");
    }
    this.sessionsByHash.set(input.tokenHash, {
      ...input,
      lastSeenAt: input.createdAt,
      revokedAt: null,
      revokeReason: null,
      accountSessionVersion: this.accountSessionVersions.get(input.accountId) ?? 0,
      identityId: input.identityId ?? this.identityByAccountId.get(input.accountId) ?? null,
      identityProvider: input.identityId?.startsWith("apple:") ? "apple" : "google"
    });
    this.authEvents.push({
      accountId: input.accountId,
      deviceInstallationId: input.deviceInstallationId,
      eventType: "session_created",
      metadata: { sessionId: input.id },
      createdAt: input.createdAt
    });
  }

  async findSessionByTokenHash(tokenHash: string): Promise<StoredAuthSession | null> {
    this.findSessionCount += 1;
    const session = this.sessionsByHash.get(tokenHash);
    if (!session) {
      return null;
    }
    return {
      id: session.id,
      identityId: session.identityId,
      identityProvider: session.identityProvider,
      verifiedGoogleSubject: session.identityProvider === "google"
        ? this.subjectByAccountId.get(session.accountId) ?? null
        : null,
      verifiedEmail: this.emailByAccountId.get(session.accountId) ?? "player@example.com",
      account: this.requireAccount(session.accountId),
      player: this.playersByAccount.get(session.accountId) ?? null,
      deviceInstallationId: session.deviceInstallationId,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt,
      revokeReason: session.revokeReason,
      accountSessionVersion: this.accountSessionVersions.get(session.accountId) ?? 0,
      sessionAccountVersion: session.accountSessionVersion
    };
  }

  async touchSession(sessionId: string, now: Date): Promise<void> {
    const session = [...this.sessionsByHash.values()].find((candidate) => candidate.id === sessionId);
    if (session) {
      session.lastSeenAt = now;
      this.touchCount += 1;
    }
  }

  async revokeSessionByTokenHash(
    tokenHash: string,
    reason: string,
    now: Date
  ): Promise<string | null> {
    const session = this.sessionsByHash.get(tokenHash);
    if (!session) {
      return null;
    }
    session.revokedAt ??= now;
    session.revokeReason ??= reason;
    return session.accountId;
  }

  async revokeAllSessions(accountId: string, reason: string, now: Date): Promise<string[]> {
    this.accountSessionVersions.set(
      accountId,
      (this.accountSessionVersions.get(accountId) ?? 0) + 1
    );
    const revoked: string[] = [];
    for (const session of this.sessionsByHash.values()) {
      if (session.accountId === accountId && !session.revokedAt) {
        session.revokedAt = now;
        session.revokeReason = reason;
        revoked.push(session.id);
      }
    }
    return revoked;
  }

  async insertRiskEvent(input: RiskEventInput): Promise<boolean> {
    if (input.dedupeKey && this.riskDedupeKeys.has(input.dedupeKey)) {
      return false;
    }
    if (input.dedupeKey) {
      this.riskDedupeKeys.add(input.dedupeKey);
    }
    this.riskEvents.push({ ...input, insertedAt: new Date() });
    return true;
  }

  async recomputeAccountRiskScore(accountId: string): Promise<number> {
    const score = Math.min(
      100,
      Math.max(
        0,
        Math.round(
          this.riskEvents
            .filter((event) => event.accountId === accountId)
            .reduce((total, event) => total + event.weight, 0)
        )
      )
    );
    this.requireAccount(accountId).riskScore = score;
    return score;
  }

  async cleanup(before: {
    sessionExpiry: Date;
    telemetryCreatedAt: Date;
    credentialExpiry: Date;
  }): Promise<{
    sessionsDeleted: number;
    authEventsDeleted: number;
    credentialUsesDeleted: number;
  }> {
    let sessionsDeleted = 0;
    for (const [hash, session] of this.sessionsByHash) {
      if (
        session.expiresAt < before.sessionExpiry ||
        (session.revokedAt !== null && session.revokedAt < before.sessionExpiry)
      ) {
        this.sessionsByHash.delete(hash);
        sessionsDeleted += 1;
      }
    }
    const retainedEvents = this.authEvents.filter(
      (event) => event.createdAt >= before.telemetryCreatedAt
    );
    const authEventsDeleted = this.authEvents.length - retainedEvents.length;
    this.authEvents.splice(0, this.authEvents.length, ...retainedEvents);
    let credentialUsesDeleted = 0;
    for (const [hash, expiresAt] of this.credentialUses) {
      if (expiresAt < before.credentialExpiry) {
        this.credentialUses.delete(hash);
        credentialUsesDeleted += 1;
      }
    }
    return { sessionsDeleted, authEventsDeleted, credentialUsesDeleted };
  }

  accountForSubject(subject: string): AuthAccountRecord {
    const account = this.accountsBySubject.get(subject);
    if (!account) {
      throw new Error(`missing test account for ${subject}`);
    }
    return account;
  }

  private requireAccount(accountId: string): AuthAccountRecord {
    const account = this.accountsById.get(accountId);
    if (!account) {
      throw new Error(`missing test account ${accountId}`);
    }
    return account;
  }

  private reserveAttempt(
    input: ReservationInput,
    eventType: string,
    networkField: "networkHash" | "networkPrefixHash"
  ): RateLimitReservation {
    const recent = this.authEvents.filter(
      (event) => event.eventType === eventType && event.createdAt >= input.since
    );
    const deviceCount = recent.filter(
      (event) => event.deviceInstallationId === input.deviceInstallationId
    ).length;
    const networkCount = recent.filter(
      (event) => event[networkField] === input[networkField]
    ).length;
    const allowed = deviceCount < input.deviceMax && networkCount < input.networkMax;
    if (allowed) {
      this.authEvents.push({
        deviceInstallationId: input.deviceInstallationId,
        eventType,
        networkHash: input.networkHash,
        networkPrefixHash: input.networkPrefixHash,
        networkKeyVersion: input.networkKeyVersion,
        createdAt: input.now
      });
    }
    return { allowed, deviceCount, networkCount };
  }
}

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
