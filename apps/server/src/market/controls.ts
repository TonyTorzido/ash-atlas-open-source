import { fileURLToPath } from "node:url";

import type pg from "pg";

import { loadConfig } from "../config.js";
import { createPool } from "../db/pool.js";
import { setMarketControlAuditContext } from "../game/marketControlAudit.js";
import { acquireMarketMutationSafetyLock } from "../game/marketSafetyLock.js";

export type ControlArguments = {
  globalReadOnly?: boolean;
  newOrders?: boolean;
  matching?: boolean;
  cancellations?: boolean;
  claims?: boolean;
  autoPauseOnInvariantFailure?: boolean;
  venueKey?: string;
  venueFrozen?: boolean;
  itemId?: string;
  itemFrozen?: boolean;
  playerId?: string;
  playerFrozen?: boolean;
  operatorIdentity?: string;
  reason?: string;
  incidentId?: string;
};

export async function updateMarketControls(
  databaseUrl: string,
  args: ControlArguments
): Promise<Record<string, unknown>> {
  const pool = createPool({ databaseUrl: databaseUrl });
  try {
    return await updateMarketControlsWithPool(pool, args);
  } finally {
    await pool.end();
  }
}

export async function updateMarketControlsWithPool(
  pool: Pick<pg.Pool, "connect">,
  args: ControlArguments
): Promise<Record<string, unknown>> {
  let client: pg.PoolClient | null = null;
  let began = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    began = true;
    const status = await updateMarketControlsInTransaction(client, args);
    await client.query("COMMIT");
    began = false;
    return status;
  } catch (error) {
    if (began && client) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client?.release();
  }
}

export async function updateMarketControlsInTransaction(
  client: pg.PoolClient,
  args: ControlArguments
): Promise<Record<string, unknown>> {
  const mutating = hasMutation(args);
  if (mutating) {
    const auditContext = {
      operatorIdentity: requiredText(args.operatorIdentity, "--operator", 160),
      reason: requiredText(args.reason, "--reason", 240),
      incidentId: optionalText(args.incidentId, "--incident-id", 160)
    };
    await acquireMarketMutationSafetyLock(client);
    await setMarketControlAuditContext(client, auditContext);
  }

  if ([
    args.globalReadOnly,
    args.newOrders,
    args.matching,
    args.cancellations,
    args.claims,
    args.autoPauseOnInvariantFailure
  ].some((value) => value !== undefined)) {
    const updated = await client.query(
      `UPDATE market_global_controls SET
         read_only = coalesce($1, read_only),
         new_orders_enabled = coalesce($2, new_orders_enabled),
         matching_enabled = coalesce($3, matching_enabled),
         cancellations_enabled = coalesce($4, cancellations_enabled),
         claims_enabled = coalesce($5, claims_enabled),
         auto_pause_on_invariant_failure = coalesce($6, auto_pause_on_invariant_failure),
         updated_at = now()
       WHERE singleton`,
      [
        args.globalReadOnly,
        args.newOrders,
        args.matching,
        args.cancellations,
        args.claims,
        args.autoPauseOnInvariantFailure
      ]
    );
    if (updated.rowCount !== 1) throw new Error("Market global controls do not exist");
  }

  if (args.playerFrozen !== undefined) {
    if (!args.playerId) throw new Error("--player-id is required with --player-frozen");
    const updated = await client.query(
      `INSERT INTO market_player_controls (
         account_id, player_id, mutations_frozen, sensitive_reason, updated_at
       )
       SELECT account_id, id, $2, CASE WHEN $2 THEN $3 ELSE NULL END, now()
       FROM players WHERE id = $1 AND account_id IS NOT NULL
       ON CONFLICT (account_id) DO UPDATE SET
         mutations_frozen = EXCLUDED.mutations_frozen,
         sensitive_reason = EXCLUDED.sensitive_reason,
         updated_at = now()`,
      [args.playerId, args.playerFrozen, args.reason]
    );
    if (updated.rowCount !== 1) throw new Error("Authenticated market player does not exist");
  }

  if (args.venueFrozen !== undefined) {
    if (!args.venueKey) throw new Error("--venue-key is required with --venue-frozen");
    const updated = await client.query(
      `UPDATE market_venue_controls c
       SET frozen = $2,
           sensitive_reason = CASE WHEN $2 THEN $3 ELSE NULL END,
           updated_at = now()
       FROM market_venues v
       WHERE c.venue_id = v.venue_id AND v.venue_key = $1`,
      [args.venueKey, args.venueFrozen, args.reason]
    );
    if (updated.rowCount !== 1) throw new Error("Market venue does not exist");
  }

  if (args.itemFrozen !== undefined) {
    if (!args.itemId) throw new Error("--item-id is required with --item-frozen");
    const locked = await client.query<{ book_id: string }>(
      `SELECT book_id
       FROM market_order_books
       WHERE item_id = $1
       ORDER BY book_id
       FOR UPDATE`,
      [args.itemId]
    );
    if (locked.rowCount === 0) throw new Error("Market item has no order book yet");
    await client.query(
      `UPDATE market_order_books
       SET frozen = $2,
           sensitive_reason = CASE WHEN $2 THEN $3 ELSE NULL END,
           updated_at = now()
       WHERE book_id = ANY($1::uuid[])`,
      [locked.rows.map((row) => row.book_id), args.itemFrozen, args.reason]
    );
  }

  return loadControlStatus(client);
}

export async function loadControlStatus(client: Pick<pg.PoolClient, "query">) {
  const global = await client.query(
    `SELECT read_only, new_orders_enabled, matching_enabled,
            cancellations_enabled, claims_enabled,
            auto_pause_on_invariant_failure, rules_version, updated_at
     FROM market_global_controls WHERE singleton`
  );
  const venues = await client.query(
    `SELECT v.venue_key, c.frozen, c.sensitive_reason, c.updated_at
     FROM market_venue_controls c JOIN market_venues v ON v.venue_id = c.venue_id
     ORDER BY v.venue_key`
  );
  const books = await client.query(
    `SELECT item_id, book_id, frozen, sensitive_reason, book_version::text, updated_at
     FROM market_order_books WHERE frozen ORDER BY item_id, book_id`
  );
  const players = await client.query(
    `SELECT player_id, mutations_frozen, sensitive_reason, updated_at
     FROM market_player_controls WHERE mutations_frozen ORDER BY player_id`
  );
  return {
    global: global.rows[0] ?? null,
    venues: venues.rows,
    frozenBooks: books.rows,
    frozenPlayers: players.rows
  };
}

export function parseArguments(values: string[]): ControlArguments {
  const parsed: ControlArguments = {};
  for (const raw of values) {
    const [key, value, extra] = raw.split("=");
    if (!key?.startsWith("--") || value === undefined || extra !== undefined) {
      throw new Error(`Invalid argument: ${raw}. Use --name=value.`);
    }
    switch (key) {
      case "--global-read-only": parsed.globalReadOnly = bool(value); break;
      case "--new-orders": parsed.newOrders = bool(value); break;
      case "--matching": parsed.matching = bool(value); break;
      case "--cancellations": parsed.cancellations = bool(value); break;
      case "--claims": parsed.claims = bool(value); break;
      case "--auto-pause-on-invariant-failure": parsed.autoPauseOnInvariantFailure = bool(value); break;
      case "--venue-key": parsed.venueKey = safeText(value, 80); break;
      case "--venue-frozen": parsed.venueFrozen = bool(value); break;
      case "--item-id": parsed.itemId = safeText(value, 120); break;
      case "--item-frozen": parsed.itemFrozen = bool(value); break;
      case "--player-id": parsed.playerId = safeText(value, 160); break;
      case "--player-frozen": parsed.playerFrozen = bool(value); break;
      case "--operator": parsed.operatorIdentity = safeText(value, 160); break;
      case "--reason": parsed.reason = safeText(value, 240); break;
      case "--incident-id": parsed.incidentId = safeText(value, 160); break;
      default: throw new Error(`Unknown market control argument: ${key}`);
    }
  }
  return parsed;
}

function hasMutation(args: ControlArguments): boolean {
  return [
    args.globalReadOnly,
    args.newOrders,
    args.matching,
    args.cancellations,
    args.claims,
    args.autoPauseOnInvariantFailure,
    args.venueFrozen,
    args.itemFrozen,
    args.playerFrozen
  ].some((value) => value !== undefined);
}

function requiredText(value: string | undefined, flag: string, maximum: number): string {
  if (value === undefined) throw new Error(`${flag} is required for mutating market controls`);
  return safeText(value, maximum);
}

function optionalText(value: string | undefined, flag: string, maximum: number): string | null {
  if (value === undefined) return null;
  try {
    return safeText(value, maximum);
  } catch {
    throw new Error(`${flag} is invalid`);
  }
}

function bool(value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("Boolean control values must be true or false");
}

function safeText(value: string, maximum: number): string {
  const normalized = value.trim();
  if (
    !normalized || normalized.length > maximum ||
    [...normalized].some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new Error("Market control text is invalid");
  }
  return normalized;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = loadConfig();
  updateMarketControls(config.DATABASE_URL, parseArguments(process.argv.slice(2)))
    .then((status) => console.log(JSON.stringify({ ok: true, status }, null, 2)))
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
