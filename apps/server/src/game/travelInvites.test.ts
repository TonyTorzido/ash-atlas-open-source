import { describe, expect, it, vi } from "vitest";

import { TravelInviteService, type TravelInviteError } from "./travelInvites.js";

const now = new Date("2026-07-13T12:00:00.000Z");
const inviteId = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-000000000002";
const flagId = "00000000-0000-4000-8000-000000000003";
const anchor = {
  scopeId: "world",
  layerId: `flag:${flagId}`,
  center: { lat: 40, lon: -105 },
  relocationRevision: 4,
  layerGeneration: 7,
  sourceType: "flag",
  sourceId: flagId
} as const;

describe("TravelInviteService", () => {
  it("creates exactly one ten-minute invite and two linked inbox projections in one transaction", async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const ids = [inviteId, "00000000-0000-4000-8000-000000000004", "00000000-0000-4000-8000-000000000005"];
    const client = scriptedClient(async (sql, values) => {
      queries.push({ sql, ...(values ? { values } : {}) });
      if (sql.includes("INSERT INTO travel_invite_operations")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("SELECT id, username FROM players")) return {
        rowCount: 2,
        rows: [{ id: "inviter", username: "Ariadne" }, { id: "invitee", username: "Beren" }]
      };
      if (sql.includes("AS blocked")) return { rowCount: 1, rows: [{ blocked: false }] };
      if (sql.includes("FROM travel_invites") && sql.includes("created_at >")) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    });
    const service = new TravelInviteService(poolFor(client), () => new Date(now), () => ids.shift()!);

    await expect(service.send({
      inviterPlayerId: "inviter",
      inviteePlayerId: "invitee",
      inviterSessionId: sessionId,
      anchor,
      requestId: "send-1"
    })).resolves.toMatchObject({ inviteId, replayed: false });

    const inviteInsert = queries.find((query) => query.sql.includes("INSERT INTO travel_invites"))!;
    expect((inviteInsert.values?.[14] as Date).getTime() - (inviteInsert.values?.[13] as Date).getTime())
      .toBe(600_000);
    expect(inviteInsert.values?.slice(4, 12)).toEqual([
      "world", `flag:${flagId}`, 4, 7, "flag", flagId, 40, -105
    ]);
    const inboxInsert = queries.find((query) => query.sql.includes("INSERT INTO player_inbox_entries"))!;
    expect(inboxInsert.sql).toContain("'sender'");
    expect(inboxInsert.sql).toContain("'recipient'");
    expect(queries.at(-1)?.sql).toBe("COMMIT");
    expect(queries.some((query) => query.sql === "ROLLBACK")).toBe(false);
  });

  it("rejects blocked pairs before creating inbox authority", async () => {
    const queries: string[] = [];
    const client = scriptedClient(async (sql) => {
      queries.push(sql);
      if (sql.includes("INSERT INTO travel_invite_operations")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("SELECT id, username FROM players")) return {
        rowCount: 2,
        rows: [{ id: "inviter", username: "Ariadne" }, { id: "invitee", username: "Beren" }]
      };
      if (sql.includes("AS blocked")) return { rowCount: 1, rows: [{ blocked: true }] };
      return { rowCount: 1, rows: [] };
    });
    const service = new TravelInviteService(poolFor(client), () => new Date(now));

    await expect(service.send({
      inviterPlayerId: "inviter",
      inviteePlayerId: "invitee",
      inviterSessionId: sessionId,
      anchor,
      requestId: "send-blocked"
    })).rejects.toMatchObject({ code: "TRAVEL_INVITE_FORBIDDEN" });
    expect(queries.some((sql) => sql.includes("INSERT INTO travel_invites"))).toBe(false);
    expect(queries).toContain("ROLLBACK");
  });

  it("returns a retry delay after five recent sends", async () => {
    const client = scriptedClient(async (sql) => {
      if (sql.includes("INSERT INTO travel_invite_operations")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("SELECT id, username FROM players")) return {
        rowCount: 2,
        rows: [{ id: "inviter", username: "Ariadne" }, { id: "invitee", username: "Beren" }]
      };
      if (sql.includes("AS blocked")) return { rowCount: 1, rows: [{ blocked: false }] };
      if (sql.includes("FROM travel_invites") && sql.includes("created_at >")) return {
        rowCount: 5,
        rows: Array.from({ length: 5 }, (_, index) => ({
          invitee_player_id: `other-${index}`,
          status: "declined",
          created_at: new Date(now.getTime() - 30_000 + index)
        }))
      };
      return { rowCount: 1, rows: [] };
    });
    const service = new TravelInviteService(poolFor(client), () => new Date(now));

    await expect(service.send({
      inviterPlayerId: "inviter",
      inviteePlayerId: "invitee",
      inviterSessionId: sessionId,
      anchor,
      requestId: "send-rate-limited"
    })).rejects.toMatchObject({
      code: "TRAVEL_INVITE_RATE_LIMITED",
      retryAfterMs: 30_000
    });
  });

  it("reports the remaining thirty-second cooldown for the same player", async () => {
    const client = scriptedClient(async (sql) => {
      if (sql.includes("INSERT INTO travel_invite_operations")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("SELECT id, username FROM players")) return {
        rowCount: 2,
        rows: [{ id: "inviter", username: "Ariadne" }, { id: "invitee", username: "Beren" }]
      };
      if (sql.includes("AS blocked")) return { rowCount: 1, rows: [{ blocked: false }] };
      if (sql.includes("status IN ('pending', 'accepting')") && sql.includes("FOR UPDATE")) {
        return { rowCount: 1, rows: [{ id: inviteId, status: "pending" }] };
      }
      if (sql.includes("FROM travel_invites") && sql.includes("created_at >")) return {
        rowCount: 1,
        rows: [{ invitee_player_id: "invitee", status: "pending", created_at: now }]
      };
      return { rowCount: 1, rows: [] };
    });
    const service = new TravelInviteService(poolFor(client), () => new Date(now));

    await expect(service.send({
      inviterPlayerId: "inviter",
      inviteePlayerId: "invitee",
      inviterSessionId: sessionId,
      anchor,
      requestId: "send-pair-cooldown"
    })).rejects.toMatchObject({
      code: "TRAVEL_INVITE_RATE_LIMITED",
      message: "You can invite this player again in 30 seconds.",
      retryAfterMs: 30_000
    });
  });

  it("blocks outgoing invites during the one-hour post-relocation cooldown", async () => {
    const queries: string[] = [];
    const client = scriptedClient(async (sql) => {
      queries.push(sql);
      if (sql.includes("INSERT INTO travel_invite_operations")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("SELECT id, username FROM players")) return {
        rowCount: 2,
        rows: [{ id: "inviter", username: "Ariadne" }, { id: "invitee", username: "Beren" }]
      };
      if (sql.includes("SELECT last_relocated_at FROM players")) return {
        rowCount: 1,
        rows: [{ last_relocated_at: new Date(now.getTime() - 15 * 60_000) }]
      };
      return { rowCount: 1, rows: [] };
    });
    const service = new TravelInviteService(poolFor(client), () => new Date(now));

    await expect(service.send({
      inviterPlayerId: "inviter",
      inviteePlayerId: "invitee",
      inviterSessionId: sessionId,
      anchor,
      requestId: "send-after-relocation"
    })).rejects.toMatchObject({
      code: "TRAVEL_INVITE_RELOCATION_COOLDOWN",
      retryAfterMs: 45 * 60_000,
      message: "You cannot send Travel Invites for 45 more minutes after relocating."
    });
    expect(queries.some((sql) => sql.includes("INSERT INTO travel_invites"))).toBe(false);
    expect(queries).toContain("ROLLBACK");
  });

  it("does not apply the outgoing relocation cooldown to receiving invites", async () => {
    const client = scriptedClient(async (sql) => {
      if (sql.includes("INSERT INTO travel_invite_operations")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("FROM travel_invites WHERE id")) return {
        rowCount: 1,
        rows: [inviteRow()]
      };
      return { rowCount: 1, rows: [] };
    });
    const service = new TravelInviteService(poolFor(client), () => new Date(now));

    await expect(service.reserveAcceptance(inviteId, "invitee", "accept-after-relocation"))
      .resolves.toMatchObject({ inviteId, inviteePlayerId: "invitee" });
  });

  it("allows outgoing invites once the post-relocation hour has elapsed", async () => {
    const client = scriptedClient(async (sql) => {
      if (sql.includes("INSERT INTO travel_invite_operations")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("SELECT id, username FROM players")) return {
        rowCount: 2,
        rows: [{ id: "inviter", username: "Ariadne" }, { id: "invitee", username: "Beren" }]
      };
      if (sql.includes("SELECT last_relocated_at FROM players")) return {
        rowCount: 1,
        rows: [{ last_relocated_at: new Date(now.getTime() - 61 * 60_000) }]
      };
      if (sql.includes("AS blocked")) return { rowCount: 1, rows: [{ blocked: false }] };
      if (sql.includes("FROM travel_invites") && sql.includes("created_at >")) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    });
    const service = new TravelInviteService(poolFor(client), () => new Date(now));

    await expect(service.send({
      inviterPlayerId: "inviter",
      inviteePlayerId: "invitee",
      inviterSessionId: sessionId,
      anchor,
      requestId: "send-after-relocation-cooldown"
    })).resolves.toMatchObject({ replayed: false });
  });

  it("invalidates a pending pair and creates a fresh invite after thirty seconds", async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const replacementId = "00000000-0000-4000-8000-000000000006";
    const ids = [
      replacementId,
      "00000000-0000-4000-8000-000000000007",
      "00000000-0000-4000-8000-000000000008"
    ];
    const client = scriptedClient(async (sql, values) => {
      queries.push({ sql, ...(values ? { values } : {}) });
      if (sql.includes("INSERT INTO travel_invite_operations")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("SELECT id, username FROM players")) return {
        rowCount: 2,
        rows: [{ id: "inviter", username: "Ariadne" }, { id: "invitee", username: "Beren" }]
      };
      if (sql.includes("AS blocked")) return { rowCount: 1, rows: [{ blocked: false }] };
      if (sql.includes("status IN ('pending', 'accepting')") && sql.includes("FOR UPDATE")) {
        return { rowCount: 1, rows: [{ id: inviteId, status: "pending" }] };
      }
      if (sql.includes("FROM travel_invites") && sql.includes("created_at >")) return {
        rowCount: 1,
        rows: [{
          invitee_player_id: "invitee",
          status: "pending",
          created_at: new Date(now.getTime() - 30_000)
        }]
      };
      return { rowCount: 1, rows: [] };
    });
    const service = new TravelInviteService(poolFor(client), () => new Date(now), () => ids.shift()!);

    await expect(service.send({
      inviterPlayerId: "inviter",
      inviteePlayerId: "invitee",
      inviterSessionId: sessionId,
      anchor,
      requestId: "send-replacement"
    })).resolves.toMatchObject({ inviteId: replacementId, replayed: false });

    const invalidation = queries.find((query) =>
      query.sql.includes("UPDATE travel_invites") && query.values?.[0] === inviteId
    );
    expect(invalidation?.values).toEqual([
      inviteId,
      "invalidated",
      "Replaced by a newer Travel Invite.",
      now
    ]);
    expect(queries.findIndex((query) => query === invalidation)).toBeLessThan(
      queries.findIndex((query) => query.sql.includes("INSERT INTO travel_invites"))
    );
    expect(queries.at(-1)?.sql).toBe("COMMIT");
  });

  it("keeps the pending predecessor when fresh invite creation fails", async () => {
    const queries: string[] = [];
    const client = scriptedClient(async (sql) => {
      queries.push(sql);
      if (sql.includes("INSERT INTO travel_invite_operations")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("SELECT id, username FROM players")) return {
        rowCount: 2,
        rows: [{ id: "inviter", username: "Ariadne" }, { id: "invitee", username: "Beren" }]
      };
      if (sql.includes("AS blocked")) return { rowCount: 1, rows: [{ blocked: false }] };
      if (sql.includes("status IN ('pending', 'accepting')") && sql.includes("FOR UPDATE")) {
        return { rowCount: 1, rows: [{ id: inviteId, status: "pending" }] };
      }
      if (sql.includes("FROM travel_invites") && sql.includes("created_at >")) return {
        rowCount: 0,
        rows: []
      };
      if (sql.includes("INSERT INTO travel_invites")) throw new Error("invite insert failed");
      return { rowCount: 1, rows: [] };
    });
    const service = new TravelInviteService(poolFor(client), () => new Date(now));

    await expect(service.send({
      inviterPlayerId: "inviter",
      inviteePlayerId: "invitee",
      inviterSessionId: sessionId,
      anchor,
      requestId: "send-replacement-fails"
    })).rejects.toThrow("invite insert failed");
    expect(queries).toContain("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
  });

  it("commits terminal expiration before rejecting a late acceptance", async () => {
    const queries: string[] = [];
    const client = scriptedClient(async (sql) => {
      queries.push(sql);
      if (sql.includes("INSERT INTO travel_invite_operations")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("FROM travel_invites WHERE id")) return {
        rowCount: 1,
        rows: [inviteRow({ status: "pending", expires_at: new Date(now.getTime() - 1) })]
      };
      return { rowCount: 1, rows: [] };
    });
    const service = new TravelInviteService(poolFor(client), () => new Date(now));

    await expect(service.reserveAcceptance(inviteId, "invitee", "accept-late")).rejects.toEqual(
      expect.objectContaining<Partial<TravelInviteError>>({ code: "TRAVEL_INVITE_EXPIRED" })
    );
    expect(queries).toContain("COMMIT");
    expect(queries).not.toContain("ROLLBACK");
    expect(queries.some((sql) => sql.includes("SET status = $2") && sql.includes("responded_at"))).toBe(true);
  });

  it("replays the same in-progress acceptance reservation without consuming it twice", async () => {
    const client = scriptedClient(async (sql) => {
      if (sql.includes("INSERT INTO travel_invite_operations")) return { rowCount: 0, rows: [] };
      if (sql.includes("FROM travel_invite_operations")) return {
        rowCount: 1,
        rows: [{ action: "accept", travel_invite_id: null, payload_matches: true, completed_at: null }]
      };
      if (sql.includes("FROM travel_invites WHERE id")) return {
        rowCount: 1,
        rows: [inviteRow({ status: "accepting", acceptance_request_id: "accept-1" })]
      };
      return { rowCount: 1, rows: [] };
    });
    const service = new TravelInviteService(poolFor(client), () => new Date(now));

    await expect(service.reserveAcceptance(inviteId, "invitee", "accept-1")).resolves.toMatchObject({
      inviteId,
      inviteePlayerId: "invitee"
    });
  });

  it("rolls back both acceptance state and ledger completion when finalization fails", async () => {
    const queries: string[] = [];
    const client = scriptedClient(async (sql) => {
      queries.push(sql);
      if (sql.includes("UPDATE travel_invites")) return {
        rowCount: 1,
        rows: [{ inviter_player_id: "inviter", invitee_player_id: "invitee" }]
      };
      if (sql.includes("UPDATE travel_invite_operations")) throw new Error("ledger unavailable");
      return { rowCount: 0, rows: [] };
    });
    const service = new TravelInviteService(poolFor(client), () => new Date(now));

    await expect(service.completeAcceptance(inviteId, "invitee", "accept-1"))
      .rejects.toThrow("ledger unavailable");
    expect(queries).toContain("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
  });
});

function inviteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: inviteId,
    inviter_player_id: "inviter",
    invitee_player_id: "invitee",
    inviter_session_id: sessionId,
    layer_scope_id: "world",
    layer_id: `flag:${flagId}`,
    layer_relocation_revision: 4,
    layer_generation: 7,
    source_type: "flag",
    source_id: flagId,
    destination_anchor_lat: 40,
    destination_anchor_lon: -105,
    status: "pending",
    expires_at: new Date(now.getTime() + 600_000),
    acceptance_request_id: null,
    ...overrides
  };
}

function scriptedClient(
  query: (sql: string, values?: unknown[]) => Promise<{ rowCount: number; rows: unknown[] }>
) {
  return { query: vi.fn(query), release: vi.fn() };
}

function poolFor(client: ReturnType<typeof scriptedClient>) {
  return { connect: vi.fn(async () => client) } as never;
}
