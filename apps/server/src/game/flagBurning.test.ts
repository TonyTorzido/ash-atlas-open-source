import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FLAG_BURN_INTERACTION_RADIUS_M,
  FLAG_HARDENED_BURN_DURATION_MS,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";

import { FlagBurnCoordinator } from "./flagBurning.js";
import type { InventoryService } from "./inventory.js";

describe("FlagBurnCoordinator", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("crafts the Torch output from the canonical recipe and preserves replay state", async () => {
    const client = transactionClient();
    const inventory = inventoryMock();
    const coordinator = coordinatorFor({ client, inventory });

    const first = await coordinator.craftTorches("burner-1", "request-1");
    expect(first).toEqual({ replayed: false, inventory: inventorySnapshot() });
    expect(inventory.debitItemsForOperationInTransaction).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        operationKey: "torch-craft:burner-1:request-1:materials",
        debits: [
          { itemId: "coal", quantity: 10, variant: "default" },
          { itemId: "crude_oil", quantity: 100, variant: "default" }
        ]
      })
    );
    expect(inventory.grantItemsForOperationInTransaction).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        operationKey: "torch-craft:burner-1:request-1:output",
        grants: [{ itemId: "torch", quantity: 25, variant: "default" }]
      })
    );

    inventory.debitItemsForOperationInTransaction.mockResolvedValueOnce({
      applied: false,
      inventory: inventorySnapshot()
    } as never);
    inventory.grantItemsForOperationInTransaction.mockResolvedValueOnce({
      applied: false,
      inventory: inventorySnapshot()
    } as never);
    const replay = await coordinator.craftTorches("burner-1", "request-1");
    expect(replay.replayed).toBe(true);
  });

  it("rejects buoys, bastion flags, and owned flags before reserving a burn operation", async () => {
    const client = transactionClient();
    const inventory = inventoryMock();
    const flags = {
      databasePool: { connect: vi.fn(async () => client) },
      getFlag: vi.fn(async () => ({
        id: "flag-1",
        ownerId: "victim-1",
        controlType: "personal",
        anchorKind: "buoy",
        systemControlled: false,
        reinforcementLevel: 0,
        cityId: null,
        kingdomId: null,
        upgradeTier: "base",
        health: 50,
        maximumHealth: 200,
        lat: 40,
        lon: -105
      })),
      deleteFlagForBurnInTransaction: vi.fn()
    };
    const coordinator = coordinatorFor({ client, inventory, flags });

    await expect(coordinator.start(
      "burner-1",
      "flag-1",
      "request-1",
      { position: { lat: 40, lon: -105 }, target: null, online: true }
    )).rejects.toMatchObject({ code: "FLAG_BURN_TARGET_INVALID" });
    expect(flags.databasePool.connect).not.toHaveBeenCalled();
  });

  it("enforces the shared 50m burn boundary before reserving", async () => {
    const client = transactionClient();
    const inventory = inventoryMock();
    const flags = {
      databasePool: { connect: vi.fn(async () => client) },
      getFlag: vi.fn(async () => ({
        id: "flag-1",
        ownerId: "victim-1",
        controlType: "personal",
        anchorKind: "flag",
        systemControlled: false,
        reinforcementLevel: 0,
        cityId: null,
        kingdomId: null,
        upgradeTier: "base",
        health: 50,
        maximumHealth: 220,
        lat: 40,
        lon: -105
      })),
      deleteFlagForBurnInTransaction: vi.fn()
    };
    const coordinator = coordinatorFor({ client, inventory, flags });

    await expect(coordinator.start(
      "burner-1",
      "flag-1",
      "request-1",
      {
        position: { lat: 40 + (FLAG_BURN_INTERACTION_RADIUS_M + 1) / 111_195, lon: -105 },
        target: null,
        online: true
      }
    )).rejects.toThrow(`within ${FLAG_BURN_INTERACTION_RADIUS_M}m`);
    expect(flags.databasePool.connect).not.toHaveBeenCalled();
  });

  it("recognizes the default Torch output when a burn starts", async () => {
    const operationRow = {
      operation_id: "operation-1",
      burner_player_id: "burner-1",
      victim_player_id: "victim-1",
      flag_id: "flag-1",
      request_id: "request-1",
      flag_name: "North Watch",
      flag_lat: 40,
      flag_lon: -105,
      notice_message: "Burn notice",
      started_at: new Date(0),
      completes_at: new Date(25_000),
      status: "active" as const,
      reinforcement_level: 0,
      burn_duration_ms: 25_000
    };
    const targetRow = {
      flag_id: "flag-1",
      victim_player_id: "victim-1",
      flag_name: "North Watch",
      flag_lat: 40,
      flag_lon: -105,
      control_type: "personal",
      anchor_kind: "flag",
      system_controlled: false,
      reinforcement_level: 0,
      health: 50,
      maximum_health: 220,
      burning_reason: null,
      city_id: null,
      kingdom_id: null,
      city_name: null,
      city_lat: null,
      city_lon: null,
      victim_username: "Victim"
    };
    const client = transactionClient((sql) => {
      const query = sql.trim();
      if (query.startsWith("SELECT operation_id")) return { rows: [], rowCount: 0 };
      if (query.startsWith("SELECT f.id::text")) return { rows: [targetRow], rowCount: 1 };
      if (query.startsWith("SELECT 1 FROM legendary_bird_events")) return { rows: [], rowCount: 0 };
      if (query.startsWith("SELECT COALESCE(sum(quantity),0)::text")) {
        return { rows: [{ quantity: "25" }], rowCount: 1 };
      }
      if (query.startsWith("INSERT INTO flag_burn_operations")) {
        return { rows: [operationRow], rowCount: 1 };
      }
      return undefined;
    });
    const inventory = inventoryMock();
    const flags = {
      databasePool: { connect: vi.fn(async () => client) },
      getFlag: vi.fn(async () => ({
        id: "flag-1",
        ownerId: "victim-1",
        controlType: "personal",
        anchorKind: "flag",
        systemControlled: false,
        reinforcementLevel: 0,
        cityId: null,
        kingdomId: null,
        upgradeTier: "base",
        health: 50,
        maximumHealth: 220,
        lat: 40,
        lon: -105
      })),
      deleteFlagForBurnInTransaction: vi.fn()
    };
    const coordinator = coordinatorFor({ client, inventory, flags, now: () => 0 });

    const outcome = await coordinator.start(
      "burner-1",
      "flag-1",
      "request-1",
      { position: { lat: 40, lon: -105 }, target: null, online: true }
    );

    expect(outcome.status).toBe("active");
    expect(inventory.lockPlayerInventoryForOperationInTransaction).toHaveBeenCalledWith(client, "burner-1");
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("resource_type='torch' AND variant='default'"),
      ["burner-1"]
    );
    expect(inventory.debitItemsForOperationInTransaction).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        operationKey: "flag-burn:operation-1:torch",
        debits: [{ itemId: "torch", quantity: 1, variant: "default" }]
      })
    );
    coordinator.cancelPlayer("burner-1", "test");
  });

  it("does not check or debit a Torch during completion", async () => {
    const completesAt = new Date(25_000).toISOString();
    const row = {
      operation_id: "operation-1",
      burner_player_id: "burner-1",
      victim_player_id: "victim-1",
      flag_id: "flag-1",
      request_id: "request-1",
      flag_name: "North Watch",
      flag_lat: 40,
      flag_lon: -105,
      notice_message: "Burn notice",
      started_at: new Date(0).toISOString(),
      completes_at: completesAt,
      status: "active" as const,
      reinforcement_level: 0,
      burn_duration_ms: 25_000,
      result: null
    };
    const client = transactionClient((sql) => {
      const query = sql.trim();
      if (query.startsWith("SELECT operation_id")) return { rows: [row], rowCount: 1 };
      if (query.startsWith("SELECT clock_timestamp()")) return { rows: [{ due: true }], rowCount: 1 };
      return undefined;
    });
    const inventory = inventoryMock();
    const flags = {
      databasePool: { connect: vi.fn(async () => client) },
      getFlag: vi.fn(),
      deleteFlagForBurnInTransaction: vi.fn(async () => ({
        flagId: "flag-1",
        deleted: true
      }))
    };
    const coordinator = coordinatorFor({ client, inventory, flags, now: () => 26_000 });
    const session = {
      operationId: "operation-1",
      playerId: "burner-1",
      victimPlayerId: "victim-1",
      flagId: "flag-1",
      requestId: "request-1",
      flagName: "North Watch",
      position: { lat: 40, lon: -105 },
      startedAt: 0,
      completesAt: 25_000,
      durationMs: 25_000,
      noticeMessage: "Burn notice"
    };
    const complete = (coordinator as unknown as {
      completeInTransaction(value: typeof session): Promise<unknown>;
    }).completeInTransaction.bind(coordinator);

    await complete(session);

    expect(flags.deleteFlagForBurnInTransaction).toHaveBeenCalledOnce();
    expect(inventory.debitItemsForOperationInTransaction).not.toHaveBeenCalled();
  });

  it("persists a hardened burn schedule across disconnects", async () => {
    const operationRow = {
      operation_id: "operation-hardened",
      burner_player_id: "burner-1",
      victim_player_id: "victim-1",
      flag_id: "flag-1",
      request_id: "request-hardened",
      flag_name: "North Watch",
      flag_lat: 40,
      flag_lon: -105,
      notice_message: "Burn notice",
      started_at: new Date(0),
      completes_at: new Date(FLAG_HARDENED_BURN_DURATION_MS),
      status: "active" as const,
      reinforcement_level: 1,
      burn_duration_ms: FLAG_HARDENED_BURN_DURATION_MS
    };
    const targetRow = {
      flag_id: "flag-1",
      victim_player_id: "victim-1",
      flag_name: "North Watch",
      flag_lat: 40,
      flag_lon: -105,
      control_type: "personal",
      anchor_kind: "flag",
      system_controlled: false,
      reinforcement_level: 1,
      health: 110,
      maximum_health: 220,
      burning_reason: null,
      city_id: null,
      kingdom_id: null,
      city_name: null,
      city_lat: null,
      city_lon: null,
      victim_username: "Victim"
    };
    const client = transactionClient((sql) => {
      const query = sql.trim();
      if (query.startsWith("SELECT operation_id")) return { rows: [], rowCount: 0 };
      if (query.startsWith("SELECT f.id::text")) return { rows: [targetRow], rowCount: 1 };
      if (query.startsWith("SELECT 1 FROM legendary_bird_events")) return { rows: [], rowCount: 0 };
      if (query.startsWith("SELECT COALESCE(sum(quantity),0)::text")) {
        return { rows: [{ quantity: "1" }], rowCount: 1 };
      }
      if (query.startsWith("INSERT INTO flag_burn_operations")) {
        return { rows: [operationRow], rowCount: 1 };
      }
      return undefined;
    });
    const inventory = inventoryMock();
    const flags = {
      databasePool: { connect: vi.fn(async () => client) },
      getFlag: vi.fn(async () => ({
        id: "flag-1",
        ownerId: "victim-1",
        controlType: "personal",
        anchorKind: "flag",
        systemControlled: false,
        reinforcementLevel: 1,
        cityId: null,
        kingdomId: null,
        upgradeTier: "stone",
        health: 110,
        maximumHealth: 220,
        lat: 40,
        lon: -105
      })),
      deleteFlagForBurnInTransaction: vi.fn()
    };
    const coordinator = coordinatorFor({ client, inventory, flags, now: () => 0 });
    const outcome = await coordinator.start(
      "burner-1",
      "flag-1",
      "request-hardened",
      { position: { lat: 40, lon: -105 }, target: null, online: true }
    );

    expect(outcome.session.durationMs).toBe(FLAG_HARDENED_BURN_DURATION_MS);
    coordinator.disconnectPlayer("burner-1");
    expect(coordinator.activeForPlayer("burner-1")).not.toBeNull();
    coordinator.cancelPlayer("burner-1", "test-cleanup");
  });
});

function coordinatorFor(input: Readonly<{
  client: ReturnType<typeof transactionClient>;
  inventory: ReturnType<typeof inventoryMock>;
  flags?: {
    databasePool: { connect(): Promise<ReturnType<typeof transactionClient>> };
    getFlag: (...args: never[]) => Promise<unknown>;
    deleteFlagForBurnInTransaction: (...args: never[]) => Promise<unknown>;
  };
  now?: () => number;
}>): FlagBurnCoordinator {
  const flags = input.flags ?? {
    databasePool: { connect: vi.fn(async () => input.client) },
    getFlag: vi.fn(async () => null),
    deleteFlagForBurnInTransaction: vi.fn(async () => ({ flagId: "flag-1", deleted: true }))
  };
  return new FlagBurnCoordinator(
    flags as never,
    input.inventory as unknown as InventoryService,
    { info: vi.fn(), warn: vi.fn() },
    {
      currentPlayer: vi.fn(() => ({
        position: { lat: 40, lon: -105 },
        target: null,
        online: true
      })),
      isPlayerAlive: vi.fn(() => true),
      sendStarted: vi.fn(),
      sendVictimNotice: vi.fn(),
      sendCancelled: vi.fn(),
      completed: vi.fn(),
      failed: vi.fn()
    },
    input.now
  );
}

function transactionClient(
  resolve?: (sql: string) => { rows: unknown[]; rowCount: number } | undefined
) {
  const client = {
    query: vi.fn(async (query: string) =>
      resolve?.(query) ?? { rows: [], rowCount: 0 }),
    release: vi.fn()
  };
  return client;
}

function inventorySnapshot(): PlayerInventorySnapshot {
  return {
    playerId: "burner-1",
    revision: 2,
    items: [],
    totals: {}
  } as unknown as PlayerInventorySnapshot;
}

function inventoryMock() {
  return {
    debitItemsForOperationInTransaction: vi.fn(async () => ({
      applied: true,
      inventory: inventorySnapshot()
    })),
    grantItemsForOperationInTransaction: vi.fn(async () => ({
      applied: true,
      inventory: inventorySnapshot()
    })),
    lockPlayerInventoryForOperationInTransaction: vi.fn(async () => undefined),
    snapshotInTransaction: vi.fn(async () => inventorySnapshot())
  };
}
