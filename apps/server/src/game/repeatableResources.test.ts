import {
  DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
  DEFAULT_MOVE_LEASH_RADIUS_M,
  DEFAULT_MOVE_LEASH_TO_VISION_GAP_M,
  STONE_MINE_YIELD_QUANTITY
} from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import {
  repeatableCompletionFailureDisposition,
  RepeatableResourceService,
  STONE_MINE_DURATION_MS,
  STONE_MINE_REGENERATION_MS,
  effectiveMiningDurationMs
} from "./repeatableResources.js";

describe("repeatable mining completion convergence", () => {
  it.each([
    ["HARVEST_TOO_EARLY", "retryable"],
    ["HARVEST_NODE_CHANGED", "terminal-cancelled"],
    ["HARVEST_NODE_NOT_FOUND", "terminal-cancelled"],
    ["HARVEST_NODE_NOT_VISIBLE", "terminal-cancelled"],
    ["HARVEST_NODE_OUT_OF_RANGE", "terminal-cancelled"],
    ["HARVEST_NODE_DEPLETED", "terminal-cancelled"],
    ["HARVEST_CANCELLED", "terminal-cancelled"],
    ["HARVEST_EXPIRED", "terminal-expired"],
    ["HARVEST_PLAYER_UNAVAILABLE", "terminal-cancelled"],
    ["HARVEST_RESOURCE_VISION_REQUIRED", "terminal-cancelled"],
    ["HARVEST_INTERNAL_FAILURE", "internal"]
  ] as const)("classifies %s as %s", (code, expected) => {
    expect(repeatableCompletionFailureDisposition(code)).toBe(expected);
  });

  it("fences terminal cleanup by session, player, and active status", async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    const session = cleanupSession("active");
    const client = {
      query: async <T>(text: string, values?: readonly unknown[]) => {
        calls.push({ text, ...(values === undefined ? {} : { values }) });
        if (text === "BEGIN" || text === "COMMIT") {
          return { rows: [] as T[], rowCount: 0 };
        }
        if (text.includes("FROM repeatable_resource_sessions")) {
          return { rows: [{ ...session } as T], rowCount: 1 };
        }
        if (text.includes("UPDATE repeatable_resource_sessions")) {
          session.status = "cancelled";
          return { rows: [{ ...session } as T], rowCount: 1 };
        }
        throw new Error(`Unexpected query: ${text}`);
      },
      release: () => undefined
    };
    const service = new RepeatableResourceService({
      connect: async () => client
    } as never);

    await expect(service.terminateActiveSessionAfterTerminalFailure(
      "player",
      session.id,
      "HARVEST_NODE_CHANGED"
    )).resolves.toMatchObject({
      statusBefore: "active",
      statusAfter: "cancelled",
      outcome: "cancelled"
    });

    const update = calls.find((call) =>
      call.text.includes("UPDATE repeatable_resource_sessions")
    );
    expect(update?.text).toContain("WHERE id::text = $1");
    expect(update?.text).toContain("AND player_id = $2");
    expect(update?.text).toContain("AND status = 'active'");
    expect(update?.values).toEqual([session.id, "player", "cancelled"]);
  });

  it.each(["completed", "cancelled", "expired"] as const)(
    "never overwrites an already-%s session",
    async (status) => {
      const session = cleanupSession(status);
      const update = vi.fn();
      const client = {
        query: async <T>(text: string) => {
          if (text === "BEGIN" || text === "COMMIT") {
            return { rows: [] as T[], rowCount: 0 };
          }
          if (text.includes("FROM repeatable_resource_sessions")) {
            return { rows: [{ ...session } as T], rowCount: 1 };
          }
          update();
          return { rows: [] as T[], rowCount: 0 };
        },
        release: () => undefined
      };
      const service = new RepeatableResourceService({
        connect: async () => client
      } as never);

      await expect(service.terminateActiveSessionAfterTerminalFailure(
        "player",
        session.id,
        "HARVEST_NODE_DEPLETED"
      )).resolves.toMatchObject({
        statusBefore: status,
        statusAfter: status,
        outcome: status === "completed" ? "completed" : "already-terminal"
      });
      expect(update).not.toHaveBeenCalled();
    }
  );
});

describe("authoritative mining duration", () => {
  it("derives mastery speed tiers from the thirty-second base", () => {
    expect(STONE_MINE_DURATION_MS).toBe(30_000);
    expect(effectiveMiningDurationMs(0, false)).toBe(30_000);
    expect(effectiveMiningDurationMs(2, false)).toBe(29_100);
    expect(effectiveMiningDurationMs(6, false)).toBe(28_200);
    expect(effectiveMiningDurationMs(8, false)).toBe(27_600);
    expect(effectiveMiningDurationMs(8, true)).toBe(0);
  });

  it("rejects ranks outside the authoritative mastery domain", () => {
    expect(() => effectiveMiningDurationMs(-1, false)).toThrow(/between 0 and 8/);
    expect(() => effectiveMiningDurationMs(9, false)).toThrow(/between 0 and 8/);
    expect(() => effectiveMiningDurationMs(1.5, false)).toThrow(/between 0 and 8/);
  });
});

describe("population-v2 stone projection authority", () => {
  it("delegates Resource Vision presentation to permanent-resource authority", async () => {
    const listInVision = vi.fn(async () => []);
    const service = new RepeatableResourceService(
      {} as never,
      undefined,
      undefined,
      undefined,
      { listInVision } as never
    );

    await service.listInVision("test", vision());

    expect(listInVision).toHaveBeenCalledWith(vision(), undefined);
  });

  it.each([
    { unbrokenVein: false, expectedState: "depleted", bonusAvailable: false },
    { unbrokenVein: true, expectedState: "ready", bonusAvailable: true }
  ] as const)(
    "CASes canonical state and preserves unbroken-vein=$unbrokenVein",
    async ({ unbrokenVein, expectedState, bonusAvailable }) => {
      const entityId = "00000000-0000-8000-8000-000000000456";
      const sessionId = "00000000-0000-4000-8000-000000000789";
      const now = new Date("2026-07-19T12:00:00.000Z");
      const calls: Array<{
        text: string;
        values: readonly unknown[] | undefined;
      }> = [];
      const node = {
        id: entityId,
        node_type: "stone_mine" as const,
        region_code: "adjacent-anchor-package",
        lat: 35,
        lon: -106,
        yield_item_id: "stone" as const,
        yield_quantity: STONE_MINE_YIELD_QUANTITY,
        harvest_revision: 4,
        ready_at: new Date(0),
        public_state: "ready" as "ready" | "depleted",
        bonus_extraction_available: false,
        bonus_extraction_revision: null as number | null,
        population_v2_entity_id: entityId,
        physical_population_zone_v2_id: "ppz2-eag1/000/000",
        population_v2_plan_id: "00000000-0000-4000-8000-000000000321",
        population_cutover_revision: 1,
        population_v2_suppressed: false,
        population_v2_state_revision: 4
      };
      const session = {
        id: sessionId,
        player_id: "player",
        node_id: entityId,
        resource_type: "stone" as const,
        operation_key: `repeatable-harvest:${sessionId}`,
        starting_revision: 4,
        status: "active" as "active" | "completed",
        effective_duration_ms: 10_000,
        started_at: new Date(now.getTime() - 20_000),
        completes_at: new Date(now.getTime() - 10_000),
        expires_at: new Date(now.getTime() + 60_000),
        completed_at: null,
        cancelled_at: null,
        database_now: now,
        mastery_results: {
          bonusYield: false,
          instant: false,
          unbrokenVein,
          bonusExtraction: false
        }
      };
      const query = async <T>(text: string, values?: readonly unknown[]) => {
        calls.push({ text, values });
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
          return { rows: [] as T[], rowCount: 0 };
        }
        if (
          text.includes("FROM repeatable_resource_sessions")
          && text.includes("WHERE id::text = $1 FOR UPDATE")
        ) {
          return { rows: [{ ...session } as T], rowCount: 1 };
        }
        if (
          text.includes("FROM repeatable_resource_nodes")
          && text.includes("FOR UPDATE")
        ) {
          return { rows: [{ ...node } as T], rowCount: 1 };
        }
        if (
          text.trimStart().startsWith("SELECT")
          && text.includes("FROM population_entity_state_v2")
        ) {
          return {
            rows: [{
              entity_id: entityId,
              state: "ready",
              state_revision: 4,
              state_actor_player_id: null,
              killed_or_harvested_at: null,
              respawn_at: null,
              selected_plan_fenced: true
            } as T],
            rowCount: 1
          };
        }
        if (text.includes("UPDATE population_entity_state_v2 AS state")) {
          expect(values?.slice(0, 4)).toEqual([
            entityId,
            4,
            "player",
            unbrokenVein
          ]);
          node.harvest_revision = 5;
          node.population_v2_state_revision = 5;
          node.public_state = unbrokenVein ? "ready" : "depleted";
          node.ready_at = unbrokenVein
            ? new Date(0)
            : new Date(now.getTime() + STONE_MINE_REGENERATION_MS);
          return { rows: [{ state_revision: 5 } as T], rowCount: 1 };
        }
        if (text.includes("UPDATE repeatable_resource_nodes")) {
          node.bonus_extraction_available = Boolean(values?.[1]);
          node.bonus_extraction_revision = node.bonus_extraction_available ? 5 : null;
          return { rows: [{ ...node } as T], rowCount: 1 };
        }
        if (text.includes("INSERT INTO repeatable_resource_harvests")) {
          return { rows: [] as T[], rowCount: 1 };
        }
        if (text.includes("UPDATE repeatable_resource_sessions")) {
          session.status = "completed";
          return { rows: [{ ...session } as T], rowCount: 1 };
        }
        throw new Error(`Unexpected repeatable-resource query: ${text}`);
      };
      const client = { query, release: () => undefined };
      const inventory = {
        snapshotInTransaction: async () => ({
          playerId: "player",
          revision: 2,
          items: [],
          totals: {
            wood: 0,
            stone: 0,
            food: 0,
            ore: 0,
            water: 0,
            leather: 0,
            giving_berry: 0,
            balsam_resin: 0,
            crystal: 0, pearl: 0, atlas_shrine_shard: 0,
            enchantment_stone: 0
          }
        }),
        grantItemsForOperationInTransaction: async () => ({
          applied: true,
          grants: [{ itemId: "stone", variant: null, remainderQuantity: 0 }],
          inventory: {
            playerId: "player",
            revision: 3,
            items: [],
            totals: {
              wood: 0,
              stone: STONE_MINE_YIELD_QUANTITY,
              food: 0,
              ore: 0,
              water: 0,
              leather: 0,
              giving_berry: 0,
              balsam_resin: 0,
              crystal: 0, pearl: 0, atlas_shrine_shard: 0,
              enchantment_stone: 0
            }
          }
        })
      };
      const service = new RepeatableResourceService(
        { connect: async () => client } as never,
        inventory as never,
        undefined,
        undefined,
        {
          lockAndConvergeNode: async () => ({
            row: { ...node },
            canonical: {
              entity_id: entityId,
              state: "ready",
              state_revision: 4,
              state_actor_player_id: null,
              killed_or_harvested_at: null,
              respawn_at: null,
              database_now: now,
              selected_plan_fenced: true,
              definition_fenced: true
            },
            promoted: false,
            projectionRepaired: false
          }),
          nodeForPlayer: async () => ({
            id: entityId,
            nodeType: "stone_mine",
            lat: 35,
            lon: -106,
            yieldItemId: "stone",
            yieldQuantity: 1,
            state: node.public_state,
            authorityRevision:
              Number(node.population_v2_state_revision) * 2
              + (node.public_state === "ready" ? 1 : 0),
            readyAt: node.public_state === "depleted"
              ? new Date(node.ready_at).toISOString()
              : null,
            timerVisibility: "visible"
          })
        } as never
      );

      const result = await service.completeMining(
        {
          playerId: "player",
          regionCode: "physical-package-after-walking",
          position: { lat: 35, lon: -106 }
        },
        sessionId,
        vision()
      );

      expect(result.node).toMatchObject({
        id: entityId,
        state: expectedState
      });
      expect(node.bonus_extraction_available).toBe(bonusAvailable);
      expect(calls.some((call) =>
        call.text.includes("UPDATE population_entity_state_v2 AS state")
      )).toBe(true);
      expect(calls.filter((call) =>
        call.text.includes("UPDATE population_entity_state_v2 AS state")
        || call.text.includes("UPDATE repeatable_resource_nodes")
      ).every((call) =>
        /population_v2_entity_id\s+(?:IS NOT NULL|=)/u.test(call.text)
        && /NOT (?:projection\.)?population_v2_suppressed/u.test(call.text)
      ))
        .toBe(true);
      expect(calls.some((call) =>
        call.text.includes("SET ready_at = CASE")
      )).toBe(false);
    }
  );
});

function vision() {
  return {
    flagId: "flag",
    flagName: "Flag",
    center: { lat: 35, lon: -106 },
    movementLeashRadiusM: DEFAULT_MOVE_LEASH_RADIUS_M,
    paddingM: DEFAULT_MOVE_LEASH_TO_VISION_GAP_M,
    radiusM: DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M
  };
}

function cleanupSession(
  status: "active" | "completed" | "cancelled" | "expired"
) {
  return {
    id: "00000000-0000-4000-8000-000000000789",
    player_id: "player",
    node_id: "00000000-0000-8000-8000-000000000456",
    resource_type: "stone" as const,
    operation_key:
      "repeatable-harvest:00000000-0000-4000-8000-000000000789",
    starting_revision: 4,
    status,
    effective_duration_ms: 10_000,
    started_at: new Date("2026-07-28T00:00:00.000Z"),
    completes_at: new Date("2026-07-28T00:00:10.000Z"),
    expires_at: new Date("2026-07-28T00:05:10.000Z"),
    completed_at:
      status === "completed"
        ? new Date("2026-07-28T00:00:10.000Z")
        : null,
    cancelled_at:
      status === "cancelled"
        ? new Date("2026-07-28T00:00:10.000Z")
        : null,
    mastery_results: {}
  };
}
