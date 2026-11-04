import type pg from "pg";

export const CURRENT_COMMUNITY_RULES_VERSION = "2026-09-15-v1" as const;

export const UGC_REPORT_CATEGORIES = [
  "harassment",
  "hate",
  "sexual",
  "threat",
  "illegal",
  "spam",
  "cheating",
  "other"
] as const;

export type UgcReportCategory = (typeof UGC_REPORT_CATEGORIES)[number];
export type UgcReportTarget =
  | { kind: "message"; messageId: string }
  | { kind: "player"; playerId: string };

export type UgcReport = Readonly<{
  id: string;
  reporterPlayerId: string;
  target: UgcReportTarget;
  channelId: string | null;
  category: UgcReportCategory;
  explanation: string | null;
  status: "pending" | "reviewing" | "actioned" | "dismissed";
  createdAt: string;
}>;

type Queryable = Pick<pg.Pool, "query">;

type AcceptanceRow = {
  accepted_at: Date | string | null;
};

type ReportRow = {
  id: string;
  reporter_player_id: string;
  target_kind: "message" | "player";
  target_message_id: string | null;
  target_player_id: string | null;
  channel_id: string | null;
  category: UgcReportCategory;
  explanation: string | null;
  status: UgcReport["status"];
  created_at: Date | string;
};

export class CommunitySafetyError extends Error {
  constructor(
    readonly code:
      | "TERMS_VERSION_UNSUPPORTED"
      | "REPORT_INVALID"
      | "REPORT_TARGET_UNAVAILABLE"
      | "REPORT_SELF"
      | "REPORT_DUPLICATE",
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
    this.name = "CommunitySafetyError";
  }
}

export class CommunitySafetyService {
  constructor(
    private readonly pool: Queryable,
    private readonly now: () => Date = () => new Date()
  ) {}

  async hasCurrentTermsAcceptance(playerId: string): Promise<boolean> {
    const result = await this.pool.query<AcceptanceRow>(
      `SELECT accepted_at
         FROM player_terms_acceptances
        WHERE player_id = $1 AND terms_version = $2
        LIMIT 1`,
      [playerId, CURRENT_COMMUNITY_RULES_VERSION]
    );
    return result.rows[0]?.accepted_at !== undefined;
  }

  async acceptCurrentTerms(playerId: string): Promise<{ version: string; acceptedAt: string }> {
    const acceptedAt = this.now();
    const result = await this.pool.query<AcceptanceRow>(
      `INSERT INTO player_terms_acceptances (player_id, terms_version, accepted_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (player_id, terms_version)
       DO UPDATE SET accepted_at = player_terms_acceptances.accepted_at
       RETURNING accepted_at`,
      [playerId, CURRENT_COMMUNITY_RULES_VERSION, acceptedAt]
    );
    const stored = result.rows[0]?.accepted_at;
    if (!stored) throw new Error("Community rules acceptance was not stored");
    return {
      version: CURRENT_COMMUNITY_RULES_VERSION,
      acceptedAt: new Date(stored).toISOString()
    };
  }

  async createReport(input: {
    reporterPlayerId: string;
    target: UgcReportTarget;
    category: string;
    explanation?: string | null;
  }): Promise<UgcReport> {
    const category = parseCategory(input.category);
    const explanation = normalizeExplanation(input.explanation);
    if (input.target.kind === "message" && !isUuid(input.target.messageId)) {
      throw new CommunitySafetyError("REPORT_INVALID", "That message report target is invalid.");
    }
    if (input.target.kind === "player" && input.target.playerId === input.reporterPlayerId) {
      throw new CommunitySafetyError("REPORT_SELF", "You cannot report your own account.");
    }

    let result: pg.QueryResult<ReportRow>;
    try {
      result = await this.pool.query<ReportRow>(
        input.target.kind === "message"
          ? `WITH target AS (
             SELECT m.id, m.sender_player_id, m.channel_id
               FROM chat_messages m
              WHERE m.id = $2 AND m.deleted_at IS NULL
           )
           INSERT INTO ugc_reports (
             id, reporter_player_id, target_kind, target_message_id, channel_id,
             category, explanation, created_at, updated_at
           )
           SELECT $1, $3, 'message', target.id, target.channel_id, $4, $5, $6, $6
             FROM target
           WHERE target.sender_player_id <> $3
             AND NOT EXISTS (
               SELECT 1 FROM ugc_reports existing
                WHERE existing.reporter_player_id = $3
                  AND existing.target_message_id = target.id
                  AND existing.status IN ('pending', 'reviewing')
             )
           RETURNING id, reporter_player_id, target_kind, target_message_id,
                     target_player_id, channel_id, category, explanation, status, created_at`
          : `WITH target AS (
             SELECT id FROM players WHERE id = $2
           )
           INSERT INTO ugc_reports (
             id, reporter_player_id, target_kind, target_player_id,
             category, explanation, created_at, updated_at
           )
           SELECT $1, $3, 'player', target.id, $4, $5, $6, $6
             FROM target
           WHERE target.id <> $3
             AND NOT EXISTS (
               SELECT 1 FROM ugc_reports existing
                WHERE existing.reporter_player_id = $3
                  AND existing.target_player_id = target.id
                  AND existing.status IN ('pending', 'reviewing')
             )
           RETURNING id, reporter_player_id, target_kind, target_message_id,
                     target_player_id, channel_id, category, explanation, status, created_at`,
        [crypto.randomUUID(), targetId(input.target), input.reporterPlayerId, category, explanation, this.now()]
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new CommunitySafetyError(
          "REPORT_DUPLICATE",
          "You already have an open report for that target",
          409
        );
      }
      throw error;
    }
    const row = result.rows[0];
    if (!row) {
      const targetExists = await this.targetExists(input.target);
      if (!targetExists) {
        throw new CommunitySafetyError("REPORT_TARGET_UNAVAILABLE", "That report target is unavailable", 404);
      }
      throw new CommunitySafetyError(
        "REPORT_DUPLICATE",
        "You already have an open report for that target",
        409
      );
    }
    return reportFromRow(row);
  }

  async listOpenReports(limit = 100): Promise<UgcReport[]> {
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 250);
    const result = await this.pool.query<ReportRow>(
      `SELECT id, reporter_player_id, target_kind, target_message_id,
              target_player_id, channel_id, category, explanation, status, created_at
         FROM ugc_reports
        WHERE status IN ('pending', 'reviewing')
        ORDER BY created_at ASC
        LIMIT $1`,
      [boundedLimit]
    );
    return result.rows.map(reportFromRow);
  }

  private async targetExists(target: UgcReportTarget): Promise<boolean> {
    const result = await this.pool.query<{ exists: boolean }>(
      target.kind === "message"
        ? "SELECT EXISTS (SELECT 1 FROM chat_messages WHERE id = $1 AND deleted_at IS NULL) AS exists"
        : "SELECT EXISTS (SELECT 1 FROM players WHERE id = $1) AS exists",
      [targetId(target)]
    );
    return result.rows[0]?.exists === true;
  }
}

function targetId(target: UgcReportTarget): string {
  return target.kind === "message" ? target.messageId : target.playerId;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseCategory(value: string): UgcReportCategory {
  if ((UGC_REPORT_CATEGORIES as readonly string[]).includes(value)) {
    return value as UgcReportCategory;
  }
  throw new CommunitySafetyError("REPORT_INVALID", "Choose a valid report category.");
}

function normalizeExplanation(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  if (normalized.length > 1_000) {
    throw new CommunitySafetyError("REPORT_INVALID", "Report details are too long.");
  }
  return normalized || null;
}

function reportFromRow(row: ReportRow): UgcReport {
  const target: UgcReportTarget = row.target_kind === "message"
    ? { kind: "message", messageId: requireValue(row.target_message_id, "message target") }
    : { kind: "player", playerId: requireValue(row.target_player_id, "player target") };
  return {
    id: row.id,
    reporterPlayerId: row.reporter_player_id,
    target,
    channelId: row.channel_id,
    category: row.category,
    explanation: row.explanation,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString()
  };
}

function requireValue<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`Missing ${label}`);
  return value;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
