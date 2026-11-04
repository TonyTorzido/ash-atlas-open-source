import { randomUUID } from "node:crypto";

import type pg from "pg";

import { FLAG_CONTROL_TOUCH_TOLERANCE_M, lockFlagControlGeometry } from "./flagControlGeometry.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

/**
 * Territory collapse: when a city ends or a kingdom falls, every flag it owns
 * breaks in a staggered wave outward from its seat.
 *
 * Ownership rule (see cities.ts convertCityFlag / kingdoms.ts convertKingdomFlag):
 * a city or kingdom flag belongs to its organization. `flags.owner_id` holds the
 * Mayor / Kingdom leader at conversion time (it cannot change while affiliated);
 * it grants nothing by itself. Rights come from the Mayor / Kingdom role.
 * Provenance (original owner, contributor) stays in the affiliation history and,
 * for kingdom flags, in original_owner_player_id / contributed_by_player_id.
 *
 * Lifecycle:
 *  1. The ending transaction calls beginTerritoryCollapseInTransaction after it
 *     marked the organization ended. It marks every flag collapsing
 *     (flags.territory_collapse_id), which immediately removes the flag from
 *     territory claim and travel, and enqueues every flag with a wave hop
 *     (network distance from the seat) and a due_at spread into batches.
 *  2. TerritoryCollapseService.breakDueBatch (ticked by the realtime supervisor)
 *     claims due rows FOR UPDATE SKIP LOCKED and deletes those flags through
 *     breakTerritoryFlagsInTransaction. The queue row's pending -> broken flip
 *     commits with the deletion, so the queue is its own idempotency ledger and a
 *     restart resumes from the remaining pending rows.
 *
 * Breaking is not demolition: no construction refund is paid (like a burn).
 * Civic city structures stay attached to the inactive city record; members'
 * personal structures are handled by the existing membership-loss path.
 */
export const TERRITORY_COLLAPSE_BATCH_SIZE = 20;
export const TERRITORY_COLLAPSE_BATCH_INTERVAL_MS = 250;
export const TERRITORY_COLLAPSE_TICK_MS = 250;

export type TerritoryCollapseKind = "city" | "kingdom";

export type BeginTerritoryCollapseInput = Readonly<{
  kind: TerritoryCollapseKind;
  id: string;
  displayName: string;
  reason: string;
  actorPlayerId: string | null;
  /** Players told once that the territory has fallen (members at the fall). */
  notifyPlayerIds: readonly string[];
  now?: Date;
}>;

export type TerritoryCollapseBegun = Readonly<{
  collapseId: string;
  kind: TerritoryCollapseKind;
  id: string;
  displayName: string;
  reason: string;
  flagCount: number;
}>;

export type TerritoryCollapseBatch = Readonly<{
  collapseId: string;
  kind: TerritoryCollapseKind;
  id: string;
  displayName: string;
  reason: string;
  /** Flags removed in this batch (broken, or already gone). */
  flagIds: string[];
  completed: boolean;
}>;

export type TerritoryCollapseAnnouncement = Readonly<{
  collapseId: string;
  kind: TerritoryCollapseKind;
  id: string;
  displayName: string;
  reason: string;
  flagCount: number;
  notifyPlayerIds: string[];
}>;

type WaveFlagRow = {
  id: string;
  owner_id: string;
  original_owner_player_id: string | null;
  control_type: string;
  center_distance_m: number;
};

/**
 * Orders flags by network hop distance from the seat. Seats are hop 0; flags
 * the network no longer reaches break last, ordered by distance. Adjacency is
 * loaded in one indexed self-join and walked breadth-first here, which stays
 * bounded where a recursive CTE carrying hop counts would revisit nodes.
 */
export async function loadTerritoryWaveOrder(
  queryable: Queryable,
  kind: TerritoryCollapseKind,
  id: string
): Promise<Array<WaveFlagRow & { hop: number }>> {
  const column = kind === "city" ? "city_id" : "kingdom_id";
  const center = kind === "city"
    ? `(SELECT COALESCE(seat.geom, city.hall_geom) FROM cities city
         LEFT JOIN flags seat ON seat.id = city.seat_flag_id WHERE city.id = $1)`
    : `(SELECT seat.geom FROM kingdom_seats seat WHERE seat.kingdom_id = $1
         ORDER BY (seat.status = 'active') DESC, seat.created_at DESC LIMIT 1)`;
  const flags = await queryable.query<WaveFlagRow>(
    `SELECT flag.id::text AS id, flag.owner_id, flag.original_owner_player_id,
            flag.control_type,
            COALESCE(ST_Distance(flag.geom::geography, (${center})::geography), 0)::double precision
              AS center_distance_m
     FROM flags flag
     WHERE flag.${column} = $1
     ORDER BY flag.id`,
    [id]
  );
  if (flags.rows.length === 0) return [];
  const edges = await queryable.query<{ a: string; b: string }>(
    `SELECT a.id::text AS a, b.id::text AS b
     FROM flags a
     JOIN flags b
       ON b.${column} = $1 AND b.id > a.id
      AND ST_DWithin(a.geom::geography, b.geom::geography,
                     a.claim_radius_m + b.claim_radius_m + $2)
     WHERE a.${column} = $1`,
    [id, FLAG_CONTROL_TOUCH_TOLERANCE_M]
  );
  const neighbors = new Map<string, string[]>();
  for (const { a, b } of edges.rows) {
    neighbors.set(a, [...(neighbors.get(a) ?? []), b]);
    neighbors.set(b, [...(neighbors.get(b) ?? []), a]);
  }
  const seatTypes = kind === "city" ? ["city_seat"] : ["kingdom_seat"];
  let roots = flags.rows.filter((flag) => seatTypes.includes(flag.control_type)).map((flag) => flag.id);
  if (roots.length === 0) {
    // No seat flag left: start from the flag nearest the seat / hall.
    const nearest = [...flags.rows].sort((left, right) =>
      Number(left.center_distance_m) - Number(right.center_distance_m) || left.id.localeCompare(right.id)
    )[0]!;
    roots = [nearest.id];
  }
  const hops = new Map<string, number>(roots.map((root) => [root, 0]));
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const hop = hops.get(current)!;
    for (const next of neighbors.get(current) ?? []) {
      if (hops.has(next)) continue;
      hops.set(next, hop + 1);
      queue.push(next);
    }
  }
  const unreachedHop = Math.max(0, ...hops.values()) + 1;
  return flags.rows
    .map((flag) => ({ ...flag, hop: hops.get(flag.id) ?? unreachedHop }))
    .sort((left, right) =>
      left.hop - right.hop ||
      Number(left.center_distance_m) - Number(right.center_distance_m) ||
      left.id.localeCompare(right.id)
    );
}

/**
 * Called inside the transaction that ends the city / kingdom, after the
 * organization row is marked ended and while its flag network is locked.
 */
export async function beginTerritoryCollapseInTransaction(
  client: Queryable,
  input: BeginTerritoryCollapseInput
): Promise<TerritoryCollapseBegun> {
  const now = input.now ?? new Date();
  const collapseId = randomUUID();
  const ordered = await loadTerritoryWaveOrder(client, input.kind, input.id);
  const notify = [...new Set([
    ...input.notifyPlayerIds,
    ...ordered.map((flag) => flag.original_owner_player_id ?? flag.owner_id)
  ])].sort();
  await client.query(
    `INSERT INTO territory_collapses (
       collapse_id, kind, city_id, kingdom_id, display_name, reason,
       actor_player_id, flag_count, notify_player_ids, created_at, completed_at, status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10,
               CASE WHEN $8::integer = 0 THEN $10::timestamptz ELSE NULL END,
               CASE WHEN $8::integer = 0 THEN 'completed' ELSE 'active' END)`,
    [
      collapseId,
      input.kind,
      input.kind === "city" ? input.id : null,
      input.kind === "kingdom" ? input.id : null,
      input.displayName,
      input.reason,
      input.actorPlayerId,
      ordered.length,
      notify,
      now
    ]
  );
  if (ordered.length > 0) {
    const ids = ordered.map((flag) => flag.id);
    const dueAt = ordered.map((_, index) => new Date(
      now.getTime() +
      Math.floor(index / TERRITORY_COLLAPSE_BATCH_SIZE) * TERRITORY_COLLAPSE_BATCH_INTERVAL_MS
    ).toISOString());
    await client.query(
      `INSERT INTO territory_collapse_flags (
         collapse_id, flag_id, wave_hop, wave_index, due_at, flag_owner_player_id
       )
       SELECT $1, entry.flag_id, entry.hop, entry.ordinality - 1, entry.due_at, entry.owner_id
       FROM unnest($2::uuid[], $3::integer[], $4::timestamptz[], $5::text[])
         WITH ORDINALITY AS entry(flag_id, hop, due_at, owner_id, ordinality)`,
      [
        collapseId,
        ids,
        ordered.map((flag) => flag.hop),
        dueAt,
        ordered.map((flag) => flag.original_owner_player_id ?? flag.owner_id)
      ]
    );
    // A Castle source flag is demoted to an ordinary collapsing Kingdom
    // flag so it no longer has to match its (now archived) seat.
    await client.query(
      `UPDATE flags
       SET territory_collapse_id = $1,
           control_type = CASE WHEN control_type = 'kingdom_seat' THEN 'kingdom' ELSE control_type END,
           original_owner_player_id = CASE WHEN control_type = 'kingdom_seat'
             THEN COALESCE(original_owner_player_id, owner_id) ELSE original_owner_player_id END,
           kingdom_founding_request_id = NULL,
           kingdom_founding_reserved_at = NULL
       WHERE id = ANY($2::uuid[])`,
      [collapseId, ids]
    );
  }
  return {
    collapseId,
    kind: input.kind,
    id: input.id,
    displayName: input.displayName,
    reason: input.reason,
    flagCount: ordered.length
  };
}

/**
 * Deletes territory flags with the terminal side effects of flag destruction:
 * live warfare channels are closed, siege targets cleared, and RESTRICT
 * references (travel invites, archived Castle sources, NPC tower posts)
 * released. City and kingdom flags carry no live warfare channels in practice,
 * so the cancellations normally touch no rows. The caller holds the flag
 * control geometry lock and the target rows.
 */
export async function breakTerritoryFlagsInTransaction(
  client: Queryable,
  flagIds: readonly string[]
): Promise<Array<{ id: string; ownerId: string }>> {
  if (flagIds.length === 0) return [];
  const ids = [...new Set(flagIds)];
  for (const table of ["flag_repair_disrupt_operations", "flag_repair_operations"]) {
    await client.query(
      `UPDATE ${table}
       SET status='cancelled',cancel_reason='flag-destroyed',completed_at=clock_timestamp()
       WHERE flag_id = ANY($1::uuid[]) AND status='active'`,
      [ids]
    );
  }
  await client.query(
    `UPDATE flag_burn_operations
     SET status='cancelled',cancel_reason='flag-destroyed',completed_at=clock_timestamp(),paused_at=NULL
     WHERE flag_id = ANY($1::uuid[]) AND status='active'`,
    [ids]
  );
  await client.query(
    `UPDATE military_siege_operations
     SET status='cancelled',completed_at=clock_timestamp()
     WHERE flag_id = ANY($1::uuid[]) AND status='pending'`,
    [ids]
  );
  for (const table of ["military_units", "military_unit_groups"]) {
    await client.query(
      `UPDATE ${table}
       SET target_flag_id=NULL,next_fire_at=NULL,revision=revision+1,updated_at=clock_timestamp()
       WHERE target_flag_id = ANY($1::uuid[])`,
      [ids]
    );
  }
  await client.query("DELETE FROM travel_invites WHERE source_flag_id = ANY($1::uuid[])", [ids]);
  await client.query(
    `UPDATE kingdom_seats SET source_flag_id = NULL
     WHERE source_flag_id = ANY($1::uuid[]) AND status <> 'active'`,
    [ids]
  );
  await client.query("DELETE FROM npc_city_defender_slots WHERE post_flag_id = ANY($1::uuid[])", [ids]);
  const deleted = await client.query<{ id: string; owner_id: string }>(
    "DELETE FROM flags WHERE id = ANY($1::uuid[]) RETURNING id::text AS id, owner_id",
    [ids]
  );
  return deleted.rows.map((row) => ({ id: row.id, ownerId: row.owner_id }));
}

type ClaimedRow = {
  collapse_id: string;
  flag_id: string;
  wave_hop: number;
  kind: TerritoryCollapseKind;
  city_id: string | null;
  kingdom_id: string | null;
  display_name: string;
  reason: string;
  actor_player_id: string | null;
  flag_owner_player_id: string | null;
};

export type TerritoryCollapseEnders = Readonly<{
  city(id: string, reason: string, actorPlayerId: string | null): Promise<TerritoryCollapseBegun | null>;
  kingdom(id: string, reason: string, actorPlayerId: string | null): Promise<TerritoryCollapseBegun | null>;
}>;

export class TerritoryCollapseService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly enders?: TerritoryCollapseEnders
  ) {}

  /**
   * The single entry point that ends a city or kingdom and starts its collapse
   * (developer tools today, sieges later). Returns null when it already ended.
   */
  async begin(input: Readonly<{
    kind: TerritoryCollapseKind;
    id: string;
    reason: string;
    actorPlayerId?: string | null;
  }>): Promise<TerritoryCollapseBegun | null> {
    if (!this.enders) throw new Error("Territory collapse enders are not configured");
    return input.kind === "city"
      ? this.enders.city(input.id, input.reason, input.actorPlayerId ?? null)
      : this.enders.kingdom(input.id, input.reason, input.actorPlayerId ?? null);
  }

  /**
   * Breaks at most one batch of due flags (across all active collapses) in one
   * transaction. Safe to run concurrently on several workers.
   */
  async breakDueBatch(
    now: Date = new Date(),
    limit: number = TERRITORY_COLLAPSE_BATCH_SIZE
  ): Promise<TerritoryCollapseBatch[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const claimed = await client.query<ClaimedRow>(
        `SELECT queued.collapse_id::text, queued.flag_id::text, queued.wave_hop,
                collapse.kind, collapse.city_id::text, collapse.kingdom_id::text,
                collapse.display_name, collapse.reason, collapse.actor_player_id,
                queued.flag_owner_player_id
         FROM territory_collapse_flags queued
         JOIN territory_collapses collapse ON collapse.collapse_id = queued.collapse_id
         WHERE queued.status = 'pending' AND queued.due_at <= $1
         ORDER BY queued.due_at, queued.wave_index, queued.flag_id
         LIMIT $2
         FOR UPDATE OF queued SKIP LOCKED`,
        [now, Math.max(1, Math.min(200, Math.trunc(limit)))]
      );
      if (claimed.rows.length === 0) {
        await client.query("COMMIT");
        return [];
      }
      await lockFlagControlGeometry(client);
      const present = await client.query<{ id: string; collapse_id: string }>(
        `SELECT flag.id::text AS id, flag.territory_collapse_id::text AS collapse_id
         FROM flags flag
         WHERE flag.id = ANY($1::uuid[]) AND flag.territory_collapse_id IS NOT NULL
         ORDER BY flag.id
         FOR UPDATE`,
        [claimed.rows.map((row) => row.flag_id)]
      );
      const presentIds = new Set(
        present.rows
          .filter((row) => claimed.rows.some((claim) =>
            claim.flag_id === row.id && claim.collapse_id === row.collapse_id))
          .map((row) => row.id)
      );
      const toBreak = claimed.rows.filter((row) => presentIds.has(row.flag_id));
      for (const kind of ["city", "kingdom"] as const) {
        const rows = toBreak.filter((row) => row.kind === kind);
        if (rows.length === 0) continue;
        const table = kind === "city" ? "city_flag_affiliation_history" : "kingdom_flag_affiliation_history";
        const orgColumn = kind === "city" ? "city_id" : "kingdom_id";
        await client.query(
          `INSERT INTO ${table} (
             id, ${orgColumn}, flag_id, flag_owner_player_id, performed_by_player_id,
             action, reason, request_id, prior_${orgColumn}, resulting_${orgColumn}, metadata
           )
           SELECT gen_random_uuid(), entry.org_id, entry.flag_id, entry.owner_id, entry.actor_id,
                  $1, entry.reason, NULL, entry.org_id, NULL,
                  jsonb_build_object('collapseId', entry.collapse_id, 'waveHop', entry.hop, 'broken', true)
           FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::uuid[], $8::integer[])
             AS entry(org_id, flag_id, owner_id, actor_id, reason, collapse_id, hop)`,
          [
            kind === "city" ? "city_deactivated" : "kingdom_dissolved",
            rows.map((row) => row.city_id ?? row.kingdom_id),
            rows.map((row) => row.flag_id),
            rows.map((row) => row.flag_owner_player_id ?? "unknown"),
            rows.map((row) => row.actor_player_id),
            rows.map((row) => `territory_collapse:${row.reason}`),
            rows.map((row) => row.collapse_id),
            rows.map((row) => row.wave_hop)
          ]
        );
      }
      const broken = new Set(
        (await breakTerritoryFlagsInTransaction(client, toBreak.map((row) => row.flag_id)))
          .map(({ id }) => id)
      );
      await client.query(
        `UPDATE territory_collapse_flags queued
         SET status = CASE WHEN queued.flag_id = ANY($3::uuid[]) THEN 'broken' ELSE 'missing' END,
             broken_at = $4
         FROM unnest($1::uuid[], $2::uuid[]) AS entry(collapse_id, flag_id)
         WHERE queued.collapse_id = entry.collapse_id AND queued.flag_id = entry.flag_id
           AND queued.status = 'pending'`,
        [
          claimed.rows.map((row) => row.collapse_id),
          claimed.rows.map((row) => row.flag_id),
          [...broken],
          now
        ]
      );
      const collapseIds = [...new Set(claimed.rows.map((row) => row.collapse_id))];
      const finished = await client.query<{ collapse_id: string; status: string }>(
        `UPDATE territory_collapses collapse
         SET broken_count = collapse.broken_count + counts.n,
             status = CASE WHEN EXISTS (
               SELECT 1 FROM territory_collapse_flags pending
               WHERE pending.collapse_id = collapse.collapse_id AND pending.status = 'pending'
             ) THEN 'active' ELSE 'completed' END,
             completed_at = CASE WHEN EXISTS (
               SELECT 1 FROM territory_collapse_flags pending
               WHERE pending.collapse_id = collapse.collapse_id AND pending.status = 'pending'
             ) THEN NULL ELSE $2::timestamptz END
         FROM (
           SELECT entry.collapse_id, count(*)::integer AS n
           FROM unnest($1::uuid[]) AS entry(collapse_id)
           GROUP BY entry.collapse_id
         ) counts
         WHERE collapse.collapse_id = counts.collapse_id
         RETURNING collapse.collapse_id::text, collapse.status`,
        [claimed.rows.map((row) => row.collapse_id), now]
      );
      await client.query("COMMIT");
      const completed = new Set(
        finished.rows.filter((row) => row.status === "completed").map((row) => row.collapse_id)
      );
      return collapseIds.map((collapseId) => {
        const rows = claimed.rows.filter((row) => row.collapse_id === collapseId);
        const first = rows[0]!;
        return {
          collapseId,
          kind: first.kind,
          id: (first.city_id ?? first.kingdom_id)!,
          displayName: first.display_name,
          reason: first.reason,
          flagIds: rows.map((row) => row.flag_id),
          completed: completed.has(collapseId)
        };
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Claims each new collapse's one-time "has fallen" notice. */
  async claimAnnouncements(now: Date = new Date()): Promise<TerritoryCollapseAnnouncement[]> {
    const result = await this.pool.query<{
      collapse_id: string;
      kind: TerritoryCollapseKind;
      city_id: string | null;
      kingdom_id: string | null;
      display_name: string;
      reason: string;
      flag_count: number;
      notify_player_ids: string[];
    }>(
      `UPDATE territory_collapses
       SET announced_at = $1
       WHERE collapse_id IN (
         SELECT collapse_id FROM territory_collapses
         WHERE announced_at IS NULL
         ORDER BY created_at, collapse_id
         LIMIT 20
         FOR UPDATE SKIP LOCKED
       )
       RETURNING collapse_id::text, kind, city_id::text, kingdom_id::text,
                 display_name, reason, flag_count, notify_player_ids`,
      [now]
    );
    return result.rows.map((row) => ({
      collapseId: row.collapse_id,
      kind: row.kind,
      id: (row.city_id ?? row.kingdom_id)!,
      displayName: row.display_name,
      reason: row.reason,
      flagCount: Number(row.flag_count),
      notifyPlayerIds: row.notify_player_ids
    }));
  }
}
