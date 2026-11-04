import { createHash } from "node:crypto";
import type pg from "pg";

export type NativePushKind = "direct_message" | "party_invite" | "kingdom_invite" | "package";
export type NativePushAudience = { accounts: readonly string[]; kinds: readonly NativePushKind[] };
/** Must be called with the SAME transaction that writes the durable source event. */
export async function enqueueNativePush(
  client: Pick<pg.PoolClient, "query">,
  input: { enabled: boolean; audience?: NativePushAudience | undefined; kind: NativePushKind; playerId: string; sourceId: string; eventKey: string; collapseKey?: string; expiresAt?: Date }
): Promise<void> {
  if (!input.enabled || !input.audience?.accounts.length || !input.audience.kinds.includes(input.kind)) return;
  const ttl = input.kind === "direct_message" ? 3_600_000 : input.kind === "package" ? 86_400_000 : 900_000;
  const expiresAt = new Date(Math.min(Date.now() + ttl, input.expiresAt?.getTime() ?? Infinity));
  const collapseKey = createHash("sha256").update(input.collapseKey ?? input.eventKey).digest("hex");
  await client.query(
    `INSERT INTO native_push_deliveries (event_key,binding_id,binding_epoch,player_id,kind,source_id,collapse_key,expires_at)
     SELECT $1,b.id,b.binding_epoch,b.player_id,$3,$4,$5,$6
     FROM native_push_bindings b JOIN player_push_preferences p ON p.player_id = b.player_id
     JOIN auth_sessions s ON s.id = b.session_id
     WHERE b.player_id = $2 AND b.enabled AND p.enabled AND s.revoked_at IS NULL AND s.expires_at > now()
       AND b.account_id=ANY($7::uuid[])
       AND CASE WHEN $3 = 'direct_message' THEN p.direct_messages WHEN $3 = 'package' THEN p.packages ELSE p.invitations END
     ON CONFLICT (event_key,binding_id,binding_epoch) DO NOTHING`,
    [input.eventKey, input.playerId, input.kind, input.sourceId, collapseKey, expiresAt,input.audience.accounts]
  );
}
