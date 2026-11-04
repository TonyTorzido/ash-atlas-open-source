import { randomUUID } from "node:crypto";
import type pg from "pg";
import { developerAccessSubjects } from "../auth/developerAuthorization.js";
import type { AppLogger } from "../logger.js";
import { isNativePushAccountAllowed, isPushQuietTime, type NativePushService } from "./nativePushService.js";
import { PUSH_SEND_TIMEOUT_MS, type PushSender, type PushEnvelope, type PushSendResult } from "./nativePushProviders.js";

type Delivery = { id: string; binding_id: string; binding_epoch: number; player_id: string; kind: string; source_id: string; collapse_key: string; expires_at: Date; attempts: number; lease_id: string };
type Target = { account_id: string; token_encrypted: Parameters<NativePushService["decryptToken"]>[0]; token_version: number; provider: PushEnvelope["provider"]; environment: PushEnvelope["environment"] };
const MAX_ATTEMPTS = 5;
// Match AuthService's session and gameplay eligibility without touching last_seen_at.
// A missing access-mode row is closed, as in TestAccessService.getAccessMode.
// Dev mode admits only developer Google subjects and approved dev-list accounts.
const TARGET_JOINS = `JOIN auth_sessions s ON s.id=b.session_id AND s.account_id=b.account_id
  JOIN accounts a ON a.id=b.account_id
  JOIN account_identities identity ON identity.id=s.identity_id AND identity.account_id=a.id AND identity.identity_status='active'
  JOIN players player ON player.id=b.player_id AND player.account_id=a.id AND player.onboarding_completed_at IS NOT NULL
  JOIN device_installations installation ON installation.id=b.device_installation_id AND installation.native_push_session_id=s.id`;
const targetEligible = (developerSubjects: string): string => `b.id=$1 AND b.binding_epoch=$2 AND b.player_id=$3 AND b.enabled
  AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
  AND s.last_seen_at>clock_timestamp()-$4*interval '1 day'
  AND a.status='active' AND a.session_version=s.account_session_version
  AND (CASE WHEN EXISTS (SELECT 1 FROM test_access_settings WHERE singleton=true AND access_mode='dev')
    THEN (identity.provider='google' AND identity.provider_subject=ANY(${developerSubjects}::text[]))
      OR (a.test_access_status='approved'
        AND EXISTS (SELECT 1 FROM dev_access_entries dev WHERE dev.account_id=a.id AND dev.status='approved'))
    ELSE a.test_access_status='approved' OR (a.test_access_status='pending'
      AND EXISTS (SELECT 1 FROM test_access_settings WHERE singleton=true AND access_mode='open')) END)`;
export class NativePushWorker {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;
  constructor(private readonly service: NativePushService, private readonly send: PushSender, private readonly logger: AppLogger) {}
  start(): void {
    if (!this.service.config.NATIVE_PUSH_DELIVERY_ENABLED || this.timer || this.running) return;
    this.stopped = false;
    this.schedule();
  }
  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.tick().catch(() => { this.logger.warn({ component: "native_push", outcome: "worker_failed" }, "Native notification delivery paused for retry"); })
        .finally(() => { this.running = undefined; this.schedule(); });
    }, 2_000);
    this.timer.unref();
  }
  async stop(): Promise<void> { this.stopped = true; clearTimeout(this.timer); await this.running; }
  async tick(): Promise<void> {
    if (!this.service.config.NATIVE_PUSH_DELIVERY_ENABLED) return;
    for (let count = 0; count < 10 && !this.stopped; count++) {
      const delivery = await this.claim();
      if (!delivery) break;
      await this.deliver(delivery);
    }
    // Retain only operationally useful metadata; token-bearing bindings expire with sessions.
    await this.service.pool.query("DELETE FROM native_push_deliveries WHERE expires_at < now() - interval '7 days'");
  }
  private async claim(): Promise<Delivery | null> {
    const client = await this.service.pool.connect();
    try {
      await client.query("BEGIN");
      // A crash or a repeatedly failing pre-send check still consumes an attempt.
      // Never reclaim forever just because no provider result was recorded.
      await client.query(`UPDATE native_push_deliveries SET status=CASE WHEN expires_at<=now() THEN 'suppressed' ELSE 'failed' END,
        result_code=CASE WHEN expires_at<=now() THEN 'expired' ELSE 'attempts_exhausted' END,lease_id=NULL,leased_until=NULL
        WHERE status='pending' AND (leased_until IS NULL OR leased_until<=now()) AND (expires_at<=now() OR attempts>=$1)`, [MAX_ATTEMPTS]);
      // Lock the binding BEFORE claiming a row, so parallel workers cannot race the
      // per-installation cap or lease different rows from the same installation.
      const binding = await client.query<{ id: string }>(`SELECT b.id FROM native_push_bindings b
        WHERE EXISTS (SELECT 1 FROM native_push_deliveries d WHERE d.binding_id=b.id AND d.status='pending' AND d.next_attempt_at<=now())
        AND NOT EXISTS (SELECT 1 FROM native_push_deliveries d WHERE d.binding_id=b.id AND d.leased_until>now())
        ORDER BY b.id FOR UPDATE OF b SKIP LOCKED LIMIT 1`);
      if (!binding.rows[0]) { await client.query("COMMIT"); return null; }
      const result = await client.query<Delivery>(`UPDATE native_push_deliveries SET lease_id=$2,leased_until=now()+interval '60 seconds',attempts=attempts+1
        WHERE id=(SELECT id FROM native_push_deliveries WHERE binding_id=$1 AND status='pending' AND next_attempt_at<=now()
          AND (leased_until IS NULL OR leased_until<=now()) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [binding.rows[0].id,randomUUID()]);
      await client.query("COMMIT"); return result.rows[0] ?? null;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  private async deliver(delivery: Delivery): Promise<void> {
    const pool = this.service.pool;
    if (new Date(delivery.expires_at).getTime() <= Date.now()) { await this.finish(delivery,"suppressed","expired"); return; }
    const identity = [delivery.binding_id,delivery.binding_epoch,delivery.player_id,this.service.config.AUTH_SESSION_INACTIVITY_DAYS];
    const target = await pool.query<Target>(`SELECT b.token_encrypted,b.token_version,b.provider,b.environment,b.account_id
      FROM native_push_bindings b ${TARGET_JOINS} WHERE ${targetEligible("$6")} AND a.id=ANY($5::uuid[])`, [...identity,this.service.config.NATIVE_PUSH_ACCOUNT_ALLOWLIST,developerAccessSubjects(this.service.config)]);
    const binding = target.rows[0];
    if (!binding) { await this.finish(delivery,"suppressed","binding_changed"); return; }
    const rolloutAllowed = (): boolean => isNativePushAccountAllowed(this.service.config,binding.account_id)
      && this.service.config.NATIVE_PUSH_CATEGORY_ALLOWLIST.some((kind) => kind === delivery.kind);
    if (!rolloutAllowed()) { await this.finish(delivery,"suppressed","rollout_disabled"); return; }
    const preferences = await this.service.preferences(delivery.player_id);
    const categoryEnabled = delivery.kind === "direct_message" ? preferences.directMessages : delivery.kind === "package" ? preferences.packages : preferences.invitations;
    if (!preferences.enabled || !categoryEnabled || isPushQuietTime(preferences) || !await sourceStillRelevant(pool,delivery)) {
      await this.finish(delivery,"suppressed","not_relevant"); return;
    }
    const quota = await pool.query<{ capped: boolean; coalesced: boolean }>(`SELECT
      count(*) FILTER (WHERE sent_at>now()-interval '1 hour') >= 10 AS capped,
      count(*) FILTER (WHERE collapse_key=$2 AND sent_at>now()-interval '60 seconds') > 0 AS coalesced
      FROM native_push_deliveries WHERE binding_id=$1 AND status='sent'`, [delivery.binding_id,delivery.collapse_key]);
    if (quota.rows[0]?.capped || quota.rows[0]?.coalesced) { await this.finish(delivery,"suppressed","rate_limited"); return; }
    let token: string;
    try { token = this.service.decryptToken(binding.token_encrypted); }
    catch {
      await this.finish(delivery,"failed","token_key_unavailable");
      this.logger.warn({ component: "native_push", deliveryId: delivery.id, code: "token_key_unavailable" }, "Native notification token key is unavailable");
      return;
    }
    // The sender invokes this AFTER credential acquisition, immediately before
    // transport, within its deadline. No awaited credential work follows this gate.
    const beforeDispatch = async (): Promise<boolean> => {
      if (this.stopped || !rolloutAllowed() || isPushQuietTime(preferences) || new Date(delivery.expires_at).getTime()<=Date.now()) return false;
      const current = await pool.query<{ leased_until: Date }>(`UPDATE native_push_deliveries d
      SET leased_until=clock_timestamp()+interval '60 seconds',result_code='submitting'
      FROM native_push_bindings b ${TARGET_JOINS}
      JOIN player_push_preferences preferences ON preferences.player_id=b.player_id
      WHERE ${targetEligible("$12")} AND b.token_version=$7
        AND a.id=ANY($10::uuid[]) AND d.kind=ANY($11::text[])
        AND preferences.revision=$8 AND preferences.enabled
        AND CASE WHEN d.kind='direct_message' THEN preferences.direct_messages WHEN d.kind='package' THEN preferences.packages ELSE preferences.invitations END
        AND d.id=$5 AND d.lease_id=$6 AND d.status='pending' AND d.leased_until>clock_timestamp()
        AND d.binding_id=b.id AND d.binding_epoch=b.binding_epoch AND d.player_id=b.player_id AND d.expires_at>clock_timestamp()
        AND EXISTS (${sourceQuery(delivery.kind, "$9", "$3")}) RETURNING d.leased_until`,
      [...identity,delivery.id,delivery.lease_id,binding.token_version,preferences.revision,delivery.source_id,this.service.config.NATIVE_PUSH_ACCOUNT_ALLOWLIST,this.service.config.NATIVE_PUSH_CATEGORY_ALLOWLIST,developerAccessSubjects(this.service.config)]);
      return Boolean(current.rows[0] && new Date(current.rows[0].leased_until).getTime()>Date.now()+5_000
        && !this.stopped && rolloutAllowed() && !isPushQuietTime(preferences));
    };
    const deadlineAt = Date.now()+PUSH_SEND_TIMEOUT_MS;
    // Acceptance and the DB receipt cannot be atomic. A crashed worker may retry a
    // generic alert; stable delivery/collapse IDs bound its visible duplication.
    let result: PushSendResult;
    try {
      result = await this.send({ id: delivery.id, targetId: delivery.binding_id, deadlineAt, beforeDispatch, token, provider: binding.provider,
        environment: binding.environment, kind: delivery.kind, collapseKey: delivery.collapse_key, expiresAt: new Date(delivery.expires_at) });
    } catch { result = { outcome: "retry", code: "provider_unavailable" }; }
    if (result.outcome === "invalid_token") {
      await pool.query(`UPDATE native_push_bindings SET enabled=false,token_hash=NULL,token_encrypted=NULL,token_version=token_version+1,updated_at=now()
        WHERE id=$1 AND binding_epoch=$2 AND token_version=$3
          AND EXISTS (SELECT 1 FROM native_push_deliveries WHERE id=$4 AND lease_id=$5 AND status='pending')`,
      [delivery.binding_id,delivery.binding_epoch,binding.token_version,delivery.id,delivery.lease_id]);
    }
    const delaySeconds = [10,30,120,300][Math.max(0,Math.min(delivery.attempts-1,3))]!;
    if (result.outcome === "retry" && delivery.attempts < MAX_ATTEMPTS && Date.now()+delaySeconds*1_000 < new Date(delivery.expires_at).getTime()) {
      // A timed-out transport may still be settling. Preserve its lease window so
      // another process cannot immediately overlap it; the sender also fences locally.
      await pool.query(`UPDATE native_push_deliveries SET next_attempt_at=GREATEST(now()+$3*interval '1 second',
          CASE WHEN $4 IN ('provider_timeout','provider_in_flight') THEN leased_until ELSE now() END),
        lease_id=NULL,leased_until=CASE WHEN $4 IN ('provider_timeout','provider_in_flight') THEN leased_until ELSE NULL END,result_code=$4
        WHERE id=$1 AND lease_id=$2 AND status='pending'`, [delivery.id,delivery.lease_id,delaySeconds,result.code]);
    } else await this.finish(delivery,result.outcome === "sent" ? "sent" : result.outcome === "suppressed" ? "suppressed" : "failed",result.code);
    this.logger.info({ component: "native_push", deliveryId: delivery.id, provider: binding.provider, outcome: result.outcome, code: result.code }, "Native notification delivery result");
  }
  private async finish(delivery: Delivery, status: string, code: string): Promise<void> {
    await this.service.pool.query(`UPDATE native_push_deliveries SET status=$3,result_code=$4,lease_id=NULL,
      leased_until=CASE WHEN $4 IN ('provider_timeout','provider_in_flight') THEN leased_until ELSE NULL END,
      sent_at=CASE WHEN $3='sent' THEN now() ELSE NULL END WHERE id=$1 AND lease_id=$2 AND status='pending'`, [delivery.id,delivery.lease_id,status,code]);
  }
}

export async function sourceStillRelevant(pool: Pick<pg.Pool,"query">, delivery: Pick<Delivery,"kind"|"source_id"|"player_id">): Promise<boolean> {
  return Boolean((await pool.query(sourceQuery(delivery.kind),[delivery.source_id,delivery.player_id])).rowCount);
}

function sourceQuery(kind: string, source = "$1", player = "$2"): string {
  if (kind === "direct_message") return `SELECT m.id FROM chat_messages m JOIN direct_conversations c ON c.channel_id=m.channel_id
    JOIN direct_conversation_participants p ON p.conversation_id=c.id AND p.player_id=${player}
    WHERE m.id::text=${source} AND m.message_status='visible' AND m.moderation_status='clear' AND NOT p.muted AND m.sequence_number>p.last_read_sequence
      AND NOT EXISTS (SELECT 1 FROM player_blocks WHERE (blocker_id=${player} AND blocked_id=m.sender_player_id) OR (blocked_id=${player} AND blocker_id=m.sender_player_id))`;
  if (kind === "package") return `SELECT id FROM player_packages WHERE id::text=${source} AND recipient_player_id=${player} AND status<>'claimed' AND read_at IS NULL`;
  if (kind !== "party_invite" && kind !== "kingdom_invite") throw new Error("Unknown notification source");
  const table = kind === "party_invite" ? "party_invites" : "kingdom_invitations";
  const prefix = kind === "party_invite" ? "party:" : "kingdom:";
  const revision = kind === "party_invite" ? "i.updated_at" : "COALESCE(i.responded_at,i.created_at)";
  return `SELECT i.id FROM ${table} i WHERE i.id::text=${source} AND i.target_player_id=${player} AND i.status='pending' AND i.expires_at>clock_timestamp()
    AND NOT EXISTS (SELECT 1 FROM player_blocks WHERE (blocker_id=${player} AND blocked_id=i.invited_by_player_id) OR (blocked_id=${player} AND blocker_id=i.invited_by_player_id))
    AND NOT EXISTS (SELECT 1 FROM player_inbox_read_receipts receipt WHERE receipt.player_id=${player} AND receipt.entry_key='${prefix}'||i.id::text
      AND receipt.read_revision=to_char(date_trunc('milliseconds',${revision}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`;
}
