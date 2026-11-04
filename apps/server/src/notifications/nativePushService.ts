import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { DEFAULT_NATIVE_PUSH_PREFERENCES, type NativePushPreferences, type NativePushStatus, type NativePushDestination } from "@ash-atlas/shared";
import type pg from "pg";
import type { AppConfig } from "../config.js";
import type { AuthenticatedSession } from "../auth/types.js";

export class NativePushError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}
type EncryptedToken = { keyId: string; iv: string; tag: string; ciphertext: string };
type Binding = { id: string; binding_epoch: number; token_version: number; enabled: boolean; session_id: string; token_hash: string | null };
export function isNativePushAccountAllowed(config: Pick<AppConfig,"NATIVE_PUSH_ACCOUNT_ALLOWLIST">, accountId: string): boolean {
  return config.NATIVE_PUSH_ACCOUNT_ALLOWLIST.includes(accountId);
}
export class NativePushService {
  constructor(readonly pool: pg.Pool, readonly config: AppConfig) {
    if (config.NATIVE_PUSH_REGISTRATION_ENABLED || config.NATIVE_PUSH_DELIVERY_ENABLED) this.tokenKey();
  }
  private tokenKey(): Buffer {
    const key = Buffer.from(this.config.NATIVE_PUSH_TOKEN_KEY_BASE64, "base64");
    if (key.length !== 32 || !this.config.NATIVE_PUSH_TOKEN_KEY_ID) throw new Error("Native push token encryption is not configured");
    return key;
  }
  encryptToken(token: string): EncryptedToken {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.tokenKey(), iv);
    cipher.setAAD(Buffer.from(this.config.NATIVE_PUSH_TOKEN_KEY_ID));
    const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return { keyId: this.config.NATIVE_PUSH_TOKEN_KEY_ID, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  }
  decryptToken(value: EncryptedToken): string {
    if (value.keyId !== this.config.NATIVE_PUSH_TOKEN_KEY_ID) throw new Error("Native push token key is unavailable");
    const decipher = createDecipheriv("aes-256-gcm", this.tokenKey(), Buffer.from(value.iv, "base64"));
    decipher.setAAD(Buffer.from(value.keyId));
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8");
  }
  async status(session: AuthenticatedSession): Promise<NativePushStatus> {
    const playerId = requirePlayer(session);
    const [bindings, preferences] = await Promise.all([
      this.pool.query<Binding>("SELECT binding_epoch,token_version,enabled,session_id FROM native_push_bindings WHERE device_installation_id = $1", [session.deviceInstallationId]),
      this.preferences(playerId)
    ]);
    const binding = bindings.rows[0];
    return { available: this.config.NATIVE_PUSH_REGISTRATION_ENABLED && isNativePushAccountAllowed(this.config,session.account.id), binding: binding ? { epoch: binding.binding_epoch, tokenVersion: binding.token_version, enabled: binding.enabled && binding.session_id === session.sessionId } : null, preferences };
  }
  async preferences(playerId: string): Promise<NativePushPreferences> {
    const result = await this.pool.query<{ revision: number; enabled: boolean; direct_messages: boolean; invitations: boolean; packages: boolean; quiet_start: number | null; quiet_end: number | null; time_zone: string }>("SELECT * FROM player_push_preferences WHERE player_id = $1", [playerId]);
    const row = result.rows[0];
    return row ? { revision: row.revision, enabled: row.enabled, directMessages: row.direct_messages, invitations: row.invitations, packages: row.packages, quietStart: row.quiet_start, quietEnd: row.quiet_end, timeZone: row.time_zone } : { ...DEFAULT_NATIVE_PUSH_PREFERENCES };
  }
  async setPreferences(session: AuthenticatedSession, value: NativePushPreferences): Promise<void> {
    try { new Intl.DateTimeFormat("en", { timeZone: value.timeZone }).format(); }
    catch { throw new NativePushError(400, "Choose a valid time zone."); }
    const result = await this.pool.query(
      `INSERT INTO player_push_preferences (player_id,enabled,direct_messages,invitations,packages,quiet_start,quiet_end,time_zone)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8 WHERE $9=0 OR EXISTS (SELECT 1 FROM player_push_preferences WHERE player_id=$1)
       ON CONFLICT (player_id) DO UPDATE SET
       enabled=$2,direct_messages=$3,invitations=$4,packages=$5,quiet_start=$6,quiet_end=$7,time_zone=$8,updated_at=now(),revision=player_push_preferences.revision+1
       WHERE player_push_preferences.revision=$9`,
      [requirePlayer(session), value.enabled, value.directMessages, value.invitations, value.packages, value.quietStart, value.quietEnd, value.timeZone, value.revision]
    );
    if (!result.rowCount) throw new NativePushError(409, "Notification preferences changed. Refresh and try again.");
  }
  async register(session: AuthenticatedSession, value: { token: string; platform: "ios" | "android"; expectedEpoch: number; expectedTokenVersion: number }): Promise<void> {
    if (!this.config.NATIVE_PUSH_REGISTRATION_ENABLED || !isNativePushAccountAllowed(this.config,session.account.id)) throw new NativePushError(503, "Notifications are not available yet.");
    const playerId = requirePlayer(session);
    const provider = value.platform === "ios" ? "apns" : "fcm";
    const environment = value.platform === "ios" ? this.config.NATIVE_PUSH_APNS_ENVIRONMENT : "production";
    const tokenHash = createHash("sha256").update(value.token).digest("hex");
    const encrypted = this.encryptToken(value.token);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize account changes against registration using the existing device row.
      const current = await client.query<{ native_push_session_id: string }>("SELECT native_push_session_id FROM device_installations WHERE id=$1 FOR UPDATE", [session.deviceInstallationId]);
      const active = await client.query("SELECT id FROM auth_sessions WHERE id=$1 AND revoked_at IS NULL AND expires_at>now() FOR SHARE", [session.sessionId]);
      if (current.rows[0]?.native_push_session_id !== session.sessionId || !active.rowCount) throw new NativePushError(409, "The account changed. Refresh notification settings.");
      const existing = await client.query<Binding>("SELECT * FROM native_push_bindings WHERE device_installation_id=$1 FOR UPDATE", [session.deviceInstallationId]);
      const binding = existing.rows[0];
      if ((binding?.binding_epoch ?? 0) !== value.expectedEpoch) throw new NativePushError(409, "Notification settings changed. Refresh and try again.");
      if ((binding?.token_version ?? 0) !== value.expectedTokenVersion) throw new NativePushError(409, "The notification token changed. Refresh and try again.");
      // Token reissuance may retain a token after reinstall; it must have one destination only.
      await client.query(`UPDATE native_push_bindings SET enabled=false,token_hash=NULL,token_encrypted=NULL,binding_epoch=binding_epoch+1,updated_at=now()
        WHERE provider=$1 AND environment=$2 AND token_hash=$3 AND device_installation_id<>$4`, [provider, environment, tokenHash, session.deviceInstallationId]);
      await client.query(
        `INSERT INTO native_push_bindings (device_installation_id,account_id,player_id,session_id,platform,provider,environment,token_hash,token_encrypted,enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
         ON CONFLICT (device_installation_id) DO UPDATE SET
         account_id=$2,player_id=$3,session_id=$4,platform=$5,provider=$6,environment=$7,token_hash=$8,token_encrypted=$9,enabled=true,
         binding_epoch=native_push_bindings.binding_epoch + CASE WHEN native_push_bindings.session_id<>$4 THEN 1 ELSE 0 END,
         token_version=native_push_bindings.token_version + CASE WHEN native_push_bindings.token_hash IS DISTINCT FROM $8 THEN 1 ELSE 0 END,updated_at=now()`,
        [session.deviceInstallationId,session.account.id,playerId,session.sessionId,value.platform,provider,environment,tokenHash,encrypted]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async reset(session: AuthenticatedSession, expectedEpoch: number): Promise<void> {
    requirePlayer(session);
    const result = await this.pool.query(`UPDATE native_push_bindings SET enabled=false,token_hash=NULL,token_encrypted=NULL,binding_epoch=binding_epoch+1,updated_at=now()
      WHERE device_installation_id=$1 AND session_id=$2 AND binding_epoch=$3`, [session.deviceInstallationId,session.sessionId,expectedEpoch]);
    if (!result.rowCount) throw new NativePushError(409, "Notification settings changed. Refresh and try again.");
  }
  async destination(session: AuthenticatedSession, deliveryId: string): Promise<NativePushDestination> {
    const result = await this.pool.query<{ kind: string; source_id: string }>(
      `SELECT d.kind,d.source_id FROM native_push_deliveries d JOIN native_push_bindings b ON b.id=d.binding_id
       WHERE d.id=$1 AND d.player_id=$2 AND b.device_installation_id=$3 AND b.session_id=$4 AND d.binding_epoch=b.binding_epoch`,
      [deliveryId,requirePlayer(session),session.deviceInstallationId,session.sessionId]);
    const delivery = result.rows[0];
    if (!delivery) throw new NativePushError(404, "This notification is no longer available for this account.");
    // Navigation only. The normal authenticated Messages reads remain source of truth.
    if (delivery.kind === "direct_message") {
      const conversation = await this.pool.query<{ conversation_id: string }>(`SELECT c.id AS conversation_id FROM chat_messages m
        JOIN direct_conversations c ON c.channel_id=m.channel_id
        JOIN direct_conversation_participants p ON p.conversation_id=c.id
        WHERE m.id::text=$1 AND p.player_id=$2`, [delivery.source_id,requirePlayer(session)]);
      return { tab: "direct", ...(conversation.rows[0] ? { conversationId: conversation.rows[0].conversation_id } : {}) };
    }
    return { tab: delivery.kind === "package" ? "game" : "requests" };
  }
}
function requirePlayer(session: AuthenticatedSession): string {
  if (!session.player || !session.deviceInstallationId) throw new NativePushError(403, "A current native player session is required.");
  return session.player.id;
}

export function isPushQuietTime(preferences: NativePushPreferences, now = new Date()): boolean {
  if (preferences.quietStart === null || preferences.quietEnd === null) return false;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: preferences.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const minute = Number(parts.find((p) => p.type === "hour")?.value) * 60 + Number(parts.find((p) => p.type === "minute")?.value);
  const { quietStart: start, quietEnd: end } = preferences;
  return start === end || (start < end ? minute >= start && minute < end : minute >= start || minute < end);
}
