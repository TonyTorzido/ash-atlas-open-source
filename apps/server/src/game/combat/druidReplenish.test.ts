import type pg from "pg";
import type { PlayerLocationSnapshot } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { PlayerAuthorityFence } from "../playerAuthorityFence.js";
import type { CombatEngine, ReplenishPlan } from "./combatEngine.js";
import type { PlayerLocationService } from "../locations/playerLocationService.js";
import type { InventoryService } from "../inventory.js";
import { DruidReplenishService } from "./druidReplenish.js";

const input = {
  playerId: "caster", targetPlayerId: "target", accountId: "account",
  connectionId: "connection", requestId: "request"
};
const profile = (playerId: string, currentHealth: number) => ({
  playerId, maxHealth: 100, currentHealth, baseAttackDamage: 10,
  lifeState: "alive" as const, downedUntil: null, deathPenaltyOperationKey: null,
  respawnAvailableAt: null, persistenceVersion: 4
});
const plan: ReplenishPlan = {
  casterId: "caster", targetId: "target", casterBefore: 100, targetBefore: 50,
  casterAfter: 50, targetAfter: 100,
  casterProfile: profile("caster", 50), targetProfile: profile("target", 100)
};
const receipt = {
  casterId: "caster", targetId: "target", casterBefore: 100, targetBefore: 50,
  casterAfter: 50, targetAfter: 100, casterVersion: 5, targetVersion: 5
};
const inventorySnapshot = { playerId: "caster", items: [] };

function harness(options: { existingReceipt?: boolean; debitFails?: boolean; loseCommitResponse?: boolean } = {}) {
  let committed = options.existingReceipt ?? false;
  let connection = 0;
  const statements: string[] = [];
  const firstClient = {
    query: vi.fn(async (sql: string, _parameters?: unknown[]) => {
      statements.push(sql);
      if (sql.startsWith("SELECT player_id, persistence_version")) return {
        rows: [{ player_id: "caster", persistence_version: "3" },
          { player_id: "target", persistence_version: "3" }]
      };
      if (sql.startsWith("SELECT metadata")) return { rows: [] };
      if (sql.startsWith("COMMIT")) {
        committed = true;
        if (options.loseCommitResponse) throw new Error("connection lost during COMMIT");
      }
      return { rowCount: 1, rows: [] };
    }),
    release: vi.fn()
  };
  const recoveryClient = {
    query: vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.startsWith("SELECT metadata")) return {
        rows: committed ? [{ metadata: { replenishReceipt: receipt } }] : []
      };
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn()
  };
  const pool = {
    query: vi.fn(async (sql: string) => {
      statements.push(sql);
      return { rows: committed ? [{ metadata: { replenishReceipt: receipt } }] : [] };
    }),
    connect: vi.fn(async () => ++connection === 1 ? firstClient : recoveryClient)
  };
  const inventory = {
    debitItemsForOperationInTransaction: vi.fn(async () => {
      if (options.debitFails) throw new Error("Inventory does not contain enough items");
      return { applied: true, inventory: inventorySnapshot };
    }),
    snapshotInTransaction: vi.fn(async () => inventorySnapshot)
  };
  const combat = {
    validateReplenishAuthority: vi.fn(),
    reserveReplenish: vi.fn(() => plan),
    completeReplenish: vi.fn()
  };
  const locations = { load: vi.fn(async (): Promise<PlayerLocationSnapshot> => ({ kind: "world" } as PlayerLocationSnapshot)) };
  const service = new DruidReplenishService(
    pool as unknown as pg.Pool,
    inventory as unknown as InventoryService,
    combat as unknown as CombatEngine,
    new PlayerAuthorityFence(),
    locations as unknown as PlayerLocationService
  );
  return { service, pool, inventory, combat, locations, firstClient, recoveryClient, statements };
}

describe("Druid Replenish durable commit", () => {
  it("rolls back an insufficient-berry debit without installing HP", async () => {
    const test = harness({ debitFails: true });
    await expect(test.service.use(input)).rejects.toThrow("Inventory does not contain enough items");
    expect(test.statements).toContain("ROLLBACK");
    expect(test.statements).not.toContain("COMMIT");
    expect(test.statements.some((statement) => statement.startsWith("UPDATE player_combat_profiles"))).toBe(false);
    expect(test.combat.completeReplenish).toHaveBeenCalledWith(plan, undefined);
  });

  it("returns a durable duplicate receipt without reserving, debiting, or applying HP again", async () => {
    const test = harness({ existingReceipt: true });
    const result = await test.service.use(input);
    expect(result).toMatchObject({ replayed: true, receipt });
    expect(test.combat.reserveReplenish).not.toHaveBeenCalled();
    expect(test.inventory.debitItemsForOperationInTransaction).not.toHaveBeenCalled();
    expect(test.combat.completeReplenish).not.toHaveBeenCalled();
  });

  it("rejects an invalid target before any debit or profile write", async () => {
    const test = harness();
    test.combat.reserveReplenish.mockImplementationOnce(() => { throw new Error("Target is not a nearby party member"); });
    await expect(test.service.use(input)).rejects.toThrow("Target is not a nearby party member");
    expect(test.pool.connect).not.toHaveBeenCalled();
    expect(test.inventory.debitItemsForOperationInTransaction).not.toHaveBeenCalled();
    expect(test.combat.completeReplenish).not.toHaveBeenCalled();
  });

  it("requires one combat-capable canonical interior instance and space", async () => {
    const test = harness();
    const interior = (instanceId: string, spaceId: string) => ({
      kind: "interior" as const, locationType: "dungeon" as const, instanceId, spaceId,
      locationId: "test-dungeon", regionCode: `interior:${instanceId}`,
      zoneId: `interior:${instanceId}:${spaceId}`, position: { x: 1, y: 1 },
      revision: 1, lastPortalId: "test-portal"
    });
    test.locations.load.mockResolvedValueOnce(interior("one", "room"))
      .mockResolvedValueOnce(interior("two", "room"));
    await expect(test.service.use(input)).rejects.toMatchObject({ code: "ABILITY_LOCATION_INVALID" });
    expect(test.inventory.debitItemsForOperationInTransaction).not.toHaveBeenCalled();
    expect(test.combat.reserveReplenish).not.toHaveBeenCalled();
  });

  it("writes both profiles above the pending version in the same transaction as five berries", async () => {
    const test = harness();
    const result = await test.service.use(input);
    expect(result).toMatchObject({ replayed: false, receipt });
    expect(test.inventory.debitItemsForOperationInTransaction).toHaveBeenCalledWith(
      test.firstClient,
      expect.objectContaining({ debits: [{ itemId: "giving_berry", variant: null, quantity: 5 }] })
    );
    const profileWrites = test.firstClient.query.mock.calls.filter(([sql]) =>
      sql.startsWith("UPDATE player_combat_profiles"));
    expect(profileWrites).toHaveLength(2);
    expect(profileWrites.map(([, parameters]) => parameters?.[4])).toEqual([5, 5]);
    expect(test.statements.indexOf("COMMIT")).toBeGreaterThan(
      test.statements.findIndex((statement) => statement.startsWith("UPDATE inventory_operations"))
    );
  });

  it("resolves a lost COMMIT response under profile row locks before installing HP", async () => {
    const test = harness({ loseCommitResponse: true });
    const result = await test.service.use(input);
    expect(result).toMatchObject({ replayed: false, receipt });
    expect(test.firstClient.release).toHaveBeenCalledWith(true);
    expect(test.recoveryClient.query).toHaveBeenCalledWith(
      expect.stringContaining("FOR UPDATE"), [["caster", "target"]]
    );
    expect(test.combat.completeReplenish).toHaveBeenCalledWith(plan, { caster: 5, target: 5 });
    expect(test.inventory.debitItemsForOperationInTransaction).toHaveBeenCalledTimes(1);
  });
});
