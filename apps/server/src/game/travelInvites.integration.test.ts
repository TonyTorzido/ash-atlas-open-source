import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { TravelInviteError, TravelInviteService } from "./travelInvites.js";

const databaseUrl = process.env.TRAVEL_INVITES_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("TravelInviteService PostgreSQL integration", () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const suffix = randomUUID().slice(0, 8);
  const inviterPlayerId = `travel-inviter-${suffix}`;
  const inviteePlayerId = `travel-invitee-${suffix}`;
  const flagId = randomUUID();
  const sessionId = randomUUID();
  let clock = new Date("2026-07-13T12:00:00.000Z");
  const service = new TravelInviteService(pool, () => new Date(clock));

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    await pool.query(
      `INSERT INTO players (
         id, username, region_code, lat, lon, anchor_lat, anchor_lon,
         move_leash_radius_m, online, geom
       ) VALUES
         ($1,'Ariadne','GLOBAL',40,-105,40,-105,100,true,ST_SetSRID(ST_MakePoint(-105,40),4326)),
         ($2,'Beren','GLOBAL',40,-105,40,-105,100,true,ST_SetSRID(ST_MakePoint(-105,40),4326))`,
      [inviterPlayerId, inviteePlayerId]
    );
    await pool.query(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom)
       VALUES ($1,$2,'Travel Test Flag',40,-105,100,ST_SetSRID(ST_MakePoint(-105,40),4326))`,
      [flagId, inviterPlayerId]
    );
  });

  beforeEach(async () => {
    await pool.query(
      `DELETE FROM travel_invite_operations WHERE player_id = ANY($1::text[])`,
      [[inviterPlayerId, inviteePlayerId]]
    );
    await pool.query(
      `DELETE FROM travel_invites WHERE inviter_player_id = $1 OR invitee_player_id = $2`,
      [inviterPlayerId, inviteePlayerId]
    );
    await pool.query(
      `DELETE FROM player_blocks
       WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
      [inviterPlayerId, inviteePlayerId]
    );
    clock = new Date("2026-07-13T12:00:00.000Z");
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM travel_invite_operations WHERE player_id = ANY($1::text[])`,
      [[inviterPlayerId, inviteePlayerId]]
    );
    await pool.query(
      `DELETE FROM travel_invites WHERE inviter_player_id = $1 OR invitee_player_id = $2`,
      [inviterPlayerId, inviteePlayerId]
    );
    await pool.query(`DELETE FROM flags WHERE id = $1`, [flagId]);
    await pool.query(`DELETE FROM players WHERE id = ANY($1::text[])`, [[inviterPlayerId, inviteePlayerId]]);
    await pool.end();
  });

  it("atomically creates exact-TTL authority and both inbox perspectives", async () => {
    clock = new Date("2026-07-13T12:00:00.000Z");
    const sent = await send("send-create");
    const invite = await pool.query<{
      created_at: Date;
      expires_at: Date;
    }>(`SELECT created_at, expires_at FROM travel_invites WHERE id = $1`, [sent.inviteId]);
    expect(invite.rows[0]!.expires_at.getTime() - invite.rows[0]!.created_at.getTime()).toBe(600_000);

    const inbox = await Promise.all([
      service.inboxForPlayer(inviterPlayerId),
      service.inboxForPlayer(inviteePlayerId)
    ]);
    expect(inbox[0][0]).toMatchObject({
      perspective: "sender",
      message: "You invited Beren to your current area.",
      status: "pending"
    });
    expect(inbox[1][0]).toMatchObject({
      perspective: "recipient",
      message: "Ariadne invited you to travel to their current area.",
      status: "pending"
    });
    await service.cancel(sent.inviteId, inviterPlayerId, "cancel-create");
  });

  it("makes decline and cancel terminal and rejects later acceptance", async () => {
    const declined = await send("send-decline");
    await service.decline(declined.inviteId, inviteePlayerId, "decline-1");
    await expect(service.reserveAcceptance(declined.inviteId, inviteePlayerId, "accept-declined"))
      .rejects.toMatchObject({ code: "TRAVEL_INVITE_NOT_PENDING" });

    clock = new Date(clock.getTime() + 60_001);
    const cancelled = await send("send-cancel");
    await service.cancel(cancelled.inviteId, inviterPlayerId, "cancel-1");
    await expect(service.reserveAcceptance(cancelled.inviteId, inviteePlayerId, "accept-cancelled"))
      .rejects.toMatchObject({ code: "TRAVEL_INVITE_NOT_PENDING" });
  });

  it("rate-limits immediate repeats, then atomically replaces the pending invite", async () => {
    const first = await send("send-duplicate-a");
    await expect(send("send-duplicate-b")).rejects.toMatchObject({
      code: "TRAVEL_INVITE_RATE_LIMITED",
      message: "You can invite this player again in 30 seconds.",
      retryAfterMs: 30_000
    });

    clock = new Date(clock.getTime() + 30_000);
    const fresh = await send("send-duplicate-fresh");
    expect(fresh.inviteId).not.toBe(first.inviteId);
    await expect(pool.query<{ id: string; status: string; invalidation_reason: string | null }>(
      `SELECT id, status, invalidation_reason
       FROM travel_invites
       WHERE id = ANY($1::uuid[])
       ORDER BY created_at ASC, id ASC`,
      [[first.inviteId, fresh.inviteId]]
    )).resolves.toMatchObject({ rows: [
      {
        id: first.inviteId,
        status: "invalidated",
        invalidation_reason: "Replaced by a newer Travel Invite."
      },
      { id: fresh.inviteId, status: "pending", invalidation_reason: null }
    ] });
    await expect(pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM travel_invites
       WHERE inviter_player_id = $1 AND invitee_player_id = $2
         AND status IN ('pending', 'accepting')`,
      [inviterPlayerId, inviteePlayerId]
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });
    await service.cancel(fresh.inviteId, inviterPlayerId, "cancel-duplicate");
  });

  it("enforces bilateral blocks for send and acceptance", async () => {
    await pool.query(
      `INSERT INTO player_blocks (blocker_id, blocked_id) VALUES ($1,$2)`,
      [inviteePlayerId, inviterPlayerId]
    );
    await expect(send("send-blocked")).rejects.toMatchObject({ code: "TRAVEL_INVITE_FORBIDDEN" });

    await pool.query(
      `DELETE FROM player_blocks WHERE blocker_id = $1 AND blocked_id = $2`,
      [inviteePlayerId, inviterPlayerId]
    );
    const sent = await send("send-before-block");
    await pool.query(
      `INSERT INTO player_blocks (blocker_id, blocked_id) VALUES ($1,$2)`,
      [inviterPlayerId, inviteePlayerId]
    );
    await expect(service.reserveAcceptance(sent.inviteId, inviteePlayerId, "accept-after-block"))
      .rejects.toMatchObject({ code: "TRAVEL_INVITE_FORBIDDEN" });
    await expect(pool.query(`SELECT status FROM travel_invites WHERE id = $1`, [sent.inviteId]))
      .resolves.toMatchObject({ rows: [{ status: "invalidated" }] });
  });

  it("enforces a durable same-player resend cooldown", async () => {
    const first = await send("send-cooldown-first");
    await service.decline(first.inviteId, inviteePlayerId, "decline-cooldown-first");
    clock = new Date(clock.getTime() + 15_000);
    await expect(send("send-cooldown-too-soon")).rejects.toMatchObject({
      code: "TRAVEL_INVITE_RATE_LIMITED",
      retryAfterMs: 15_000
    });
    clock = new Date(clock.getTime() + 15_001);
    await expect(send("send-cooldown-ready")).resolves.toMatchObject({ replayed: false });
  });

  it("persists exact expiration and rejects acceptance at the deadline", async () => {
    clock = new Date("2026-07-13T13:00:00.000Z");
    const expired = await send("send-expired");
    clock = new Date(clock.getTime() + 600_000);
    await expect(service.reserveAcceptance(expired.inviteId, inviteePlayerId, "accept-expired"))
      .rejects.toMatchObject({ code: "TRAVEL_INVITE_EXPIRED" });
    await expect(pool.query(`SELECT status FROM travel_invites WHERE id = $1`, [expired.inviteId]))
      .resolves.toMatchObject({ rows: [{ status: "expired" }] });
  });

  it("allows only one concurrent acceptance reservation and consumes it once", async () => {
    clock = new Date("2026-07-13T14:00:00.000Z");
    const sent = await send("send-race");
    const attempts = await Promise.allSettled([
      service.reserveAcceptance(sent.inviteId, inviteePlayerId, "accept-race-a"),
      service.reserveAcceptance(sent.inviteId, inviteePlayerId, "accept-race-b")
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const winningRequestId = attempts[0]!.status === "fulfilled" ? "accept-race-a" : "accept-race-b";
    await service.completeAcceptance(sent.inviteId, inviteePlayerId, winningRequestId);
    await expect(service.reserveAcceptance(sent.inviteId, inviteePlayerId, "accept-after"))
      .rejects.toMatchObject({ code: "TRAVEL_INVITE_NOT_PENDING" });
    await expect(pool.query(`SELECT status FROM travel_invites WHERE id = $1`, [sent.inviteId]))
      .resolves.toMatchObject({ rows: [{ status: "accepted" }] });
  });

  it("invalidates pending and reserved lifecycle records before travel can consume them", async () => {
    const pending = await send("send-invalidate");
    await expect(service.invalidateForInviter(
      inviterPlayerId,
      "The inviter disconnected.",
      { sessionId }
    )).resolves.toEqual([inviteePlayerId, inviterPlayerId].sort());
    await expect(service.reserveAcceptance(pending.inviteId, inviteePlayerId, "accept-invalidated"))
      .rejects.toMatchObject({ code: "TRAVEL_INVITE_NOT_PENDING" });

    clock = new Date(clock.getTime() + 60_001);
    const reserved = await send("send-reserved-race");
    await service.reserveAcceptance(reserved.inviteId, inviteePlayerId, "accept-reserved-race");
    await expect(service.invalidateForInviter(inviterPlayerId, "The inviter disconnected.", { sessionId }))
      .resolves.toEqual([inviteePlayerId, inviterPlayerId].sort());
    await expect(service.completeAcceptance(reserved.inviteId, inviteePlayerId, "accept-reserved-race"))
      .rejects.toMatchObject({ code: "TRAVEL_INVITE_NOT_PENDING" });
    await expect(pool.query(`SELECT status FROM travel_invites WHERE id = $1`, [reserved.inviteId]))
      .resolves.toMatchObject({ rows: [{ status: "invalidated" }] });
  });

  it("runs doorway checks only for new sends, so a replay returns the original invite", async () => {
    let checks = 0;
    const allow = async () => { checks += 1; };
    const refuse = async () => {
      checks += 1;
      throw new TravelInviteError("TRAVEL_DOORWAY_NO_PRESENCE", "Location could not be confirmed.");
    };
    await expect(send("send-doorway-refused", refuse)).rejects.toMatchObject({ code: "TRAVEL_DOORWAY_NO_PRESENCE" });
    expect((await pool.query(
      "SELECT 1 FROM travel_invite_operations WHERE player_id = $1 AND request_id = $2",
      [inviterPlayerId, "send-doorway-refused"]
    )).rowCount).toBe(0);
    const first = await send("send-doorway", allow);
    expect(first.replayed).toBe(false);
    const replay = await send("send-doorway", refuse);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(checks).toBe(2);
  });

  async function send(requestId: string, beforeCreate?: () => Promise<void>) {
    return service.send({
      inviterPlayerId,
      inviteePlayerId,
      inviterSessionId: sessionId,
      anchor: {
        scopeId: "world",
        layerId: `flag:${flagId}`,
        center: { lat: 40, lon: -105 },
        relocationRevision: 4,
        layerGeneration: 7,
        sourceType: "flag",
        sourceId: flagId
      },
      requestId,
      ...(beforeCreate ? { beforeCreate } : {})
    });
  }
});
