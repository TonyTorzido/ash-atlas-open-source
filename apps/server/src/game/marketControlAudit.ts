import type pg from "pg";

type Queryable = Pick<pg.PoolClient, "query">;

export type MarketControlAuditContext = {
  operatorIdentity: string;
  reason: string;
  incidentId?: string | null;
};

/**
 * Transaction-local context consumed by the 0601 control guards. Keeping the
 * context in PostgreSQL means a control update and its immutable evidence
 * either commit together or roll back together.
 */
export async function setMarketControlAuditContext(
  queryable: Queryable,
  context: MarketControlAuditContext
): Promise<void> {
  const operatorIdentity = requireAuditText(context.operatorIdentity, "operator identity", 160);
  const reason = requireAuditText(context.reason, "control reason", 240);
  const incidentId = context.incidentId == null
    ? ""
    : requireAuditText(context.incidentId, "incident id", 160);
  await queryable.query(
    `SELECT
       set_config('ash_atlas.market_control_operator', $1, true),
       set_config('ash_atlas.market_control_reason', $2, true),
       set_config('ash_atlas.market_control_incident_id', $3, true)`,
    [operatorIdentity, reason, incidentId]
  );
}

function requireAuditText(value: string, name: string, maximum: number): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximum ||
    [...normalized].some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new Error(`Market ${name} is invalid`);
  }
  return normalized;
}
