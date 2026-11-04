import { randomUUID } from "node:crypto";

import {
  KINGDOM_ANARCHY_DURATION_MS,
  KINGDOM_REVOLT_FAILED_COOLDOWN_MS,
  KINGDOM_REVOLT_VOTE_DURATION_MS
} from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import type { AppLogger } from "../logger.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import { InventoryService } from "./inventory.js";
import { KingdomService } from "./kingdoms.js";
import { applyWarDeathLosses } from "./warDeathLosses.js";

const databaseUrl = process.env.KINGDOM_REVOLT_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("kingdom revolt and anarchy PostgreSQL integration", () => {
  let pool: pg.Pool;
  let inventory: InventoryService;
  let kingdoms: KingdomService;
  let now: Date;
  let kingdomId = "";

  beforeAll(async () => {
    const name = new URL(databaseUrl!).pathname.slice(1);
    if (!name.startsWith("ash_atlas_stability")) {
      throw new Error("KINGDOM_REVOLT_TEST_DATABASE_URL must target an ash_atlas_stability* database");
    }
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 8 });
    inventory = new InventoryService(pool);
  }, 120_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE kingdoms, players CASCADE");
    now = new Date();
    for (const id of ["ruler", "ash", "birch", "cedar", "dormant", "raider"]) await createPlayer(id);
    // "dormant" was last seen 8 days ago, so it is not an active member.
    await pool.query("UPDATE players SET last_seen_at = now() - interval '8 days' WHERE id = 'dormant'");
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as AppLogger;
    kingdoms = new KingdomService(
      pool,
      { lookupGameplayEnvironment: vi.fn(), lookupGameplayEnvironments: vi.fn() } as unknown as WorldLookupClient,
      loadConfig({ NODE_ENV: "test" }),
      logger,
      () => new Date(now)
    );
    kingdomId = await createKingdom("ruler", "Emberreach");
    for (const id of ["ash", "birch", "cedar", "dormant"]) await addKingdomMember(kingdomId, id, "member");
  });

  afterAll(async () => {
    await pool?.query("TRUNCATE kingdoms, players CASCADE");
    await pool?.end();
  });

  it("passes on a strict majority of active members, blocks leader actions in anarchy, then installs the starter", async () => {
    // The leader can neither start nor vote.
    await expect(kingdoms.startRevolt("ruler", "ruler-start")).rejects.toMatchObject({ code: "KINGDOM_REVOLT_LEADER_CANNOT_VOTE" });
    const started = await kingdoms.startRevolt("ash", "ash-start");
    const revolt = started.state!.revolt!.revolt!;
    // 3 eligible (dormant excluded, leader excluded); the starter's yes is 1 of 3.
    expect(revolt).toMatchObject({ yesVotes: 1, eligibleVoters: 3, boostPoints: 0, viewerVote: "yes", viewerCanVote: false });
    await expect(kingdoms.voteRevolt("ruler", { requestId: "ruler-vote", revoltId: revolt.revoltId, support: false }))
      .rejects.toMatchObject({ code: "KINGDOM_REVOLT_LEADER_CANNOT_VOTE" });
    await expect(kingdoms.startRevolt("birch", "birch-start")).rejects.toMatchObject({ code: "KINGDOM_REVOLT_ALREADY_OPEN" });

    // 2 of 3 is more than 55%: the vote ends at once.
    const passed = await kingdoms.voteRevolt("birch", { requestId: "birch-vote", revoltId: revolt.revoltId, support: true });
    expect(passed.state!.revolt!.revolt).toBeNull();
    expect(passed.state!.revolt!.anarchy).toMatchObject({ deposedLeaderPlayerId: "ruler" });
    expect(await roles()).toEqual({ ash: "member", birch: "member", cedar: "member", dormant: "member", ruler: "member" });

    // Anarchy: nobody holds leader-only permissions; a new revolt has no target.
    await expect(kingdoms.memberAction("ruler", { requestId: "ruler-transfer", targetPlayerId: "ash", action: "transfer_leadership" }))
      .rejects.toMatchObject({ code: "KINGDOM_PERMISSION_DENIED" });
    await expect(kingdoms.dissolveKingdom("ruler", "ruler-dissolve")).rejects.toMatchObject({ code: "KINGDOM_PERMISSION_DENIED" });
    await expect(kingdoms.upgradeBrickFurnace("ash", { requestId: "ash-furnace", targetLevel: 1 }))
      .rejects.toMatchObject({ code: "KINGDOM_PERMISSION_DENIED" });
    await expect(kingdoms.startRevolt("cedar", "cedar-start")).rejects.toMatchObject({ code: "KINGDOM_REVOLT_ANARCHY" });
    expect(await kingdoms.settleRevolts()).toEqual([]);

    // Two days later the revolt's starter takes the leader role.
    now = new Date(now.getTime() + KINGDOM_ANARCHY_DURATION_MS + 1_000);
    expect(await kingdoms.settleRevolts()).toEqual([kingdomId]);
    expect((await roles()).ash).toBe("leader");
    const kingdom = await pool.query("SELECT leader_player_id, anarchy_until FROM kingdoms WHERE id = $1", [kingdomId]);
    expect(kingdom.rows[0]).toEqual({ leader_player_id: "ash", anarchy_until: null });
    const revoltRow = await pool.query("SELECT status, yes_votes, eligible_voters, successor_player_id FROM kingdom_revolts");
    expect(revoltRow.rows).toEqual([{ status: "succeeded", yes_votes: 2, eligible_voters: 3, successor_player_id: "ash" }]);
    // The new leader holds leader-only actions again: the furnace build passes the
    // permission check and stops only on its cost.
    const build = await kingdoms.upgradeBrickFurnace("ash", { requestId: "ash-furnace-2", targetLevel: 1 })
      .then(() => null, (error: { code?: string }) => error.code);
    expect(build).not.toBe("KINGDOM_PERMISSION_DENIED");
    await expect(kingdoms.upgradeBrickFurnace("ruler", { requestId: "ruler-furnace", targetLevel: 1 }))
      .rejects.toMatchObject({ code: "KINGDOM_PERMISSION_DENIED" });
  });

  it("does not pass at exactly 50% and fails when the 4 days run out", async () => {
    await pool.query("UPDATE kingdom_memberships SET status='removed', ended_at=now() WHERE player_id IN ('cedar')");
    // 2 eligible (ash, birch): the starter's yes is exactly 50%, not more.
    const started = await kingdoms.startRevolt("ash", "ash-start");
    const revolt = started.state!.revolt!.revolt!;
    expect(revolt).toMatchObject({ yesVotes: 1, eligibleVoters: 2, supportPercent: 50 });
    await kingdoms.voteRevolt("birch", { requestId: "birch-no", revoltId: revolt.revoltId, support: false });
    expect(await kingdoms.settleRevolts()).toEqual([]);
    now = new Date(now.getTime() + KINGDOM_REVOLT_VOTE_DURATION_MS);
    expect(await kingdoms.settleRevolts()).toEqual([kingdomId]);
    const row = await pool.query("SELECT status, yes_votes, eligible_voters FROM kingdom_revolts");
    expect(row.rows).toEqual([{ status: "failed", yes_votes: 1, eligible_voters: 2 }]);
    expect((await roles()).ruler).toBe("leader");
    // A closed vote takes no more votes.
    await expect(kingdoms.voteRevolt("cedar", { requestId: "late", revoltId: revolt.revoltId, support: true }))
      .rejects.toMatchObject({ code: "KINGDOM_MEMBERSHIP_REQUIRED" });
    await expect(kingdoms.voteRevolt("ash", { requestId: "late-ash", revoltId: revolt.revoltId, support: true }))
      .rejects.toMatchObject({ code: "KINGDOM_REVOLT_NOT_FOUND" });
    // A failed revolt holds the next one off for 24 hours.
    await expect(kingdoms.startRevolt("birch", "birch-too-soon")).rejects.toMatchObject({ code: "KINGDOM_REVOLT_COOLDOWN" });
    expect((await kingdoms.getState("birch")).revolt!.nextRevoltAt).not.toBeNull();
    now = new Date(now.getTime() + KINGDOM_REVOLT_FAILED_COOLDOWN_MS);
    const again = await kingdoms.startRevolt("birch", "birch-after-cooldown");
    expect(again.state!.revolt!.revolt).toMatchObject({ startedByPlayerId: "birch" });
  });

  it("rejects a duplicate vote and replays a repeated request without a second row", async () => {
    const started = await kingdoms.startRevolt("ash", "ash-start");
    const revoltId = started.state!.revolt!.revolt!.revoltId;
    const first = await kingdoms.voteRevolt("birch", { requestId: "birch-no", revoltId, support: false });
    expect(first.replayed).toBe(false);
    const replay = await kingdoms.voteRevolt("birch", { requestId: "birch-no", revoltId, support: false });
    expect(replay.replayed).toBe(true);
    await expect(kingdoms.voteRevolt("birch", { requestId: "birch-yes", revoltId, support: true }))
      .rejects.toMatchObject({ code: "KINGDOM_REVOLT_ALREADY_VOTED" });
    await expect(kingdoms.voteRevolt("ash", { requestId: "ash-again", revoltId, support: true }))
      .rejects.toMatchObject({ code: "KINGDOM_REVOLT_ALREADY_VOTED" });
    // Concurrent new requests from one voter record one vote.
    await Promise.allSettled([
      kingdoms.voteRevolt("cedar", { requestId: "cedar-1", revoltId, support: false }),
      kingdoms.voteRevolt("cedar", { requestId: "cedar-2", revoltId, support: false })
    ]);
    const votes = await pool.query("SELECT voter_player_id, support FROM kingdom_revolt_votes ORDER BY voter_player_id");
    expect(votes.rows).toEqual([
      { voter_player_id: "ash", support: true },
      { voter_player_id: "birch", support: false },
      { voter_player_id: "cedar", support: false }
    ]);
    await expect(pool.query("DELETE FROM kingdom_revolt_votes")).rejects.toMatchObject({ code: "55000" });
  });

  it("adds 12 points per leader war death, capped at 24, and passes once the boost tips it", async () => {
    const rivalId = await createKingdom("raider", "Ironmarch");
    const [sideA, sideB] = [kingdomId, rivalId].sort();
    await pool.query(
      `INSERT INTO organization_wars (side_a_kind, side_a_id, side_b_kind, side_b_id, aggressor_kind, aggressor_id, declared_via)
       VALUES ('kingdom',$1,'kingdom',$2,'kingdom',$3,'settings')`,
      [sideA, sideB, rivalId]
    );
    await pool.query("UPDATE kingdom_memberships SET status='removed', ended_at=now() WHERE player_id = 'birch'");
    // 2 eligible (ash, cedar): ash's yes is 50%, short of the 55% bar.
    const started = await kingdoms.startRevolt("ash", "ash-start");
    expect(started.state!.revolt!.revolt).toMatchObject({ supportPercent: 50, boostPoints: 0 });
    // A member's war death gives no boost.
    await warDeath("cedar", "death-cedar");
    expect((await kingdoms.getState("ash")).revolt!.revolt!.boostPoints).toBe(0);
    // The leader's first war death: +12, which tips 50% to 62% and passes the vote.
    const loss = await warDeath("ruler", "death-ruler-1");
    expect(loss).toMatchObject({ applied: true, victimWasLeader: true, victimKingdomId: kingdomId });
    expect(await kingdoms.settleRevolts([kingdomId])).toEqual([kingdomId]);
    const row = await pool.query("SELECT status, boost_points FROM kingdom_revolts");
    expect(row.rows).toEqual([{ status: "succeeded", boost_points: 12 }]);
  });

  it("caps the boost at 24 points", async () => {
    const rivalId = await createKingdom("raider", "Ironmarch");
    const [sideA, sideB] = [kingdomId, rivalId].sort();
    await pool.query(
      `INSERT INTO organization_wars (side_a_kind, side_a_id, side_b_kind, side_b_id, aggressor_kind, aggressor_id, declared_via)
       VALUES ('kingdom',$1,'kingdom',$2,'kingdom',$3,'settings')`,
      [sideA, sideB, rivalId]
    );
    await createPlayer("elm");
    await addKingdomMember(kingdomId, "elm", "member");
    // 4 eligible: ash's yes is 25%; three leader deaths would be 61% uncapped, 49% capped.
    await kingdoms.startRevolt("ash", "ash-start");
    for (const key of ["d1", "d2", "d3"]) await warDeath("ruler", key);
    expect(await kingdoms.settleRevolts([kingdomId])).toEqual([]);
    const state = (await kingdoms.getState("ash")).revolt!;
    expect(state.revolt).toMatchObject({ boostPoints: 24, supportPercent: 49, yesVotes: 1, eligibleVoters: 4 });
    expect(state.revolt!.boostEndsAt).not.toBeNull();
    // Once the deaths are more than 2 days old the boost is gone.
    now = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1_000 + 60_000);
    expect((await kingdoms.getState("ash")).revolt!.boostPoints).toBe(0);
  });

  async function warDeath(victimPlayerId: string, key: string) {
    return applyWarDeathLosses(pool, inventory, { deathOperationKey: key, victimPlayerId, killerPlayerId: "raider" });
  }

  async function roles(): Promise<Record<string, string>> {
    const result = await pool.query<{ player_id: string; role: string }>(
      "SELECT player_id, role FROM kingdom_memberships WHERE kingdom_id = $1 AND status = 'active' ORDER BY player_id",
      [kingdomId]
    );
    return Object.fromEntries(result.rows.map((row) => [row.player_id, row.role]));
  }

  async function createPlayer(id: string): Promise<void> {
    const accountId = randomUUID();
    await pool.query("INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')", [accountId]);
    await pool.query(
      `INSERT INTO players (
         id, account_id, username, username_normalized, display_color, region_code, lat, lon,
         anchor_lat, anchor_lon, move_leash_radius_m, online, geom
       ) VALUES ($1,$2,$1,$1,'#38bdf8','NM',36,-106,36,-106,900,true,ST_SetSRID(ST_MakePoint(-106,36),4326))`,
      [id, accountId]
    );
  }

  async function createKingdom(leaderId: string, name: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO kingdoms (id, normalized_name, display_name, founder_player_id, leader_player_id, founding_request_id)
       VALUES ($1,$2,$3,$4,$4,$5)`,
      [id, `${name.toLowerCase()}-${id.slice(0, 8)}`, name, leaderId, randomUUID()]
    );
    await addKingdomMember(id, leaderId, "leader");
    return id;
  }

  async function addKingdomMember(kingdom: string, playerId: string, role: "leader" | "member"): Promise<void> {
    await pool.query(
      `INSERT INTO kingdom_memberships (id, kingdom_id, player_id, role, status, joined_at, perk_qualified_at)
       VALUES (gen_random_uuid(),$1,$2,$3,'active',clock_timestamp(),now())`,
      [kingdom, playerId, role]
    );
  }
});
