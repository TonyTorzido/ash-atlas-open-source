import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import { runMigrations } from "../db/migrate.js";
import { DungeonRepeatError, DungeonRepeatLedger } from "./dungeonRepeatLedger.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const migration = "0787_dungeon_repeat_ledger.sql";

describeDatabase("dungeon repeat ledger PostgreSQL authority", () => {
  const databaseName = `ash_atlas_stability_dungeon_repeat_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let ledger: DungeonRepeatLedger;
  let databaseUrl = "";
  let migrationsDirectory = "";

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 4 });
    migrationsDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-dungeon-repeat-"));
    await writeFile(path.join(migrationsDirectory, "0001_fixture.sql"), fixture, "utf8");
    await runMigrations(databaseUrl, { migrationsDirectory });
    await copyFile(
      fileURLToPath(new URL(`../../../../db/migrations/${migration}`, import.meta.url)),
      path.join(migrationsDirectory, migration)
    );
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([migration]);
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([]);
    // Delver's Lore is a hidden old skill; the dev flag keeps its lockout reduction testable.
    ledger = new DungeonRepeatLedger(pool, { fullClassRosterEnabled: true, ultimatesEnabled: false });
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin?.end();
    if (migrationsDirectory) await rm(migrationsDirectory, { recursive: true, force: true });
  });

  it("freezes the authoritative rank, replays idempotently, gates active entry, expires, and fails closed", async () => {
    await pool.query(
      "INSERT INTO player_skill_ranks (player_id, skill_id, rank) VALUES ('player-1', 'delvers_lore', 2)"
    );
    const first = await ledger.recordCompletion({
      completionKey: "completion-1",
      playerId: "player-1",
      dungeonKey: "cistern_warrens:sewer-1",
      sessionIdentity: "session-1"
    });
    expect(first).toMatchObject({ delversLoreRank: 2, cooldownDays: 5 });

    await pool.query(
      "UPDATE player_skill_ranks SET rank=3 WHERE player_id='player-1' AND skill_id='delvers_lore'"
    );
    await expect(ledger.recordCompletion({
      completionKey: "completion-1",
      playerId: "player-1",
      dungeonKey: "cistern_warrens:sewer-1",
      sessionIdentity: "session-1"
    })).resolves.toEqual(first);
    await expect(ledger.authorizeEntry("player-1", "cistern_warrens:sewer-1"))
      .rejects.toMatchObject({ code: "DUNGEON_REPEAT_COOLDOWN_ACTIVE" });

    await expect(ledger.recordCompletion({
      completionKey: "completion-1",
      playerId: "player-1",
      dungeonKey: "cistern_warrens:sewer-1",
      sessionIdentity: "different-session"
    })).rejects.toBeInstanceOf(DungeonRepeatError);

    const concurrent = await Promise.all([
      ledger.recordCompletion({
        completionKey: "completion-2a", playerId: "player-1",
        dungeonKey: "cistern_warrens:sewer-2", sessionIdentity: "session-2"
      }),
      ledger.recordCompletion({
        completionKey: "completion-2b", playerId: "player-1",
        dungeonKey: "cistern_warrens:sewer-2", sessionIdentity: "session-2"
      })
    ]);
    expect(new Set(concurrent.map((entry) => entry.completionKey)).size).toBe(1);
    expect(concurrent[0]).toMatchObject({ delversLoreRank: 3, cooldownDays: 4 });
    await expect(pool.query(
      `SELECT count(*)::int AS count FROM dungeon_completion_ledger
       WHERE player_id='player-1' AND dungeon_key='cistern_warrens:sewer-2' AND session_identity='session-2'`
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });

    await pool.query(
      `UPDATE dungeon_completion_ledger
       SET completed_at=now() - interval '8 days', lockout_expires_at=now() - interval '1 day'
       WHERE completion_key='completion-1'`
    );
    await expect(ledger.authorizeEntry("player-1", "cistern_warrens:sewer-1")).resolves.toBeUndefined();
  });

  it("uses the six-day baseline for absent and rank-one Delver's Lore", async () => {
    await pool.query("INSERT INTO players (id) VALUES ('player-2'), ('player-3')");
    await pool.query(
      "INSERT INTO player_skill_ranks (player_id, skill_id, rank) VALUES ('player-3', 'delvers_lore', 1)"
    );
    await expect(ledger.recordCompletion({
      completionKey: "completion-rank-0", playerId: "player-2",
      dungeonKey: "cistern_warrens:sewer-1", sessionIdentity: "session-rank-0"
    })).resolves.toMatchObject({ delversLoreRank: 0, cooldownDays: 6 });
    await expect(ledger.recordCompletion({
      completionKey: "completion-rank-1", playerId: "player-3",
      dungeonKey: "cistern_warrens:sewer-1", sessionIdentity: "session-rank-1"
    })).resolves.toMatchObject({ delversLoreRank: 1, cooldownDays: 6 });
  });

  it("expires an hour lockout in hours and leaves day lockouts unchanged", async () => {
    await pool.query("INSERT INTO players (id) VALUES ('player-4') ON CONFLICT DO NOTHING");
    const hours = await ledger.recordCompletion({
      completionKey: "completion-hours", playerId: "player-4",
      dungeonKey: "fallen_prison:run-1", sessionIdentity: "session-hours", lockoutHours: 12
    });
    expect(hours.lockoutExpiresAt.getTime() - hours.completedAt.getTime()).toBe(12 * 3_600_000);
    const days = await ledger.recordCompletion({
      completionKey: "completion-days", playerId: "player-4",
      dungeonKey: "cistern_warrens:run-1", sessionIdentity: "session-days"
    });
    expect(days.lockoutExpiresAt.getTime() - days.completedAt.getTime()).toBe(6 * 86_400_000);
    await expect(ledger.authorizeEntry("player-4", "fallen_prison:run-1"))
      .rejects.toMatchObject({ code: "DUNGEON_REPEAT_COOLDOWN_ACTIVE" });
  });

  it("Restless Herds shortens a qualified member's day lockout by one day, never below one", async () => {
    await pool.query("INSERT INTO players (id) VALUES ('beast-1'), ('beast-2'), ('beast-3')");
    await pool.query("INSERT INTO kingdoms (id, status) VALUES ('00000000-0000-4000-8000-000000000001', 'active')");
    await pool.query(
      `INSERT INTO kingdom_memberships (kingdom_id, player_id, status, perk_qualified_at) VALUES
         ('00000000-0000-4000-8000-000000000001', 'beast-1', 'active', now() - interval '1 day'),
         ('00000000-0000-4000-8000-000000000001', 'beast-2', 'active', now() + interval '1 day')`
    );
    await pool.query(
      `INSERT INTO kingdom_perk_selections (kingdom_id, perk_level, perk_id)
       VALUES ('00000000-0000-4000-8000-000000000001', 8, 'restless_herds')`
    );
    await pool.query("INSERT INTO player_skill_ranks (player_id, skill_id, rank) VALUES ('beast-3', 'delvers_lore', 3)");
    const clear = (playerId: string, key: string, baseCooldownDays?: number) => ledger.recordCompletion({
      completionKey: `beasts-${key}`, playerId, dungeonKey: `cistern_warrens:${key}`, sessionIdentity: `session-${key}`,
      ...(baseCooldownDays === undefined ? {} : { baseCooldownDays })
    });
    const member = await clear("beast-1", "member");
    expect(member.cooldownDays).toBe(5);
    expect(member.lockoutExpiresAt.getTime() - member.completedAt.getTime()).toBe(5 * 86_400_000);
    await expect(clear("beast-1", "short", 1)).resolves.toMatchObject({ cooldownDays: 1 });
    // Not before the membership qualifies, and not for other players.
    await expect(clear("beast-2", "unqualified")).resolves.toMatchObject({ cooldownDays: 6 });
    await expect(clear("beast-3", "outsider")).resolves.toMatchObject({ cooldownDays: 4 });
    // Delver's Lore rank 3 (-2) and Restless Herds (-1) stack.
    await pool.query(
      `INSERT INTO kingdom_memberships (kingdom_id, player_id, status, perk_qualified_at)
       VALUES ('00000000-0000-4000-8000-000000000001', 'beast-3', 'active', now() - interval '1 day')`
    );
    await expect(clear("beast-3", "stacked")).resolves.toMatchObject({ cooldownDays: 3 });
  });

  it("an early leave locks out but is not a clear", async () => {
    await pool.query("INSERT INTO players (id) VALUES ('player-5') ON CONFLICT DO NOTHING");
    const left = await ledger.recordEarlyLeave({ playerId: "player-5", dungeonKey: "dungeon:drowned_city", runId: "run-1", baseCooldownDays: 6 });
    expect(left).toMatchObject({ kind: "early_leave", sessionIdentity: "left:run-1", cooldownDays: 6 });
    await expect(ledger.recordEarlyLeave({ playerId: "player-5", dungeonKey: "dungeon:drowned_city", runId: "run-1", baseCooldownDays: 6 }))
      .resolves.toEqual(left);
    await expect(ledger.authorizeEntry("player-5", "dungeon:drowned_city"))
      .rejects.toMatchObject({ code: "DUNGEON_REPEAT_COOLDOWN_ACTIVE", message: expect.stringContaining("left this dungeon before the end") });
    const clears = await pool.query(
      `SELECT count(*)::int AS count FROM dungeon_completion_ledger
       WHERE player_id='player-5' AND completion_key NOT LIKE 'dungeon-left:%'`
    );
    expect(clears.rows[0]).toEqual({ count: 0 });
  });
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))) {
    throw new Error("Dungeon repeat ledger tests require a local disposable ash_atlas_stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable database name");
  }
  return `"${value}"`;
}

const fixture = `
CREATE TABLE players (id text PRIMARY KEY);
CREATE TABLE player_skill_ranks (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  skill_id text NOT NULL,
  rank smallint NOT NULL CHECK (rank BETWEEN 1 AND 3),
  PRIMARY KEY (player_id, skill_id)
);
INSERT INTO players (id) VALUES ('player-1');
CREATE TABLE kingdoms (id uuid PRIMARY KEY, status text NOT NULL);
CREATE TABLE kingdom_memberships (
  kingdom_id uuid NOT NULL REFERENCES kingdoms(id),
  player_id text NOT NULL REFERENCES players(id),
  status text NOT NULL,
  perk_qualified_at timestamptz NOT NULL
);
CREATE TABLE kingdom_perk_selections (
  kingdom_id uuid NOT NULL REFERENCES kingdoms(id),
  perk_level smallint NOT NULL,
  perk_id text NOT NULL,
  PRIMARY KEY (kingdom_id, perk_level)
);
`;
