import { randomUUID } from "node:crypto";

import type {
  FlagAccessDecision,
  FlagAccessManagementSnapshot,
  FlagAccessMode,
  FlagAccessSnapshot,
  FlagManagementDashboardSnapshot,
  FlagOwnerPreferencesSnapshot,
  FlagPassageRequestSnapshot
} from "@ash-atlas/shared";
import type pg from "pg";

import { WalletOperationError, WalletService } from "./wallet.js";

export const MAX_FLAG_JUMP_TOLL_GOLD = 1_000_000n;
export const MAX_OWNED_FLAGS_DASHBOARD = 250;
export const MAX_NORMAL_PASSAGE_GRANTS = 250;
export const MAX_PENDING_PASSAGE_REQUESTS = 250;
export const FLAG_PASSAGE_REQUEST_TTL_MS = 24 * 60 * 60_000;
export const FLAG_PASSAGE_REQUEST_COOLDOWN_MS = 5 * 60_000;

type Queryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

type AccessRow = {
  id: string;
  control_type: string;
  owner_id: string;
  developer_test_target: boolean;
  collapsing?: boolean;
  access_mode: string;
  jump_toll_gold: string;
  access_revision: string;
  normal_grant: boolean;
  pending_request: boolean;
  enemy_blocked: boolean;
  war_structure_kind: string | null;
  kingdom_member: boolean;
  traveler_account_id: string | null;
  owner_account_id: string | null;
};

export type Authorization = Readonly<{
  flagId: string;
  controlType: string;
  ownerPlayerId: string;
  developerTestTarget: boolean;
  mode: FlagAccessMode | null;
  jumpTollGold: bigint;
  accessRevision: bigint;
  travelerAccountId: string | null;
  ownerAccountId: string | null;
  decision: FlagAccessDecision;
}>;

export type FlagAccessErrorCode = FlagAccessDecision["reasonCode"]
  | "FLAG_ACCESS_FORBIDDEN"
  | "FLAG_ACCESS_INVALID"
  | "FLAG_OVERRIDE_LIMIT_REACHED"
  | "PASSAGE_REQUEST_EXISTS"
  | "PASSAGE_REQUEST_RATE_LIMITED"
  | "PASSAGE_REQUEST_NOT_FOUND"
  | "PASSAGE_REQUEST_NOT_PENDING"
  | "PASSAGE_REQUEST_CONFLICT"
  | "PLAYER_NOT_FOUND";

export class FlagAccessError extends Error {
  constructor(
    readonly code: FlagAccessErrorCode,
    message: string,
    readonly details: Readonly<{
      currentTollGold?: string;
      requiredGold?: string;
    }> = {}
  ) {
    super(message);
    this.name = "FlagAccessError";
  }
}

export function decidePersonalFlagAccess(input: Readonly<{
  controlType: string;
  ownerPlayerId: string;
  travelerPlayerId: string;
  companionHostPlayerId?: string;
  mode: FlagAccessMode | null;
  jumpTollGold: bigint;
  normalPassage: boolean;
  enemyBlocked: boolean;
  requestPending?: boolean;
}>): FlagAccessDecision {
  if (input.controlType === "city" || input.controlType === "city_seat") {
    return allowed("ALLOWED_PUBLIC", 0n);
  }
  if (input.controlType !== "personal") return denied("FLAG_TYPE_UNSUPPORTED");
  if (input.travelerPlayerId === input.ownerPlayerId) return allowed("ALLOWED_OWNER", 0n);
  if (input.companionHostPlayerId === input.ownerPlayerId) {
    return allowed("ALLOWED_INVITE", 0n);
  }
  if (input.mode === "private") return denied("PRIVATE_OWNER_ONLY");
  if (input.enemyBlocked) {
    return denied(input.mode === "public" ? "PUBLIC_ENEMY_BLOCKED" : "NORMAL_ENEMY_BLOCKED");
  }
  if (input.mode === "public") {
    return allowed(
      "ALLOWED_PUBLIC",
      input.companionHostPlayerId === undefined ? input.jumpTollGold : 0n
    );
  }
  if (input.mode === "normal") {
    if (input.normalPassage) {
      return allowed(
        "ALLOWED_NORMAL",
        input.companionHostPlayerId === undefined ? input.jumpTollGold : 0n
      );
    }
    return denied(
      input.requestPending ? "NORMAL_REQUEST_PENDING" : "NORMAL_PASSAGE_REQUIRED",
      !input.requestPending
    );
  }
  return denied("FLAG_TYPE_UNSUPPORTED");
}

export class FlagAccessService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly wallet = new WalletService(),
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID
  ) {}

  async snapshotForPlayer(flagId: string, playerId: string): Promise<FlagAccessSnapshot> {
    const authorization = await this.authorize(flagId, playerId);
    if (authorization.decision.reasonCode === "FLAG_NOT_FOUND") {
      throw new FlagAccessError("FLAG_NOT_FOUND", "Flag does not exist.");
    }
    const management = !authorization.developerTestTarget &&
      authorization.ownerPlayerId === playerId && authorization.controlType === "personal"
      ? await this.normalManagement(playerId)
      : null;
    return {
      flagId,
      ownerPlayerId: authorization.ownerPlayerId,
      mode: authorization.mode ?? "private",
      jumpTollGold: authorization.jumpTollGold.toString(),
      accessRevision: authorization.accessRevision.toString(),
      requestPending: authorization.decision.reasonCode === "NORMAL_REQUEST_PENDING",
      decision: authorization.decision,
      management
    };
  }

  async authorize(flagId: string, travelerPlayerId: string): Promise<Authorization> {
    return this.authorizeWith(this.pool, flagId, travelerPlayerId, false);
  }

  async executeTravel<T>(input: Readonly<{
    flagId: string;
    travelerPlayerId: string;
    companionHostPlayerId?: string;
    requestId: string;
    expectedTollGold?: string;
    commit(client: pg.PoolClient, authorization: Authorization): Promise<T>;
  }>): Promise<Readonly<{
    authorization: Authorization;
    value: T | null;
    replayed: boolean;
    travelerGoldBalance: string | null;
    ownerGoldBalance: string | null;
  }>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const authorization = await this.authorizeWith(
        client, input.flagId, input.travelerPlayerId, true, input.companionHostPlayerId
      );
      if (!authorization.decision.allowed) throw accessDenied(authorization.decision);
      const chargedToll = BigInt(authorization.decision.tollGold);
      const expectedToll = parseExpectedToll(input.expectedTollGold);
      if (
        (chargedToll > 0n && expectedToll === null) ||
        (expectedToll !== null && expectedToll !== chargedToll)
      ) {
        throw new FlagAccessError(
          "TOLL_CHANGED",
          `The toll changed to ${chargedToll} gold. Review the new price.`,
          { currentTollGold: chargedToll.toString() }
        );
      }

      const inserted = await client.query(
        `INSERT INTO flag_travel_commands (
           traveler_player_id, request_id, flag_id, owner_player_id, access_mode,
           toll_gold, access_revision
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (traveler_player_id, request_id) DO NOTHING
         RETURNING request_id`,
        [input.travelerPlayerId, input.requestId, input.flagId,
          authorization.ownerPlayerId, authorization.mode,
          chargedToll.toString(), authorization.accessRevision.toString()]
      );
      if (!inserted.rowCount) {
        const replay = await client.query<{
          flag_id: string;
          owner_player_id: string;
          access_mode: string;
          toll_gold: string;
          access_revision: string;
          completed_at: Date | null;
        }>(
          `SELECT flag_id, owner_player_id, access_mode, toll_gold::text,
                  access_revision::text, completed_at
           FROM flag_travel_commands
           WHERE traveler_player_id = $1 AND request_id = $2
           FOR UPDATE`,
          [input.travelerPlayerId, input.requestId]
        );
        const command = replay.rows[0];
        if (!command || !command.completed_at) {
          throw new FlagAccessError("TRAVEL_FAILED", "Travel command is incomplete.");
        }
        if (command.flag_id !== input.flagId || command.owner_player_id !== authorization.ownerPlayerId) {
          throw new FlagAccessError("FLAG_CHANGED", "The flag changed. Review it before travelling.");
        }
        if (
          command.access_mode !== authorization.mode ||
          BigInt(command.toll_gold) !== chargedToll ||
          BigInt(command.access_revision) !== authorization.accessRevision
        ) {
          throw new FlagAccessError("ACCESS_CHANGED", "Flag access changed. Review it before travelling.");
        }
        const travelerGoldBalance = await walletBalance(client, input.travelerPlayerId);
        const ownerGoldBalance = await walletBalance(client, authorization.ownerPlayerId);
        await client.query("COMMIT");
        return { authorization, value: null, replayed: true, travelerGoldBalance, ownerGoldBalance };
      }

      const value = await input.commit(client, authorization);
      let travelerGoldBalance: string | null = null;
      let ownerGoldBalance: string | null = null;
      if (chargedToll > 0n) {
        if (!authorization.travelerAccountId || !authorization.ownerAccountId) {
          throw new FlagAccessError("FLAG_CHANGED", "Authoritative wallet ownership changed.");
        }
        await ensureAndLockWallets(client, [
          [input.travelerPlayerId, authorization.travelerAccountId],
          [authorization.ownerPlayerId, authorization.ownerAccountId]
        ]);
        try {
          const debit = await this.wallet.debitForOperationInTransaction(client, {
            playerId: input.travelerPlayerId,
            accountId: authorization.travelerAccountId,
            amount: chargedToll,
            operationKey: `flag-toll:${input.requestId}:traveler`,
            reason: "flag_jump_toll",
            metadata: {
              flagId: input.flagId,
              travelerPlayerId: input.travelerPlayerId,
              ownerPlayerId: authorization.ownerPlayerId,
              travelRequestId: input.requestId,
              tollGold: chargedToll.toString(),
              accessMode: authorization.mode,
              direction: "debit"
            }
          });
          const credit = await this.wallet.creditForOperationInTransaction(client, {
            playerId: authorization.ownerPlayerId,
            accountId: authorization.ownerAccountId,
            amount: chargedToll,
            operationKey: `flag-toll:${input.requestId}:owner`,
            reason: "flag_jump_toll",
            metadata: {
              flagId: input.flagId,
              travelerPlayerId: input.travelerPlayerId,
              ownerPlayerId: authorization.ownerPlayerId,
              travelRequestId: input.requestId,
              tollGold: chargedToll.toString(),
              accessMode: authorization.mode,
              direction: "credit"
            }
          });
          travelerGoldBalance = debit.goldBalance.toString();
          ownerGoldBalance = credit.goldBalance.toString();
        } catch (error) {
          if (error instanceof WalletOperationError && error.code === "WALLET_INSUFFICIENT_FUNDS") {
            const current = BigInt(await walletBalance(client, input.travelerPlayerId) ?? "0");
            throw new FlagAccessError(
              "INSUFFICIENT_GOLD",
              `You need ${chargedToll - current} more gold to travel.`,
              { requiredGold: (chargedToll - current).toString() }
            );
          }
          throw error;
        }
      }
      await client.query(
        `UPDATE flag_travel_commands SET completed_at = now()
         WHERE traveler_player_id = $1 AND request_id = $2`,
        [input.travelerPlayerId, input.requestId]
      );
      await client.query("COMMIT");
      return { authorization, value, replayed: false, travelerGoldBalance, ownerGoldBalance };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async updateSettings(input: Readonly<{
    ownerPlayerId: string;
    flagId: string;
    mode: FlagAccessMode;
    jumpTollGold: string;
  }>): Promise<FlagAccessSnapshot> {
    // The owner's chosen mode applies whether or not they are Settled
    // (owner decision 2026-10-15).
    const toll = parseRequiredToll(input.jumpTollGold);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockOwnedPersonalFlag(client, input.flagId, input.ownerPlayerId);
      const nextToll = input.mode === "private" ? 0n : toll;
      await client.query(
        `UPDATE flags
         SET access_mode = $3, jump_toll_gold = $4
         WHERE id = $1 AND owner_id = $2`,
        [input.flagId, input.ownerPlayerId, input.mode, nextToll.toString()]
      );
      await client.query("COMMIT");
      return this.snapshotForPlayer(input.flagId, input.ownerPlayerId);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async requestPassage(input: Readonly<{
    flagId: string;
    requesterPlayerId: string;
    requestId: string;
  }>): Promise<Readonly<{ request: FlagPassageRequestSnapshot; ownerPlayerId: string; replayed: boolean }>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `flag-passage-request:${input.requesterPlayerId}:${input.requestId}`
      ]);
      const replay = await replayPassageRequest(client, input.requesterPlayerId, input.requestId);
      if (replay) {
        if (replay.source_flag_id && replay.source_flag_id !== input.flagId) {
          throw new FlagAccessError("PASSAGE_REQUEST_CONFLICT", "Passage request ID conflicts with another flag.");
        }
        await client.query("COMMIT");
        return { request: passageSnapshot(replay), ownerPlayerId: replay.owner_player_id, replayed: true };
      }
      const authorization = await this.authorizeWith(client, input.flagId, input.requesterPlayerId, true);
      await expireNormalPassageRequests(client, authorization.ownerPlayerId, this.now());
      if (!authorization.decision.requestable) {
        if (authorization.decision.reasonCode === "NORMAL_REQUEST_PENDING") {
          throw new FlagAccessError("PASSAGE_REQUEST_EXISTS", "A passage request is already pending.");
        }
        if (authorization.decision.allowed) {
          throw new FlagAccessError("FLAG_ACCESS_INVALID", "Passage is already available.");
        }
        throw accessDenied(authorization.decision);
      }
      if (authorization.mode !== "normal") {
        throw new FlagAccessError("FLAG_ACCESS_INVALID", "This flag does not support passage requests.");
      }
      const createdAt = this.now();
      const cooldown = new Date(createdAt.getTime() - FLAG_PASSAGE_REQUEST_COOLDOWN_MS);
      const recent = await client.query(
        `SELECT 1 FROM normal_flag_passage_requests
         WHERE owner_player_id = $1 AND requester_player_id = $2 AND created_at > $3 LIMIT 1`,
        [authorization.ownerPlayerId, input.requesterPlayerId, cooldown]
      );
      if (recent.rowCount) {
        throw new FlagAccessError("PASSAGE_REQUEST_RATE_LIMITED", "Please wait before requesting passage again.");
      }
      const result = await client.query<PassageRow>(
        `INSERT INTO normal_flag_passage_requests (
           id, owner_player_id, requester_player_id, source_flag_id,
           create_request_id, created_at, expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, owner_player_id, requester_player_id,
                   (SELECT username FROM players WHERE id = requester_player_id) AS requester_name,
                   source_flag_id,
                   (SELECT name FROM flags WHERE id = source_flag_id) AS source_flag_name,
                   status, created_at, expires_at, resolution_request_id`,
        [
          this.createId(),
          authorization.ownerPlayerId,
          input.requesterPlayerId,
          input.flagId,
          input.requestId,
          createdAt,
          new Date(createdAt.getTime() + FLAG_PASSAGE_REQUEST_TTL_MS)
        ]
      );
      await client.query("COMMIT");
      return {
        request: passageSnapshot(result.rows[0]!),
        ownerPlayerId: authorization.ownerPlayerId,
        replayed: false
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async resolvePassageRequest(input: Readonly<{
    ownerPlayerId: string;
    flagId: string;
    passageRequestId: string;
    requestId: string;
    action: "approve" | "deny";
  }>): Promise<FlagAccessSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `flag-passage-resolution:${input.ownerPlayerId}:${input.requestId}`
      ]);
      const request = await lockPassageRequest(client, input.passageRequestId);
      if (!request || request.owner_player_id !== input.ownerPlayerId) {
        throw new FlagAccessError("PASSAGE_REQUEST_NOT_FOUND", "Passage request not found.");
      }
      await lockAccessPair(client, input.ownerPlayerId, request.requester_player_id);
      if (request.status !== "pending") {
        if (request.resolution_request_id === input.requestId) {
          await client.query("COMMIT");
          return this.snapshotForPlayer(input.flagId, input.ownerPlayerId);
        }
        throw new FlagAccessError("PASSAGE_REQUEST_NOT_PENDING", "This passage request is no longer pending.");
      }
      const eligible = await client.query<{ id: string }>(
        `SELECT id FROM flags WHERE owner_id = $1 AND control_type = 'personal'
         AND access_mode = 'normal' AND developer_test_target = false
         ORDER BY id LIMIT 1`,
        [input.ownerPlayerId]
      );
      if (!eligible.rows[0]) {
        throw new FlagAccessError("ACCESS_CHANGED", "This request scope has no current eligible flags.");
      }
      const authorization = await this.authorizeWith(
        client, eligible.rows[0].id, request.requester_player_id, true
      );
      if (input.action === "approve") {
        if (authorization.decision.reasonCode === "NORMAL_ENEMY_BLOCKED") {
          throw new FlagAccessError("NORMAL_ENEMY_BLOCKED", "Enemy passage requests cannot be approved.");
        }
        await client.query(
          `INSERT INTO normal_flag_passage_grants (
             owner_player_id, grantee_player_id, granted_by_player_id
           ) VALUES ($1,$2,$1)
           ON CONFLICT (owner_player_id, grantee_player_id) DO UPDATE
           SET granted_by_player_id = EXCLUDED.granted_by_player_id, granted_at = now()`,
          [input.ownerPlayerId, request.requester_player_id]
        );
      }
      await client.query(
        `UPDATE normal_flag_passage_requests
         SET status = $2, resolution_request_id = $3, resolved_at = $4
         WHERE id = $1 AND owner_player_id = $5 AND status = 'pending'`,
        [
          request.id,
          input.action === "approve" ? "approved" : "denied",
          input.requestId,
          this.now(),
          input.ownerPlayerId
        ]
      );
      await client.query("COMMIT");
      return this.snapshotForPlayer(input.flagId, input.ownerPlayerId);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async passageRequestForOwner(
    ownerPlayerId: string,
    requestId: string
  ): Promise<FlagPassageRequestSnapshot | null> {
    const result = await this.pool.query<PassageRow>(
      `${NORMAL_REQUEST_SELECT} WHERE request.id = $1 AND request.owner_player_id = $2`,
      [requestId, ownerPlayerId]
    );
    return result.rows[0] ? passageSnapshot(result.rows[0]) : null;
  }

  async dashboard(ownerPlayerId: string): Promise<FlagManagementDashboardSnapshot> {
    await expireNormalPassageRequests(this.pool, ownerPlayerId, this.now());
    const [preferences, flags, grants, requests, ownedFlagCounts] = await Promise.all([
      this.getPreferences(ownerPlayerId),
      this.pool.query<{
        id: string;
        name: string;
        anchor_kind: "flag" | "buoy";
        access_mode: string;
        jump_toll_gold: string;
        lat: number;
        lon: number;
        access_revision: string;
        atlas_shrine_slot_number: number | null;
      }>(
        `SELECT id, name, anchor_kind, access_mode, jump_toll_gold::text, lat, lon,
                access_revision::text, atlas_shrine_slot_number
         FROM flags
         WHERE owner_id = $1
           AND control_type = 'personal'
           AND city_id IS NULL
           AND kingdom_id IS NULL
           AND developer_test_target = false
         ORDER BY name, id LIMIT $2`,
        [ownerPlayerId, MAX_OWNED_FLAGS_DASHBOARD + 1]
      ),
      this.pool.query<{
        owner_player_id: string;
        grantee_player_id: string;
        username: string;
        granted_at: Date | string;
      }>(
        `SELECT passage.owner_player_id, passage.grantee_player_id, player.username, passage.granted_at
         FROM normal_flag_passage_grants passage
         JOIN players player ON player.id = passage.grantee_player_id
         WHERE passage.owner_player_id = $1
         ORDER BY player.username, player.id LIMIT $2`,
        [ownerPlayerId, MAX_NORMAL_PASSAGE_GRANTS + 1]
      ),
      this.pool.query<PassageRow>(
        `${NORMAL_REQUEST_SELECT}
         WHERE request.owner_player_id = $1 AND request.status = 'pending'
         ORDER BY request.created_at, request.id LIMIT $2`,
        [ownerPlayerId, MAX_PENDING_PASSAGE_REQUESTS + 1]
      ),
      this.pool.query<{ access_mode: string; count: string }>(
        `SELECT access_mode,count(*)::text AS count
         FROM flags
         WHERE owner_id=$1 AND control_type='personal' AND developer_test_target = false
         GROUP BY access_mode`,
        [ownerPlayerId]
      )
    ]);
    return {
      preferences,
      flags: flags.rows.slice(0, MAX_OWNED_FLAGS_DASHBOARD).map((row) => ({
        flagId: row.id,
        flagName: row.name.trim() || (row.anchor_kind === "buoy" ? "Unnamed Buoy" : "Unnamed Flag"),
        anchorKind: row.anchor_kind,
        mode: isAccessMode(row.access_mode) ? row.access_mode : "private",
        jumpTollGold: row.jump_toll_gold,
        lat: row.lat,
        lon: row.lon,
        areaLabel: "",
        accessRevision: row.access_revision,
        ...(row.atlas_shrine_slot_number === null
          ? {}
          : { atlasShrineSlotNumber: Number(row.atlas_shrine_slot_number) })
      })),
      ownedFlagCountsByMode: {
        private: Number(ownedFlagCounts.rows.find((row) => row.access_mode === "private")?.count ?? 0),
        public: Number(ownedFlagCounts.rows.find((row) => row.access_mode === "public")?.count ?? 0),
        normal: Number(ownedFlagCounts.rows.find((row) => row.access_mode === "normal")?.count ?? 0)
      },
      normalGrants: grants.rows.slice(0, MAX_NORMAL_PASSAGE_GRANTS).map((row) => ({
        ownerPlayerId: row.owner_player_id,
        granteePlayerId: row.grantee_player_id,
        granteeName: row.username,
        grantedAt: iso(row.granted_at)
      })),
      normalRequests: requests.rows.slice(0, MAX_PENDING_PASSAGE_REQUESTS).map(passageSnapshot),
      truncated: flags.rows.length > MAX_OWNED_FLAGS_DASHBOARD ||
        grants.rows.length > MAX_NORMAL_PASSAGE_GRANTS ||
        requests.rows.length > MAX_PENDING_PASSAGE_REQUESTS
    };
  }

  async getPreferences(ownerPlayerId: string): Promise<FlagOwnerPreferencesSnapshot> {
    const result = await this.pool.query<{
      default_flag_access_mode: string;
      default_public_toll_gold: string;
      default_normal_toll_gold: string;
    }>(
      `INSERT INTO player_flag_preferences (owner_player_id) VALUES ($1)
       ON CONFLICT (owner_player_id) DO UPDATE SET owner_player_id = EXCLUDED.owner_player_id
       RETURNING default_flag_access_mode, default_public_toll_gold::text,
                 default_normal_toll_gold::text`,
      [ownerPlayerId]
    );
    const row = result.rows[0]!;
    return {
      defaultFlagAccessMode: isAccessMode(row.default_flag_access_mode)
        ? row.default_flag_access_mode
        : "private",
      defaultPublicTollGold: row.default_public_toll_gold,
      defaultNormalTollGold: row.default_normal_toll_gold
    };
  }

  async updatePreferences(
    ownerPlayerId: string,
    input: FlagOwnerPreferencesSnapshot
  ): Promise<FlagOwnerPreferencesSnapshot> {
    const publicToll = parseRequiredToll(input.defaultPublicTollGold);
    const normalToll = parseRequiredToll(input.defaultNormalTollGold);
    await this.pool.query(
      `INSERT INTO player_flag_preferences (
         owner_player_id, default_flag_access_mode, default_public_toll_gold,
         default_normal_toll_gold
       ) VALUES ($1,$2,$3,$4)
       ON CONFLICT (owner_player_id) DO UPDATE SET
         default_flag_access_mode = EXCLUDED.default_flag_access_mode,
         default_public_toll_gold = EXCLUDED.default_public_toll_gold,
         default_normal_toll_gold = EXCLUDED.default_normal_toll_gold`,
      [
        ownerPlayerId,
        input.defaultFlagAccessMode,
        publicToll.toString(),
        normalToll.toString()
      ]
    );
    return input;
  }

  async bulkUpdateToll(
    ownerPlayerId: string,
    mode: "public" | "normal",
    tollGold: string
  ): Promise<number> {
    const toll = parseRequiredToll(tollGold);
    const result = await this.pool.query(
      `UPDATE flags SET jump_toll_gold = $3
       WHERE owner_id = $1 AND control_type = 'personal' AND access_mode = $2
         AND developer_test_target = false`,
      [ownerPlayerId, mode, toll.toString()]
    );
    return result.rowCount ?? 0;
  }

  async setNormalGrant(
    ownerPlayerId: string,
    granteePlayerId: string,
    allowed: boolean
  ): Promise<void> {
    if (ownerPlayerId === granteePlayerId) {
      throw new FlagAccessError("FLAG_ACCESS_INVALID", "Owners already have access.");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockAccessPair(client, ownerPlayerId, granteePlayerId);
      const eligible = await client.query(
        `SELECT 1 FROM flags WHERE owner_id = $1 AND control_type = 'personal'
         AND access_mode = 'normal' AND developer_test_target = false LIMIT 1 FOR SHARE`,
        [ownerPlayerId]
      );
      if (!eligible.rowCount) {
        throw new FlagAccessError("ACCESS_CHANGED", "You do not have a Normal flag.");
      }
      if (allowed) {
        const player = await client.query("SELECT 1 FROM players WHERE id = $1 FOR SHARE", [granteePlayerId]);
        if (!player.rowCount) throw new FlagAccessError("PLAYER_NOT_FOUND", "Player not found.");
        const enemy = await client.query(
          `SELECT 1 FROM player_enemy_marks WHERE
           (owner_id = $1 AND target_id = $2) OR (owner_id = $2 AND target_id = $1) LIMIT 1`,
          [ownerPlayerId, granteePlayerId]
        );
        if (enemy.rowCount) {
          throw new FlagAccessError("NORMAL_ENEMY_BLOCKED", "Enemy passage cannot be granted.");
        }
        const count = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM normal_flag_passage_grants
           WHERE owner_player_id = $1 AND grantee_player_id <> $2`,
          [ownerPlayerId, granteePlayerId]
        );
        if (Number(count.rows[0]!.count) >= MAX_NORMAL_PASSAGE_GRANTS) {
          throw new FlagAccessError("FLAG_OVERRIDE_LIMIT_REACHED", "Normal passage grant limit reached.");
        }
        await client.query(
          `INSERT INTO normal_flag_passage_grants (
             owner_player_id, grantee_player_id, granted_by_player_id
           ) VALUES ($1,$2,$1)
           ON CONFLICT (owner_player_id, grantee_player_id) DO UPDATE
           SET granted_by_player_id = EXCLUDED.granted_by_player_id, granted_at = now()`,
          [ownerPlayerId, granteePlayerId]
        );
      } else {
        await client.query(
          `DELETE FROM normal_flag_passage_grants
           WHERE owner_player_id = $1 AND grantee_player_id = $2`,
          [ownerPlayerId, granteePlayerId]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async searchPlayers(ownerPlayerId: string, query: string): Promise<Array<Readonly<{
    playerId: string;
    playerName: string;
  }>>> {
    const normalized = query.trim().replace(/[%_]/g, "");
    if (normalized.length < 2) return [];
    const result = await this.pool.query<{ id: string; username: string }>(
      `SELECT id, username FROM players
       WHERE id <> $1 AND username ILIKE '%' || $2 || '%'
       ORDER BY CASE WHEN lower(username) = lower($2) THEN 0 ELSE 1 END,
                username, id
       LIMIT 20`,
      [ownerPlayerId, normalized]
    );
    return result.rows.map((row) => ({ playerId: row.id, playerName: row.username }));
  }

  private async authorizeWith(
    queryable: Queryable,
    flagId: string,
    travelerPlayerId: string,
    lock: boolean,
    companionHostPlayerId?: string
  ): Promise<Authorization> {
    if (lock) {
      const observed = await queryable.query<{ owner_id: string }>(
        "SELECT owner_id FROM flags WHERE id = $1",
        [flagId]
      );
      if (!observed.rows[0]) return missingAuthorization(flagId);
      await lockAccessPair(queryable, observed.rows[0].owner_id, travelerPlayerId);
      const flag = await queryable.query<{ owner_id: string }>(
        "SELECT owner_id FROM flags WHERE id = $1 FOR UPDATE",
        [flagId]
      );
      if (!flag.rows[0]) return missingAuthorization(flagId);
      if (flag.rows[0].owner_id !== observed.rows[0].owner_id) {
        throw new FlagAccessError(
          "OWNER_CHANGED",
          "The flag owner changed. Review the destination before travelling."
        );
      }
    }
    const result = await queryable.query<AccessRow>(
      `SELECT f.id, f.control_type, f.owner_id, f.access_mode,
              f.developer_test_target, f.territory_collapse_id IS NOT NULL AS collapsing,
              f.jump_toll_gold::text, f.access_revision::text,
              EXISTS (
                SELECT 1 FROM normal_flag_passage_grants passage
                WHERE passage.owner_player_id = f.owner_id
                  AND passage.grantee_player_id = $2
              ) AS normal_grant,
              EXISTS (
                SELECT 1 FROM normal_flag_passage_requests request
                WHERE f.access_mode = 'normal'
                  AND request.owner_player_id = f.owner_id
                  AND request.requester_player_id = $2
                  AND request.status = 'pending' AND request.expires_at > $3
              ) AS pending_request,
              EXISTS (
                SELECT 1 FROM player_enemy_marks enemy
                WHERE (enemy.owner_id = f.owner_id AND enemy.target_id = $2)
                   OR (enemy.owner_id = $2 AND enemy.target_id = f.owner_id)
              ) AS enemy_blocked,
              f.war_structure_kind,
              EXISTS (
                SELECT 1 FROM kingdom_memberships membership
                WHERE membership.kingdom_id = f.kingdom_id AND membership.player_id = $2
                  AND membership.status = 'active'
              ) AS kingdom_member,
              traveler.account_id::text AS traveler_account_id,
              owner.account_id::text AS owner_account_id
       FROM flags f
       LEFT JOIN players traveler ON traveler.id = $2
       LEFT JOIN players owner ON owner.id = f.owner_id
       WHERE f.id = $1`,
      [flagId, travelerPlayerId, this.now()]
    );
    const row = result.rows[0];
    if (!row) return missingAuthorization(flagId);
    const mode = isAccessMode(row.access_mode) ? row.access_mode : null;
    const jumpTollGold = safeBigInt(row.jump_toll_gold);
    // A collapsing city / kingdom flag is no longer a travel destination.
    // A War Outpost is a forward travel point for its kingdom's members only;
    // a War Tower is never a travel destination.
    const decision = row.collapsing
      ? denied("FLAG_TYPE_UNSUPPORTED")
      : row.war_structure_kind === "war_outpost"
      ? row.kingdom_member ? allowed("ALLOWED_OWNER", 0n) : denied("PRIVATE_OWNER_ONLY")
      : row.war_structure_kind !== null
      ? denied("FLAG_NOT_TRAVEL_DESTINATION")
      : row.developer_test_target
      ? denied(
        row.access_mode === "public"
          ? "PUBLIC_ENEMY_BLOCKED"
          : row.access_mode === "normal"
            ? "NORMAL_ENEMY_BLOCKED"
            : "PRIVATE_OWNER_ONLY"
      )
      : decidePersonalFlagAccess({
        controlType: row.control_type,
        ownerPlayerId: row.owner_id,
        travelerPlayerId,
        ...(companionHostPlayerId === undefined ? {} : { companionHostPlayerId }),
        mode,
        jumpTollGold,
        normalPassage: row.normal_grant,
        enemyBlocked: row.enemy_blocked,
        requestPending: row.pending_request
      });
    return {
      flagId: row.id,
      controlType: row.control_type,
      ownerPlayerId: row.owner_id,
      developerTestTarget: row.developer_test_target,
      mode,
      jumpTollGold,
      accessRevision: safeRevision(row.access_revision),
      travelerAccountId: row.traveler_account_id,
      ownerAccountId: row.owner_account_id,
      decision
    };
  }

  private async normalManagement(ownerPlayerId: string): Promise<FlagAccessManagementSnapshot> {
    await expireNormalPassageRequests(this.pool, ownerPlayerId, this.now());
    const requests = await this.pool.query<PassageRow>(
      `${NORMAL_REQUEST_SELECT}
       WHERE request.owner_player_id = $1 AND request.status = 'pending'
       ORDER BY request.created_at, request.id LIMIT $2`,
      [ownerPlayerId, MAX_PENDING_PASSAGE_REQUESTS]
    );
    return { pendingRequests: requests.rows.map(passageSnapshot) };
  }
}

type PassageRow = {
  id: string;
  owner_player_id: string;
  requester_player_id: string;
  requester_name: string;
  source_flag_id: string | null;
  source_flag_name: string | null;
  status: FlagPassageRequestSnapshot["status"];
  created_at: Date | string;
  expires_at: Date | string;
  resolution_request_id?: string | null;
};

const NORMAL_REQUEST_SELECT = `SELECT request.id, request.owner_player_id,
  request.requester_player_id, player.username AS requester_name,
  request.source_flag_id, flag.name AS source_flag_name,
  request.status, request.created_at, request.expires_at, request.resolution_request_id
  FROM normal_flag_passage_requests request
  JOIN players player ON player.id = request.requester_player_id
  LEFT JOIN flags flag ON flag.id = request.source_flag_id`;

function accessDenied(decision: FlagAccessDecision): FlagAccessError {
  return new FlagAccessError(decision.reasonCode, decideMessage(decision.reasonCode));
}

function decideMessage(code: FlagAccessDecision["reasonCode"]): string {
  switch (code) {
    case "PRIVATE_OWNER_ONLY": return "This is a Private flag.";
    case "PUBLIC_ENEMY_BLOCKED": return "Enemies cannot use this Public flag.";
    case "NORMAL_PASSAGE_REQUIRED": return "Normal passage from this owner is required.";
    case "NORMAL_ENEMY_BLOCKED": return "Enemies cannot receive Normal passage.";
    case "NORMAL_REQUEST_PENDING": return "Your Normal passage request is pending.";
    case "FLAG_TYPE_UNSUPPORTED": return "This destination does not use personal flag access.";
    case "FLAG_NOT_FOUND": return "Flag does not exist.";
    default: return "Flag travel is unavailable.";
  }
}

type AllowedReason = "ALLOWED_OWNER" | "ALLOWED_INVITE" | "ALLOWED_PUBLIC" | "ALLOWED_NORMAL";

function allowed(reasonCode: AllowedReason, tollGold: bigint): FlagAccessDecision {
  return { allowed: true, requestable: false, reasonCode, tollGold: tollGold.toString() };
}

function denied(
  reasonCode: Exclude<FlagAccessDecision["reasonCode"], AllowedReason>,
  requestable = false
): FlagAccessDecision {
  return { allowed: false, requestable, reasonCode, tollGold: "0" };
}

function missingAuthorization(flagId: string): Authorization {
  return {
    flagId,
    controlType: "missing",
    ownerPlayerId: "",
    developerTestTarget: false,
    mode: null,
    jumpTollGold: 0n,
    accessRevision: 0n,
    travelerAccountId: null,
    ownerAccountId: null,
    decision: denied("FLAG_NOT_FOUND")
  };
}

function isAccessMode(value: string): value is FlagAccessMode {
  return value === "private" || value === "public" || value === "normal";
}

function parseExpectedToll(value: string | undefined): bigint | null {
  return value === undefined ? null : parseRequiredToll(value);
}

function parseRequiredToll(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,15})$/.test(value)) {
    throw new FlagAccessError("FLAG_ACCESS_INVALID", "Toll must be a whole nonnegative amount of gold.");
  }
  const toll = BigInt(value);
  if (toll > MAX_FLAG_JUMP_TOLL_GOLD) {
    throw new FlagAccessError(
      "FLAG_ACCESS_INVALID",
      `Toll cannot exceed ${MAX_FLAG_JUMP_TOLL_GOLD} gold.`
    );
  }
  return toll;
}

function safeBigInt(value: string): bigint {
  try {
    const parsed = BigInt(value);
    return parsed >= 0n && parsed <= MAX_FLAG_JUMP_TOLL_GOLD ? parsed : 0n;
  } catch {
    return 0n;
  }
}

function safeRevision(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

async function lockOwnedPersonalFlag(
  client: pg.PoolClient,
  flagId: string,
  ownerPlayerId: string
): Promise<void> {
  const result = await client.query(
    `SELECT 1 FROM flags
     WHERE id = $1 AND owner_id = $2 AND control_type = 'personal'
       AND developer_test_target = false FOR UPDATE`,
    [flagId, ownerPlayerId]
  );
  if (!result.rowCount) {
    throw new FlagAccessError("FLAG_ACCESS_FORBIDDEN", "You cannot manage access for this flag.");
  }
}

async function lockAccessPair(queryable: Queryable, first: string, second: string): Promise<void> {
  const [low, high] = [first, second].sort();
  await queryable.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`flag-access-pair:${low}:${high}`]
  );
}

async function expireNormalPassageRequests(
  queryable: Queryable,
  ownerId: string,
  now: Date
): Promise<void> {
  await queryable.query(
    `UPDATE normal_flag_passage_requests SET status = 'expired', resolved_at = $2
     WHERE owner_player_id = $1 AND status = 'pending' AND expires_at <= $2`,
    [ownerId, now]
  );
}

async function replayPassageRequest(
  client: pg.PoolClient,
  requesterId: string,
  requestId: string
): Promise<PassageRow | null> {
  const result = await client.query<PassageRow>(
    `${NORMAL_REQUEST_SELECT}
     WHERE request.requester_player_id = $1 AND request.create_request_id = $2
     FOR UPDATE OF request`,
    [requesterId, requestId]
  );
  return result.rows[0] ?? null;
}

async function lockPassageRequest(
  client: pg.PoolClient,
  id: string
): Promise<PassageRow | null> {
  const result = await client.query<PassageRow>(
    `${NORMAL_REQUEST_SELECT} WHERE request.id = $1 FOR UPDATE OF request`,
    [id]
  );
  return result.rows[0] ?? null;
}

async function ensureAndLockWallets(
  client: pg.PoolClient,
  identities: readonly (readonly [string, string])[]
): Promise<void> {
  for (const [playerId, accountId] of identities) {
    await client.query(
      `INSERT INTO player_wallets (player_id, account_id, gold_balance, version)
       SELECT id, account_id, 0, 0 FROM players
       WHERE id = $1 AND account_id = $2
       ON CONFLICT (player_id) DO NOTHING`,
      [playerId, accountId]
    );
  }
  await client.query(
    `SELECT player_id FROM player_wallets
     WHERE player_id = ANY($1::text[])
     ORDER BY player_id FOR UPDATE`,
    [identities.map(([playerId]) => playerId).sort()]
  );
}

async function walletBalance(queryable: Queryable, playerId: string): Promise<string | null> {
  const result = await queryable.query<{ gold_balance: string }>(
    "SELECT gold_balance::text FROM player_wallets WHERE player_id = $1",
    [playerId]
  );
  return result.rows[0]?.gold_balance ?? null;
}

function passageSnapshot(row: PassageRow): FlagPassageRequestSnapshot {
  return {
    id: row.id,
    scope: "normal_owner",
    ownerPlayerId: row.owner_player_id,
    requesterPlayerId: row.requester_player_id,
    requesterName: row.requester_name,
    sourceFlagId: row.source_flag_id,
    sourceFlagName: row.source_flag_name,
    status: row.status,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at)
  };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
