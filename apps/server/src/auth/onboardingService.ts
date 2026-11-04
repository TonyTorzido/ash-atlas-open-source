import type pg from "pg";
import {
  isPersonalFlagColor,
  personalFlagColorHex,
  type PersonalFlagColor,
  type TestAccessMode
} from "@ash-atlas/shared";

import type { AppConfig } from "../config.js";
import type { PetService } from "../game/petService.js";
import { packageIdForPosition } from "../game/spatialZones.js";
import type { AppLogger } from "../logger.js";
import {
  InitialSpawnError,
  type InitialSpawnSampler
} from "./initialSpawn.js";
import { isDeveloperAccessSession } from "./developerAuthorization.js";
import type {
  TestAccessModeQueryable,
  TestAccessModeReader
} from "./testAccessService.js";
import { validatePlayerName } from "./authService.js";
import { AuthError, type AuthenticatedSession, type AuthPlayerRecord } from "./types.js";

type PlayerRow = {
  id: string;
  account_id: string;
  username: string;
  personal_flag_color: PersonalFlagColor;
  onboarding_completed_at: Date;
};

const CLOSED_ACCESS_MODE_READER: TestAccessModeReader = {
  getAccessMode: async () => "closed"
};

export class OnboardingService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly config: AppConfig,
    private readonly spawns: InitialSpawnSampler,
    private readonly dogs: Pick<PetService, "ensureStarterPetInTransaction">,
    private readonly logger: Pick<AppLogger, "info" | "warn">,
    private readonly now: () => Date = () => new Date(),
    private readonly accessMode: TestAccessModeReader = CLOSED_ACCESS_MODE_READER
  ) {}

  metricsSnapshot() {
    return this.spawns.metricsSnapshot();
  }

  async complete(
    session: AuthenticatedSession,
    input: {
      displayName: string;
      personalFlagColor: string;
    }
  ): Promise<AuthPlayerRecord> {
    await this.requireApprovedStatus(
      session,
      session.account.status,
      session.account.testAccessStatus,
      await this.accessMode.getAccessMode()
    );
    const { displayName, normalizedName } = validatePlayerName(input.displayName);
    if (!isPersonalFlagColor(input.personalFlagColor)) {
      throw new AuthError(
        "PERSONAL_FLAG_COLOR_INVALID",
        "Choose red, blue, green, gold, or purple",
        400
      );
    }
    const existing = await this.loadPlayer(session.account.id);
    if (existing) {
      this.spawns.noteReusedAssignment();
      await this.ensureExistingPet(session);
      return existing;
    }

    let assignments;
    try {
      assignments = [await this.spawns.assign({
        accountId: session.account.id,
        accountCreatedAt: session.account.createdAt
      })];
    } catch (error) {
      const reason = error instanceof InitialSpawnError ? error.reason : "UNKNOWN";
      this.logger.warn(
        {
          accountId: session.account.id,
          reason,
          algorithmVersion: "initial-spawn:v1"
        },
        "initial player spawn assignment failed"
      );
      throw new AuthError(
        "ONBOARDING_FAILED",
        "Player setup could not be completed. Please try again.",
        503
      );
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const account = await client.query<{
        status: "active" | "suspended" | "deleted";
        test_access_status: "pending" | "approved" | "denied" | "revoked";
        created_at: Date;
      }>(
        `SELECT status, test_access_status, created_at
         FROM accounts WHERE id = $1 FOR UPDATE`,
        [session.account.id]
      );
      const accountRow = account.rows[0];
      if (!accountRow) {
        throw new AuthError("ACCOUNT_UNAVAILABLE", "Account unavailable", 403);
      }
      await this.requireApprovedStatus(
        session,
        accountRow.status,
        accountRow.test_access_status,
        await this.accessMode.getAccessMode(client, "share"),
        client
      );
      if (
        new Date(accountRow.created_at).getTime() !== session.account.createdAt.getTime()
      ) {
        throw new AuthError("ONBOARDING_FAILED", "Account creation identity changed", 409);
      }

      const completed = await findPlayer(client, session.account.id);
      if (completed) {
        await this.dogs.ensureStarterPetInTransaction(client, session.account.id);
        await client.query("COMMIT");
        this.spawns.noteReusedAssignment();
        return completed;
      }

      const completedAt = this.now();
      const playerId = crypto.randomUUID();
      const assignment = assignments[0]!;
      const position = assignment.position;
      const result = await client.query<PlayerRow>(
        `INSERT INTO players (
           id, account_id, username, username_normalized,
           display_color, personal_flag_color, onboarding_completed_at,
           region_code, lat, lon, anchor_lat, anchor_lon,
           move_leash_radius_m, online, last_seen_at, geom,
           initial_spawn_latitude, initial_spawn_longitude,
           initial_spawn_algorithm_version, initial_spawn_land_mask_version,
           initial_spawn_world_identity, initial_spawn_rejected_candidates,
           initial_spawn_assigned_at, initial_spawn_state_code
         )
         VALUES (
           $1, $2, $3, $4,
           $5, $6, $7,
           $8, $9, $10, $9, $10,
           $11, false, $7, ST_SetSRID(ST_MakePoint($10, $9), 4326),
           $9, $10, $12, $13, $14, $15, $7, $16
         )
         ON CONFLICT DO NOTHING
         RETURNING id, account_id, username, personal_flag_color, onboarding_completed_at`,
        [
          playerId,
          session.account.id,
          displayName,
          normalizedName,
          personalFlagColorHex(input.personalFlagColor),
          input.personalFlagColor,
          completedAt,
          packageIdForPosition(position),
          position.lat,
          position.lon,
          this.config.MOVE_LEASH_RADIUS_M,
          assignment.algorithmVersion,
          assignment.landMaskVersion,
          assignment.worldIdentity,
          assignment.rejectedCandidates,
          assignment.stateCode
        ]
      );
      const created = result.rows[0];
      if (!created) {
        const concurrent = await findPlayer(client, session.account.id);
        if (concurrent) {
          await this.dogs.ensureStarterPetInTransaction(client, session.account.id);
          await client.query("COMMIT");
          this.spawns.noteReusedAssignment();
          return concurrent;
        }
        throw new AuthError("PLAYER_NAME_TAKEN", "That name is already taken", 409);
      }

      await this.dogs.ensureStarterPetInTransaction(client, session.account.id);
      await client.query("COMMIT");
      this.logger.info(
        {
          accountId: session.account.id,
          playerId,
          algorithmVersion: assignment.algorithmVersion,
          landMaskVersion: assignment.landMaskVersion,
          stateCode: assignment.stateCode,
          candidateAttempts: assignment.rejectedCandidates + 1,
          assignmentDurationMs: assignment.durationMs
        },
        "new player onboarding completed"
      );
      return playerFromRow(created);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private loadPlayer(accountId: string): Promise<AuthPlayerRecord | null> {
    return findPlayer(this.pool, accountId);
  }

  private async ensureExistingPet(session: AuthenticatedSession): Promise<void> {
    const accountId = session.account.id;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const account = await client.query<{
        status: "active" | "suspended" | "deleted";
        test_access_status: "pending" | "approved" | "denied" | "revoked";
      }>(
        `SELECT status, test_access_status
         FROM accounts WHERE id = $1 FOR UPDATE`,
        [accountId]
      );
      const row = account.rows[0];
      if (!row) {
        throw new AuthError("ACCOUNT_UNAVAILABLE", "Account unavailable", 403);
      }
      await this.requireApprovedStatus(
        session,
        row.status,
        row.test_access_status,
        await this.accessMode.getAccessMode(client, "share"),
        client
      );
      await this.dogs.ensureStarterPetInTransaction(client, accountId);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async requireApprovedStatus(
    session: AuthenticatedSession,
    lifecycle: "active" | "suspended" | "deleted",
    access: "pending" | "approved" | "denied" | "revoked",
    mode: TestAccessMode,
    queryable?: TestAccessModeQueryable
  ): Promise<void> {
    requireActiveLifecycle(lifecycle);
    if (mode === "dev") {
      if (isDeveloperAccessSession(this.config, session)) return;
      if (access === "approved" && await this.hasDevAccess(session.account.id, queryable)) {
        return;
      }
      if (access === "approved" || access === "pending") {
        throw new AuthError(
          "TEST_ACCESS_DEV_ONLY",
          "Only developer accounts can enter Ash Atlas",
          403
        );
      }
    }
    if (access === "approved" || (mode === "open" && access === "pending")) return;
    const code = access === "pending"
      ? "TEST_ACCESS_PENDING"
      : access === "denied"
        ? "TEST_ACCESS_DENIED"
        : "TEST_ACCESS_REVOKED";
    throw new AuthError(code, "Approved test access is required", 403);
  }

  private async hasDevAccess(
    accountId: string,
    queryable?: TestAccessModeQueryable
  ): Promise<boolean> {
    if (!queryable) return (await this.accessMode.hasDevAccess?.(accountId)) === true;
    const result = await queryable.query(
      `SELECT 1 FROM dev_access_entries
       WHERE account_id = $1 AND status = 'approved'
       FOR SHARE`,
      [accountId]
    );
    return (result.rowCount ?? 0) > 0;
  }
}

async function findPlayer(
  queryable: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">,
  accountId: string
): Promise<AuthPlayerRecord | null> {
  const result = await queryable.query<PlayerRow>(
    `SELECT id, account_id, username, personal_flag_color, onboarding_completed_at
     FROM players WHERE account_id = $1`,
    [accountId]
  );
  return result.rows[0] ? playerFromRow(result.rows[0]) : null;
}

function playerFromRow(row: PlayerRow): AuthPlayerRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    displayName: row.username,
    personalFlagColor: row.personal_flag_color,
    onboardingCompletedAt: new Date(row.onboarding_completed_at)
  };
}

function requireActiveLifecycle(lifecycle: "active" | "suspended" | "deleted"): void {
  if (lifecycle === "suspended") {
    throw new AuthError("ACCOUNT_SUSPENDED", "Account suspended", 403);
  }
  if (lifecycle !== "active") {
    throw new AuthError("ACCOUNT_UNAVAILABLE", "Account unavailable", 403);
  }
}
