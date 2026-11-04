import {
  GIVING_BERRY_ITEM_ID,
  GIVING_SAPLING_ITEM_ID,
  GROVE_DOUBLE_YIELD_CHANCE,
  GROWN_TREE_BERRY_REGROW_MS,
  PLAYER_SAPLING_TREE_ID_PREFIX,
  SAPLING_DEATH_AFTER_MS,
  SAPLING_INTERACT_RANGE_M,
  SAPLING_PLANT_TARGET_RANGE_M,
  TILLER_PLANT_USE_COST,
  treeLatticePoint,
  SHOVEL_ITEM_ID,
  SAPLING_MATURE_AFTER_MS,
  SAPLING_TEND_INTERVAL_MS,
  SAPLING_MIN_SPACING_M,
  SAPLING_SPACING_TOLERANCE_M,
  SAPLING_VIEW_LIMIT,
  decideSaplingPull,
  decideSaplingTend,
  distanceMeters,
  evaluateSapling,
  isSaplingPlantableBiome,
  nearestTreeLatticePoint,
  saplingBiomeRefusal,
  saplingDiesAtMs,
  saplingHeals,
  saplingMapItem,
  saplingMaturesAtMs,
  type LatLon,
  type PlayerInventorySnapshot,
  type SaplingMapItem,
  type SaplingTreeFacts,
  type SaplingPlantSource,
  type SaplingWorldSnapshot,
  type WorldZoneBiome
} from "@ash-atlas/shared";
import { createHash } from "node:crypto";
import type pg from "pg";

import { SpatialHashGrid } from "./combat/spatialGrid.js";
import type { InventoryService } from "./inventory.js";

export class SaplingError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
    this.name = "SaplingError";
  }
}

type SaplingRow = {
  id: string;
  owner_player_id: string;
  owner_username: string | null;
  request_id: string;
  region_code: string;
  lat: number | string;
  lon: number | string;
  status: "sapling" | "grown" | "dead" | "pulled" | "chopped";
  planted_at: Date;
  last_tended_at: Date;
  fast_growth: boolean;
  death_at: Date;
  mature_at: Date;
  matured_at: Date | null;
  pulled_by_player_id: string | null;
  berry_ready_at: Date | null;
  state_revision: string | number;
  due_at: Date | null;
};

const ROW_COLUMNS = `s.id, s.owner_player_id, p.username AS owner_username, s.request_id, s.region_code,
  s.lat, s.lon, s.status, s.planted_at, s.last_tended_at, s.fast_growth, s.death_at, s.mature_at,
  s.matured_at, s.pulled_by_player_id, s.berry_ready_at, s.state_revision, s.due_at`;

export type SaplingMutationResult = Readonly<{
  sapling: SaplingWorldSnapshot | null;
  replayed: boolean;
  notice: string;
  inventory?: PlayerInventorySnapshot;
}>;

/** One tree changing: it is added or updated (with its timing facts), or removed. */
export type SaplingTreeChange =
  | Readonly<{ kind: "upsert"; tree: SaplingTreeFacts }>
  | Readonly<{ kind: "remove"; id: string; lat: number; lon: number }>;

/** A change as the map sees it: the compact row to draw (or the id to drop) and where the tree stands. */
export type SaplingViewChange = Readonly<{
  position: LatLon;
  upsert: SaplingMapItem | null;
  removedId: string | null;
}>;

/** The combat engine's tree index, updated one tree at a time. */
export type SaplingAuraSink = Readonly<{
  upsert(tree: Readonly<{ id: string; lat: number; lon: number }>): void;
  remove(treeId: string): void;
}>;

export type GivingSaplingDependencies = Readonly<{
  /** "land" only; water and an unavailable lookup both refuse planting. */
  terrainAt(position: LatLon): Promise<"land" | "water" | "unknown">;
  /** Owner of the flag territory covering the point, or null when it is unclaimed. */
  territoryOwnerAt(position: LatLon): Promise<string | null>;
  /** The biome at a point (the world zone map); "wilds" when it cannot be classified. */
  biomeAt?(position: LatLon): Promise<WorldZoneBiome>;
  /** Healing-aura index; each lifecycle change updates exactly the trees that changed. */
  aura?: SaplingAuraSink;
  /** Called after a commit with the compact view changes, to push to the players who can see them. */
  onViewChange?(changes: readonly SaplingViewChange[]): void;
  /** Wild or other known trees within the radius (the combat engine's tree index). */
  nearbyTrees?(position: LatLon, radiusM: number): readonly Readonly<{ id: string; position: LatLon }>[];
  now?(): number;
}>;

/** Tiller Boot hooks: spend pooled uses on the caller's transaction; refresh the worn item afterwards. */
export type TillerBootHooks = Readonly<{
  /** Takes `count` uses from the worn boot inside the transaction; false when no usable boot is worn. */
  spendUses(client: pg.PoolClient, playerId: string, count: number): Promise<boolean>;
  afterUse(playerId: string): Promise<void>;
}>;

export type SaplingGridResult = Readonly<{ planted: number; skipped: number; inventory: PlayerInventorySnapshot | null }>;

export function saplingTreeId(saplingId: string): string {
  return `${PLAYER_SAPLING_TREE_ID_PREFIX}${saplingId}`;
}

export class GivingSaplingService {
  private readonly now: () => number;
  /** Every live tree, in memory. The database stays the truth for mutations; reads are served from here. */
  private readonly trees = new Map<string, SaplingTreeFacts>();
  private readonly grid = new SpatialHashGrid(250);
  private tiller: TillerBootHooks | null = null;

  setTillerBoot(hooks: TillerBootHooks): void {
    this.tiller = hooks;
  }

  constructor(
    private readonly pool: pg.Pool,
    private readonly inventory: InventoryService,
    private readonly deps: GivingSaplingDependencies
  ) {
    this.now = deps.now ?? Date.now;
  }

  /** Number of live trees held in memory (tests and diagnostics). */
  get liveTreeCount(): number {
    return this.trees.size;
  }

  private apply(change: SaplingTreeChange, views: SaplingViewChange[] | null): void {
    const nowMs = this.now();
    if (change.kind === "upsert") {
      const tree = change.tree;
      this.trees.set(tree.id, tree);
      this.grid.insert(tree.id, { lat: tree.lat, lon: tree.lon });
      const heals = tree.state === "grown" ||
        saplingHeals({ plantedAtMs: tree.plantedAtMs, lastTendedAtMs: tree.lastTendedAtMs, fastGrowth: tree.fastGrowth }, nowMs);
      const aura = this.deps.aura;
      if (aura) {
        if (heals) aura.upsert({ id: saplingTreeId(tree.id), lat: tree.lat, lon: tree.lon });
        else aura.remove(saplingTreeId(tree.id));
      }
      const item = saplingMapItem(tree, nowMs);
      if (views && item) views.push({ position: { lat: tree.lat, lon: tree.lon }, upsert: item, removedId: null });
      return;
    }
    this.trees.delete(change.id);
    this.grid.remove(change.id);
    this.deps.aura?.remove(saplingTreeId(change.id));
    views?.push({ position: { lat: change.lat, lon: change.lon }, upsert: null, removedId: change.id });
  }

  /** Publishes committed changes: the index, the healing aura, and one batched push to viewers. */
  private emit(changes: readonly SaplingTreeChange[]): void {
    if (changes.length === 0) return;
    const views: SaplingViewChange[] = [];
    for (const change of changes) this.apply(change, views);
    if (views.length > 0) this.deps.onViewChange?.(views);
  }

  /**
   * Loads every live tree into the in-memory index and the healing aura. Called once at boot, in keyset
   * pages so memory stays flat; afterwards each lifecycle change updates exactly the trees it touches.
   * Sick saplings are indexed (they are drawn and tappable) but do not heal.
   */
  async loadIndex(): Promise<number> {
    this.emit(await this.processDue(this.pool, {}));
    this.trees.clear();
    let loaded = 0;
    let after = "00000000-0000-0000-0000-000000000000";
    for (;;) {
      const page = await this.pool.query<{
        id: string; lat: number | string; lon: number | string; status: "sapling" | "grown";
        planted_at: Date; last_tended_at: Date; fast_growth: boolean; berry_ready_at: Date | null;
      }>(
        `SELECT id, lat, lon, status, planted_at, last_tended_at, fast_growth, berry_ready_at
           FROM player_saplings
          WHERE status IN ('sapling', 'grown') AND id > $1::uuid
          ORDER BY id
          LIMIT 5000`,
        [after]
      );
      for (const row of page.rows) {
        this.apply({
          kind: "upsert",
          tree: {
            id: row.id, lat: Number(row.lat), lon: Number(row.lon), state: row.status,
            plantedAtMs: row.planted_at.getTime(), lastTendedAtMs: row.last_tended_at.getTime(),
            fastGrowth: row.fast_growth, berryReadyAtMs: row.berry_ready_at?.getTime() ?? null
          }
        }, null);
      }
      loaded += page.rows.length;
      if (page.rows.length < 5000) break;
      after = page.rows[page.rows.length - 1]!.id;
    }
    return loaded;
  }

  /** The bounded sweep: settles only the rows whose timer is due (indexed on due_at). */
  async sweepDue(): Promise<number> {
    const changes = await this.processDue(this.pool, {});
    this.emit(changes);
    return changes.length;
  }

  /** A grown tree was chopped by the harvest flow: it leaves the index, the aura and every view. */
  forgetChoppedTree(nodeId: string): void {
    const id = nodeId.startsWith(PLAYER_SAPLING_TREE_ID_PREFIX) ? nodeId.slice(PLAYER_SAPLING_TREE_ID_PREFIX.length) : nodeId;
    const tree = this.trees.get(id);
    if (tree) this.emit([{ kind: "remove", id, lat: tree.lat, lon: tree.lon }]);
  }

  /**
   * Settles due growing saplings (optionally only one owner's or one sapling) and returns the aura
   * changes to publish after the surrounding transaction commits. Each sapling does at most one of:
   * mature (still heals), die (stops healing), turn sick (stops healing), or just move its next due_at.
   */
  private async processDue(
    queryable: Pick<pg.Pool, "query">,
    filter: Readonly<{ saplingId?: string; ownerId?: string }>,
    limit = 200,
    maxBatches = 5
  ): Promise<SaplingTreeChange[]> {
    const changes: SaplingTreeChange[] = [];
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const nowMs = this.now();
      const params: unknown[] = [new Date(nowMs), limit];
      let extra = "";
      if (filter.saplingId) { params.push(filter.saplingId); extra += ` AND id = $${params.length}`; }
      if (filter.ownerId) { params.push(filter.ownerId); extra += ` AND owner_player_id = $${params.length}`; }
      const due = await queryable.query<{
        id: string; lat: number | string; lon: number | string; planted_at: Date; last_tended_at: Date; fast_growth: boolean;
      }>(
        `SELECT id, lat, lon, planted_at, last_tended_at, fast_growth
           FROM player_saplings
          WHERE status = 'sapling' AND due_at IS NOT NULL AND due_at <= $1${extra}
          ORDER BY due_at
          LIMIT $2
          FOR UPDATE SKIP LOCKED`,
        params
      );
      for (const row of due.rows) {
        const input = { plantedAtMs: row.planted_at.getTime(), lastTendedAtMs: row.last_tended_at.getTime(), fastGrowth: row.fast_growth };
        const life = evaluateSapling(input, nowMs);
        const lat = Number(row.lat);
        const lon = Number(row.lon);
        const facts = (state: "sapling" | "grown", berryReadyAtMs: number | null): SaplingTreeFacts => ({
          id: row.id, lat, lon, state, plantedAtMs: input.plantedAtMs, lastTendedAtMs: input.lastTendedAtMs,
          fastGrowth: input.fastGrowth, berryReadyAtMs
        });
        if (life.state === "grown") {
          await queryable.query(
            `UPDATE player_saplings
                SET status = 'grown', matured_at = $2, berry_ready_at = $2, due_at = NULL
              WHERE id = $1`,
            [row.id, new Date(life.maturedAtMs)]
          );
          changes.push({ kind: "upsert", tree: facts("grown", life.maturedAtMs) });
        } else if (life.state === "dead") {
          await queryable.query(
            "UPDATE player_saplings SET status = 'dead', died_at = $2, due_at = NULL WHERE id = $1",
            [row.id, new Date(life.diedAtMs)]
          );
          changes.push({ kind: "remove", id: row.id, lat, lon });
        } else {
          const sick = nowMs >= life.tendReadyAtMs;
          const nextDue = sick ? Math.min(life.diesAtMs, life.maturesAtMs) : Math.min(life.tendReadyAtMs, life.diesAtMs, life.maturesAtMs);
          await queryable.query("UPDATE player_saplings SET due_at = $2 WHERE id = $1", [row.id, new Date(nextDue)]);
          // Turning sick changes how it is drawn and stops its healing.
          if (sick) changes.push({ kind: "upsert", tree: facts("sapling", null) });
        }
      }
      if (due.rows.length < limit) break;
    }
    return changes;
  }

  /**
   * The compact rows to draw around a point, nearest first, served from memory (no database read):
   * at most `limit` trees within `radiusM`. Truncation only drops the farthest trees.
   */
  listNear(center: LatLon, radiusM: number, limit = SAPLING_VIEW_LIMIT): SaplingMapItem[] {
    const nowMs = this.now();
    const candidates: Array<{ distanceM: number; tree: SaplingTreeFacts }> = [];
    for (const id of this.grid.query(center, radiusM)) {
      const tree = this.trees.get(id);
      if (tree) candidates.push({ distanceM: distanceMeters(center, tree), tree });
    }
    candidates.sort((left, right) => left.distanceM - right.distanceM || (left.tree.id < right.tree.id ? -1 : 1));
    const items: SaplingMapItem[] = [];
    for (const { tree } of candidates) {
      if (items.length >= limit) break;
      const item = saplingMapItem(tree, nowMs);
      if (item) items.push(item);
    }
    return items;
  }

  /** One tree with its owner and exact timers (the tap prompt): a single-row read, null once it is gone. */
  async detail(saplingId: string): Promise<SaplingWorldSnapshot | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(saplingId)) return null;
    const row = await this.loadRow(this.pool, saplingId);
    if (!row || (row.status !== "sapling" && row.status !== "grown")) return null;
    return this.liveSnapshot(row);
  }

  async plant(input: Readonly<{
    playerId: string;
    requestId: string;
    regionCode: string;
    position: LatLon;
    source: SaplingPlantSource;
    /** Planting planner: the tree is planted at the lattice point nearest this (re-snapped here). */
    target?: LatLon | undefined;
    aggressive: boolean;
    worldPresent: boolean;
    /** Range allowed to the snapped target (the Tiller grid reaches past the single-plant range). */
    targetRangeM?: number;
    /** Runs inside the planting transaction before it commits; throwing rolls the planting back. */
    inTransaction?(client: pg.PoolClient): Promise<void>;
  }>): Promise<SaplingMutationResult> {
    if (!input.worldPresent) throw new SaplingError("SAPLING_WORLD_REQUIRED", "Return to the open world to plant.");
    if (input.aggressive) throw new SaplingError("SAPLING_AGGRESSIVE", "You cannot plant while aggressive.");
    if (!Number.isFinite(input.position.lat) || !Number.isFinite(input.position.lon)) {
      throw new SaplingError("SAPLING_INVALID_POSITION", "Your position is unavailable.", true);
    }
    let position = input.position;
    if (input.target) {
      if (!Number.isFinite(input.target.lat) || !Number.isFinite(input.target.lon)) {
        throw new SaplingError("SAPLING_INVALID_POSITION", "That planting spot is not valid.");
      }
      const snapped = nearestTreeLatticePoint(input.target);
      position = { lat: snapped.lat, lon: snapped.lon };
      if (distanceMeters(position, input.position) > (input.targetRangeM ?? SAPLING_PLANT_TARGET_RANGE_M)) {
        throw new SaplingError("SAPLING_OUT_OF_RANGE", "Move closer to that planting spot.", true);
      }
    }
    const replay = await this.findByRequest(input.playerId, input.requestId);
    if (replay) {
      return { sapling: this.liveSnapshot(replay), replayed: true, notice: "Already planted." };
    }
    const terrain = await this.deps.terrainAt(position);
    if (terrain === "water") throw new SaplingError("SAPLING_WATER", "Saplings cannot be planted on water.");
    if (terrain !== "land") throw new SaplingError("SAPLING_TERRAIN_UNAVAILABLE", "Terrain is unavailable here. Try again.", true);
    const biome = this.deps.biomeAt ? await this.deps.biomeAt(position) : "wilds";
    if (!isSaplingPlantableBiome(biome)) throw new SaplingError("SAPLING_BIOME", saplingBiomeRefusal(biome));
    const territoryOwner = await this.deps.territoryOwnerAt(position);
    if (territoryOwner !== null && territoryOwner !== input.playerId) {
      throw new SaplingError("SAPLING_TERRITORY_OWNED_BY_OTHER", "This land is claimed by another player.");
    }
    const knownTree = this.deps.nearbyTrees?.(position, SAPLING_MIN_SPACING_M - SAPLING_SPACING_TOLERANCE_M)
      .find((tree) => distanceMeters(tree.position, position) < SAPLING_MIN_SPACING_M - SAPLING_SPACING_TOLERANCE_M);
    if (knownTree) throw new SaplingError("SAPLING_TOO_CLOSE", "Too close to another tree.");

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Spacing is read-then-insert across players, so planting is serialized world-wide.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('giving-sapling-plant'))");
      const raced = await this.findByRequest(input.playerId, input.requestId, client);
      if (raced) {
        await client.query("COMMIT");
        return { sapling: this.liveSnapshot(raced), replayed: true, notice: "Already planted." };
      }
      const crowded = await client.query(
        `SELECT 1 FROM player_saplings
          WHERE status IN ('sapling', 'grown')
            AND ST_DWithin(
              ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography,
              ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography, $3)
          LIMIT 1`,
        [position.lat, position.lon, SAPLING_MIN_SPACING_M - SAPLING_SPACING_TOLERANCE_M]
      );
      if ((crowded.rowCount ?? 0) > 0) throw new SaplingError("SAPLING_TOO_CLOSE", "Too close to another tree.");
      const itemId = input.source === "berry" ? GIVING_BERRY_ITEM_ID : GIVING_SAPLING_ITEM_ID;
      try {
        await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey: `sapling-plant:${input.playerId}:${input.requestId}`,
          playerId: input.playerId,
          source: "sapling_plant",
          sourceEntityType: "sapling",
          sourceEntityId: input.requestId,
          debits: [{ itemId, variant: "default", quantity: 1n }]
        });
      } catch (error) {
        if (error instanceof Error && /not contain enough/u.test(error.message)) {
          throw new SaplingError(
            input.source === "berry" ? "SAPLING_NO_BERRY" : "SAPLING_NO_SAPLING",
            input.source === "berry" ? "You need a Giving Berry to plant." : "You have no sapling to plant."
          );
        }
        throw error;
      }
      const plantedAt = new Date(this.now());
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO player_saplings
           (owner_player_id, request_id, region_code, lat, lon, planted_at, last_tended_at, death_at, mature_at, due_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9)
         RETURNING id`,
        [
          input.playerId, input.requestId, input.regionCode, position.lat, position.lon, plantedAt,
          new Date(plantedAt.getTime() + SAPLING_DEATH_AFTER_MS),
          new Date(plantedAt.getTime() + SAPLING_MATURE_AFTER_MS),
          new Date(plantedAt.getTime() + SAPLING_TEND_INTERVAL_MS)
        ]
      );
      await input.inTransaction?.(client);
      const row = await this.loadRow(client, inserted.rows[0]!.id);
      const inventory = await this.inventory.snapshotInTransaction(client, input.playerId);
      await client.query("COMMIT");
      this.emit([{ kind: "upsert", tree: factsFromRow(row!) }]);
      return {
        sapling: this.snapshot(row!, this.now()),
        replayed: false,
        notice: "You planted a sapling. Tend it every day or it will die.",
        inventory
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async tend(input: Readonly<{
    playerId: string;
    saplingId: string;
    position: LatLon;
    groveLoreRank: number;
    /** Auto-tend: only the player's own saplings. */
    ownerOnly?: boolean;
    /** Runs inside the tending transaction before it commits; throwing rolls the tending back. */
    inTransaction?(client: pg.PoolClient): Promise<void>;
  }>): Promise<SaplingMutationResult> {
    return this.withLockedRow(input.saplingId, async (client, row, changes) => {
      if (row.status !== "sapling") throw new SaplingError("SAPLING_NOT_GROWING", "That sapling is no longer growing.");
      if (input.ownerOnly && row.owner_player_id !== input.playerId) throw new SaplingError("SAPLING_NOT_OWNER", "That sapling is not yours.");
      this.assertInRange(row, input.position);
      const decision = decideSaplingTend({
        sapling: lifecycleInput(row),
        tenderIsOwner: row.owner_player_id === input.playerId,
        tenderGroveLoreRank: input.groveLoreRank,
        nowMs: this.now()
      });
      if (!decision.allowed) {
        if (decision.code === "SAPLING_TEND_TOO_SOON") {
          throw new SaplingError(decision.code, "It was tended recently. Come back tomorrow.", true);
        }
        throw new SaplingError(decision.code, "That sapling is no longer growing.");
      }
      const at = new Date(this.now());
      const next = { plantedAtMs: row.planted_at.getTime(), lastTendedAtMs: at.getTime(), fastGrowth: decision.fastGrowth };
      const dies = saplingDiesAtMs(next);
      const matures = saplingMaturesAtMs(next);
      await client.query(
        `UPDATE player_saplings
            SET last_tended_at = $2, fast_growth = $3, death_at = $4, mature_at = $5, tend_count = tend_count + 1,
                due_at = $6
          WHERE id = $1`,
        [row.id, at, decision.fastGrowth, new Date(dies), new Date(matures),
          new Date(Math.min(at.getTime() + SAPLING_TEND_INTERVAL_MS, dies, matures))]
      );
      // Tending cures a sick sapling: it heals again.
      changes.push({ kind: "upsert", tree: {
        id: row.id, lat: Number(row.lat), lon: Number(row.lon), state: "sapling",
        plantedAtMs: next.plantedAtMs, lastTendedAtMs: next.lastTendedAtMs, fastGrowth: next.fastGrowth, berryReadyAtMs: null
      } });
      await input.inTransaction?.(client);
      const updated = await this.loadRow(client, row.id);
      const faster = decision.fastGrowth && !row.fast_growth;
      return {
        sapling: this.snapshot(updated!, this.now()),
        replayed: false,
        notice: faster ? "You tended the sapling. It will mature in 4 days." : "You tended the sapling."
      };
    });
  }

  /**
   * Tiller Boot: plants up to nine saplings in a 3x3 block of the planting lattice around the
   * player. Each cell is its own planting (every normal rule applies); a cell that refuses is
   * skipped, and each planted sapling takes its seed and 10 boot uses in one transaction.
   */
  async plantGrid(input: Readonly<{
    playerId: string;
    requestId: string;
    regionCode: string;
    position: LatLon;
    aggressive: boolean;
    worldPresent: boolean;
  }>): Promise<SaplingGridResult> {
    const tiller = this.tiller;
    if (!tiller) throw new SaplingError("SAPLING_UNAVAILABLE", "Saplings are temporarily unavailable.", true);
    const centre = nearestTreeLatticePoint(input.position);
    const cells: LatLon[] = [];
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        const point = treeLatticePoint(centre.row + dr, centre.col + dc);
        cells.push({ lat: point.lat, lon: point.lon });
      }
    }
    cells.sort((a, b) => distanceMeters(a, input.position) - distanceMeters(b, input.position));
    let planted = 0;
    let skipped = 0;
    let inventory: PlayerInventorySnapshot | null = null;
    let go = true;
    for (let index = 0; index < cells.length && go; index += 1) {
      const target = cells[index]!;
      for (const source of ["sapling", "berry"] as const) {
        try {
          const result = await this.plant({
            playerId: input.playerId,
            requestId: `${input.requestId}:g${index}:${source}`,
            regionCode: input.regionCode,
            position: input.position,
            source,
            target,
            aggressive: input.aggressive,
            worldPresent: input.worldPresent,
            targetRangeM: 130,
            inTransaction: async (client) => {
              if (!(await tiller.spendUses(client, input.playerId, TILLER_PLANT_USE_COST))) {
                throw new SaplingError("SAPLING_NO_BOOT", "Wear a Tiller Boot with uses left to plant a grid.");
              }
            }
          });
          if (!result.replayed) planted += 1;
          if (result.inventory) inventory = result.inventory;
          break;
        } catch (error) {
          if (!(error instanceof SaplingError)) throw error;
          if (error.code === "SAPLING_NO_SAPLING") continue;
          if (error.code === "SAPLING_NO_BERRY") { go = false; break; }
          if (error.code === "SAPLING_NO_BOOT") { go = false; if (planted === 0) throw error; break; }
          if (error.code === "SAPLING_AGGRESSIVE" || error.code === "SAPLING_WORLD_REQUIRED" ||
            error.code === "SAPLING_INVALID_POSITION") throw error;
          skipped += 1;
          break;
        }
      }
    }
    if (planted > 0) await tiller.afterUse(input.playerId).catch(() => undefined);
    return { planted, skipped, inventory };
  }

  /**
   * Tiller Boot auto-tend: tends one of the player's own saplings exactly like a manual tend,
   * spending one boot use in the same transaction. Returns false when nothing was tended.
   */
  async autoTend(input: Readonly<{ playerId: string; saplingId: string; position: LatLon; groveLoreRank: number }>): Promise<boolean> {
    const tiller = this.tiller;
    if (!tiller) return false;
    try {
      await this.tend({
        ...input,
        ownerOnly: true,
        inTransaction: async (client) => {
          if (!(await tiller.spendUses(client, input.playerId, 1))) {
            throw new SaplingError("SAPLING_NO_BOOT", "No Tiller Boot uses left.");
          }
        }
      });
      await tiller.afterUse(input.playerId).catch(() => undefined);
      return true;
    } catch (error) {
      if (error instanceof SaplingError) return false;
      throw error;
    }
  }

  async pull(input: Readonly<{
    playerId: string;
    saplingId: string;
    position: LatLon;
    groveLoreRank: number;
  }>): Promise<SaplingMutationResult> {
    return this.withLockedRow(input.saplingId, async (client, row, changes) => {
      if (row.status === "pulled" && row.pulled_by_player_id === input.playerId) {
        return {
          sapling: null,
          replayed: true,
          notice: "You already pulled that sapling.",
          inventory: await this.inventory.snapshotInTransaction(client, input.playerId)
        };
      }
      if (row.status !== "sapling") throw new SaplingError("SAPLING_NOT_GROWING", "That sapling is no longer growing.");
      this.assertInRange(row, input.position);
      const territoryOwner = await this.deps.territoryOwnerAt({ lat: Number(row.lat), lon: Number(row.lon) });
      const shovels = await client.query<{ quantity: string }>(
        "SELECT COALESCE(sum(quantity), 0)::text AS quantity FROM player_inventory WHERE player_id = $1 AND resource_type = $2",
        [input.playerId, SHOVEL_ITEM_ID]
      );
      const decision = decideSaplingPull({
        sapling: lifecycleInput(row),
        groveLoreRank: input.groveLoreRank,
        hasShovel: Number(shovels.rows[0]?.quantity ?? 0) > 0,
        pullerIsOwner: row.owner_player_id === input.playerId,
        territoryOwnerPlayerId: territoryOwner,
        pullerPlayerId: input.playerId,
        nowMs: this.now()
      });
      if (!decision.allowed) {
        throw new SaplingError(decision.code, pullDenial(decision.code));
      }
      const granted = await this.inventory.grantItemsForOperationInTransaction(client, {
        operationKey: `sapling-pull:${row.id}`,
        playerId: input.playerId,
        source: "sapling_pull",
        sourceEntityType: "sapling",
        sourceEntityId: row.id,
        grants: [{ itemId: GIVING_SAPLING_ITEM_ID, variant: "default", quantity: 1 }]
      });
      await client.query(
        "UPDATE player_saplings SET status = 'pulled', pulled_at = $2, pulled_by_player_id = $3, due_at = NULL WHERE id = $1",
        [row.id, new Date(this.now()), input.playerId]
      );
      changes.push({ kind: "remove", id: row.id, lat: Number(row.lat), lon: Number(row.lon) });
      return {
        sapling: null,
        replayed: !granted.applied,
        notice: "You pulled up the sapling. Plant it somewhere else.",
        inventory: granted.inventory
      };
    });
  }

  /** A grown tree grows one Giving Berry back every 5 hours; anyone in range may gather it. */
  async gather(input: Readonly<{ playerId: string; saplingId: string; position: LatLon; groveLoreRank?: number }>): Promise<SaplingMutationResult> {
    return this.withLockedRow(input.saplingId, async (client, row, changes) => {
      if (row.status !== "grown" || !row.berry_ready_at) {
        throw new SaplingError("SAPLING_NO_BERRIES", "This tree has no berries to gather.");
      }
      this.assertInRange(row, input.position);
      const nowMs = this.now();
      if (row.berry_ready_at.getTime() > nowMs) {
        throw new SaplingError("SAPLING_BERRIES_NOT_READY", "The berries have not grown back yet.", true);
      }
      // Grove Lore double harvest. The roll is a hash of this berry batch, so a replay rolls the same.
      const rank = Math.max(0, Math.min(3, Math.floor(input.groveLoreRank ?? 0)));
      const doubled = doubleHarvestRoll(row.id, row.berry_ready_at.getTime()) < GROVE_DOUBLE_YIELD_CHANCE[rank]!;
      const granted = await this.inventory.grantItemsForOperationInTransaction(client, {
        operationKey: `sapling-gather:${row.id}:${row.berry_ready_at.getTime()}`,
        playerId: input.playerId,
        source: "sapling_gather",
        sourceEntityType: "sapling",
        sourceEntityId: row.id,
        grants: [{ itemId: GIVING_BERRY_ITEM_ID, variant: "default", quantity: doubled ? 2 : 1 }]
      });
      await client.query("UPDATE player_saplings SET berry_ready_at = $2 WHERE id = $1", [
        row.id, new Date(nowMs + GROWN_TREE_BERRY_REGROW_MS)
      ]);
      const updated = await this.loadRow(client, row.id);
      // The berry is gone until it regrows: the drawn tree changes for everyone who can see it.
      changes.push({ kind: "upsert", tree: factsFromRow(updated!) });
      return {
        sapling: this.snapshot(updated!, nowMs),
        replayed: !granted.applied,
        notice: doubled ? "You gathered 2 Giving Berries." : "You gathered a Giving Berry.",
        inventory: granted.inventory
      };
    });
  }

  private assertInRange(row: SaplingRow, position: LatLon): void {
    if (distanceMeters({ lat: Number(row.lat), lon: Number(row.lon) }, position) > SAPLING_INTERACT_RANGE_M) {
      throw new SaplingError("SAPLING_OUT_OF_RANGE", "Move closer to the tree.", true);
    }
  }

  private async withLockedRow(
    saplingId: string,
    work: (client: pg.PoolClient, row: SaplingRow, changes: SaplingTreeChange[]) => Promise<SaplingMutationResult>
  ): Promise<SaplingMutationResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query("SELECT id FROM player_saplings WHERE id = $1 FOR UPDATE", [saplingId]);
      if (locked.rowCount === 0) throw new SaplingError("SAPLING_NOT_FOUND", "That sapling is gone.");
      const changes = await this.processDue(client, { saplingId });
      const row = await this.loadRow(client, saplingId);
      if (!row) throw new SaplingError("SAPLING_NOT_FOUND", "That sapling is gone.");
      const result = await work(client, row, changes);
      await client.query("COMMIT");
      // Aura changes are published only after the transaction commits.
      this.emit(changes);
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadRow(queryable: Pick<pg.Pool, "query">, id: string): Promise<SaplingRow | null> {
    const result = await queryable.query<SaplingRow>(
      `SELECT ${ROW_COLUMNS} FROM player_saplings s LEFT JOIN players p ON p.id = s.owner_player_id WHERE s.id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  private async findByRequest(
    playerId: string,
    requestId: string,
    queryable: Pick<pg.Pool, "query"> = this.pool
  ): Promise<SaplingRow | null> {
    const result = await queryable.query<SaplingRow>(
      `SELECT ${ROW_COLUMNS} FROM player_saplings s LEFT JOIN players p ON p.id = s.owner_player_id
        WHERE s.owner_player_id = $1 AND s.request_id = $2`,
      [playerId, requestId]
    );
    return result.rows[0] ?? null;
  }

  /** A replayed plant answers with the sapling only while it is still alive. */
  private liveSnapshot(row: SaplingRow): SaplingWorldSnapshot | null {
    const nowMs = this.now();
    if (row.status === "dead" || row.status === "pulled") return null;
    const life = row.status === "sapling" ? evaluateSapling(lifecycleInput(row), nowMs) : null;
    return life?.state === "dead" ? null : this.snapshot(row, nowMs);
  }

  private snapshot(row: SaplingRow, nowMs: number): SaplingWorldSnapshot {
    const life = row.status === "sapling" ? evaluateSapling(lifecycleInput(row), nowMs) : null;
    const grown = row.status === "grown" || life?.state === "grown";
    const berryReadyMs = row.berry_ready_at?.getTime() ?? null;
    const iso = (ms: number): string => new Date(ms).toISOString();
    return {
      saplingId: row.id,
      stateRevision: Number(row.state_revision),
      ownerPlayerId: row.owner_player_id,
      ownerUsername: row.owner_username,
      lat: Number(row.lat),
      lon: Number(row.lon),
      state: grown ? "grown" : "sapling",
      plantedAt: row.planted_at.toISOString(),
      lastTendedAt: row.last_tended_at.toISOString(),
      tendReadyAt: life?.state === "sapling" ? iso(life.tendReadyAtMs) : null,
      diesAt: life?.state === "sapling" ? iso(life.diesAtMs) : null,
      maturesAt: life?.state === "sapling" ? iso(life.maturesAtMs) : null,
      fastGrowth: row.fast_growth,
      berryReadyAt: grown && berryReadyMs !== null && berryReadyMs > nowMs ? iso(berryReadyMs) : null,
      berryAvailable: grown && (berryReadyMs === null ? life?.state === "grown" : berryReadyMs <= nowMs)
    };
  }
}

function doubleHarvestRoll(saplingId: string, berryReadyAtMs: number): number {
  const digest = createHash("sha256").update(`sapling-double:${saplingId}:${berryReadyAtMs}`).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

function factsFromRow(row: SaplingRow): SaplingTreeFacts {
  return {
    id: row.id, lat: Number(row.lat), lon: Number(row.lon),
    state: row.status === "grown" ? "grown" : "sapling",
    plantedAtMs: row.planted_at.getTime(), lastTendedAtMs: row.last_tended_at.getTime(),
    fastGrowth: row.fast_growth, berryReadyAtMs: row.berry_ready_at?.getTime() ?? null
  };
}

function lifecycleInput(row: SaplingRow): { plantedAtMs: number; lastTendedAtMs: number; fastGrowth: boolean } {
  return { plantedAtMs: row.planted_at.getTime(), lastTendedAtMs: row.last_tended_at.getTime(), fastGrowth: row.fast_growth };
}

function pullDenial(code: string): string {
  switch (code) {
    case "SAPLING_PULL_RANK_REQUIRED": return "You need a Shovel (or Grove Lore rank 3) to pull up saplings.";
    case "SAPLING_TERRITORY_OWNED_BY_OTHER": return "This land is claimed by another player.";
    default: return "That sapling is no longer growing.";
  }
}
