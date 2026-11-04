import {
  BRICKS_ITEM_ID,
  WAR_FORCED_PEACE_MS,
  structureWarfareDisplayKind,
  structureWarfareProfileForFlag,
  warSurrenderSplit,
  type StructureWarfareProfile
} from "@ash-atlas/shared";
import type pg from "pg";

import { lockKingdomTreasuryBalance, moveKingdomTreasuryInTransaction } from "./kingdomTreasuryLedger.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

export type OrganizationKind = "city" | "kingdom";

export type OrganizationRef = Readonly<{ kind: OrganizationKind; id: string }>;

export type PlayerOrganizations = Readonly<{ cityId: string | null; kingdomId: string | null }>;

export type WarfareFlagRow = Readonly<{
  control_type: string;
  anchor_kind: string;
  system_controlled: boolean;
  city_id: string | null;
  kingdom_id: string | null;
  reinforcement_level: number;
  /** flags.tower_level; selects that omit it read as an un-upgraded structure. */
  tower_level?: number | null;
  /** flags.obelisk_level; selects that omit it read as "not an obelisk". */
  obelisk_level?: number | null;
  war_structure_kind?: string | null;
}>;

/** "Under attack" alerts go out at most once per defending organization per window. */
export const ORGANIZATION_UNDER_ATTACK_ALERT_INTERVAL_MS = 15 * 60 * 1_000;

const WAR_DECLARED_EVENT_KIND = "organization_war_declared";
const UNDER_ATTACK_EVENT_KIND = "organization_under_attack";
const WAR_ENDED_EVENT_KIND = "organization_war_ended";
const PEACE_OFFERED_EVENT_KIND = "organization_war_peace_offered";

export function warfareProfileForRow(row: WarfareFlagRow): StructureWarfareProfile | null {
  return structureWarfareProfileForFlag({
    controlType: row.control_type,
    anchorKind: row.anchor_kind,
    systemControlled: row.system_controlled,
    cityId: row.city_id,
    kingdomId: row.kingdom_id,
    reinforcementLevel: Number(row.reinforcement_level),
    towerLevel: row.tower_level === null || row.tower_level === undefined ? null : Number(row.tower_level),
    obeliskLevel: row.obelisk_level === null || row.obelisk_level === undefined ? null : Number(row.obelisk_level),
    warStructureKind: row.war_structure_kind ?? null
  });
}

export function organizationOfFlag(row: WarfareFlagRow): OrganizationRef | null {
  const profile = warfareProfileForRow(row);
  if (!profile?.organization) return null;
  const id = profile.organization === "city" ? row.city_id : row.kingdom_id;
  return id ? { kind: profile.organization, id: String(id) } : null;
}

/** Active city and kingdom memberships of a player (read, not locked). */
export async function loadPlayerOrganizations(
  queryable: Queryable,
  playerId: string
): Promise<PlayerOrganizations> {
  const result = await queryable.query<{ city_id: string | null; kingdom_id: string | null }>(
    `SELECT (
              SELECT membership.city_id::text
              FROM city_memberships membership
              JOIN cities city ON city.id = membership.city_id AND city.active
              WHERE membership.player_id = $1 AND membership.left_at IS NULL
              ORDER BY membership.joined_at DESC
              LIMIT 1
            ) AS city_id,
            (
              SELECT membership.kingdom_id::text
              FROM kingdom_memberships membership
              JOIN kingdoms kingdom ON kingdom.id = membership.kingdom_id AND kingdom.status = 'active'
              WHERE membership.player_id = $1 AND membership.status = 'active'
              LIMIT 1
            ) AS kingdom_id`,
    [playerId]
  );
  return {
    cityId: result.rows[0]?.city_id ?? null,
    kingdomId: result.rows[0]?.kingdom_id ?? null
  };
}

/** True when the structure belongs to the player's own city or kingdom. */
export function isAlliedOrganizationStructure(
  organizations: PlayerOrganizations,
  row: Pick<WarfareFlagRow, "city_id" | "kingdom_id">
): boolean {
  return (row.city_id !== null && String(row.city_id) === organizations.cityId) ||
    (row.kingdom_id !== null && String(row.kingdom_id) === organizations.kingdomId);
}

/**
 * The side a player fights for. A kingdom outranks a city, so a player in
 * both declares war on behalf of the kingdom.
 */
export function attackingOrganization(organizations: PlayerOrganizations): OrganizationRef | null {
  if (organizations.kingdomId) return { kind: "kingdom", id: organizations.kingdomId };
  if (organizations.cityId) return { kind: "city", id: organizations.cityId };
  return null;
}

/** Current Mayor / Kingdom leader, falling back to the recorded flag owner. */
export async function organizationLeaderId(
  queryable: Queryable,
  organization: OrganizationRef
): Promise<string | null> {
  const result = await queryable.query<{ leader_id: string | null }>(
    organization.kind === "city"
      ? "SELECT mayor_player_id AS leader_id FROM cities WHERE id = $1"
      : "SELECT leader_player_id AS leader_id FROM kingdoms WHERE id = $1",
    [organization.id]
  );
  return result.rows[0]?.leader_id ?? null;
}

export async function organizationName(
  queryable: Queryable,
  organization: OrganizationRef
): Promise<string> {
  const result = await queryable.query<{ name: string }>(
    organization.kind === "city"
      ? "SELECT name FROM cities WHERE id = $1"
      : "SELECT display_name AS name FROM kingdoms WHERE id = $1",
    [organization.id]
  );
  return result.rows[0]?.name ?? (organization.kind === "city" ? "a city" : "a kingdom");
}

/** The Mayor / leader and every active member, deduplicated and sorted. */
export async function organizationAudience(
  queryable: Queryable,
  organization: OrganizationRef
): Promise<string[]> {
  const result = await queryable.query<{ player_id: string }>(
    organization.kind === "city"
      ? `SELECT player_id FROM city_memberships WHERE city_id = $1 AND left_at IS NULL
         UNION SELECT mayor_player_id FROM cities WHERE id = $1 AND mayor_player_id IS NOT NULL`
      : `SELECT player_id FROM kingdom_memberships WHERE kingdom_id = $1 AND status = 'active'
         UNION SELECT leader_player_id FROM kingdoms WHERE id = $1`,
    [organization.id]
  );
  return [...new Set(result.rows.map((row) => row.player_id))].sort();
}

function canonicalSides(left: OrganizationRef, right: OrganizationRef): [OrganizationRef, OrganizationRef] {
  const leftKey = `${left.kind}:${left.id}`;
  const rightKey = `${right.kind}:${right.id}`;
  return leftKey < rightKey ? [left, right] : [right, left];
}

function organizationLabel(kind: OrganizationKind, name: string): string {
  return kind === "city" ? `the city of ${name}` : `the Kingdom of ${name}`;
}

/** End of the forced peace between two organizations, or null when none holds. */
export async function forcedPeaceUntil(
  queryable: Queryable,
  left: OrganizationRef,
  right: OrganizationRef
): Promise<Date | null> {
  if (left.kind === right.kind && left.id === right.id) return null;
  const [sideA, sideB] = canonicalSides(left, right);
  const result = await queryable.query<{ peace_until: Date | null }>(
    `SELECT max(peace_until) AS peace_until FROM organization_wars
     WHERE side_a_kind = $1 AND side_a_id = $2::uuid AND side_b_kind = $3 AND side_b_id = $4::uuid
       AND peace_until > clock_timestamp()`,
    [sideA.kind, sideA.id, sideB.kind, sideB.id]
  );
  const until = result.rows[0]?.peace_until;
  return until ? new Date(until) : null;
}

export function forcedPeaceMessage(until: Date): string {
  return "A forced peace holds between your side and this city or kingdom until " +
    `${until.toISOString().slice(0, 16).replace("T", " ")} UTC. No attacks or war declarations until then.`;
}

/**
 * Pre-damage check for every hostile action on a city or kingdom structure:
 * the refusal message when the attacker's side (kingdom first, then city)
 * is in a forced peace with the defender, otherwise null.
 */
export async function forcedPeaceRefusalInTransaction(
  client: Queryable,
  attackerPlayerId: string,
  defender: OrganizationRef
): Promise<string | null> {
  const attacker = attackingOrganization(await loadPlayerOrganizations(client, attackerPlayerId));
  if (!attacker) return null;
  const until = await forcedPeaceUntil(client, attacker, defender);
  return until ? forcedPeaceMessage(until) : null;
}

async function insertGameNotices(
  queryable: Queryable,
  playerIds: readonly string[],
  message: string,
  eventKind: string,
  eventId: string
): Promise<void> {
  if (playerIds.length === 0) return;
  await queryable.query(
    `INSERT INTO player_inbox_entries (
       id, player_id, entry_kind, message, created_at, status, event_kind, event_id
     )
     SELECT gen_random_uuid(), recipient.player_id, 'game_notice', $2, clock_timestamp(), 'notice', $3, $4::uuid
     FROM unnest($1::text[]) AS recipient(player_id)
     JOIN players player ON player.id = recipient.player_id
     ON CONFLICT (player_id, event_kind, event_id) WHERE entry_kind = 'game_notice' DO NOTHING`,
    [playerIds, message, eventKind, eventId]
  );
}

/**
 * Returns the active war between two organizations, declaring it on the spot
 * when none exists. Idempotent: the partial unique index admits one active row
 * per pair, so concurrent attackers converge on the same war and only the
 * inserting transaction sends the "war declared" alerts.
 */
export async function ensureActiveWarInTransaction(
  client: Queryable,
  input: Readonly<{
    aggressor: OrganizationRef;
    defender: OrganizationRef;
    via: "settings" | "attack";
    playerId: string | null;
  }>
): Promise<{ warId: string; declared: boolean }> {
  if (input.aggressor.kind === input.defender.kind && input.aggressor.id === input.defender.id) {
    throw new OrganizationWarError("WAR_TARGET_INVALID", "An organization cannot declare war on itself.");
  }
  const peaceUntil = await forcedPeaceUntil(client, input.aggressor, input.defender);
  if (peaceUntil) {
    throw new OrganizationWarError("WAR_FORCED_PEACE", forcedPeaceMessage(peaceUntil), 409);
  }
  const [sideA, sideB] = canonicalSides(input.aggressor, input.defender);
  const inserted = await client.query<{ war_id: string }>(
    `INSERT INTO organization_wars (
       side_a_kind, side_a_id, side_b_kind, side_b_id,
       aggressor_kind, aggressor_id, declared_by_player_id, declared_via
     ) VALUES ($1,$2::uuid,$3,$4::uuid,$5,$6::uuid,$7,$8)
     ON CONFLICT (side_a_kind, side_a_id, side_b_kind, side_b_id) WHERE status = 'active' DO NOTHING
     RETURNING war_id::text`,
    [
      sideA.kind, sideA.id, sideB.kind, sideB.id,
      input.aggressor.kind, input.aggressor.id, input.playerId, input.via
    ]
  );
  const warId = inserted.rows[0]?.war_id;
  if (!warId) {
    const existing = await client.query<{ war_id: string }>(
      `SELECT war_id::text FROM organization_wars
       WHERE side_a_kind = $1 AND side_a_id = $2::uuid AND side_b_kind = $3 AND side_b_id = $4::uuid
         AND status = 'active'`,
      [sideA.kind, sideA.id, sideB.kind, sideB.id]
    );
    const row = existing.rows[0];
    if (!row) throw new Error("Active war disappeared during declaration");
    return { warId: row.war_id, declared: false };
  }
  const [aggressorName, defenderName] = await Promise.all([
    organizationName(client, input.aggressor),
    organizationName(client, input.defender)
  ]);
  const message = `War declared: ${organizationLabel(input.aggressor.kind, aggressorName)} is now at war with ` +
    `${organizationLabel(input.defender.kind, defenderName)}.`;
  const audience = [...new Set([
    ...await organizationAudience(client, input.aggressor),
    ...await organizationAudience(client, input.defender)
  ])].sort();
  await insertGameNotices(client, audience, message, WAR_DECLARED_EVENT_KIND, warId);
  return { warId, declared: true };
}

/**
 * Sends the defending organization's "under attack" alert unless one went
 * out within the rate-limit window. The upsert's WHERE clause is the limiter,
 * so concurrent hits send at most one alert.
 */
export async function sendUnderAttackAlertInTransaction(
  client: Queryable,
  input: Readonly<{
    defender: OrganizationRef;
    profile: Pick<StructureWarfareProfile, "kind">;
    /** Player-facing structure kind; defaults to the profile display kind (city buildings pass their name). */
    structureLabel?: string;
    structureName: string;
  }>
): Promise<boolean> {
  const claimed = await client.query<{ alert_id: string }>(
    `INSERT INTO organization_war_alerts (
       organization_kind, organization_id, alert_kind, alert_id, last_sent_at
     ) VALUES ($1,$2::uuid,'under_attack',gen_random_uuid(),clock_timestamp())
     ON CONFLICT (organization_kind, organization_id, alert_kind) DO UPDATE
       SET alert_id = EXCLUDED.alert_id, last_sent_at = EXCLUDED.last_sent_at
       WHERE organization_war_alerts.last_sent_at
         <= clock_timestamp() - ($3::bigint * interval '1 millisecond')
     RETURNING alert_id::text`,
    [input.defender.kind, input.defender.id, ORGANIZATION_UNDER_ATTACK_ALERT_INTERVAL_MS]
  );
  const alertId = claimed.rows[0]?.alert_id;
  if (!alertId) return false;
  const name = await organizationName(client, input.defender);
  const structure = input.structureLabel ?? structureWarfareDisplayKind(input.profile.kind);
  const message = `Under attack: ${organizationLabel(input.defender.kind, name)} is under attack. ` +
    `A hostile player struck its ${structure} “${input.structureName}”.`;
  await insertGameNotices(
    client,
    await organizationAudience(client, input.defender),
    message,
    UNDER_ATTACK_EVENT_KIND,
    alertId
  );
  return true;
}

/**
 * Called by every hostile action on a city or kingdom structure, inside the
 * damage transaction: declares the war when the attacker fights for a city or
 * kingdom (a player in neither creates no war) and raises the defender's
 * rate-limited "under attack" alert.
 */
export async function recordOrganizationHostilityInTransaction(
  client: Queryable,
  input: Readonly<{
    attackerPlayerId: string;
    defender: OrganizationRef;
    profile: Pick<StructureWarfareProfile, "kind">;
    /** Player-facing structure kind; defaults to the profile display kind (city buildings pass their name). */
    structureLabel?: string;
    structureName: string;
  }>
): Promise<{ warId: string | null; declared: boolean }> {
  const attacker = attackingOrganization(await loadPlayerOrganizations(client, input.attackerPlayerId));
  let war: { warId: string | null; declared: boolean } = { warId: null, declared: false };
  if (attacker && !(attacker.kind === input.defender.kind && attacker.id === input.defender.id)) {
    war = await ensureActiveWarInTransaction(client, {
      aggressor: attacker,
      defender: input.defender,
      via: "attack",
      playerId: input.attackerPlayerId
    });
  }
  await sendUnderAttackAlertInTransaction(client, {
    defender: input.defender,
    profile: input.profile,
    ...(input.structureLabel ? { structureLabel: input.structureLabel } : {}),
    structureName: input.structureName
  });
  return war;
}

/** True when an active repair channel is running on the structure. */
export async function hasActiveRepair(queryable: Queryable, flagId: string): Promise<boolean> {
  const result = await queryable.query(
    "SELECT 1 FROM flag_repair_operations WHERE flag_id = $1::uuid AND status = 'active' LIMIT 1",
    [flagId]
  );
  return (result.rowCount ?? 0) > 0;
}

export class OrganizationWarError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) {
    super(message);
    this.name = "OrganizationWarError";
  }
}

export type OrganizationWarSideSnapshot = Readonly<{
  kind: OrganizationKind;
  id: string;
  name: string;
}>;

export type OrganizationWarSnapshot = Readonly<{
  warId: string;
  /** The player's own side (city or kingdom). */
  own: OrganizationWarSideSnapshot;
  enemy: OrganizationWarSideSnapshot;
  aggressor: "own" | "enemy";
  declaredVia: "settings" | "attack";
  declaredAt: string;
  /** Which side has a standing peace offer, if any. */
  peaceOffer: "own" | "enemy" | null;
  /** True when this player leads the own side (may surrender or make peace). */
  canAct: boolean;
}>;

export type OrganizationPeaceSnapshot = Readonly<{
  warId: string;
  own: OrganizationWarSideSnapshot;
  enemy: OrganizationWarSideSnapshot;
  endedReason: "surrender" | "mutual_peace";
  /** Set for a surrender: which side gave up. */
  surrendered: "own" | "enemy" | null;
  peaceUntil: string;
}>;

export type OrganizationWarState = Readonly<{
  wars: OrganizationWarSnapshot[];
  /** Forced peaces still running for the player's own sides. */
  peaces: OrganizationPeaceSnapshot[];
  /** Organizations this player may declare war for (leader / Mayor). */
  canDeclareAs: OrganizationWarSideSnapshot[];
  /** Server clock when the state was read, for translating peaceUntil to the display clock. */
  serverTime: string;
}>;

export type OrganizationWarSurrenderResult = Readonly<{
  warId: string;
  /** False when the same side's surrender was already settled (replay). */
  settled: boolean;
  currency: "bricks" | "city_coins";
  balanceBefore: number;
  transferred: number;
  destroyed: number;
  peaceUntil: string;
}>;

type WarRow = {
  war_id: string;
  side_a_kind: OrganizationKind;
  side_a_id: string;
  side_b_kind: OrganizationKind;
  side_b_id: string;
  status: "active" | "ended";
  ended_reason: "surrender" | "mutual_peace" | null;
  peace_until: Date | null;
  peace_offer_kind: OrganizationKind | null;
  peace_offer_id: string | null;
};

function sameOrganization(left: OrganizationRef, right: OrganizationRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function warSides(row: Pick<WarRow, "side_a_kind" | "side_a_id" | "side_b_kind" | "side_b_id">): [OrganizationRef, OrganizationRef] {
  return [{ kind: row.side_a_kind, id: row.side_a_id }, { kind: row.side_b_kind, id: row.side_b_id }];
}

async function lockWarRow(client: Queryable, warId: string): Promise<WarRow> {
  const result = await client.query<WarRow>(
    `SELECT war_id::text, side_a_kind, side_a_id::text, side_b_kind, side_b_id::text, status,
            ended_reason, peace_until, peace_offer_kind, peace_offer_id::text
     FROM organization_wars WHERE war_id = $1::uuid FOR UPDATE`,
    [warId]
  );
  const row = result.rows[0];
  if (!row) throw new OrganizationWarError("WAR_NOT_FOUND", "That war no longer exists.", 404);
  return row;
}

/** The war's other side, or a refusal when `side` is not one of its sides. */
function enemySide(row: WarRow, side: OrganizationRef): OrganizationRef {
  const [sideA, sideB] = warSides(row);
  if (sameOrganization(sideA, side)) return sideB;
  if (sameOrganization(sideB, side)) return sideA;
  throw new OrganizationWarError("WAR_SIDE_INVALID", "Your city or kingdom is not part of that war.");
}

/**
 * Moves City Coins in or out of a city treasury with its ledger row. The
 * caller holds the war row lock (and, for two cities, both treasury rows
 * locked in id order); operation_key is unique, so a replay cannot move
 * the balance twice.
 */
async function moveCityCoinsForWarInTransaction(
  client: Queryable,
  input: Readonly<{
    cityId: string;
    actorPlayerId: string;
    delta: number;
    entryType: "war_surrender_transfer" | "war_surrender_destroyed";
    operationKey: string;
    warId: string;
    metadata: Record<string, unknown>;
  }>
): Promise<void> {
  const updated = await client.query<{ balance: string }>(
    `UPDATE city_treasuries
     SET balance = balance + $2::bigint,
         lifetime_earned = lifetime_earned + GREATEST($2::bigint, 0),
         lifetime_spent = lifetime_spent + GREATEST(-$2::bigint, 0),
         revision = revision + 1,
         updated_at = now()
     WHERE city_id = $1::uuid AND balance + $2::bigint >= 0
     RETURNING balance::text`,
    [input.cityId, input.delta]
  );
  if (!updated.rows[0]) throw new Error("City treasury cannot cover the surrender settlement");
  await client.query(
    `INSERT INTO city_coin_ledger (
       operation_key, city_id, player_id, entry_type, delta, balance_after, source_type, source_id, metadata
     ) VALUES ($1,$2::uuid,$3,$4,$5::bigint,$6::bigint,'organization_war',$7,$8::jsonb)`,
    [input.operationKey, input.cityId, input.actorPlayerId, input.entryType, input.delta,
      updated.rows[0].balance, input.warId, JSON.stringify(input.metadata)]
  );
}

/**
 * Settles a surrender inside the caller's transaction (war row locked and
 * still active): 14% of the loser's treasury currency to the winner, 12%
 * destroyed. Kingdoms hold Bricks and cities hold City Coins; between a
 * city and a kingdom the winner cannot hold the loser's currency, so its
 * transfer share is destroyed as well. Treasury rows are locked in id order.
 */
async function settleSurrenderInTransaction(
  client: Queryable,
  input: Readonly<{ warId: string; loser: OrganizationRef; winner: OrganizationRef; actorPlayerId: string }>
): Promise<{ currency: "bricks" | "city_coins"; balanceBefore: number; transferred: number; destroyed: number }> {
  const { warId, loser, winner, actorPlayerId } = input;
  const sameCurrency = loser.kind === winner.kind;
  const metadata = { warId, loser, winner };
  if (loser.kind === "kingdom") {
    const lockOrder = sameCurrency ? [loser.id, winner.id].sort() : [loser.id];
    let balanceBefore = 0;
    for (const kingdomId of lockOrder) {
      const balance = await lockKingdomTreasuryBalance(client, kingdomId, BRICKS_ITEM_ID);
      if (kingdomId === loser.id) balanceBefore = balance;
    }
    const split = warSurrenderSplit(balanceBefore);
    const transferred = sameCurrency ? split.transferShare : 0;
    const destroyed = split.destroyShare + (sameCurrency ? 0 : split.transferShare);
    if (transferred > 0) {
      const operationKey = `war-surrender:${warId}:transfer`;
      for (const [kingdomId, direction] of [[loser.id, "debit"], [winner.id, "credit"]] as const) {
        const moved = await moveKingdomTreasuryInTransaction(client, {
          kingdomId, actorPlayerId, resourceType: BRICKS_ITEM_ID, direction, quantity: transferred,
          sourceType: "war_surrender_transfer", operationKey, sourceId: warId, metadata
        });
        if (!moved) throw new Error("Surrender transfer exceeded the locked treasury balance");
      }
    }
    if (destroyed > 0) {
      const moved = await moveKingdomTreasuryInTransaction(client, {
        kingdomId: loser.id, actorPlayerId, resourceType: BRICKS_ITEM_ID, direction: "debit", quantity: destroyed,
        sourceType: "war_surrender_destroyed", operationKey: `war-surrender:${warId}:destroy`, sourceId: warId, metadata
      });
      if (!moved) throw new Error("Surrender destruction exceeded the locked treasury balance");
    }
    return { currency: "bricks", balanceBefore, transferred, destroyed };
  }
  const cityIds = sameCurrency ? [loser.id, winner.id].sort() : [loser.id];
  await client.query(
    "INSERT INTO city_treasuries (city_id) SELECT unnest($1::uuid[]) ON CONFLICT (city_id) DO NOTHING",
    [cityIds]
  );
  const locked = await client.query<{ city_id: string; balance: string }>(
    `SELECT city_id::text, balance::text FROM city_treasuries
     WHERE city_id = ANY($1::uuid[]) ORDER BY city_id FOR UPDATE`,
    [cityIds]
  );
  const balanceBefore = Number(locked.rows.find((row) => row.city_id === loser.id)?.balance ?? 0);
  const split = warSurrenderSplit(balanceBefore);
  const transferred = sameCurrency ? split.transferShare : 0;
  const destroyed = split.destroyShare + (sameCurrency ? 0 : split.transferShare);
  if (transferred > 0) {
    await moveCityCoinsForWarInTransaction(client, {
      cityId: loser.id, actorPlayerId, delta: -transferred, entryType: "war_surrender_transfer",
      operationKey: `war-surrender:${warId}:transfer-out`, warId, metadata
    });
    await moveCityCoinsForWarInTransaction(client, {
      cityId: winner.id, actorPlayerId, delta: transferred, entryType: "war_surrender_transfer",
      operationKey: `war-surrender:${warId}:transfer-in`, warId, metadata
    });
  }
  if (destroyed > 0) {
    await moveCityCoinsForWarInTransaction(client, {
      cityId: loser.id, actorPlayerId, delta: -destroyed, entryType: "war_surrender_destroyed",
      operationKey: `war-surrender:${warId}:destroy`, warId, metadata
    });
  }
  return { currency: "city_coins", balanceBefore, transferred, destroyed };
}

/** Settings-facing war state: list, targets and declarations. */
export class OrganizationWarService {
  constructor(private readonly pool: pg.Pool) {}

  async state(playerId: string): Promise<OrganizationWarState> {
    const organizations = await loadPlayerOrganizations(this.pool, playerId);
    const own: OrganizationRef[] = [
      ...(organizations.kingdomId ? [{ kind: "kingdom" as const, id: organizations.kingdomId }] : []),
      ...(organizations.cityId ? [{ kind: "city" as const, id: organizations.cityId }] : [])
    ];
    const wars: OrganizationWarSnapshot[] = [];
    const peaces: OrganizationPeaceSnapshot[] = [];
    for (const side of own) {
      const canAct = await this.canDeclareFor(playerId, side);
      const ownName = await organizationName(this.pool, side);
      const ended = await this.pool.query<{
        war_id: string;
        side_a_kind: OrganizationKind;
        side_a_id: string;
        side_b_kind: OrganizationKind;
        side_b_id: string;
        ended_reason: "surrender" | "mutual_peace";
        peace_until: Date;
        loser_kind: OrganizationKind | null;
        loser_id: string | null;
      }>(
        `SELECT war.war_id::text, war.side_a_kind, war.side_a_id::text, war.side_b_kind, war.side_b_id::text,
                war.ended_reason, war.peace_until, surrender.loser_kind, surrender.loser_id::text
         FROM organization_wars war
         LEFT JOIN organization_war_surrenders surrender ON surrender.war_id = war.war_id
         WHERE war.peace_until > clock_timestamp()
           AND ((war.side_a_kind = $1 AND war.side_a_id = $2::uuid) OR (war.side_b_kind = $1 AND war.side_b_id = $2::uuid))
         ORDER BY war.peace_until DESC, war.war_id`,
        [side.kind, side.id]
      );
      for (const row of ended.rows) {
        const [sideA, sideB] = warSides(row);
        const enemy = sameOrganization(sideA, side) ? sideB : sideA;
        if (peaces.some((peace) => peace.own.id === side.id && sameOrganization(peace.enemy, enemy))) continue;
        peaces.push({
          warId: row.war_id,
          own: { ...side, name: ownName },
          enemy: { ...enemy, name: await organizationName(this.pool, enemy) },
          endedReason: row.ended_reason,
          surrendered: row.loser_kind && row.loser_id
            ? sameOrganization({ kind: row.loser_kind, id: row.loser_id }, side) ? "own" : "enemy"
            : null,
          peaceUntil: new Date(row.peace_until).toISOString()
        });
      }
      const result = await this.pool.query<{
        war_id: string;
        side_a_kind: OrganizationKind;
        side_a_id: string;
        side_b_kind: OrganizationKind;
        side_b_id: string;
        aggressor_kind: OrganizationKind;
        aggressor_id: string;
        declared_via: "settings" | "attack";
        declared_at: Date;
        peace_offer_kind: OrganizationKind | null;
        peace_offer_id: string | null;
      }>(
        `SELECT war_id::text, side_a_kind, side_a_id::text, side_b_kind, side_b_id::text,
                aggressor_kind, aggressor_id::text, declared_via, declared_at,
                peace_offer_kind, peace_offer_id::text
         FROM organization_wars
         WHERE status = 'active'
           AND ((side_a_kind = $1 AND side_a_id = $2::uuid) OR (side_b_kind = $1 AND side_b_id = $2::uuid))
         ORDER BY declared_at DESC, war_id`,
        [side.kind, side.id]
      );
      for (const row of result.rows) {
        const enemy: OrganizationRef = row.side_a_kind === side.kind && row.side_a_id === side.id
          ? { kind: row.side_b_kind, id: row.side_b_id }
          : { kind: row.side_a_kind, id: row.side_a_id };
        wars.push({
          warId: row.war_id,
          own: { ...side, name: ownName },
          enemy: { ...enemy, name: await organizationName(this.pool, enemy) },
          aggressor: row.aggressor_kind === side.kind && row.aggressor_id === side.id ? "own" : "enemy",
          declaredVia: row.declared_via,
          declaredAt: new Date(row.declared_at).toISOString(),
          peaceOffer: row.peace_offer_kind && row.peace_offer_id
            ? sameOrganization({ kind: row.peace_offer_kind, id: row.peace_offer_id }, side) ? "own" : "enemy"
            : null,
          canAct
        });
      }
    }
    const canDeclareAs: OrganizationWarSideSnapshot[] = [];
    for (const side of own) {
      if (await this.canDeclareFor(playerId, side)) {
        canDeclareAs.push({ ...side, name: await organizationName(this.pool, side) });
      }
    }
    return { wars, peaces, canDeclareAs, serverTime: new Date().toISOString() };
  }

  /**
   * The acting side gives up: its treasury pays the surrender settlement and
   * a forced peace starts. Idempotent per war: the war row lock serializes
   * concurrent requests, and a repeat by the side that already surrendered
   * returns the recorded settlement without moving anything.
   */
  async surrender(
    playerId: string,
    input: Readonly<{ warId: string; as: OrganizationRef }>
  ): Promise<OrganizationWarSurrenderResult> {
    return this.inTransaction(async (client) => {
      await this.requireLeader(client, playerId, input.as, "surrender");
      const war = await lockWarRow(client, input.warId);
      const winner = enemySide(war, input.as);
      if (war.status !== "active") {
        const prior = await client.query<{
          loser_kind: OrganizationKind;
          loser_id: string;
          currency: "bricks" | "city_coins";
          balance_before: string;
          transferred: string;
          destroyed: string;
        }>(
          `SELECT loser_kind, loser_id::text, currency, balance_before::text, transferred::text, destroyed::text
           FROM organization_war_surrenders WHERE war_id = $1::uuid`,
          [war.war_id]
        );
        const row = prior.rows[0];
        if (row && sameOrganization({ kind: row.loser_kind, id: row.loser_id }, input.as) && war.peace_until) {
          return {
            warId: war.war_id,
            settled: false,
            currency: row.currency,
            balanceBefore: Number(row.balance_before),
            transferred: Number(row.transferred),
            destroyed: Number(row.destroyed),
            peaceUntil: new Date(war.peace_until).toISOString()
          };
        }
        throw new OrganizationWarError("WAR_NOT_ACTIVE", "This war has already ended.", 409);
      }
      const settlement = await settleSurrenderInTransaction(client, {
        warId: war.war_id, loser: input.as, winner, actorPlayerId: playerId
      });
      const peaceUntil = await this.endWar(client, war.war_id, "surrender");
      await client.query(
        `INSERT INTO organization_war_surrenders (
           war_id, loser_kind, loser_id, winner_kind, winner_id, surrendered_by_player_id,
           currency, balance_before, transferred, destroyed
         ) VALUES ($1::uuid,$2,$3::uuid,$4,$5::uuid,$6,$7,$8,$9,$10)`,
        [war.war_id, input.as.kind, input.as.id, winner.kind, winner.id, playerId, settlement.currency,
          settlement.balanceBefore, settlement.transferred, settlement.destroyed]
      );
      const [loserName, winnerName] = await Promise.all([
        organizationName(client, input.as),
        organizationName(client, winner)
      ]);
      const unit = settlement.currency === "bricks" ? "Bricks" : "City Coins";
      const amounts = settlement.transferred > 0
        ? `${settlement.transferred.toLocaleString("en-US")} ${unit} went to the winner and ` +
          `${settlement.destroyed.toLocaleString("en-US")} were destroyed.`
        : `${settlement.destroyed.toLocaleString("en-US")} ${unit} were destroyed.`;
      await this.noticeBothSides(
        client,
        input.as,
        winner,
        `Surrender: ${organizationLabel(input.as.kind, loserName)} surrendered to ` +
          `${organizationLabel(winner.kind, winnerName)}. ${amounts} Peace holds for 7 days.`,
        WAR_ENDED_EVENT_KIND,
        war.war_id
      );
      return { warId: war.war_id, settled: true, ...settlement, peaceUntil: peaceUntil.toISOString() };
    });
  }

  /**
   * Offers peace for the acting side. When the other side already offered,
   * this accepts instead. Repeating an offer is a no-op.
   */
  async offerPeace(
    playerId: string,
    input: Readonly<{ warId: string; as: OrganizationRef }>
  ): Promise<{ warId: string; ended: boolean }> {
    return this.inTransaction(async (client) => {
      await this.requireLeader(client, playerId, input.as, "make peace");
      const war = await lockWarRow(client, input.warId);
      const enemy = enemySide(war, input.as);
      if (war.status !== "active") throw new OrganizationWarError("WAR_NOT_ACTIVE", "This war has already ended.", 409);
      if (war.peace_offer_kind && war.peace_offer_id && sameOrganization({ kind: war.peace_offer_kind, id: war.peace_offer_id }, enemy)) {
        await this.makePeace(client, war.war_id, input.as, enemy);
        return { warId: war.war_id, ended: true };
      }
      if (war.peace_offer_kind && war.peace_offer_id) return { warId: war.war_id, ended: false };
      await client.query(
        `UPDATE organization_wars
         SET peace_offer_kind = $2, peace_offer_id = $3::uuid, peace_offered_by_player_id = $4,
             peace_offered_at = clock_timestamp()
         WHERE war_id = $1::uuid AND status = 'active'`,
        [war.war_id, input.as.kind, input.as.id, playerId]
      );
      const name = await organizationName(client, input.as);
      await insertGameNotices(
        client,
        await organizationAudience(client, enemy),
        `Peace offered: ${organizationLabel(input.as.kind, name)} offers to end the war without penalty. ` +
          "Your leader can accept it from the Wars list.",
        PEACE_OFFERED_EVENT_KIND,
        war.war_id
      );
      return { warId: war.war_id, ended: false };
    });
  }

  /** Accepts the other side's standing peace offer: the war ends with no penalty. */
  async acceptPeace(
    playerId: string,
    input: Readonly<{ warId: string; as: OrganizationRef }>
  ): Promise<{ warId: string; ended: boolean }> {
    return this.inTransaction(async (client) => {
      await this.requireLeader(client, playerId, input.as, "make peace");
      const war = await lockWarRow(client, input.warId);
      const enemy = enemySide(war, input.as);
      if (war.status !== "active") {
        if (war.ended_reason === "mutual_peace") return { warId: war.war_id, ended: false };
        throw new OrganizationWarError("WAR_NOT_ACTIVE", "This war has already ended.", 409);
      }
      if (!war.peace_offer_kind || !war.peace_offer_id || !sameOrganization({ kind: war.peace_offer_kind, id: war.peace_offer_id }, enemy)) {
        throw new OrganizationWarError("WAR_PEACE_NOT_OFFERED", "The other side has not offered peace.", 409);
      }
      await this.makePeace(client, war.war_id, input.as, enemy);
      return { warId: war.war_id, ended: true };
    });
  }

  private async makePeace(client: Queryable, warId: string, own: OrganizationRef, enemy: OrganizationRef): Promise<void> {
    await this.endWar(client, warId, "mutual_peace");
    const [ownName, enemyName] = await Promise.all([organizationName(client, own), organizationName(client, enemy)]);
    await this.noticeBothSides(
      client,
      own,
      enemy,
      `Peace: ${organizationLabel(own.kind, ownName)} and ${organizationLabel(enemy.kind, enemyName)} ` +
        "agreed to end their war. Peace holds for 7 days.",
      WAR_ENDED_EVENT_KIND,
      warId
    );
  }

  /** Ends the locked, active war and starts the forced peace. */
  private async endWar(client: Queryable, warId: string, reason: "surrender" | "mutual_peace"): Promise<Date> {
    const ended = await client.query<{ peace_until: Date }>(
      `UPDATE organization_wars
       SET status = 'ended', ended_at = clock_timestamp(), ended_reason = $2,
           peace_until = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
           peace_offer_kind = NULL, peace_offer_id = NULL, peace_offered_by_player_id = NULL, peace_offered_at = NULL
       WHERE war_id = $1::uuid AND status = 'active'
       RETURNING peace_until`,
      [warId, reason, WAR_FORCED_PEACE_MS]
    );
    const row = ended.rows[0];
    if (!row) throw new Error("War ended concurrently despite the row lock");
    return new Date(row.peace_until);
  }

  private async noticeBothSides(
    client: Queryable,
    left: OrganizationRef,
    right: OrganizationRef,
    message: string,
    eventKind: string,
    eventId: string
  ): Promise<void> {
    const audience = [...new Set([
      ...await organizationAudience(client, left),
      ...await organizationAudience(client, right)
    ])].sort();
    await insertGameNotices(client, audience, message, eventKind, eventId);
  }

  private async requireLeader(
    client: Queryable,
    playerId: string,
    side: OrganizationRef,
    action: string
  ): Promise<void> {
    if (await this.canDeclareFor(playerId, side, client)) return;
    throw new OrganizationWarError(
      "WAR_PERMISSION_DENIED",
      side.kind === "kingdom" ? `Only the Kingdom leader may ${action}.` : `Only the city Mayor may ${action}.`,
      403
    );
  }

  private async inTransaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Active cities and kingdoms matching a name, excluding the player's own. */
  async targets(playerId: string, query: string): Promise<OrganizationWarSideSnapshot[]> {
    const organizations = await loadPlayerOrganizations(this.pool, playerId);
    const pattern = `%${query.trim().replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
    const result = await this.pool.query<{ kind: OrganizationKind; id: string; name: string }>(
      `SELECT * FROM (
         SELECT 'kingdom'::text AS kind, id::text, display_name AS name
         FROM kingdoms WHERE status = 'active' AND display_name ILIKE $1
           AND ($2::uuid IS NULL OR id <> $2::uuid)
         UNION ALL
         SELECT 'city'::text AS kind, id::text, name
         FROM cities WHERE active AND name ILIKE $1
           AND ($3::uuid IS NULL OR id <> $3::uuid)
       ) candidates
       ORDER BY name, kind, id
       LIMIT 20`,
      [pattern, organizations.kingdomId, organizations.cityId]
    );
    return result.rows.map((row) => ({ kind: row.kind, id: row.id, name: row.name }));
  }

  async declare(
    playerId: string,
    input: Readonly<{ as: OrganizationRef; target: OrganizationRef }>
  ): Promise<{ warId: string; declared: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!await this.canDeclareFor(playerId, input.as, client)) {
        throw new OrganizationWarError(
          "WAR_PERMISSION_DENIED",
          input.as.kind === "kingdom"
            ? "Only the Kingdom leader may declare war."
            : "Only the city Mayor may declare war.",
          403
        );
      }
      const target = await client.query(
        input.target.kind === "city"
          ? "SELECT 1 FROM cities WHERE id = $1::uuid AND active"
          : "SELECT 1 FROM kingdoms WHERE id = $1::uuid AND status = 'active'",
        [input.target.id]
      );
      if (target.rowCount !== 1) {
        throw new OrganizationWarError("WAR_TARGET_INVALID", "That city or kingdom is not active.", 404);
      }
      const organizations = await loadPlayerOrganizations(client, playerId);
      if (
        (input.target.kind === "city" && input.target.id === organizations.cityId) ||
        (input.target.kind === "kingdom" && input.target.id === organizations.kingdomId)
      ) {
        throw new OrganizationWarError("WAR_TARGET_INVALID", "You cannot declare war on your own city or kingdom.");
      }
      const result = await ensureActiveWarInTransaction(client, {
        aggressor: input.as,
        defender: input.target,
        via: "settings",
        playerId
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async canDeclareFor(
    playerId: string,
    side: OrganizationRef,
    queryable: Queryable = this.pool
  ): Promise<boolean> {
    const result = await queryable.query(
      side.kind === "kingdom"
        ? `SELECT 1 FROM kingdom_memberships membership
           JOIN kingdoms kingdom ON kingdom.id = membership.kingdom_id AND kingdom.status = 'active'
           WHERE membership.kingdom_id = $1::uuid AND membership.player_id = $2
             AND membership.status = 'active' AND membership.role = 'leader'`
        : `SELECT 1 FROM cities city
           JOIN city_memberships membership
             ON membership.city_id = city.id AND membership.player_id = $2 AND membership.left_at IS NULL
           WHERE city.id = $1::uuid AND city.active AND city.mayor_player_id = $2`,
      [side.id, playerId]
    );
    return (result.rowCount ?? 0) > 0;
  }
}
