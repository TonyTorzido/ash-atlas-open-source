import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { loadConfig, type AppConfig } from "../config.js";
import {
  CollectibleService,
  COLLECTIBLE_VISIBILITY_RADIUS_M,
  FLAG_VISIT_VISIBLE_PREPARATION_RADIUS_M,
  PICKUP_RADIUS_M,
  MOVE_LEASH_TO_VISION_GAP_M,
  RESOURCE_PREPARATION_RADIUS_M,
  MAX_VISIBLE_COLLECTIBLE_NODES,
  classifyCollectibleWater,
  resourceVisionForFlag,
  type CollectiblePlayer
} from "../game/collectibles.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import type { WorldLookupResult } from "../world/worldTypes.js";

const PLAYER: CollectiblePlayer = {
  playerId: "player-1",
  regionCode: "NM",
  position: {
    lat: 35.0844,
    lon: -106.6504
  }
};
const TEST_FLAG_ID = "11111111-1111-4111-8111-111111111111";
const TEST_MOVEMENT_LEASH_RADIUS_M = 600;

describe("water collection classification", () => {
  it("accepts obvious freshwater from major lakes and nearby major rivers", () => {
    expect(
      classifyCollectibleWater(
        worldLookupFor({
          insideMajorLake: true
        })
      )
    ).toBe("fresh");
    expect(
      classifyCollectibleWater(
        worldLookupFor({
          nearMajorRiver: true,
          majorRiverDistanceM: 35
        })
      )
    ).toBe("fresh");
  });

  it("accepts saltwater and rejects dry land", () => {
    expect(
      classifyCollectibleWater(
        worldLookupFor({
          isLand: false,
          isSaltwater: true
        })
      )
    ).toBe("salt");
    expect(classifyCollectibleWater(worldLookupFor({}))).toBeNull();
  });
});

describe("anchor-authoritative collectible projection", () => {
  it("queries the full vision circle without filtering to one package", async () => {
    const query = vi.fn(async (
      text: string,
      values?: readonly unknown[]
    ) => {
      void text;
      void values;
      return { rows: [], rowCount: 0 };
    });
    const service = new CollectibleService(
      { query } as unknown as pg.Pool,
      worldLookupClient(worldLookupFor({})),
      createConfig(),
      loggerStub()
    );
    const vision = visionForFlag(PLAYER.position);

    await service.listAvailableInVision("anchor-package", vision);

    expect(query).toHaveBeenCalledOnce();
    const [sql, values] = query.mock.calls[0]!;
    expect(sql).not.toMatch(/region_code\s*=/i);
    expect(sql).toContain("ST_DWithin");
    expect(sql).toContain("FROM population_spawn_slots_v2 AS authority_slot");
    expect(sql).toContain("JOIN population_zone_generations_v2 AS authority_generation");
    expect(sql).toContain("authority_generation.is_current");
    expect(sql).toContain("authority_generation.status='active'");
    expect(sql).toContain("authority_generation.expires_at > statement_timestamp()");
    expect(sql).toContain("authority_cutover.selected_plan_id=authority_plan.plan_id");
    expect(sql).toContain("authority_cutover.serving_version='v2'");
    expect(sql).toContain("authority_cutover.status='stable'");
    expect(sql).toContain(
      "authority_state.state_revision=tree.population_v2_state_revision"
    );
    expect(values).toEqual([
      vision.center.lat,
      vision.center.lon,
      vision.radiusM,
      MAX_VISIBLE_COLLECTIBLE_NODES
    ]);
  });
});

describe("CollectibleService water collection", () => {
  it("rejects new water collection before consulting World or inventory", async () => {
    const world = createWorldLookupClient(worldLookupFor({ insideMajorLake: true }));
    const service = new CollectibleService(
      createInventoryPool(),
      world.client,
      createConfig(),
      loggerStub()
    );

    await expect(service.collectWaterAt(PLAYER, {
        lat: PLAYER.position.lat,
        lon: PLAYER.position.lon
      }, "water-request-1"))
      .rejects.toThrow(/not currently available/);
    expect(world.lookupGameplayEnvironment).not.toHaveBeenCalled();
  });

  it("derives the validated default cadence from the canonical water interaction", () => {
    expect(createConfig().WATER_COLLECTION_CADENCE_MS).toBe(2_000);
    expect(() =>
      loadConfig({ NODE_ENV: "test", WATER_COLLECTION_CADENCE_MS: "0" })
    ).toThrow();
  });

});

describe("CollectibleService performance guards", () => {
  it("limits nearby node queries to the visible collectible cap", async () => {
    let queryText = "";
    let queryValues: readonly unknown[] = [];
    const pool = createPoolFromQueryHandler(async <T>(text: string, values?: readonly unknown[]) => {
      queryText = text;
      queryValues = values ?? [];
      return {
        rows: [] as T[],
        rowCount: 0
      };
    });
    const service = new CollectibleService(
      pool,
      worldLookupClient(worldLookupFor({})),
      createConfig(),
      loggerStub()
    );

    await service.listAvailableNear(PLAYER);

    expect(queryText).toContain("ORDER BY distance_m ASC, id ASC");
    expect(queryText).toContain("LIMIT $5");
    expect(queryValues[4]).toBe(MAX_VISIBLE_COLLECTIBLE_NODES);
  });
});

describe("CollectibleService Resource Vision preparation", () => {
  it("prepares water metadata without invoking a population generator", async () => {
    const queries: string[] = [];
    const pool = createPoolFromQueryHandler(async <T>(text: string, values?: readonly unknown[]) => {
      queries.push(text);
      if (text.includes("INSERT INTO flag_resource_visions")) {
        return {
          rows: [{
            flag_id: values?.[0],
            layout_version: values?.[1],
            status: values?.[2],
            radius_m: values?.[3],
            node_count: values?.[4],
            water_highlight_count: values?.[5],
            requested_at: new Date(),
            generated_at: new Date(),
            last_error: null,
            updated_at: new Date()
          } as T],
          rowCount: 1
        };
      }
      return { rows: [] as T[], rowCount: 0 };
    });
    const lookupResourceEnvironments = vi.fn(async () => []);
    const collectibleWaterSourcesNear = vi.fn(async () => []);
    const service = new CollectibleService(
      pool,
      {
        ...worldLookupClient(worldLookupFor({})),
        lookupResourceEnvironments,
        collectibleWaterSourcesNear
      } as unknown as WorldLookupClient,
      createConfig(),
      loggerStub()
    );
    const resourceVision = visionForFlag(PLAYER.position);

    const prepared = await service.prepareResourceVision({ resourceVision });
    const status = await service.commitResourceVision(prepared);

    expect(collectibleWaterSourcesNear).toHaveBeenCalledOnce();
    expect(lookupResourceEnvironments).not.toHaveBeenCalled();
    expect(queries.some((query) => query.includes("INSERT INTO spawn_cells"))).toBe(false);
    expect(queries.some((query) => query.includes("INSERT INTO collectible_nodes"))).toBe(false);
    expect(status).toMatchObject({ status: "ready", nodeCount: 0 });
  });
});

describe("CollectibleService pickup", () => {
  it("harvests a nearby available node and increments inventory", async () => {
    const pool = createPickupPool({
      node: nodeRow({
        id: "NM:cell:wood",
        resource_type: "wood",
        lat: PLAYER.position.lat,
        lon: PLAYER.position.lon,
        quantity: 2
      })
    });
    const service = new CollectibleService(
      pool,
      worldLookupClient(worldLookupFor({})),
      createConfig(),
      loggerStub()
    );

    const result = await service.pickupNode(PLAYER, "NM:cell:wood", visionForFlag(PLAYER.position));
    const replay = await service.pickupNode(
      PLAYER,
      "NM:cell:wood",
      visionForFlag(PLAYER.position)
    );

    expect(result.node.state).toBe("harvested");
    expect(result.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(result.inventory.totals.wood).toBe(4);
    expect(replay.inventory.totals.wood).toBe(4);
  });

  it("does not serve an unowned legacy collectible row", async () => {
    const pool = createPickupPool({
      node: nodeRow({
        id: "NM:cell:legacy-wood",
        resource_type: "wood",
        lat: PLAYER.position.lat,
        lon: PLAYER.position.lon,
        population_v2_entity_id: null,
        population_v2_state_revision: null
      })
    });
    const service = new CollectibleService(
      pool,
      worldLookupClient(worldLookupFor({})),
      createConfig(),
      loggerStub()
    );

    await expect(service.pickupNode(
      PLAYER,
      "NM:cell:legacy-wood",
      visionForFlag(PLAYER.position)
    )).rejects.toThrow(/does not exist/);
    expect((await service.inventoryForPlayer(PLAYER.playerId)).totals.wood).toBe(0);
  });

  it("does not double-grant concurrent pickup requests for one node", async () => {
    const pool = createPickupPool({
      node: nodeRow({
        id: "NM:cell:concurrent-wood",
        resource_type: "wood",
        quantity: 2
      })
    });
    const service = new CollectibleService(
      pool,
      worldLookupClient(worldLookupFor({})),
      createConfig(),
      loggerStub()
    );

    await Promise.allSettled([
      service.pickupNode(
        PLAYER,
        "NM:cell:concurrent-wood",
        visionForFlag(PLAYER.position)
      ),
      service.pickupNode(
        PLAYER,
        "NM:cell:concurrent-wood",
        visionForFlag(PLAYER.position)
      )
    ]);

    expect((await service.inventoryForPlayer(PLAYER.playerId)).totals.wood).toBe(4);
  });

  it("rejects far away and already harvested nodes", async () => {
    const farPool = createPickupPool({
      node: nodeRow({
        id: "far-ore",
        resource_type: "ore",
        lat: PLAYER.position.lat + 0.005,
        lon: PLAYER.position.lon
      })
    });
    const farService = new CollectibleService(
      farPool,
      worldLookupClient(worldLookupFor({})),
      createConfig(),
      loggerStub()
    );
    await expect(
      farService.pickupNode(PLAYER, "far-ore", visionForFlag(PLAYER.position))
    ).rejects.toThrow(/too far/);
    expect((await farService.inventoryForPlayer(PLAYER.playerId)).totals.stone).toBe(0);

    const harvestedPool = createPickupPool({
      node: nodeRow({
        id: "spent-food",
        resource_type: "food",
        state: "harvested",
        population_v2_state_revision: 1
      })
    });
    const harvestedService = new CollectibleService(
      harvestedPool,
      worldLookupClient(worldLookupFor({})),
      createConfig(),
      loggerStub()
    );
    await expect(
      harvestedService.pickupNode(PLAYER, "spent-food", visionForFlag(PLAYER.position))
    ).rejects.toThrow(/already/);
    expect((await harvestedService.inventoryForPlayer(PLAYER.playerId)).totals.food).toBe(0);
  });

  it("CASes a population-v2 tree through canonical state before granting inventory", async () => {
    const entityId = "00000000-0000-8000-8000-000000000123";
    const pool = createPickupPool({
      node: nodeRow({
        id: entityId,
        population_v2_entity_id: entityId,
        population_v2_state_revision: 7
      })
    });
    const service = new CollectibleService(
      pool,
      worldLookupClient(worldLookupFor({})),
      createConfig(),
      loggerStub()
    );

    const result = await service.pickupNode(
      PLAYER,
      entityId,
      visionForFlag(PLAYER.position)
    );
    const replay = await service.pickupNode(
      PLAYER,
      entityId,
      visionForFlag(PLAYER.position)
    );

    expect(result).toMatchObject({
      replayed: false,
      node: { id: entityId, state: "harvested" },
      inventory: { totals: { wood: 4 } }
    });
    expect(replay).toMatchObject({
      replayed: true,
      inventory: { totals: { wood: 4 } }
    });
    const queries = pool.recordedQueries();
    expect(queries.find((entry) =>
      entry.text.includes("UPDATE population_entity_state_v2")
    )?.values?.slice(0, 3)).toEqual([entityId, 7, PLAYER.playerId]);
    expect(queries.some((entry) =>
      entry.text.includes("UPDATE collectible_nodes")
    )).toBe(false);
    expect(queries.find((entry) =>
      entry.text.includes("INSERT INTO inventory_operations")
    )?.values?.[0]).toBe(`collect:${entityId}:${PLAYER.playerId}:life:7`);
    const canonicalTransition = queries.find((entry) =>
      entry.text.includes("UPDATE population_entity_state_v2")
    )?.text;
    expect(canonicalTransition).toContain("tree.population_v2_entity_id=");
    expect(canonicalTransition).toContain("NOT tree.population_v2_suppressed");
  });

  it("settles a durable developer Flax plant through the normal harvest path", async () => {
    const nodeId = "plant:dev:flax-test";
    const pool = createPickupPool({
      node: developerPlantRow({ id: nodeId })
    });
    const service = new CollectibleService(
      pool,
      worldLookupClient(worldLookupFor({})),
      createConfig(),
      loggerStub()
    );

    const result = await service.completeHarvestInTransaction(
      pool,
      PLAYER,
      nodeId,
      visionForFlag(PLAYER.position),
      0,
      `collect:${nodeId}:${PLAYER.playerId}:life:0`
    );

    expect(result.node).toMatchObject({
      id: nodeId,
      type: "flax_fiber",
      quantity: 3,
      state: "harvested",
      treeLifeRevision: 1
    });
    expect(result.inventory.totals.flax_fiber).toBe(3);
    expect(pool.recordedQueries().some((entry) =>
      entry.text.includes("UPDATE developer_spawned_plants")
    )).toBe(true);
  });

  it("excludes suppressed projections from ambient visibility reads", async () => {
    const pool = createPickupPool({ node: nodeRow({}) });
    const service = new CollectibleService(
      pool,
      worldLookupClient(worldLookupFor({})),
      createConfig(),
      loggerStub()
    );

    await service.listAvailableNear(PLAYER);

    const visibility = pool.recordedQueries().find((entry) =>
      entry.text.includes("ST_Distance") && entry.text.includes("FROM collectible_nodes")
    );
    expect(visibility?.text).toContain("AND NOT population_v2_suppressed");
    expect(visibility?.text).toContain("AND population_v2_entity_id IS NOT NULL");
  });

  it("rejects a stale population generation with exact-id removal reconciliation", async () => {
    const entityId = "00000000-0000-8000-8000-000000000777";
    const pool = createPickupPool({
      node: nodeRow({
        id: entityId,
        population_v2_entity_id: entityId,
        population_v2_state_revision: 12,
        population_v2_current_authority: false
      })
    });
    const service = new CollectibleService(
      pool,
      worldLookupClient(worldLookupFor({})),
      createConfig(),
      loggerStub()
    );

    await expect(service.validateHarvestStartInTransaction(
      pool,
      PLAYER,
      entityId,
      visionForFlag(PLAYER.position),
      12
    )).rejects.toMatchObject({
      code: "HARVEST_NODE_NOT_FOUND",
      details: {
        nodeId: entityId,
        stateRevision: 12,
        nodePosition: PLAYER.position,
        reconciliation: "remove-node"
      }
    });

    const lockQuery = pool.recordedQueries().find((entry) =>
      entry.text.includes("AS population_v2_current_authority")
    );
    expect(lockQuery?.text).toContain("FOR UPDATE OF tree");
    expect(pool.recordedQueries().some((entry) =>
      entry.text.includes("UPDATE population_entity_state_v2")
    )).toBe(false);
    expect(pool.recordedQueries().some((entry) =>
      entry.text.includes("INSERT INTO inventory_operations")
    )).toBe(false);
  });
});

describe("collectible constants", () => {
  it("keeps G3 gameplay radii explicit", () => {
    const vision = visionForFlag(PLAYER.position);

    expect(MOVE_LEASH_TO_VISION_GAP_M).toBe(50);
    expect(vision.movementLeashRadiusM).toBe(TEST_MOVEMENT_LEASH_RADIUS_M);
    expect(vision.radiusM).toBe(TEST_MOVEMENT_LEASH_RADIUS_M + MOVE_LEASH_TO_VISION_GAP_M);
    expect(vision.radiusM).toBe(650);
    expect(FLAG_VISIT_VISIBLE_PREPARATION_RADIUS_M).toBe(650);
    expect(COLLECTIBLE_VISIBILITY_RADIUS_M).toBe(650);
    expect(RESOURCE_PREPARATION_RADIUS_M).toBe(750);
    expect(PICKUP_RADIUS_M).toBe(50);
  });
});

type NodeRow = {
  id: string;
  cell_id: string;
  resource_type: string;
  quantity: number;
  lat: number;
  lon: number;
  state: string;
  created_at: Date;
  harvested_at: Date | null;
  harvested_by_player_id: string | null;
  population_v2_entity_id: string | null;
  population_v2_state_revision: number | null;
  population_v2_current_authority: boolean;
  developer_spawned_plant_id?: string | null;
};

type RecordedQuery = {
  text: string;
  values?: readonly unknown[] | undefined;
};

type PickupPool = pg.Pool & {
  recordedQueries(): RecordedQuery[];
};

type InventoryState = Map<string, number>;
type InventoryOperationState = Map<
  string,
  {
    playerId: string;
    source: string;
    sourceEntityType: string | null;
    sourceEntityId: string | null;
  }
>;
type InventoryEventState = Array<{
  operationKey: string;
  itemId: string;
  variant: string;
  quantity: number;
}>;

function visionForFlag(center: CollectiblePlayer["position"], flagId = TEST_FLAG_ID) {
  return resourceVisionForFlag({
    flagId,
    flagName: flagId === TEST_FLAG_ID ? "Test Flag" : "Second Flag",
    flagCenter: center,
    movementLeashRadiusM: TEST_MOVEMENT_LEASH_RADIUS_M
  });
}

function createInventoryPool(): pg.Pool {
  const inventory: InventoryState = new Map();
  const operations: InventoryOperationState = new Map();
  const events: InventoryEventState = [];
  const waterOperations = new Map<string, {
    operation_key: string;
    player_id: string;
    request_id: string;
    source_entity_id: string;
    water_kind: string;
    result_message: string;
  }>();
  let nextWaterAllowedAt = Number.NEGATIVE_INFINITY;
  let lastWaterCollectedAt = Number.NEGATIVE_INFINITY;
  const query = async <T>(text: string, values?: readonly unknown[]) => {
    if (text.includes("FROM water_collection_operations")) {
      const row = waterOperations.get(String(values?.[0]));
      return { rows: row ? [row as T] : [], rowCount: row ? 1 : 0 };
    }
    if (text.includes("INSERT INTO player_water_collection_cadence")) {
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("EXTRACT(epoch FROM (next_allowed_at")) {
      const retryAfterMs = Math.max(0, Math.ceil(nextWaterAllowedAt - Date.now()));
      return {
        rows: [{ retry_after_ms: String(retryAfterMs) } as T],
        rowCount: 1
      };
    }
    if (text.includes("UPDATE player_water_collection_cadence AS cadence")) {
      lastWaterCollectedAt = Date.now();
      nextWaterAllowedAt = lastWaterCollectedAt + Number(values?.[1]);
      return {
        rows: [{
          collected_at: new Date(lastWaterCollectedAt),
          next_allowed_at: new Date(nextWaterAllowedAt)
        } as T],
        rowCount: 1
      };
    }
    if (text.includes("INSERT INTO water_collection_operations")) {
      const operationKey = String(values?.[0]);
      waterOperations.set(operationKey, {
        operation_key: operationKey,
        player_id: String(values?.[1]),
        request_id: String(values?.[2]),
        source_entity_id: String(values?.[3]),
        water_kind: String(values?.[4]),
        result_message: String(values?.[5])
      });
      return { rows: [], rowCount: 1 };
    }
    return handleInventoryFoundationQuery<T>(text, values, inventory, operations, events);
  };
  const client = {
    query,
    release: vi.fn()
  };
  return {
    query,
    connect: async () => client
  } as unknown as pg.Pool;
}

function createPickupPool(options: { node: NodeRow }): PickupPool {
  const inventory: InventoryState = new Map();
  const operations: InventoryOperationState = new Map();
  const events: InventoryEventState = [];
  const node = { ...options.node };
  const queries: RecordedQuery[] = [];
  const client = {
    query: async <T>(text: string, values?: readonly unknown[]) => {
      queries.push({ text, values });
      if (text.includes("UPDATE population_entity_state_v2")) {
        if (
          !node.population_v2_entity_id
          || node.state !== "available"
          || node.population_v2_state_revision !== Number(values?.[1])
        ) {
          return { rows: [] as T[], rowCount: 0 };
        }
        node.state = "harvested";
        node.population_v2_state_revision += 1;
        node.harvested_at = values?.[3] as Date;
        node.harvested_by_player_id = String(values?.[2]);
        return {
          rows: [{ entity_id: node.population_v2_entity_id } as T],
          rowCount: 1
        };
      }
      if (text.includes("SELECT entity_id AS id") && text.includes("FROM developer_spawned_plants")) {
        return {
          rows: [node] as T[],
          rowCount: 1
        };
      }
      if (text.includes("UPDATE developer_spawned_plants")) {
        if (node.state !== "available") {
          return {
            rows: [] as T[],
            rowCount: 0
          };
        }
        node.state = "harvested";
        node.population_v2_state_revision = Number(node.population_v2_state_revision ?? 0) + 1;
        node.harvested_at = values?.[2] as Date;
        node.harvested_by_player_id = String(values?.[3]);
        return {
          rows: [node] as T[],
          rowCount: 1
        };
      }
      if (
        text.includes("SELECT id, cell_id, resource_type") &&
        text.includes("FROM collectible_nodes")
      ) {
        if (
          text.includes("population_v2_entity_id IS NOT NULL")
          && !node.population_v2_entity_id
        ) {
          return {
            rows: [] as T[],
            rowCount: 0
          };
        }
        return {
          rows: [node] as T[],
          rowCount: 1
        };
      }
      if (text.includes("UPDATE collectible_nodes")) {
        if (node.state !== "available") {
          return {
            rows: [] as T[],
            rowCount: 0
          };
        }
        node.state = "harvested";
        node.harvested_at = new Date("2026-07-08T10:00:00.000Z");
        node.harvested_by_player_id = String(values?.[2]);
        return {
          rows: [node] as T[],
          rowCount: 1
        };
      }
      return handleInventoryFoundationQuery<T>(text, values, inventory, operations, events);
    },
    release: vi.fn()
  };
  return {
    connect: async () => client,
    query: client.query,
    recordedQueries: () => queries.map((entry) => ({ ...entry }))
  } as unknown as PickupPool;
}

function handleInventoryFoundationQuery<T>(
  text: string,
  values: readonly unknown[] | undefined,
  inventory: InventoryState,
  operations: InventoryOperationState,
  events: InventoryEventState
): { rows: T[]; rowCount: number } {
  if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
    return { rows: [], rowCount: 0 };
  }
  if (text.includes("lock_player_inventory_carry")) {
    return { rows: [{ maximum_weight_grams: "1000000" }] as T[], rowCount: 1 };
  }
  if (text.includes("player_inventory_weight_grams")) {
    const currentWeight = BigInt(Array.from(inventory.values()).reduce(
      (total, quantity) => total + quantity,
      0
    ));
    return {
      rows: [{ current_weight: currentWeight.toString(), maximum_weight: "1000000", allowed_weight: "1000000" }] as T[],
      rowCount: 1
    };
  }
  if (text.includes("player_inventory_capacities")) {
    return { rows: [{ base_slots: 40, backpack_bonus_slots: 0, unlocked_slots: 40, inventory_revision: "0" }] as T[], rowCount: 1 };
  }
  if (text.includes("AS occupied_slots")) {
    return { rows: [{ occupied_slots: String(inventory.size) }] as T[], rowCount: 1 };
  }
  if (text.includes("FROM player_inventory_slots")) {
    const rows = inventoryRows(inventory, String(values?.[0])).map((row, slotIndex) => ({
      ...row, stack_id: `stack-${slotIndex}`, slot_index: slotIndex, manual_split: false
    }));
    return { rows: rows as T[], rowCount: rows.length };
  }
  if (text.includes("FROM player_inventory inventory")) {
    const rows = inventoryRows(inventory, String(values?.[0])).map((row, rowIndex) => ({
      ...row,
      entry_id: `entry-${rowIndex}`,
      quantity: String(row.quantity),
      version: "1",
      unit_weight_grams: 1,
      rod_id: null,
      uses_remaining: null
    }));
    return { rows: rows as T[], rowCount: rows.length };
  }
  if (text.includes("INSERT INTO inventory_operations")) {
    const operationKey = String(values?.[0]);
    if (operations.has(operationKey)) {
      return { rows: [], rowCount: 0 };
    }
    const operation = {
      playerId: String(values?.[1]),
      source: String(values?.[2]),
      sourceEntityType: nullableString(values?.[3]),
      sourceEntityId: nullableString(values?.[4])
    };
    operations.set(operationKey, operation);
    return {
      rows: [
        {
          operation_key: operationKey,
          player_id: operation.playerId,
          source: operation.source,
          source_entity_type: operation.sourceEntityType,
          source_entity_id: operation.sourceEntityId
        } as T
      ],
      rowCount: 1
    };
  }
  if (text.includes("FROM inventory_operations")) {
    const operationKey = String(values?.[0]);
    const operation = operations.get(operationKey);
    if (!operation || (values?.[1] !== undefined && operation.playerId !== values[1])) {
      return { rows: [], rowCount: 0 };
    }
    return {
      rows: [
        {
          operation_key: operationKey,
          player_id: operation.playerId,
          source: operation.source,
          source_entity_type: operation.sourceEntityType,
          source_entity_id: operation.sourceEntityId
        } as T
      ],
      rowCount: 1
    };
  }
  if (text.includes("INSERT INTO inventory_events")) {
    events.push({
      operationKey: String(values?.[0]),
      itemId: String(values?.[2]),
      variant: String(values?.[3]),
      quantity: Number(values?.[4])
    });
    return { rows: [], rowCount: 1 };
  }
  if (text.includes("FROM inventory_events")) {
    const rows = events
      .filter((event) => event.operationKey === values?.[0])
      .map((event) => ({
        item_id: event.itemId,
        variant: event.variant,
        delta_quantity: event.quantity
      }));
    return { rows: rows as T[], rowCount: rows.length };
  }
  if (text.includes("INSERT INTO player_inventory")) {
    const playerId = String(values?.[0]);
    const resourceType = String(values?.[1]);
    const variant = String(values?.[2]);
    const quantity = Number(values?.[3]);
    const key = `${playerId}|${resourceType}|${variant}`;
    const nextQuantity = (inventory.get(key) ?? 0) + quantity;
    inventory.set(key, nextQuantity);
    return {
      rows: [
        {
          player_id: playerId,
          resource_type: resourceType,
          variant,
          quantity: nextQuantity
        } as T
      ],
      rowCount: 1
    };
  }
  if (text.includes("SELECT player_id, resource_type, variant, quantity")) {
    const rows = inventoryRows(inventory, String(values?.[0]));
    return {
      rows: rows as T[],
      rowCount: rows.length
    };
  }
  return { rows: [], rowCount: 0 };
}

function inventoryRows(inventory: InventoryState, playerId: string) {
  return [...inventory.entries()].map(([key, quantity]) => {
    const [rowPlayerId, resourceType, variant] = key.split("|");
    return {
      player_id: rowPlayerId ?? playerId,
      resource_type: resourceType ?? "wood",
      variant: variant ?? "default",
      quantity
    };
  });
}

function createPoolFromQueryHandler(
  query: <T>(text: string, values?: readonly unknown[]) => Promise<{
    rows: T[];
    rowCount: number;
  }>
): pg.Pool {
  const client = { query, release: vi.fn() };
  return {
    query,
    connect: async () => client
  } as unknown as pg.Pool;
}

function nodeRow(overrides: Partial<NodeRow>): NodeRow {
  const id = overrides.id ?? "00000000-0000-8000-8000-000000000001";
  return {
    id,
    cell_id: "NM:1:1",
    resource_type: "wood",
    quantity: 1,
    lat: PLAYER.position.lat,
    lon: PLAYER.position.lon,
    state: "available",
    created_at: new Date("2026-07-08T09:00:00.000Z"),
    harvested_at: null,
    harvested_by_player_id: null,
    population_v2_entity_id: id,
    population_v2_state_revision: 0,
    population_v2_current_authority: true,
    ...overrides
  };
}

function developerPlantRow(overrides: Partial<NodeRow> = {}): NodeRow {
  const id = overrides.id ?? "plant:dev:flax-test";
  return nodeRow({
    id,
    resource_type: "flax_fiber",
    quantity: 3,
    population_v2_entity_id: null,
    population_v2_state_revision: 0,
    developer_spawned_plant_id: id,
    ...overrides
  });
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function worldLookupFor(overrides: {
  isLand?: boolean;
  isSaltwater?: boolean;
  insideMajorLake?: boolean;
  nearMajorRiver?: boolean;
  majorRiverDistanceM?: number;
}): WorldLookupResult {
  return {
    ok: true,
    packageId: "us_nm_v1_lat35_lon-107",
    elevationM: 1_500,
    terrainClass: "flat",
    biome: "Desert",
    ecoregion: "Chihuahuan Desert",
    raw: {
      profile: {
        is_land: overrides.isLand ?? true,
        is_saltwater: overrides.isSaltwater ?? false,
        inside_major_lake: overrides.insideMajorLake ?? false,
        near_major_river: overrides.nearMajorRiver ?? false,
        major_river_distance_m: overrides.majorRiverDistanceM ?? null
      }
    }
  };
}

function worldLookupClient(result: WorldLookupResult): WorldLookupClient {
  return {
    isReachable: vi.fn(async () => true),
    lookup: vi.fn(async () => result),
    lookupGameplayEnvironment: vi.fn(async () => result),
    lookupResourceEnvironments: vi.fn(async (points: Array<{ lat: number; lon: number }>) =>
      points.map((point) => ({ ...result, latitude: point.lat, longitude: point.lon }))
    ),
    collectibleWaterSourcesNear: vi.fn(async () => [])
  } as unknown as WorldLookupClient;
}

function createWorldLookupClient(result: WorldLookupResult) {
  const lookupGameplayEnvironment = vi.fn(async () => result);
  const lookupResourceEnvironments = vi.fn(
    async (points: Array<{ lat: number; lon: number }>) =>
      points.map((point) => ({ ...result, latitude: point.lat, longitude: point.lon }))
  );
  return {
    client: {
      isReachable: vi.fn(async () => true),
      lookup: vi.fn(async () => result),
      lookupGameplayEnvironment,
      lookupResourceEnvironments,
      collectibleWaterSourcesNear: vi.fn(async () => [])
    } as unknown as WorldLookupClient,
    lookupGameplayEnvironment,
    lookupResourceEnvironments
  };
}

function createConfig(): AppConfig {
  return loadConfig({ NODE_ENV: "test" });
}

function loggerStub() {
  return {
    warn: vi.fn(),
    info: vi.fn()
  };
}
