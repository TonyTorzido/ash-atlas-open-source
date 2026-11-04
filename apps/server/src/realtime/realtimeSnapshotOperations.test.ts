import {
  GIVING_TREE_AURA_INTERVAL_MS,
  type CollectibleNode,
  type PlayerInventorySnapshot,
  type RepeatableResourceNode,
  type ResourceVision,
  type ResourceVisionStatus,
  type WorldViewAuthority
} from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { CombatEngine } from "../game/combat/combatEngine.js";
import { createRealtimeSnapshotOperations } from "./realtimeSnapshotOperations.js";

describe("realtime dropped-item snapshots", () => {
  it("never delivers an async snapshot to a replacement connection", async () => {
    let releaseDrops!: () => void;
    const dropsReady = new Promise<void>((resolve) => {
      releaseDrops = resolve;
    });
    let connectionId = "connection-a";
    let connectionGeneration = 1;
    const sendToConnection = vi.fn();
    const listActiveInGameplayCircle = vi.fn(async () => {
      await dropsReady;
      return [];
    });
    const gameplayCircle = {
      center: { lat: 35, lon: -106 },
      radiusM: 650,
      eligibleRegionCodes: ["package-a"],
      eligibleZoneIds: ["world:package-a"],
      generation: 4
    };
    const operations = createRealtimeSnapshotOperations({
      logger: { warn: vi.fn() },
      registry: {
        activeConnectionIdForPlayer: vi.fn(() => connectionId),
        sendToConnection
      },
      connectionGenerations: {
        current: vi.fn(() => connectionGeneration),
        isCurrent: vi.fn((_playerId: string, expected: number) =>
          expected === connectionGeneration
        )
      },
      gameState: {
        getGameplayViewCircle: vi.fn(() => gameplayCircle),
        getPlayer: vi.fn(() => ({ relocationRevision: 7 })),
        getResourceVisionRevision: vi.fn(() => 9)
      },
      droppedItems: {
        listActiveInGameplayCircle
      }
    } as never);

    const stalePublication = operations.sendDroppedItemsForPlayer("player-1");
    await vi.waitFor(() => {
      expect(listActiveInGameplayCircle).toHaveBeenCalledOnce();
    });
    connectionId = "connection-b";
    connectionGeneration = 2;
    releaseDrops();
    await stalePublication;

    expect(sendToConnection).not.toHaveBeenCalled();

    await operations.sendDroppedItemsForPlayer("player-1");
    expect(sendToConnection).toHaveBeenCalledWith(
      "connection-b",
      expect.objectContaining({ type: "DROPPED_ITEMS_SNAPSHOT" })
    );
  });
});

describe("realtime Travel Inbox cooldown snapshots", () => {
  it("publishes timestamp-derived relocation and invite availability", async () => {
    const registry = {
      activeConnectionIdForPlayer: vi.fn(() => "connection-player-1"),
      send: vi.fn()
    };
    const relocationStatus = vi.fn(async () => ({
      lastRelocatedAt: new Date("2026-07-13T12:00:00.000Z"),
      relocationAvailableAt: Date.parse("2026-07-14T12:00:00.000Z"),
      travelInviteAvailableAt: Date.parse("2026-07-13T13:00:00.000Z"),
      serverTime: Date.parse("2026-07-13T12:15:00.000Z")
    }));
    const operations = createRealtimeSnapshotOperations({
      logger: { warn: vi.fn() },
      registry,
      gameState: {},
      travelInvites: { inboxForPlayer: vi.fn(async () => []) },
      playerService: { relocationStatus }
    } as never);

    await operations.sendTravelInboxForPlayers(["player-1"]);

    expect(registry.send).toHaveBeenCalledWith("player-1", {
      type: "TRAVEL_INBOX_SNAPSHOT",
      entries: [],
      serverTime: Date.parse("2026-07-13T12:15:00.000Z"),
      relocationAvailableAt: Date.parse("2026-07-14T12:00:00.000Z"),
      travelInviteAvailableAt: Date.parse("2026-07-13T13:00:00.000Z")
    });
  });

  it("adds the account land-action hold when the gate is wired", async () => {
    const registry = {
      activeConnectionIdForPlayer: vi.fn(() => "connection-player-1"),
      recordForConnection: vi.fn(() => ({ accountId: "account-1" })),
      send: vi.fn()
    };
    const availableAt = vi.fn(async () => 1_800_000_000_000);
    const operations = createRealtimeSnapshotOperations({
      logger: { warn: vi.fn() },
      registry,
      gameState: {},
      travelInvites: { inboxForPlayer: vi.fn(async () => []) },
      landActions: { availableAt }
    } as never);

    await operations.sendTravelInboxForPlayers(["player-1"]);

    expect(availableAt).toHaveBeenCalledWith("account-1");
    expect(registry.send).toHaveBeenCalledWith("player-1", expect.objectContaining({
      type: "TRAVEL_INBOX_SNAPSHOT",
      landActionAvailableAt: 1_800_000_000_000
    }));
  });
});

describe("realtime Giving Tree snapshots", () => {
  it("loads bootstrap inventory after delayed collectible work", async () => {
    let releaseNodes!: () => void;
    const nodesReady = new Promise<void>((resolve) => {
      releaseNodes = resolve;
    });
    let inventory = emptyInventory(1);
    const repeatableNode = legacyStoneMineProjection();
    const listInVision = vi.fn(async () => [repeatableNode]);
    const registry = {
      send: vi.fn(),
      activeConnectionIdForPlayer: vi.fn(() => "connection-player-1")
    };
    const gameState = {
      getResourceVision: vi.fn(() => resourceVision()),
      getResourceVisionRevision: vi.fn(() => 9),
      getGameplayViewCircle: vi.fn(() => ({ generation: 4 })),
      getPlayer: vi.fn(() => ({ relocationRevision: 7 }))
    };
    const operations = createRealtimeSnapshotOperations({
      logger: { warn: vi.fn() },
      registry,
      gameState,
      repeatableResources: { listInVision },
      collectibles: {
        resourceVisionStatus: vi.fn(async () => resourceVisionStatus()),
        waterHighlightsForVision: vi.fn(async () => []),
        listAvailableInVision: vi.fn(async () => {
          await nodesReady;
          return [];
        }),
        inventoryForPlayer: vi.fn(async () => inventory)
      }
    } as never);

    const pending = operations.sendCollectiblesForPlayer(
      { playerId: "player-1", anchor: resourceVision().center, relocationRevision: 7 } as never
    );
    await vi.waitFor(() => {
      expect(gameState.getGameplayViewCircle).toHaveBeenCalled();
    });
    inventory = {
      ...emptyInventory(2),
      items: [{
        playerId: "player-1",
        resourceType: "stone",
        variant: null,
        quantity: 1
      }],
      totals: { ...emptyInventory(2).totals, stone: 1 }
    };
    releaseNodes();
    await pending;

    expect(registry.send).toHaveBeenCalledWith(
      "player-1",
      expect.objectContaining({
        type: "COLLECTIBLES_SNAPSHOT",
        repeatableNodes: [repeatableNode]
      })
    );
    expect(registry.send).toHaveBeenCalledWith(
      "player-1",
      expect.objectContaining({
        type: "PLAYER_RESOURCES_UPDATED",
        inventory: expect.objectContaining({ revision: 2 })
      })
    );
    expect(listInVision).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ flagId: "flag-1" }),
      "player-1"
    );
  });

  it("registers travel-ready snapshot trees for healing", async () => {
    const combat = healingEngine();
    addHealingPlayer(combat, 90);
    const tree = collectible();
    const registry = {
      send: vi.fn(),
      activeConnectionIdForPlayer: vi.fn(() => "connection-player-1")
    };
    const gameState = {
      getResourceVisionRevision: vi.fn(() => 9),
      getGameplayViewCircle: vi.fn(() => ({ generation: 4 })),
      getPlayer: vi.fn(() => ({ relocationRevision: 7 }))
    };
    const operations = createRealtimeSnapshotOperations({
      logger: { warn: vi.fn() },
      registry,
      gameState,
      combat,
      collectibles: {
        waterHighlightsForVision: vi.fn(async () => []),
        listAvailableInVision: vi.fn(async () => [tree]),
        inventoryForPlayer: vi.fn(async () => emptyInventory())
      }
    } as never);

    await operations.sendTravelResourceVisionReadyAndSnapshot(
      { playerId: "player-1", relocationRevision: 7 } as never,
      resourceVision(),
      resourceVisionStatus()
    );

    combat.tick();
    expect(combat.entity("player-1")?.currentHealth).toBe(93);
    for (let tick = 0; tick < GIVING_TREE_AURA_INTERVAL_MS * 20 / 1_000 - 1; tick += 1) combat.tick();
    expect(combat.entity("player-1")?.currentHealth).toBe(93);
    combat.tick();
    expect(combat.entity("player-1")?.currentHealth).toBe(96);
    expect(registry.send).toHaveBeenCalledWith(
      "player-1",
      expect.objectContaining({
        type: "COLLECTIBLES_SNAPSHOT",
        playerId: "player-1",
        relocationRevision: 7,
        resourceVisionRevision: 9,
        authority: expect.objectContaining({
          gameplayViewGeneration: 4,
          scope: { kind: "flag", id: "flag-1" },
          includedDomains: ["population", "repeatable-resource"],
          completeness: "complete",
          ordinaryNodesTruncated: false
        })
      })
    );
  });
});

describe("realtime combat snapshots", () => {
  it("keeps ordinary bootstrap and recovery snapshots out of presentation readiness", () => {
    const combat = healingEngine();
    addHealingPlayer(combat, 100);
    const registry = { send: vi.fn() };
    const authority = worldViewAuthority();
    const operations = createRealtimeSnapshotOperations({
      logger: { warn: vi.fn() },
      registry,
      gameState: {},
      combat,
      worldRuntime: {
        interestFrameFor: vi.fn(() => ({
          nearbyIdsByPlayer: new Map([["player-1", new Set(["player-1"])]]),
          cacheHits: 0,
          cacheMisses: 1
        }))
      },
      currentWorldViewAuthority: () => authority
    } as never);

    expect(operations.sendCombatScopeSnapshot(
      "player-1",
      undefined,
      false
    )).toMatchObject({
      worldViewAuthority: null,
      combatSnapshotGeneration: null
    });
    expect(registry.send).toHaveBeenCalledWith(
      "player-1",
      expect.not.objectContaining({
        worldViewAuthority: expect.anything(),
        combatSnapshotGeneration: expect.anything()
      })
    );
  });

  it("publishes one counted full baseline for the exact world-view authority", () => {
    const combat = healingEngine();
    addHealingPlayer(combat, 100);
    combat.spawnMob({
      entityId: "wolf:travel-baseline",
      archetype: "wolf",
      position: { lat: 35, lon: -106 },
      regionCode: "NM",
      zoneId: "world:NM"
    });
    const registry = { send: vi.fn() };
    const authority = worldViewAuthority();
    const operations = createRealtimeSnapshotOperations({
      logger: { warn: vi.fn() },
      registry,
      gameState: {},
      combat,
      worldRuntime: {
        interestFrameFor: vi.fn(() => ({
          nearbyIdsByPlayer: new Map([[
            "player-1",
            new Set(["player-1", "wolf:travel-baseline"])
          ]]),
          cacheHits: 0,
          cacheMisses: 1
        }))
      },
      currentWorldViewAuthority: () => authority
    } as never);

    const publication = operations.sendCombatScopeSnapshot(
      "player-1",
      authority
    );

    expect(publication).toEqual({
      worldViewAuthority: authority,
      combatSnapshotGeneration: 1,
      combatEntityCount: 1,
      mobEntityCount: 1,
      expectedMobActorCount: 1
    });
    expect(registry.send).toHaveBeenCalledOnce();
    expect(registry.send).toHaveBeenCalledWith(
      "player-1",
      expect.objectContaining({
        type: "COMBAT_SNAPSHOT",
        worldViewAuthority: authority,
        combatSnapshotGeneration: 1,
        state: expect.objectContaining({
          upserts: expect.arrayContaining([
            expect.objectContaining({ entityId: "wolf:travel-baseline" })
          ])
        })
      })
    );
  });

  it("does not publish a baseline for a stale expected authority", () => {
    const combat = healingEngine();
    addHealingPlayer(combat, 100);
    const registry = { send: vi.fn() };
    const authority = worldViewAuthority();
    const operations = createRealtimeSnapshotOperations({
      logger: { warn: vi.fn() },
      registry,
      gameState: {},
      combat,
      worldRuntime: {
        interestFrameFor: vi.fn()
      },
      currentWorldViewAuthority: () => authority
    } as never);

    expect(operations.sendCombatScopeSnapshot("player-1", {
      ...authority,
      relocationRevision: authority.relocationRevision - 1
    })).toBeNull();
    expect(registry.send).not.toHaveBeenCalled();
  });
});

function healingEngine(): CombatEngine {
  return new CombatEngine({
    tickRateHz: 20,
    playerMovementSpeedMps: 40,
    isPlayerAuthorityActive: () => true
  });
}

function addHealingPlayer(engine: CombatEngine, currentHealth: number): void {
  engine.connectPlayer({
    playerId: "player-1",
    name: "player-1",
    regionCode: "NM",
    zoneId: "world:NM",
    position: { lat: 35, lon: -106 },
    accountId: "account-player-1",
    connectionId: "connection-player-1",
    profile: {
      playerId: "player-1",
      maxHealth: 100,
      currentHealth,
      baseAttackDamage: 10
    }
  });
}

function collectible(): CollectibleNode {
  return {
    id: "travel-tree",
    type: "wood",
    lat: 35,
    lon: -106,
    quantity: 4,
    state: "available",
    createdAt: "",
    harvestedAt: null,
    sourceCellId: "population-v2:travel-zone",
    waterKind: null,
    resinAvailable: false,
    treeLifeRevision: 8
  };
}

function legacyStoneMineProjection(): RepeatableResourceNode {
  return {
    id: "legacy-stone-mine",
    nodeType: "stone_mine",
    lat: 35,
    lon: -106,
    yieldItemId: "stone",
    yieldQuantity: 3,
    state: "ready",
    authorityRevision: 1,
    readyAt: null,
    timerVisibility: "visible",
    ownerPlayerId: null,
    ownerUsername: null,
    accessMode: null,
    accessRevision: 0,
    tollGold: "0",
    canManage: false,
    bonusExtractionAvailable: false
  };
}

function resourceVision(): ResourceVision {
  return {
    flagId: "flag-1",
    flagName: "Flag",
    destinationKind: "flag",
    center: { lat: 35, lon: -106 },
    movementLeashRadiusM: 900,
    paddingM: 50,
    radiusM: 950
  };
}

function resourceVisionStatus(): ResourceVisionStatus {
  return {
    flagId: "flag-1",
    layoutVersion: "test",
    status: "ready",
    radiusM: 950,
    nodeCount: 1,
    waterHighlightCount: 0,
    requestedAt: "2026-07-24T00:00:00.000Z",
    generatedAt: "2026-07-24T00:00:01.000Z",
    lastError: null,
    updatedAt: "2026-07-24T00:00:01.000Z"
  };
}

function worldViewAuthority(): WorldViewAuthority {
  return {
    playerId: "player-1",
    connectionId: "connection-player-1",
    connectionGeneration: 3,
    relocationRevision: 7,
    resourceVisionRevision: 9,
    gameplayViewGeneration: 11,
    populationPreparationGeneration: 13
  };
}

function emptyInventory(revision = 0): PlayerInventorySnapshot {
  return {
    playerId: "player-1",
    revision,
    items: [],
    totals: {
      wood: 0,
      stone: 0,
      coal: 0,
      iron: 0,
      sulfur: 0,
      iron_bar: 0,
      venomsteel_bar: 0,
      venomsteel_core: 0,
      fire_feather: 0, tempest_quill: 0, ice_feather: 0,
      fire_bar: 0, fire_core: 0, lightning_bar: 0, lightning_core: 0, ice_bar: 0, ice_core: 0,
      food: 0,
      ore: 0,
      water: 0,
      leather: 0,
      deer_hide: 0,
      hog_hide: 0,
      wolf_pelt: 0,
      bear_hide: 0,
    alligator_hide: 0,
    squid_flesh: 0,
    crab_carapace: 0,
    raw_meat: 0,
    shell: 0,
      giving_berry: 0,
      balsam_resin: 0,
      crude_oil: 0,
      jellyfish_venom: 0, brood_silk: 0, refined_oil: 0, raptor_scale: 0, giant_egg: 0, brood_egg: 0, clutch_egg: 0, crawler_egg: 0, broken_whistle: 0, bonewrought_blade: 0, bonewrought_mail: 0, anti_venom_tonic: 0, battle_draught: 0, ember_flask: 0, spark_tonic: 0, field_net: 0, field_trap: 0, lamp_sheath: 0, cinder_lantern: 0, challengers_lantern: 0, survey_stake_kit: 0, compass: 0, elder_acorn: 0, zephyr: 0, cave_lichen: 0, gale_plume: 0, heartsap: 0, wyrm_egg: 0, dragon_scale: 0, maw_bloom_petal: 0, giving_tree_sapling: 0, edict_seal: 0, prison_key_fragment: 0,
      crystal: 0, pearl: 0, atlas_shrine_shard: 0,
      enchantment_stone: 0
    }
  };
}
