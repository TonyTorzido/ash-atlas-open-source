import { createHash, randomBytes as cryptoRandomBytes, randomUUID } from "node:crypto";

import {
  buildAttestClientData,
  formatAttestBoundFix,
  type AttestBoundFix,
  type AttestPurpose,
  type FormattedAttestBoundFix,
  type TrustAttestChallengeResponse,
  type TrustAttestResultResponse,
  type TrustAttestationSessionConfig
} from "@ash-atlas/shared";

import type { AppConfig } from "../../../config.js";
import type { AppLogger } from "../../../logger.js";
import type { TrustSignalSink } from "../trustService.js";
import { verifyAppAttestAssertion, verifyAppAttestAttestation, type AppAttestKeyFailure } from "./appAttest.js";
import { APPLE_APP_ATTESTATION_ROOT_CA_PEM } from "./appleAppAttestRoot.js";
import {
  attestAppFail,
  attestPass,
  attestRevocationReason,
  attestSignal,
  attestTamper,
  attestUnavailable,
  type AttestMethod,
  type AttestVerdict
} from "./assurance.js";
import { attestationRefHash } from "./attestationResolver.js";
import type { AttestationStore, AttestPlatform, ConsumedChallenge } from "./attestationStore.js";
import type { DeviceCheckValidator } from "./deviceCheckClient.js";
import type { DeviceEnvironmentService } from "./deviceEnvironment.js";
import type { PlayIntegrityDecoder } from "./playIntegrityClient.js";
import { evaluatePlayIntegrity, parseCertDigestList } from "./playIntegrityVerdict.js";

// Attestation endpoints' logic (NATIVE_ANTISPOOF_BUILD_PLAN.md §8.3, §8.5). Every
// verdict, pass or fail, returns the same body shape; only the stored row differs.

export const ATTEST_CHALLENGES_PER_SESSION_HOUR = 20;
const HOUR_MS = 60 * 60_000;

export type AttestationServiceConfig = Pick<
  AppConfig,
  | "TRUST_ATTESTATION_MODE"
  | "TRUST_PLAY_INTEGRITY_ENABLED"
  | "TRUST_PLAY_INTEGRITY_PACKAGE_NAME"
  | "TRUST_PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER"
  | "TRUST_PLAY_INTEGRITY_CERT_SHA256"
  | "TRUST_APP_ATTEST_ENABLED"
  | "TRUST_APP_ATTEST_APP_ID"
  | "TRUST_APP_ATTEST_ALLOW_DEVELOPMENT"
  | "TRUST_DEVICECHECK_ENABLED"
  | "TRUST_ATTEST_VERDICT_TTL_SECONDS"
  | "TRUST_ATTEST_CHALLENGE_TTL_SECONDS"
>;

export type AttestationSession = Readonly<{
  sessionId: string;
  deviceInstallationId: string | null;
  account: Readonly<{ id: string }>;
}>;

export type AttestationRevoker = (
  accountId: string,
  reason: "attest_tamper" | "attest_app_fail",
  metadata: Record<string, unknown>
) => Promise<void>;

export type AttestOutcomeResult =
  | Readonly<{ status: "ok"; body: TrustAttestResultResponse }>
  | Readonly<{ status: "not_found" | "invalid_request" | "challenge_invalid" | "key_exists" | "key_unknown" }>;

export type ChallengeResult =
  | Readonly<{ status: "ok"; body: TrustAttestChallengeResponse }>
  | Readonly<{ status: "not_found" | "rate_limited" }>;

export type AndroidAttestInput = Readonly<{
  challengeId: string;
  purpose: "session" | "relocation";
  shellBuild: number;
  token?: string | undefined;
  clientError?: string | undefined;
  fix?: AttestBoundFix | undefined;
  environment?: unknown;
}>;

export type IosKeyInput = Readonly<{
  challengeId: string;
  keyId: string;
  attestationObject: Buffer;
  environment?: unknown;
  deviceCheckToken?: string | undefined;
}>;

export type IosAssertInput = Readonly<{
  challengeId: string;
  purpose: "session" | "relocation";
  keyId: string;
  assertion: Buffer;
  shellBuild: number;
  fix?: AttestBoundFix | undefined;
  environment?: unknown;
  deviceCheckToken?: string | undefined;
}>;

export type DeviceCheckInput = Readonly<{
  challengeId: string;
  purpose: "session" | "relocation";
  deviceToken: string;
  shellBuild: number;
  environment?: unknown;
}>;

const sha256Hex = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

const KEY_FAILURE_VERDICT = (reason: AppAttestKeyFailure): AttestVerdict =>
  reason === "nonce_mismatch" ? attestTamper(reason) : attestAppFail(reason);

export class AttestationService {
  private readonly logger: Pick<AppLogger, "warn"> | undefined;
  private readonly now: () => Date;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly sink: TrustSignalSink | undefined;
  private readonly revoke: AttestationRevoker | undefined;
  private readonly playIntegrity: PlayIntegrityDecoder | null;
  private readonly deviceCheck: DeviceCheckValidator | null;
  private readonly appAttestRootPem: string;
  private readonly certDigests: readonly string[];
  private readonly environment: DeviceEnvironmentService | null;

  constructor(
    private readonly store: AttestationStore,
    private readonly config: AttestationServiceConfig,
    options: Readonly<{
      playIntegrity?: PlayIntegrityDecoder | null;
      deviceCheck?: DeviceCheckValidator | null;
      appAttestRootPem?: string;
      sink?: TrustSignalSink;
      revoke?: AttestationRevoker;
      // Environment block + integrity signals (plan §8.9); never affects the verdict.
      environment?: DeviceEnvironmentService | null;
      logger?: Pick<AppLogger, "warn">;
      now?: () => Date;
      randomBytes?: (size: number) => Buffer;
    }> = {}
  ) {
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    this.randomBytes = options.randomBytes ?? cryptoRandomBytes;
    this.sink = options.sink;
    this.revoke = options.revoke;
    this.environment = options.environment ?? null;
    this.playIntegrity = config.TRUST_PLAY_INTEGRITY_ENABLED ? options.playIntegrity ?? null : null;
    this.deviceCheck = config.TRUST_DEVICECHECK_ENABLED ? options.deviceCheck ?? null : null;
    this.appAttestRootPem = options.appAttestRootPem ?? APPLE_APP_ATTESTATION_ROOT_CA_PEM;
    // Hex/colon config converted once (Play Integrity reports base64url).
    this.certDigests = parseCertDigestList(config.TRUST_PLAY_INTEGRITY_CERT_SHA256);
  }

  private get on(): boolean {
    return this.config.TRUST_ATTESTATION_MODE !== "off";
  }

  private androidEnabled(): boolean {
    return this.on && this.playIntegrity !== null;
  }

  private appAttestEnabled(): boolean {
    return this.on && this.config.TRUST_APP_ATTEST_ENABLED;
  }

  private deviceCheckEnabled(): boolean {
    return this.on && this.deviceCheck !== null;
  }

  /** Session payload for native clients; undefined when nothing is enabled. */
  sessionConfig(): TrustAttestationSessionConfig | undefined {
    if (!this.on) return undefined;
    const android = this.androidEnabled() && this.config.TRUST_PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER
      ? { cloudProjectNumber: this.config.TRUST_PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER }
      : undefined;
    const ios = this.appAttestEnabled() || this.deviceCheckEnabled()
      ? { appAttest: this.appAttestEnabled(), deviceCheck: this.deviceCheckEnabled() }
      : undefined;
    if (!android && !ios) return undefined;
    return {
      mode: this.config.TRUST_ATTESTATION_MODE,
      ...(android ? { android } : {}),
      ...(ios ? { ios } : {}),
      refreshSeconds: this.refreshAfterSeconds()
    };
  }

  async createChallenge(
    session: AttestationSession,
    input: Readonly<{ platform: AttestPlatform; purpose: AttestPurpose }>
  ): Promise<ChallengeResult> {
    const enabled = input.platform === "android"
      ? this.androidEnabled() && input.purpose !== "ios_key"
      : input.purpose === "ios_key"
        ? this.appAttestEnabled()
        : this.appAttestEnabled() || this.deviceCheckEnabled();
    if (!enabled) return { status: "not_found" };
    const now = this.now();
    const challenge = this.randomBytes(32);
    const id = randomUUID();
    const expiresAt = new Date(now.getTime() + this.config.TRUST_ATTEST_CHALLENGE_TTL_SECONDS * 1000);
    const created = await this.store.createChallenge({
      id,
      accountId: session.account.id,
      sessionId: session.sessionId,
      installationId: session.deviceInstallationId,
      platform: input.platform,
      purpose: input.purpose,
      challenge,
      createdAt: now,
      expiresAt
    }, new Date(now.getTime() - HOUR_MS), ATTEST_CHALLENGES_PER_SESSION_HOUR);
    if (!created) return { status: "rate_limited" };
    return { status: "ok", body: { challengeId: id, challenge: challenge.toString("base64url"), expiresAt: expiresAt.toISOString() } };
  }

  async attestAndroid(session: AttestationSession, input: AndroidAttestInput): Promise<AttestOutcomeResult> {
    if (!this.androidEnabled()) return { status: "not_found" };
    const fix = this.fixFor(input.purpose, input.fix);
    if (fix === false) return { status: "invalid_request" };
    const challenge = await this.consume(session, "android", input.purpose, input.challengeId);
    if (!challenge) return { status: "challenge_invalid" };
    const now = this.now();
    const clientData = buildAttestClientData(input.purpose, challenge.challenge.toString("base64url"), fix);
    const requestHash = createHash("sha256").update(clientData, "utf8").digest("base64url");
    let verdict: AttestVerdict;
    let tokenHash: string | null = null;
    if (!input.token) {
      verdict = attestUnavailable(`client_error:${input.clientError ?? "none"}`);
    } else {
      tokenHash = sha256Hex(input.token);
      const decoded = await this.playIntegrity!(input.token);
      verdict = decoded.status === "ok"
        ? evaluatePlayIntegrity(decoded.payload, {
            packageName: this.config.TRUST_PLAY_INTEGRITY_PACKAGE_NAME,
            certDigests: this.certDigests,
            requestHash,
            nowMs: now.getTime()
          })
        : decoded.status === "invalid"
          ? attestAppFail("token_invalid")
          : attestUnavailable(`decode_${decoded.code}`);
    }
    return this.finish(session, challenge, {
      platform: "android",
      method: "play_integrity",
      purpose: input.purpose,
      verdict,
      tokenHash,
      keyId: null,
      boundFix: fix ? formatAttestBoundFix(fix) : null,
      shellBuild: input.shellBuild,
      environment: { value: input.environment, fix }
    });
  }

  async registerIosKey(session: AttestationSession, input: IosKeyInput): Promise<AttestOutcomeResult> {
    if (!this.appAttestEnabled()) return { status: "not_found" };
    const challenge = await this.consume(session, "ios", "ios_key", input.challengeId);
    if (!challenge) return { status: "challenge_invalid" };
    const now = this.now();
    const clientData = buildAttestClientData("ios_key", challenge.challenge.toString("base64url"));
    const result = verifyAppAttestAttestation({
      keyId: input.keyId,
      attestationObject: input.attestationObject,
      clientDataHash: createHash("sha256").update(clientData, "utf8").digest(),
      now
    }, {
      appId: this.config.TRUST_APP_ATTEST_APP_ID,
      allowDevelopment: this.config.TRUST_APP_ATTEST_ALLOW_DEVELOPMENT,
      rootCertificatePem: this.appAttestRootPem
    });
    let keyId: string | null = null;
    let verdict: AttestVerdict;
    if (result.ok) {
      const inserted = await this.store.insertAppAttestKey({
        keyId: input.keyId,
        installationId: session.deviceInstallationId,
        accountId: session.account.id,
        environment: result.environment,
        publicKeySpki: result.publicKeySpki,
        receipt: result.receipt,
        createdAt: now
      });
      if (inserted === "exists") return { status: "key_exists" };
      keyId = input.keyId;
      verdict = attestPass("attested", { environment: result.environment });
    } else {
      verdict = KEY_FAILURE_VERDICT(result.reason);
    }
    return this.finish(session, challenge, {
      platform: "ios",
      method: "app_attest",
      purpose: "ios_key",
      verdict,
      tokenHash: sha256Hex(input.attestationObject),
      keyId,
      boundFix: null,
      shellBuild: null,
      environment: { value: input.environment, deviceCheckToken: input.deviceCheckToken, fix: null }
    });
  }

  async assertIos(session: AttestationSession, input: IosAssertInput): Promise<AttestOutcomeResult> {
    if (!this.appAttestEnabled()) return { status: "not_found" };
    const fix = this.fixFor(input.purpose, input.fix);
    if (fix === false) return { status: "invalid_request" };
    const challenge = await this.consume(session, "ios", input.purpose, input.challengeId);
    if (!challenge) return { status: "challenge_invalid" };
    const key = await this.store.loadAppAttestKey(input.keyId);
    if (!key) return { status: "key_unknown" };
    const clientData = buildAttestClientData(input.purpose, challenge.challenge.toString("base64url"), fix);
    const result = verifyAppAttestAssertion({
      assertion: input.assertion,
      clientData: Buffer.from(clientData, "utf8"),
      publicKeySpki: key.publicKeySpki,
      previousSignCount: key.signCount
    }, { appId: this.config.TRUST_APP_ATTEST_APP_ID });
    let verdict: AttestVerdict;
    if (result.ok) {
      // A concurrent assertion with the same or a higher counter wins the race.
      verdict = await this.store.advanceSignCount(input.keyId, result.signCount, this.now())
        ? attestPass("attested", { environment: key.environment, signCount: result.signCount })
        : attestTamper("counter_regression", { signCount: result.signCount });
    } else {
      verdict = result.reason === "rp_id_mismatch"
        ? attestAppFail(result.reason)
        : result.reason === "cbor_invalid"
          ? attestAppFail("assertion_malformed")
          : attestTamper(result.reason, result.reason === "counter_regression" ? { storedSignCount: key.signCount } : {});
    }
    return this.finish(session, challenge, {
      platform: "ios",
      method: "app_attest",
      purpose: input.purpose,
      verdict,
      tokenHash: sha256Hex(input.assertion),
      keyId: input.keyId,
      boundFix: fix ? formatAttestBoundFix(fix) : null,
      shellBuild: input.shellBuild,
      environment: { value: input.environment, deviceCheckToken: input.deviceCheckToken, fix }
    });
  }

  async checkDevice(session: AttestationSession, input: DeviceCheckInput): Promise<AttestOutcomeResult> {
    if (!this.deviceCheckEnabled()) return { status: "not_found" };
    const challenge = await this.consume(session, "ios", input.purpose, input.challengeId);
    if (!challenge) return { status: "challenge_invalid" };
    const result = await this.deviceCheck!(input.deviceToken);
    const verdict = result === "valid"
      ? attestPass("device_checked")
      : result === "invalid"
        ? attestAppFail("devicecheck_invalid")
        : attestUnavailable("devicecheck_unavailable");
    return this.finish(session, challenge, {
      platform: "ios",
      method: "devicecheck",
      purpose: input.purpose,
      verdict,
      tokenHash: sha256Hex(input.deviceToken),
      keyId: null,
      boundFix: null,
      shellBuild: input.shellBuild,
      environment: { value: input.environment, deviceCheckToken: input.deviceToken, fix: null }
    });
  }

  // Relocation needs the fix it binds; session attestations carry none.
  private fixFor(purpose: "session" | "relocation", fix: AttestBoundFix | undefined): AttestBoundFix | null | false {
    if (purpose === "relocation") return fix ?? false;
    return fix ? false : null;
  }

  private consume(
    session: AttestationSession,
    platform: AttestPlatform,
    purpose: AttestPurpose,
    challengeId: string
  ): Promise<ConsumedChallenge | null> {
    return this.store.consumeChallenge({
      challengeId,
      accountId: session.account.id,
      sessionId: session.sessionId,
      platform,
      purpose,
      now: this.now()
    });
  }

  private refreshAfterSeconds(): number {
    return Math.max(60, this.config.TRUST_ATTEST_VERDICT_TTL_SECONDS - 300);
  }

  private async finish(
    session: AttestationSession,
    challenge: ConsumedChallenge,
    input: Readonly<{
      platform: AttestPlatform;
      method: AttestMethod;
      purpose: AttestPurpose;
      verdict: AttestVerdict;
      tokenHash: string | null;
      keyId: string | null;
      boundFix: FormattedAttestBoundFix | null;
      shellBuild: number | null;
      environment?: Readonly<{ value: unknown; deviceCheckToken?: string | undefined; fix: AttestBoundFix | null }>;
    }>
  ): Promise<AttestOutcomeResult> {
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.config.TRUST_ATTEST_VERDICT_TTL_SECONDS * 1000);
    const ref = this.randomBytes(32).toString("base64url");
    const id = randomUUID();
    let verdict = input.verdict;
    const row = {
      id,
      accountId: session.account.id,
      sessionId: session.sessionId,
      installationId: session.deviceInstallationId,
      platform: input.platform,
      method: input.method,
      purpose: input.purpose,
      challengeId: challenge.id,
      appAttestKeyId: input.keyId,
      outcome: verdict.outcome,
      assurance: verdict.assurance,
      reason: verdict.reason,
      verdict: verdict.summary,
      boundFix: input.boundFix,
      tokenHash: input.tokenHash,
      refHash: attestationRefHash(ref),
      shellBuild: input.shellBuild,
      createdAt: now,
      expiresAt
    };
    if (await this.store.insertAttestation(row) === "token_replay") {
      // The same token on a fresh challenge: replay.
      verdict = attestTamper("token_replay");
      await this.store.insertAttestation({
        ...row,
        outcome: verdict.outcome,
        assurance: verdict.assurance,
        reason: verdict.reason,
        verdict: verdict.summary,
        tokenHash: null
      });
    }
    await this.afterVerdict(session.account.id, id, input.method, verdict, now);
    if (this.environment && input.environment) {
      // Fire-and-forget (never throws): DeviceCheck bit queries must not delay the answer.
      void this.environment.record({
        accountId: session.account.id,
        attestationId: id,
        platform: input.platform,
        environment: input.environment.value,
        deviceCheckToken: input.environment.deviceCheckToken,
        fix: input.environment.fix ? { lat: input.environment.fix.lat, lon: input.environment.fix.lon } : null,
        playIntegrity: input.method === "play_integrity" ? verdict.summary : null
      });
    }
    return {
      status: "ok",
      body: { attestationRef: ref, expiresAt: expiresAt.toISOString(), refreshAfterSeconds: this.refreshAfterSeconds() }
    };
  }

  // Never throws: the verdict is already stored.
  private async afterVerdict(
    accountId: string,
    attestationId: string,
    method: AttestMethod,
    verdict: AttestVerdict,
    at: Date
  ): Promise<void> {
    const metadata = { attestationId, method, reason: verdict.reason };
    if (this.sink && verdict.signals.length > 0) {
      try {
        await this.sink.recordSignals({
          accountId,
          signals: verdict.signals.map((rule) => attestSignal(rule, accountId, at, attestationId, metadata))
        });
      } catch (error) {
        this.logger?.warn({ err: error, accountId }, "Attestation trust signals could not be recorded");
      }
    }
    const revocation = attestRevocationReason(verdict.signals);
    if (revocation && this.config.TRUST_ATTESTATION_MODE === "enforce" && this.revoke) {
      try {
        await this.revoke(accountId, revocation, metadata);
      } catch (error) {
        this.logger?.warn({ err: error, accountId }, "Attestation revocation failed");
      }
    }
  }
}
