import type pg from "pg";

import { CHAT_AUTOMATION_POLICY, CHAT_SERVER_LIMITS } from "./policy.js";
import type { ChatModerationEvent } from "./types.js";

export interface ChatModerationConsumer {
  handle(event: ChatModerationEvent): Promise<void>;
}

export class InProcessChatModerationConsumer implements ChatModerationConsumer {
  constructor(
    private readonly handler: (event: ChatModerationEvent) => void | Promise<void>
  ) {}

  async handle(event: ChatModerationEvent): Promise<void> {
    await this.handler(event);
  }
}

export type ModerationDispatcherMetrics = {
  queueDepth: number;
  peakQueueDepth: number;
  accepted: number;
  processed: number;
  retries: number;
  failures: number;
  droppedAtCapacity: number;
  duplicates: number;
};

type QueuedModerationEvent = { event: ChatModerationEvent; attempt: number };

export class BoundedModerationDispatcher {
  private readonly queue: QueuedModerationEvent[] = [];
  private readonly queuedMessageIds = new Set<string>();
  private flushing: Promise<void> | null = null;
  private flushScheduled = false;
  private readonly metrics: ModerationDispatcherMetrics = {
    queueDepth: 0,
    peakQueueDepth: 0,
    accepted: 0,
    processed: 0,
    retries: 0,
    failures: 0,
    droppedAtCapacity: 0,
    duplicates: 0
  };

  constructor(
    private readonly consumer: ChatModerationConsumer,
    private readonly maximumDepth: number = CHAT_SERVER_LIMITS.moderationQueueDepth,
    private readonly maximumRetries: number = CHAT_SERVER_LIMITS.moderationRetryCount,
    private readonly onDeadLetter?: (event: ChatModerationEvent, error: unknown) => void | Promise<void>
  ) {
    if (maximumDepth < 1 || maximumRetries < 0) {
      throw new Error("Moderation queue bounds are invalid");
    }
  }

  enqueue(event: ChatModerationEvent): boolean {
    if (this.queuedMessageIds.has(event.messageId)) {
      this.metrics.duplicates += 1;
      return true;
    }
    if (this.queue.length >= this.maximumDepth) {
      this.metrics.droppedAtCapacity += 1;
      return false;
    }
    this.queue.push({ event: structuredClone(event), attempt: 0 });
    this.queuedMessageIds.add(event.messageId);
    this.metrics.accepted += 1;
    this.updateDepthMetrics();
    this.scheduleFlush();
    return true;
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.run().finally(() => {
      this.flushing = null;
      if (this.queue.length > 0) this.scheduleFlush();
    });
    return this.flushing;
  }

  metricsSnapshot(): ModerationDispatcherMetrics {
    return { ...this.metrics, queueDepth: this.queue.length };
  }

  private async run(): Promise<void> {
    while (this.queue.length > 0) {
      const queued = this.queue.shift();
      if (!queued) break;
      this.updateDepthMetrics();
      try {
        await this.consumer.handle(queued.event);
        this.queuedMessageIds.delete(queued.event.messageId);
        this.metrics.processed += 1;
      } catch (error) {
        if (queued.attempt < this.maximumRetries) {
          queued.attempt += 1;
          this.metrics.retries += 1;
          this.queue.push(queued);
          this.updateDepthMetrics();
          continue;
        }
        this.queuedMessageIds.delete(queued.event.messageId);
        this.metrics.failures += 1;
        try {
          await this.onDeadLetter?.(queued.event, error);
        } catch {
          // A failed audit sink cannot make the bounded dispatcher retain the event forever.
        }
      }
    }
  }

  private updateDepthMetrics(): void {
    this.metrics.queueDepth = this.queue.length;
    this.metrics.peakQueueDepth = Math.max(this.metrics.peakQueueDepth, this.queue.length);
  }

  private scheduleFlush(): void {
    if (this.flushing || this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      void this.flush();
    });
  }
}

export type ModerationRecommendedAction =
  | "no_action"
  | "flag_for_review"
  | "hide_message"
  | "temporary_channel_mute"
  | "temporary_global_mute";

export type ModerationDecisionInput = {
  decisionId: string;
  messageId: string;
  playerId: string;
  categories: string[];
  confidence: number;
  recommendedAction: ModerationRecommendedAction;
  requestedMuteScope?: "global" | "channel";
  requestedDurationSeconds?: number;
  reason: string;
  policyVersion: string;
  modelVersion?: string | null;
  rulesVersion?: string | null;
  metadata?: Record<string, unknown>;
};

export type AppliedModerationDecision = {
  decisionId: string;
  messageId: string;
  channelId: string;
  playerId: string;
  recommendedAction: ModerationRecommendedAction;
  appliedAction: ModerationRecommendedAction;
  appliedMuteDurationSeconds: number | null;
  confidence: number;
  processingStatus: "applied" | "reversed";
  humanReviewStatus: "not_required" | "pending";
  replayed: boolean;
};

type DecisionRow = {
  decision_id: string;
  message_id: string;
  channel_id: string;
  player_id: string;
  confidence: string | number;
  policy_version: string;
  model_version: string | null;
  rules_version: string | null;
  categories: string[];
  recommended_action: ModerationRecommendedAction;
  applied_action: ModerationRecommendedAction;
  requested_mute_scope: "global" | "channel" | null;
  requested_duration_seconds: number | null;
  applied_mute_duration_seconds: number | null;
  reason: string;
  metadata: unknown;
  processing_status: "applied" | "reversed";
  human_review_status: "not_required" | "pending";
};

type ModeratedMessageRow = {
  id: string;
  channel_id: string;
  sender_player_id: string;
};

export class ModerationDecisionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ModerationDecisionError";
  }
}

export class PostgresModerationDecisionService {
  private automatedMuteActions = 0;
  private automatedMuteReversals = 0;

  constructor(
    private readonly pool: pg.Pool,
    private readonly maximumAutomatedMuteSeconds: number,
    private readonly minimumAutomaticConfidence: number = CHAT_AUTOMATION_POLICY.automaticActionMinimumConfidence,
    private readonly severeCategories: ReadonlySet<string> = CHAT_AUTOMATION_POLICY.severeCategories
  ) {
    if (!Number.isSafeInteger(maximumAutomatedMuteSeconds) || maximumAutomatedMuteSeconds < 1) {
      throw new Error("Automated moderation mute cap must be a positive integer");
    }
  }

  async apply(input: ModerationDecisionInput): Promise<AppliedModerationDecision> {
    validateDecisionInput(input);
    const replay = await this.findDecision(this.pool, input.decisionId);
    if (replay) return replayDecision(replay, input);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const lockedReplay = await this.findDecision(client, input.decisionId);
      if (lockedReplay) {
        const result = replayDecision(lockedReplay, input);
        await client.query("COMMIT");
        return result;
      }
      const messageResult = await client.query<ModeratedMessageRow>(
        `SELECT id, channel_id, sender_player_id FROM chat_messages
         WHERE id = $1 FOR UPDATE`,
        [input.messageId]
      );
      const message = messageResult.rows[0];
      if (!message) throw new ModerationDecisionError("MESSAGE_NOT_FOUND", "Moderated message does not exist");
      if (message.sender_player_id !== input.playerId) {
        throw new ModerationDecisionError("PLAYER_MISMATCH", "Moderation player does not match message sender");
      }

      const applied = resolveAutomatedModerationAction(
        input,
        this.minimumAutomaticConfidence,
        this.severeCategories,
        this.maximumAutomatedMuteSeconds
      );
      const inserted = await client.query<DecisionRow>(
        `INSERT INTO chat_moderation_decisions (
           decision_id, message_id, channel_id, player_id, source, policy_version,
           model_version, rules_version, categories, confidence, recommended_action,
           applied_action, requested_mute_scope, requested_duration_seconds,
           applied_mute_duration_seconds, reason, processing_status,
           human_review_status, metadata
         ) VALUES ($1,$2,$3,$4,'automated_moderation',$5,$6,$7,$8,$9,$10,$11,
                   $12,$13,$14,$15,'applied',$16,$17::jsonb)
         RETURNING decision_id, message_id, channel_id, player_id, confidence,
                   policy_version, model_version, rules_version, categories,
                   recommended_action, applied_action, requested_mute_scope,
                   requested_duration_seconds, applied_mute_duration_seconds,
                   reason, metadata, processing_status, human_review_status`,
        [
          input.decisionId, message.id, message.channel_id, message.sender_player_id,
          input.policyVersion.trim(), input.modelVersion?.trim() || null,
          input.rulesVersion?.trim() || null, input.categories.map((category) => category.trim()),
          input.confidence, input.recommendedAction, applied.action,
          input.requestedMuteScope ?? null, input.requestedDurationSeconds ?? null,
          applied.muteDurationSeconds, input.reason.trim(), applied.humanReviewStatus,
          JSON.stringify(input.metadata ?? {}) ?? "{}"
        ]
      );
      await this.applyMessageState(client, message.id, applied.action);
      if (applied.action === "temporary_channel_mute" || applied.action === "temporary_global_mute") {
        await client.query(
          `INSERT INTO chat_mutes (
             id, player_id, scope, channel_id, source, reason_category, reason,
             actor_type, actor_id, actor_metadata, moderation_decision_id,
             idempotency_key, expires_at
           ) VALUES ($1,$2,$3,$4,'automated_moderation','automated_policy',$5,
                     'moderation_service',$6::text,'{}'::jsonb,$6::uuid,$7,
                     now() + ($8 * interval '1 second'))`,
          [
            crypto.randomUUID(), message.sender_player_id,
            applied.action === "temporary_global_mute" ? "global" : "channel",
            applied.action === "temporary_channel_mute" ? message.channel_id : null,
            input.reason.trim(), input.decisionId, `decision:${input.decisionId}`,
            applied.muteDurationSeconds
          ]
        );
      }
      await client.query("COMMIT");
      const row = inserted.rows[0];
      if (!row) throw new Error("Moderation decision insert returned no row");
      if (applied.action === "temporary_channel_mute" || applied.action === "temporary_global_mute") {
        this.automatedMuteActions += 1;
      }
      return decisionFromRow(row, false);
    } catch (error) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(error)) {
        const duplicate = await this.findDecision(this.pool, input.decisionId);
        if (duplicate) return replayDecision(duplicate, input);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async reverse(decisionId: string, reversedBy: string, reason: string): Promise<AppliedModerationDecision> {
    assertUuid(decisionId, "Decision id");
    if (
      !reversedBy.trim() || Array.from(reversedBy.trim()).length > 128 ||
      !reason.trim() || Array.from(reason.trim()).length > 500
    ) {
      throw new ModerationDecisionError("REVERSAL_INVALID", "Reversal actor and reason are required");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<DecisionRow>(
        `${DECISION_SELECT} WHERE decision_id = $1 FOR UPDATE`,
        [decisionId]
      );
      const existing = result.rows[0];
      if (!existing) throw new ModerationDecisionError("DECISION_NOT_FOUND", "Moderation decision does not exist");
      if (existing.processing_status === "reversed") {
        await client.query("COMMIT");
        return decisionFromRow(existing, true);
      }
      if (existing.applied_action === "hide_message") {
        await client.query(
          "SELECT id FROM chat_messages WHERE id = $1 FOR UPDATE",
          [existing.message_id]
        );
      }
      await client.query(
        `UPDATE chat_mutes SET revoked_at = now(), revoked_by = $2, revocation_reason = $3
         WHERE moderation_decision_id = $1 AND revoked_at IS NULL`,
        [decisionId, reversedBy.trim(), reason.trim()]
      );
      if (existing.applied_action === "hide_message") {
        const otherHide = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM chat_moderation_decisions
             WHERE message_id = $1 AND decision_id <> $2
               AND processing_status = 'applied' AND applied_action = 'hide_message'
           ) AS exists`,
          [existing.message_id, decisionId]
        );
        if (!otherHide.rows[0]?.exists) {
          await client.query(
            `UPDATE chat_messages SET message_status = 'visible', moderation_status = 'flagged'
             WHERE id = $1 AND message_status = 'hidden'`,
            [existing.message_id]
          );
        }
      }
      const updated = await client.query<DecisionRow>(
        `UPDATE chat_moderation_decisions
         SET processing_status = 'reversed', reversed_at = now(), reversed_by = $2,
             reversal_reason = $3, human_review_status = 'pending'
         WHERE decision_id = $1
         RETURNING decision_id, message_id, channel_id, player_id, confidence,
                   policy_version, model_version, rules_version, categories,
                   recommended_action, applied_action, requested_mute_scope,
                   requested_duration_seconds, applied_mute_duration_seconds,
                   reason, metadata, processing_status, human_review_status`,
        [decisionId, reversedBy.trim(), reason.trim()]
      );
      await client.query("COMMIT");
      const row = updated.rows[0];
      if (!row) throw new Error("Moderation reversal returned no row");
      if (
        existing.applied_action === "temporary_channel_mute" ||
        existing.applied_action === "temporary_global_mute"
      ) {
        this.automatedMuteReversals += 1;
      }
      return decisionFromRow(row, false);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  metricsSnapshot(): { automatedMuteActions: number; automatedMuteReversals: number } {
    return {
      automatedMuteActions: this.automatedMuteActions,
      automatedMuteReversals: this.automatedMuteReversals
    };
  }

  private async findDecision(queryable: Queryable, decisionId: string): Promise<DecisionRow | null> {
    const result = await queryable.query<DecisionRow>(`${DECISION_SELECT} WHERE decision_id = $1`, [decisionId]);
    return result.rows[0] ?? null;
  }

  private async applyMessageState(
    queryable: Queryable,
    messageId: string,
    action: ModerationRecommendedAction
  ): Promise<void> {
    if (action === "hide_message") {
      await queryable.query(
        `UPDATE chat_messages SET message_status = 'hidden', moderation_status = 'actioned'
         WHERE id = $1 AND message_status <> 'deleted'`,
        [messageId]
      );
    } else if (action === "flag_for_review") {
      await queryable.query(`UPDATE chat_messages SET moderation_status = 'flagged' WHERE id = $1`, [messageId]);
    } else if (action === "no_action") {
      await queryable.query(`UPDATE chat_messages SET moderation_status = 'clear' WHERE id = $1`, [messageId]);
    } else {
      await queryable.query(`UPDATE chat_messages SET moderation_status = 'actioned' WHERE id = $1`, [messageId]);
    }
  }
}

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

const DECISION_SELECT = `SELECT decision_id, message_id, channel_id, player_id, confidence,
  policy_version, model_version, rules_version, categories,
  recommended_action, applied_action, requested_mute_scope,
  requested_duration_seconds, applied_mute_duration_seconds, reason, metadata,
  processing_status, human_review_status FROM chat_moderation_decisions`;

export function resolveAutomatedModerationAction(
  input: ModerationDecisionInput,
  minimumConfidence: number,
  severeCategories: ReadonlySet<string>,
  maximumMuteSeconds: number
): {
  action: ModerationRecommendedAction;
  muteDurationSeconds: number | null;
  humanReviewStatus: "not_required" | "pending";
} {
  if (input.recommendedAction === "no_action") {
    return { action: "no_action", muteDurationSeconds: null, humanReviewStatus: "not_required" };
  }
  if (input.recommendedAction === "flag_for_review") {
    return { action: "flag_for_review", muteDurationSeconds: null, humanReviewStatus: "pending" };
  }
  const severe = input.categories.some((category) => severeCategories.has(category.trim()));
  if (input.confidence < minimumConfidence || !severe) {
    return { action: "flag_for_review", muteDurationSeconds: null, humanReviewStatus: "pending" };
  }
  if (input.recommendedAction === "hide_message") {
    return { action: "hide_message", muteDurationSeconds: null, humanReviewStatus: "pending" };
  }
  return {
    action: input.recommendedAction,
    muteDurationSeconds: Math.min(input.requestedDurationSeconds ?? 0, maximumMuteSeconds),
    humanReviewStatus: "pending"
  };
}

function validateDecisionInput(input: ModerationDecisionInput): void {
  assertUuid(input.decisionId, "Decision id");
  assertUuid(input.messageId, "Message id");
  if (
    !input.playerId ||
    !input.policyVersion.trim() || Array.from(input.policyVersion.trim()).length > 64 ||
    !input.reason.trim() || Array.from(input.reason.trim()).length > 500 ||
    (input.modelVersion !== undefined && input.modelVersion !== null &&
      (!input.modelVersion.trim() || Array.from(input.modelVersion.trim()).length > 128)) ||
    (input.rulesVersion !== undefined && input.rulesVersion !== null &&
      (!input.rulesVersion.trim() || Array.from(input.rulesVersion.trim()).length > 128))
  ) {
    throw new ModerationDecisionError("DECISION_INVALID", "Moderation decision identity, policy, and reason are required");
  }
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new ModerationDecisionError("CONFIDENCE_INVALID", "Moderation confidence must be between zero and one");
  }
  if (
    input.categories.length > 16 ||
    input.categories.some((category) => !category.trim() || Array.from(category.trim()).length > 128)
  ) {
    throw new ModerationDecisionError("CATEGORIES_INVALID", "Moderation categories are invalid");
  }
  const muteAction = input.recommendedAction === "temporary_channel_mute" ||
    input.recommendedAction === "temporary_global_mute";
  if (muteAction) {
    const expectedScope = input.recommendedAction === "temporary_global_mute" ? "global" : "channel";
    if (
      input.requestedMuteScope !== expectedScope ||
      !Number.isSafeInteger(input.requestedDurationSeconds) ||
      (input.requestedDurationSeconds ?? 0) <= 0
    ) {
      throw new ModerationDecisionError("MUTE_INVALID", "Temporary mute scope and duration are invalid");
    }
  } else if (input.requestedMuteScope !== undefined || input.requestedDurationSeconds !== undefined) {
    throw new ModerationDecisionError("MUTE_INVALID", "Non-mute moderation decisions cannot request a mute");
  }
}

function decisionFromRow(row: DecisionRow, replayed: boolean): AppliedModerationDecision {
  return {
    decisionId: row.decision_id,
    messageId: row.message_id,
    channelId: row.channel_id,
    playerId: row.player_id,
    recommendedAction: row.recommended_action,
    appliedAction: row.applied_action,
    appliedMuteDurationSeconds: row.applied_mute_duration_seconds,
    confidence: Number(row.confidence),
    processingStatus: row.processing_status,
    humanReviewStatus: row.human_review_status,
    replayed
  };
}

function replayDecision(
  row: DecisionRow,
  input: ModerationDecisionInput
): AppliedModerationDecision {
  if (
    row.message_id !== input.messageId ||
    row.player_id !== input.playerId ||
    row.policy_version !== input.policyVersion.trim() ||
    row.model_version !== (input.modelVersion?.trim() || null) ||
    row.rules_version !== (input.rulesVersion?.trim() || null) ||
    !equalStringLists(row.categories, input.categories.map((category) => category.trim())) ||
    Math.abs(Number(row.confidence) - roundedConfidence(input.confidence)) > Number.EPSILON ||
    row.recommended_action !== input.recommendedAction ||
    row.requested_mute_scope !== (input.requestedMuteScope ?? null) ||
    row.requested_duration_seconds !== (input.requestedDurationSeconds ?? null) ||
    row.reason !== input.reason.trim() ||
    stableJson(row.metadata) !== stableJson(input.metadata ?? {})
  ) {
    throw new ModerationDecisionError(
      "DECISION_ID_CONFLICT",
      "Moderation decision id was already used for a different decision"
    );
  }
  return decisionFromRow(row, true);
}

function equalStringLists(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function roundedConfidence(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record).sort().map((key) => [key, canonicalJson(record[key])])
  );
}

function assertUuid(value: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new ModerationDecisionError("IDENTIFIER_INVALID", `${label} must be a UUID`);
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
