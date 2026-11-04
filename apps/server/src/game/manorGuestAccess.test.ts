import { MANOR_KICK_REENTRY_LOCK_MS } from "@ash-atlas/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ManorPresenceService } from "./manor.js";

const manorId = "22222222-2222-4222-8222-222222222222";
const manorRow = {
  id: manorId,
  owner_player_id: "owner",
  owner_username: "Ash",
  world_region_code: "world-test",
  world_lat: 35,
  world_lon: -106,
  built_at: new Date("2026-07-21T00:00:00.000Z"),
  source_flag_id: null,
  placement_revision: 7
};

afterEach(() => vi.useRealTimers());

describe("manor guest authorization", () => {
  it("gives the owner first precedence without consulting bans", async () => {
    const query = vi.fn(async (sql: string) => sql.includes("FROM player_manors m JOIN players")
      ? { rowCount: 1, rows: [manorRow] }
      : { rowCount: 1, rows: [{}] });
    const service = new ManorPresenceService({ query } as never);
    await expect(service.authorizeEntry({
      playerId: "owner", manorId, activePartyMember: false, activeTravelInviteId: null
    })).resolves.toMatchObject({ accessSource: "OWNER", travelInviteId: null });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("lets a manor ban override both an active invite and active party membership", async () => {
    const service = new ManorPresenceService(poolWithBan(true));
    await expect(service.authorizeEntry({
      playerId: "guest", manorId, activePartyMember: true, activeTravelInviteId: "invite"
    })).rejects.toMatchObject({ code: "MANOR_BANNED" });
  });

  it("prefers an active manor invite over party admission", async () => {
    const service = new ManorPresenceService(poolWithBan(false));
    await expect(service.authorizeEntry({
      playerId: "guest", manorId, activePartyMember: true, activeTravelInviteId: "invite"
    })).resolves.toMatchObject({ accessSource: "TRAVEL_INVITE", travelInviteId: "invite" });
  });

  it("applies the temporary kick lock without creating a permanent ban, then expires it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T12:00:00.000Z"));
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT 1 FROM player_manors")) return { rowCount: 1, rows: [{}] };
        if (sql.includes("DELETE FROM player_manor_presence")) return {
          rowCount: 1,
          rows: [{
            player_id: "guest", manor_id: manorId, owner_player_id: "owner", access_source: "PARTY",
            admission_travel_invite_id: null, return_region_code: "world-test", return_lat: 35, return_lon: -106
          }]
        };
        return { rowCount: 0, rows: [] };
      }),
      release: vi.fn()
    };
    const pool = poolWithBan(false) as unknown as { connect: () => Promise<typeof client> };
    pool.connect = vi.fn(async () => client);
    const service = new ManorPresenceService(pool as never);
    await service.kick("owner", manorId, "guest");
    await expect(service.authorizeEntry({
      playerId: "guest", manorId, activePartyMember: true, activeTravelInviteId: null
    })).rejects.toMatchObject({ code: "MANOR_TEMPORARILY_KICKED" });
    vi.advanceTimersByTime(MANOR_KICK_REENTRY_LOCK_MS);
    await expect(service.authorizeEntry({
      playerId: "guest", manorId, activePartyMember: true, activeTravelInviteId: null
    })).resolves.toMatchObject({ accessSource: "PARTY" });
  });
});

describe("manor jump replay ledger", () => {
  it("replays the same manor and rejects request-id reuse for another manor", async () => {
    const query = vi.fn(async () => ({ rowCount: 1, rows: [{ manor_id: manorId }] }));
    const service = new ManorPresenceService({ query } as never);
    await expect(service.completedJump("owner", "jump-1", manorId)).resolves.toBe(true);
    await expect(service.completedJump(
      "owner", "jump-1", "33333333-3333-4333-8333-333333333333"
    )).rejects.toMatchObject({ code: "REPLAY_CONFLICT" });
  });
});

function poolWithBan(banned: boolean) {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM player_manors m JOIN players")) return { rowCount: 1, rows: [manorRow] };
      if (sql.includes("FROM manor_bans")) return { rowCount: banned ? 1 : 0, rows: banned ? [{}] : [] };
      return { rowCount: 0, rows: [] };
    })
  } as never;
}
