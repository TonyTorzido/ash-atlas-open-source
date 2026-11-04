import type { AttestPurpose, FormattedAttestBoundFix, LocationFixAssurance } from "@ash-atlas/shared";
import type pg from "pg";

import type { AttestMethod, AttestOutcome } from "./assurance.js";

// Device attestation persistence (migration 0911). Raw tokens are never stored:
// only sha256(token), sha256(attestationRef) and summarized verdicts.

export type AttestPlatform = "ios" | "android";

export type ChallengeInsert = Readonly<{
  id: string;
  accountId: string;
  sessionId: string;
  installationId: string | null;
  platform: AttestPlatform;
  purpose: AttestPurpose;
  challenge: Buffer;
  createdAt: Date;
  expiresAt: Date;
}>;

export type ConsumeChallenge = Readonly<{
  challengeId: string;
  accountId: string;
  sessionId: string;
  platform: AttestPlatform;
  purpose: AttestPurpose;
  now: Date;
}>;

export type ConsumedChallenge = Readonly<{ id: string; challenge: Buffer; installationId: string | null }>;

export type AttestationInsert = Readonly<{
  id: string;
  accountId: string;
  sessionId: string;
  installationId: string | null;
  platform: AttestPlatform;
  method: AttestMethod;
  purpose: AttestPurpose;
  challengeId: string | null;
  appAttestKeyId: string | null;
  outcome: AttestOutcome;
  assurance: LocationFixAssurance;
  reason: string | null;
  verdict: Record<string, unknown>;
  boundFix: FormattedAttestBoundFix | null;
  tokenHash: string | null;
  refHash: string;
  shellBuild: number | null;
  createdAt: Date;
  expiresAt: Date;
}>;

export type AppAttestKeyInsert = Readonly<{
  keyId: string;
  installationId: string | null;
  accountId: string;
  environment: "production" | "development";
  publicKeySpki: Buffer;
  receipt: Buffer | null;
  createdAt: Date;
}>;

export type AppAttestKeyRecord = Readonly<{
  keyId: string;
  publicKeySpki: Buffer;
  signCount: number;
  environment: "production" | "development";
}>;

export type StoredAttestation = Readonly<{
  id: string;
  accountId: string;
  sessionId: string | null;
  installationId: string | null;
  platform: AttestPlatform;
  method: AttestMethod;
  purpose: AttestPurpose;
  outcome: AttestOutcome;
  assurance: LocationFixAssurance;
  boundFix: FormattedAttestBoundFix | null;
  expiresAt: Date;
}>;

export type AttestationCleanup = Readonly<{ attestations: number; challenges: number; keys: number }>;

export interface AttestationStore {
  /** Inserts unless the session already created `maxPerWindow` since `windowStart`. */
  createChallenge(challenge: ChallengeInsert, windowStart: Date, maxPerWindow: number): Promise<boolean>;
  /** Atomic single use, bound to account, session, platform and purpose, unexpired. */
  consumeChallenge(input: ConsumeChallenge): Promise<ConsumedChallenge | null>;
  /** "token_replay" when token_hash already exists (the row is not written). */
  insertAttestation(row: AttestationInsert): Promise<"inserted" | "token_replay">;
  insertAppAttestKey(key: AppAttestKeyInsert): Promise<"inserted" | "exists">;
  /** Unrevoked key, or null. */
  loadAppAttestKey(keyId: string): Promise<AppAttestKeyRecord | null>;
  /** Raises sign_count only if `signCount` is higher (false = regression or lost race). */
  advanceSignCount(keyId: string, signCount: number, now: Date): Promise<boolean>;
  findByRefHash(refHash: string): Promise<StoredAttestation | null>;
  cleanup(input: Readonly<{ now: Date; retentionDays: number; challengeGraceDays: number; keyIdleDays: number }>): Promise<AttestationCleanup>;
}

type AttestationRow = {
  id: string;
  account_id: string;
  session_id: string | null;
  device_installation_id: string | null;
  platform: AttestPlatform;
  method: AttestMethod;
  purpose: AttestPurpose;
  outcome: AttestOutcome;
  assurance: LocationFixAssurance;
  bound_fix: FormattedAttestBoundFix | null;
  expires_at: Date;
};

const DAY_MS = 24 * 60 * 60_000;

export class PostgresAttestationStore implements AttestationStore {
  constructor(private readonly pool: pg.Pool) {}

  async createChallenge(challenge: ChallengeInsert, windowStart: Date, maxPerWindow: number): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Serializes the count-then-insert per session.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('attest_challenge:' || $1::text, 0))", [challenge.sessionId]);
      const result = await client.query(
        `INSERT INTO attestation_challenges (
           id, account_id, session_id, device_installation_id, platform, purpose, challenge, created_at, expires_at
         )
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
          WHERE (SELECT count(*) FROM attestation_challenges
                  WHERE session_id = $3 AND created_at > $10) < $11`,
        [
          challenge.id, challenge.accountId, challenge.sessionId, challenge.installationId, challenge.platform,
          challenge.purpose, challenge.challenge, challenge.createdAt, challenge.expiresAt, windowStart, maxPerWindow
        ]
      );
      await client.query("COMMIT");
      return result.rowCount === 1;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async consumeChallenge(input: ConsumeChallenge): Promise<ConsumedChallenge | null> {
    const result = await this.pool.query<{ id: string; challenge: Buffer; device_installation_id: string | null }>(
      `UPDATE attestation_challenges
          SET consumed_at = $6
        WHERE id = $1 AND account_id = $2 AND session_id = $3 AND platform = $4 AND purpose = $5
          AND consumed_at IS NULL AND expires_at > $6
        RETURNING id, challenge, device_installation_id`,
      [input.challengeId, input.accountId, input.sessionId, input.platform, input.purpose, input.now]
    );
    const row = result.rows[0];
    return row ? { id: row.id, challenge: row.challenge, installationId: row.device_installation_id } : null;
  }

  async insertAttestation(row: AttestationInsert): Promise<"inserted" | "token_replay"> {
    try {
      await this.pool.query(
        `INSERT INTO device_attestations (
           id, account_id, session_id, device_installation_id, platform, method, purpose, challenge_id,
           app_attest_key_id, outcome, assurance, reason, verdict, bound_fix, token_hash, ref_hash,
           shell_build, created_at, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15, $16, $17, $18, $19)`,
        [
          row.id, row.accountId, row.sessionId, row.installationId, row.platform, row.method, row.purpose,
          row.challengeId, row.appAttestKeyId, row.outcome, row.assurance, row.reason, JSON.stringify(row.verdict),
          row.boundFix ? JSON.stringify(row.boundFix) : null, row.tokenHash, row.refHash, row.shellBuild,
          row.createdAt, row.expiresAt
        ]
      );
      return "inserted";
    } catch (error) {
      if (isUniqueViolation(error, "device_attestations_token_hash_key")) return "token_replay";
      throw error;
    }
  }

  async insertAppAttestKey(key: AppAttestKeyInsert): Promise<"inserted" | "exists"> {
    const result = await this.pool.query(
      `INSERT INTO app_attest_keys (
         key_id, device_installation_id, first_account_id, environment, public_key_spki, receipt, created_at, last_used_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (key_id) DO NOTHING`,
      [key.keyId, key.installationId, key.accountId, key.environment, key.publicKeySpki, key.receipt, key.createdAt]
    );
    return result.rowCount === 1 ? "inserted" : "exists";
  }

  async loadAppAttestKey(keyId: string): Promise<AppAttestKeyRecord | null> {
    const result = await this.pool.query<{
      key_id: string;
      public_key_spki: Buffer;
      sign_count: string;
      environment: "production" | "development";
    }>(
      `SELECT key_id, public_key_spki, sign_count, environment
         FROM app_attest_keys WHERE key_id = $1 AND revoked_at IS NULL`,
      [keyId]
    );
    const row = result.rows[0];
    return row
      ? { keyId: row.key_id, publicKeySpki: row.public_key_spki, signCount: Number(row.sign_count), environment: row.environment }
      : null;
  }

  async advanceSignCount(keyId: string, signCount: number, now: Date): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE app_attest_keys
          SET sign_count = $2, last_used_at = $3
        WHERE key_id = $1 AND revoked_at IS NULL AND sign_count < $2`,
      [keyId, signCount, now]
    );
    return result.rowCount === 1;
  }

  async findByRefHash(refHash: string): Promise<StoredAttestation | null> {
    const result = await this.pool.query<AttestationRow>(
      `SELECT id, account_id, session_id, device_installation_id, platform, method, purpose, outcome, assurance,
              bound_fix, expires_at
         FROM device_attestations WHERE ref_hash = $1`,
      [refHash]
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          accountId: row.account_id,
          sessionId: row.session_id,
          installationId: row.device_installation_id,
          platform: row.platform,
          method: row.method,
          purpose: row.purpose,
          outcome: row.outcome,
          assurance: row.assurance,
          boundFix: row.bound_fix,
          expiresAt: row.expires_at
        }
      : null;
  }

  async cleanup(input: Readonly<{ now: Date; retentionDays: number; challengeGraceDays: number; keyIdleDays: number }>): Promise<AttestationCleanup> {
    const at = input.now.getTime();
    const attestations = await this.pool.query(
      "DELETE FROM device_attestations WHERE created_at < $1",
      [new Date(at - input.retentionDays * DAY_MS)]
    );
    const challenges = await this.pool.query(
      "DELETE FROM attestation_challenges WHERE expires_at < $1",
      [new Date(at - input.challengeGraceDays * DAY_MS)]
    );
    const keys = await this.pool.query(
      "DELETE FROM app_attest_keys WHERE COALESCE(last_used_at, created_at) < $1",
      [new Date(at - input.keyIdleDays * DAY_MS)]
    );
    return { attestations: attestations.rowCount ?? 0, challenges: challenges.rowCount ?? 0, keys: keys.rowCount ?? 0 };
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return typeof error === "object"
    && error !== null
    && (error as { code?: unknown }).code === "23505"
    && (error as { constraint?: unknown }).constraint === constraint;
}
