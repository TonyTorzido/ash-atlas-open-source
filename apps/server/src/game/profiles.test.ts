import type pg from "pg";
import { describe, expect, it } from "vitest";

import {
  ProfileSocialError,
  ProfileSocialService,
  canonicalPlayerPair,
  normalizeProfileBiography,
  normalizeProfileTitle
} from "./profiles.js";

describe("profile text", () => {
  it("accepts only unlocked titles and canonical plain-text biographies", () => {
    expect(normalizeProfileTitle("Alpha Tester")).toBe("Alpha Tester");
    expect(normalizeProfileBiography(" First  line\r\n\r\n\r\n Second\tline ")).toBe("First line\n\nSecond line");
    expect(normalizeProfileTitle(null)).toBeNull();
    expect(() => normalizeProfileTitle("Guardian")).toThrow(ProfileSocialError);
  });

  it("rejects oversized or controlled biography text", () => {
    expect(() => normalizeProfileBiography("unsafe\u0000text")).toThrow(/control/i);
    expect(() => normalizeProfileBiography("x".repeat(281))).toThrow(/280/);
  });
});

describe("profile/social authority", () => {
  it("canonicalizes friendship pairs and rejects self targeting", () => {
    expect(canonicalPlayerPair("b", "a")).toEqual(["a", "b"]);
    expect(() => canonicalPlayerPair("a", "a")).toThrow(/yourself/i);
  });

  it("returns an explicit public DTO with authoritative presence and nullable slots", async () => {
    const requestedAppearances: Array<[string, string]> = [];
    const pool = {
      query: async (sql: string) => {
        if (/player_achievements|weekly_leaderboard_totals|player_combat_records/.test(sql)) return { rows: [], rowCount: 0 };
        if (sql.includes("FROM players p")) return { rows: [{
          player_id: "target", username: "Target", display_color: "#123456", level: 7,
          title: "Scout", biography: "Plain text", created_at: new Date(0), updated_at: new Date(1),
          player_created_at: new Date(0), last_seen_at: null, active_specialization_id: "ronin"
        }], rowCount: 1 };
        return { rows: [{
          viewer_blocked: false, target_blocked: false, friends: false,
          outgoing: true, incoming: false, enemy: false
        }], rowCount: 1 };
      }
    } as unknown as pg.Pool;
    const service = new ProfileSocialService(pool, {
      isPlayerOnline: (id) => id === "target",
      playerAppearance: async (playerId, bodyVariantId) => {
        requestedAppearances.push([playerId, bodyVariantId]);
        return {
          schemaVersion: 1,
          catalogRevision: 1,
          revision: 7,
          bodyVariantId,
          poseId: "melee_idle",
          slots: {},
          activeHand: "melee"
        };
      }
    });
    const profile = await service.getProfile("viewer", "target");
    expect(profile).toMatchObject({
      playerId: "target", displayName: "Target", level: 7, presence: "hidden",
      title: null, class: { id: "ronin", name: "Ronin" }, kingdom: null, settlement: null,
      relationship: { friendship: "outgoing_request", enemyMarkedByViewer: false },
      appearance: { revision: 7, bodyVariantId: "default" }
    });
    expect(requestedAppearances).toEqual([["target", "default"]]);
    expect(profile).not.toHaveProperty("email");
    expect(profile).not.toHaveProperty("lastSeenAt");
  });

  it.each([["ninja"], [null]] as const)("shows no class for a hidden or missing active class (%s)", async (activeSpecializationId) => {
    const pool = {
      query: async (sql: string) => {
        if (/player_achievements|weekly_leaderboard_totals|player_combat_records/.test(sql)) return { rows: [], rowCount: 0 };
        if (sql.includes("FROM players p")) return { rows: [{
          player_id: "target", username: "Target", display_color: "#123456", level: 24,
          title: null, biography: null, created_at: new Date(0), updated_at: new Date(1),
          player_created_at: new Date(0), last_seen_at: null, active_specialization_id: activeSpecializationId
        }], rowCount: 1 };
        return { rows: [{
          viewer_blocked: false, target_blocked: false, friends: false,
          outgoing: false, incoming: false, enemy: false
        }], rowCount: 1 };
      }
    } as unknown as pg.Pool;
    const profile = await new ProfileSocialService(pool).getProfile("viewer", "target");
    expect(profile.class).toBeNull();
  });

  it("reveals exact presence to friends and self only", async () => {
    const pool = {
      query: async (sql: string) => {
        if (/player_achievements|weekly_leaderboard_totals|player_combat_records/.test(sql)) return { rows: [], rowCount: 0 };
        if (sql.includes("FROM players p")) return { rows: [{
          player_id: "target", username: "Target", display_color: null, level: 1,
          title: null, biography: null, created_at: new Date(0), updated_at: new Date(1),
          player_created_at: new Date(0), last_seen_at: null
        }], rowCount: 1 };
        return { rows: [{
          viewer_blocked: false, target_blocked: false, friends: true,
          outgoing: false, incoming: false, enemy: false
        }], rowCount: 1 };
      }
    } as unknown as pg.Pool;
    const service = new ProfileSocialService(pool, {
      playerPresence: () => "recently_active"
    });
    await expect(service.getProfile("viewer", "target"))
      .resolves.toMatchObject({ presence: "recently_active" });
    await expect(service.getProfile("target", "target"))
      .resolves.toMatchObject({ presence: "recently_active" });
  });

  it("uses the same pair-scoped transaction for a friend-to-enemy replacement", async () => {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql.replace(/\s+/g, " ").trim());
        if (sql.includes("SELECT id FROM players")) return { rows: [{ id: "target" }], rowCount: 1 };
        if (sql.includes(" AS blocked")) return { rows: [{ blocked: false, enemies: false }], rowCount: 1 };
        if (sql.includes("INSERT INTO player_enemy_marks")) {
          return { rows: [{ id: "00000000-0000-4000-8000-000000000001" }], rowCount: 1 };
        }
        if (sql.includes("DELETE FROM friendships")) return { rows: [], rowCount: 1 };
        if (/player_achievements|weekly_leaderboard_totals|player_combat_records/.test(sql)) return { rows: [], rowCount: 0 };
        if (sql.includes("FROM players p")) return { rows: [{
          player_id: "target", username: "Target", display_color: null, level: 0,
          title: null, biography: null, created_at: new Date(0), updated_at: new Date(0),
          player_created_at: new Date(0), last_seen_at: null
        }], rowCount: 1 };
        if (sql.includes(" AS viewer_blocked")) return { rows: [{
          viewer_blocked: false, target_blocked: false, friends: false,
          outgoing: false, incoming: false, enemy: true
        }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined
    };
    const pool = { connect: async () => client } as unknown as pg.Pool;
    const result = await new ProfileSocialService(pool).mutate("viewer", "target", "mark_enemy");
    expect(result.relationship.enemyMarkedByViewer).toBe(true);
    expect(queries.some((query) => query.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(queries.some((query) => query.startsWith("DELETE FROM friendships"))).toBe(true);
    expect(queries.some((query) => query.startsWith("INSERT INTO player_enemy_marks"))).toBe(true);
    expect(queries.some((query) => query.includes("'enemy_declaration'"))).toBe(true);
    expect(queries.at(-1)).toBe("COMMIT");
  });

  it("returns current actor names with an authoritative pending-request count", async () => {
    const pool = {
      query: async (sql: string) => sql.includes("count(*)")
        ? { rows: [{ count: "2" }], rowCount: 1 }
        : {
            rows: [{
              id: "00000000-0000-4000-8000-000000000001",
              entry_kind: "friend_request",
              actor_player_id: "actor",
              actor_display_name: "Current Name",
              status: "pending",
              created_at: new Date(0),
              updated_at: new Date(1)
            }],
            rowCount: 1
          }
    } as unknown as pg.Pool;
    await expect(new ProfileSocialService(pool).inbox("recipient")).resolves.toEqual({
      pendingIncomingFriendRequestCount: 2,
      entries: [{
        id: "00000000-0000-4000-8000-000000000001",
        kind: "friend_request",
        actorPlayerId: "actor",
        actorDisplayName: "Current Name",
        state: "pending",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(1).toISOString()
      }]
    });
  });

  it("rejects self mutations before opening a transaction", async () => {
    const pool = { connect: async () => { throw new Error("must not connect"); } } as unknown as pg.Pool;
    await expect(new ProfileSocialService(pool).mutate("same", "same", "block")).rejects.toMatchObject({
      code: "SELF_TARGET_NOT_ALLOWED"
    });
  });

  it("bulk-filters either-direction blocks while preserving the bounded candidate order", async () => {
    const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
    const pool = {
      query: async (sql: string, values: readonly unknown[]) => {
        queries.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
        return {
          rows: [
            { blocker_id: "viewer", blocked_id: "blocked-by-viewer" },
            { blocker_id: "blocked-viewer", blocked_id: "viewer" }
          ],
          rowCount: 2
        };
      }
    } as unknown as pg.Pool;
    const service = new ProfileSocialService(pool);

    await expect(service.filterDirectlyInteractable("viewer", [
      "viewer", "allowed", "blocked-by-viewer", "blocked-viewer", "allowed"
    ])).resolves.toEqual(["viewer", "allowed"]);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain("blocked_id = ANY($2::text[])");
    expect(queries[0]?.sql).toContain("blocker_id = ANY($2::text[])");
    expect(queries[0]?.values).toEqual([
      "viewer",
      ["allowed", "blocked-by-viewer", "blocked-viewer"]
    ]);
  });
});
