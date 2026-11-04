import {
  EQUIPMENT_BALANCE_VERSION,
  EQUIPMENT_SLOTS,
  MANOR_SMITH,
  MAX_EQUIPMENT_LEVEL,
  emptyEquipmentSlots,
  equipmentUpgradeCost,
  requireEquipmentDefinition,
  resolveEquipmentCombatStats,
  resolveEquipmentItemDerivedStats,
  type ActiveEquipmentLoadout,
  type ClientMessage,
  type CombatKitIndex,
  type EquipmentInstanceV2,
  type EquipmentSlotRecord,
  type EquipmentSnapshotV2,
  type ManorOccupantAccessSource,
  type ServerMessage,
  parseServerMessage
} from "@ash-atlas/shared";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { installAuthGuard } from "../auth/authGuard.js";
import type { AuthService } from "../auth/authService.js";
import { loadConfig } from "../config.js";
import { worldBootstrapLocationFixtures } from "../realtime/worldBootstrapTestFixtures.js";
import { CombatEngine } from "../game/combat/combatEngine.js";
import type { CombatProfileService } from "../game/combat/combatProfiles.js";
import {
  EquipmentError,
  type AppliedKitActivation,
  type EquipmentService,
  type StagedKitActivation
} from "../game/equipment.js";
import type { FlagService } from "../game/flags.js";
import {
  ManorRuntime,
  type ManorPresenceService
} from "../game/manor.js";
import type { PlayerService } from "../game/players.js";
import type { ProgressionService } from "../game/progression.js";
import { GameState, type PlayerRecord } from "../game/state.js";
import { WalletOperationError } from "../game/wallet.js";
import { createLogger } from "../logger.js";
import { ConnectionRegistry } from "../realtime/connectionRegistry.js";
import { registerRealtime } from "../realtime/websocket.js";

describe("equipment WebSocket lifecycle", () => {
  it("connects the equipment runtime on HELLO and confirms kit activation only at the exact tick boundary", async () => {
    const harness = await createEquipmentHarness();
    try {
      harness.socket.send(hello());
      await waitForMessage(harness.messages, "EQUIPMENT_SNAPSHOT");

      expect(harness.equipment.connectRuntime).toHaveBeenCalledWith("player-1", {
        context: "pve",
        characterLevel: 0,
        classId: "warrior",
        classRank: 0,
        achievementIds: []
      });

      const acceptedTick = harness.combat.serverTick;
      harness.socket.send(JSON.stringify({
        type: "ACTIVATE_COMBAT_KIT",
        requestId: "activate-kit-two",
        kitIndex: 2,
        expectedInventoryRevision: 7
      } satisfies ClientMessage));
      await vi.waitFor(() => {
        expect(harness.equipment.stageKitActivation).toHaveBeenCalledOnce();
      });

      expect(messageForRequest(
        harness.messages,
        "COMBAT_KIT_ACTIVATED",
        "activate-kit-two"
      )).toBeUndefined();
      expect(harness.equipment.markActivationApplied).not.toHaveBeenCalled();
      expect(harness.currentSnapshot().activeKitIndex).toBe(1);

      harness.combat.tick();

      const confirmation = await waitForRequestMessage(
        harness.messages,
        "COMBAT_KIT_ACTIVATED",
        "activate-kit-two"
      );
      expect(confirmation).toMatchObject({
        requestId: "activate-kit-two",
        kitIndex: 2,
        inventoryRevision: 7,
        activeRevision: 4,
        activationTick: acceptedTick + 1,
        replayed: false
      });
      expect(harness.equipment.markActivationApplied)
        .toHaveBeenCalledWith("player-1", "activate-kit-two", acceptedTick + 1);
      expect(harness.currentSnapshot().activeKitIndex).toBe(2);
    } finally {
      await harness.close();
    }
  });

  it("round-trips level-cap character and equipment snapshots across connect, disconnect, and reconnect", async () => {
    const harness = await createEquipmentHarness({ level: 25 });
    try {
      for (const phase of ["connect", "reconnect"] as const) {
        if (phase === "reconnect") {
          harness.socket.terminate();
          await vi.waitFor(() => {
            expect(harness.equipment.flushAndRelease).toHaveBeenCalledWith("player-1");
          });
          harness.messages.length = 0;
          harness.rawMessages.length = 0;
          await harness.reconnect();
        }
        harness.socket.send(hello());
        await waitForMessage(harness.messages, "EQUIPMENT_SNAPSHOT");
        await waitForMessage(harness.messages, "PROGRESSION_SNAPSHOT");
        // The client parser enforces the 0..25 level-cap schemas.
        const parsed = harness.rawMessages.map(parseServerMessage);
        const equipment = parsed.find((message) => message.type === "EQUIPMENT_SNAPSHOT");
        const progression = parsed.find((message) => message.type === "PROGRESSION_SNAPSHOT");
        expect(equipment).toMatchObject({
          equipment: {
            characterLevel: 25,
            active: { melee: { itemLevel: 25, maximumItemLevel: 25, nextUpgradeLevel: null } },
            derivedStats: { characterLevel: 25, weaponItemLevel: 25 }
          }
        });
        expect(progression).toMatchObject({ progression: { level: 25 } });
      }
    } finally {
      await harness.close();
    }
  });

  it("reports the precise server-owned invalid-kit reason", async () => {
    const harness = await createEquipmentHarness();
    const invalidTelemetry = vi.spyOn(harness.combat, "recordInvalidKitActivation");
    try {
      harness.socket.send(hello());
      await waitForMessage(harness.messages, "EQUIPMENT_SNAPSHOT");

      harness.socket.send(JSON.stringify({
        type: "ACTIVATE_COMBAT_KIT",
        requestId: "activate-invalid-shield",
        kitIndex: 3,
        expectedInventoryRevision: 7
      } satisfies ClientMessage));

      const invalidated = await waitForRequestMessage(
        harness.messages,
        "COMBAT_KIT_INVALIDATED",
        "activate-invalid-shield"
      );
      expect(invalidated).toMatchObject({
        kitIndex: 3,
        reason: "readied_secondary_not_ranged",
        equipment: {
          activeKitIndex: 1,
          inventoryRevision: 7
        }
      });
      expect(await waitForRequestMessage(
        harness.messages,
        "ERROR",
        "activate-invalid-shield"
      )).toMatchObject({
        code: "EQUIPMENT_KIT_INVALID"
      });
      expect(harness.equipment.markActivationApplied).not.toHaveBeenCalled();
      expect(invalidTelemetry).toHaveBeenCalledWith("player-1");
    } finally {
      await harness.close();
    }
  });

  it("cancels an unapplied boundary and flushes/releases equipment on disconnect", async () => {
    const harness = await createEquipmentHarness();
    harness.socket.send(hello());
    await waitForMessage(harness.messages, "EQUIPMENT_SNAPSHOT");

    harness.socket.send(JSON.stringify({
      type: "ACTIVATE_COMBAT_KIT",
      requestId: "disconnect-before-equipment-tick",
      kitIndex: 2,
      expectedInventoryRevision: 7
    } satisfies ClientMessage));
    await vi.waitFor(() => {
      expect(harness.equipment.stageKitActivation).toHaveBeenCalledOnce();
    });
    expect(harness.pendingActivation()).not.toBeNull();

    harness.socket.terminate();
    await vi.waitFor(() => {
      expect(harness.equipment.flushAndRelease).toHaveBeenCalledWith("player-1");
    });
    expect(harness.pendingActivation()).toBeNull();

    harness.combat.tick();
    expect(harness.equipment.markActivationApplied).not.toHaveBeenCalled();
    expect(messageForRequest(
      harness.messages,
      "COMBAT_KIT_ACTIVATED",
      "disconnect-before-equipment-tick"
    )).toBeUndefined();

    await harness.app.close();
  });

  it("stages active upgrades and readied-weapon changes without mutating combat mid-tick", async () => {
    const harness = await createEquipmentHarness();
    const stage = vi.spyOn(harness.combat, "stageEquipmentCombatUpdate");
    try {
      harness.socket.send(hello());
      await waitForMessage(harness.messages, "EQUIPMENT_SNAPSHOT");

      harness.socket.send(JSON.stringify({
        type: "UPGRADE_EQUIPMENT",
        requestId: "upgrade-active-sword",
        instanceId: IDS.sword,
        expectedLevel: 0
      } satisfies ClientMessage));
      await waitForRequestMessage(
        harness.messages,
        "EQUIPMENT_UPGRADE_RESULT",
        "upgrade-active-sword"
      );
      expect(stage).toHaveBeenCalledWith("player-1", expect.objectContaining({
        requestId: "upgrade-active-sword",
        kind: "active_item_upgrade"
      }));
      expect(harness.appliedEquipmentUpdates).toEqual([]);

      harness.socket.send(JSON.stringify({
        type: "TOGGLE_READIED_WEAPON",
        requestId: "ready-secondary",
        readiedWeaponSlot: "secondary",
        expectedInventoryRevision: 8
      } satisfies ClientMessage));
      await waitForRequestMessage(
        harness.messages,
        "COMBAT_KIT_SNAPSHOT",
        "ready-secondary"
      );
      expect(stage).toHaveBeenCalledWith("player-1", expect.objectContaining({
        requestId: "ready-secondary",
        kind: "readied_weapon",
        state: expect.objectContaining({
          activeWeaponSlot: "secondary",
          activeWeaponInstanceId: IDS.bow,
          stats: expect.objectContaining({
            readiedWeaponSlot: "secondary",
            readiedWeaponCategory: "bow"
          })
        })
      }));
      expect(harness.appliedEquipmentUpdates).toEqual([]);

      harness.combat.tick();
      expect(harness.appliedEquipmentUpdates).toEqual([{
        activationTick: 1,
        kinds: ["active_item_upgrade", "readied_weapon"]
      }]);
    } finally {
      await harness.close();
    }
  });

  it("holds kit activation behind an equipment mutation that is in flight", async () => {
    const upgradeGate = createDeferred<void>();
    const harness = await createEquipmentHarness({
      upgradeGate: upgradeGate.promise
    });
    try {
      harness.socket.send(hello());
      await waitForMessage(harness.messages, "EQUIPMENT_SNAPSHOT");

      harness.socket.send(JSON.stringify({
        type: "UPGRADE_EQUIPMENT",
        requestId: "upgrade-held-open",
        instanceId: IDS.sword,
        expectedLevel: 0
      } satisfies ClientMessage));
      await vi.waitFor(() => {
        expect(harness.equipment.upgrade).toHaveBeenCalledOnce();
      });

      harness.socket.send(JSON.stringify({
        type: "ACTIVATE_COMBAT_KIT",
        requestId: "activate-during-upgrade",
        kitIndex: 2,
        expectedInventoryRevision: 7
      } satisfies ClientMessage));
      // Combat/equipment messages are serialized per player, so the activation waits behind the upgrade.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(harness.equipment.stageKitActivation).not.toHaveBeenCalled();
      expect(harness.pendingActivation()).toBeNull();

      upgradeGate.resolve();
      await waitForRequestMessage(
        harness.messages,
        "EQUIPMENT_UPGRADE_RESULT",
        "upgrade-held-open"
      );
    } finally {
      upgradeGate.resolve();
      await harness.close();
    }
  });

  it("returns the typed wallet rejection for an equipment upgrade", async () => {
    const harness = await createEquipmentHarness({
      upgradeError: new WalletOperationError(
        "WALLET_INSUFFICIENT_FUNDS",
        "Wallet does not contain enough gold"
      )
    });
    try {
      harness.socket.send(hello());
      await waitForMessage(harness.messages, "EQUIPMENT_SNAPSHOT");

      harness.socket.send(JSON.stringify({
        type: "UPGRADE_EQUIPMENT",
        requestId: "upgrade-insufficient-gold",
        instanceId: IDS.sword,
        expectedLevel: 0
      } satisfies ClientMessage));

      expect(await waitForRequestMessage(
        harness.messages,
        "ERROR",
        "upgrade-insufficient-gold"
      )).toMatchObject({
        code: "WALLET_INSUFFICIENT_FUNDS",
        message: "Wallet does not contain enough gold"
      });
    } finally {
      await harness.close();
    }
  });

  it.each(["OWNER", "PARTY", "TRAVEL_INVITE"] as const)(
    "passes exact %s manor smith authority and rejects the stale session after ejection",
    async (accessSource) => {
      const harness = await createEquipmentHarness({ manor: true });
      try {
        harness.socket.send(hello());
        await waitForMessage(harness.messages, "EQUIPMENT_SNAPSHOT");
        const manorSession = harness.enterManor(accessSource);

        harness.socket.send(JSON.stringify({
          type: "UPGRADE_EQUIPMENT",
          requestId: `manor-upgrade-${accessSource}`,
          instanceId: IDS.sword,
          expectedLevel: 0,
          manorSessionId: manorSession.sessionId,
          manorMovementSequence: manorSession.movementSequence
        } satisfies ClientMessage));
        await waitForRequestMessage(
          harness.messages,
          "EQUIPMENT_UPGRADE_RESULT",
          `manor-upgrade-${accessSource}`
        );
        expect(harness.equipment.upgrade).toHaveBeenLastCalledWith(
          expect.objectContaining({ playerId: "player-1" }),
          IDS.sword,
          0,
          `manor-upgrade-${accessSource}`,
          undefined,
          expect.objectContaining({
            kind: "manor_smith",
            manorId: "00000000-0000-4000-8000-000000000077",
            manorSessionId: manorSession.sessionId,
            movementSequence: manorSession.movementSequence
          })
        );

        harness.ejectManor(manorSession.sessionId);
        harness.socket.send(JSON.stringify({
          type: "UPGRADE_EQUIPMENT",
          requestId: `stale-manor-upgrade-${accessSource}`,
          instanceId: IDS.sword,
          expectedLevel: 1,
          manorSessionId: manorSession.sessionId,
          manorMovementSequence: manorSession.movementSequence
        } satisfies ClientMessage));
        expect(await waitForRequestMessage(
          harness.messages,
          "ERROR",
          `stale-manor-upgrade-${accessSource}`
        )).toMatchObject({ code: "MANOR_SMITH_ACCESS_DENIED" });
        expect(harness.equipment.upgrade).toHaveBeenCalledTimes(1);
      } finally {
        await harness.close();
      }
    }
  );
});

async function createEquipmentHarness(
  options: {
    upgradeGate?: Promise<void>;
    upgradeError?: Error;
    manor?: boolean;
    /** Character and active-sword level for level-cap round-trip checks. */
    level?: number;
  } = {}
) {
  const app = Fastify();
  const config = loadConfig({
    NODE_ENV: "test",
    RECONNECT_GRACE_MS: "5",
    LINKDEAD_WORLD_PRESENCE_MS: "5"
  });
  const logger = createLogger("test");
  const registry = new ConnectionRegistry();
  const gameState = new GameState(config, logger);
  const initial = equipmentSnapshot({
    activeMelee: "starter_sword",
    activeKitIndex: 1,
    activeRevision: 3,
    ...(options.level === undefined
      ? {}
      : { swordLevel: options.level, characterLevel: options.level })
  });
  const activated = equipmentSnapshot({
    activeMelee: "training_axe",
    activeKitIndex: 2,
    activeRevision: 4
  });
  const upgraded = equipmentSnapshot({
    activeMelee: "starter_sword",
    activeKitIndex: 1,
    activeRevision: 4,
    checkpointRevision: 4,
    inventoryRevision: 8,
    swordLevel: 1
  });
  const secondaryReadied = equipmentSnapshot({
    activeMelee: "starter_sword",
    activeKitIndex: 1,
    activeRevision: 5,
    checkpointRevision: 5,
    inventoryRevision: 8,
    readiedWeaponSlot: "secondary",
    swordLevel: 1
  });
  let connected = false;
  let current = initial;
  let pending: StagedKitActivation | null = null;
  const appliedEquipmentUpdates: Array<{
    activationTick: number;
    kinds: string[];
  }> = [];

  const equipment = {
    ensureStarterLoadout: vi.fn(async () => ({
      applied: false,
      replayed: true,
      equipment: initial
    })),
    runtimeSnapshot: vi.fn(() => connected ? current : null),
    connectRuntime: vi.fn(async () => {
      connected = true;
      current = initial;
      return current;
    }),
    getSnapshot: vi.fn(async () => current),
    setRuntimeContext: vi.fn(() => current),
    pendingActivation: vi.fn(() => pending),
    stageKitActivation: vi.fn((
      _playerId: string,
      input: {
        requestId: string;
        kitIndex: CombatKitIndex;
        expectedInventoryRevision: number;
      }
    ): StagedKitActivation => {
      if (input.kitIndex === 3) {
        throw new EquipmentError(
          "EQUIPMENT_KIT_INVALID",
          "Combat kit 3 is invalid: readied_secondary_not_ranged",
          "readied_secondary_not_ranged"
        );
      }
      pending = {
        requestId: input.requestId,
        kitIndex: input.kitIndex,
        inventoryRevision: activated.inventoryRevision,
        activeRevision: activated.activeRevision,
        activationTick: null,
        replayed: false,
        equipment: activated,
        derivedStats: activated.derivedStats
      };
      return pending;
    }),
    markActivationApplied: vi.fn((
      _playerId: string,
      requestId: string,
      activationTick: number
    ): AppliedKitActivation => {
      if (!pending || pending.requestId !== requestId) {
        throw new Error("activation was not staged");
      }
      const applied = {
        ...pending,
        activationTick,
        replayed: false
      };
      current = pending.equipment;
      pending = null;
      return applied;
    }),
    cancelPendingActivation: vi.fn((_playerId: string, requestId?: string) => {
      if (!pending || (requestId !== undefined && pending.requestId !== requestId)) {
        return false;
      }
      pending = null;
      return true;
    }),
    upgrade: vi.fn(async () => {
      await options.upgradeGate;
      if (options.upgradeError) throw options.upgradeError;
      current = upgraded;
      return {
        applied: true,
        replayed: false,
        instanceId: IDS.sword,
        levelBefore: 0,
        levelAfter: 1,
        goldCost: "10",
        balanceVersion: EQUIPMENT_BALANCE_VERSION,
        goldBalance: "90",
        equipment: upgraded
      };
    }),
    toggleReadiedWeapon: vi.fn(async () => {
      current = secondaryReadied;
      return {
        applied: true,
        replayed: false,
        equipment: secondaryReadied
      };
    }),
    flushAndRelease: vi.fn(async () => {
      pending = null;
      connected = false;
    })
  };
  const combat = new CombatEngine({
    tickRateHz: config.SERVER_TICK_HZ,
    isPlayerAuthorityActive: (playerId, accountId, connectionId) =>
      registry.isActiveConnection(accountId, connectionId) &&
      registry.isActivePlayerConnection(playerId, connectionId),
    getAuthoritativeViewCircle: (playerId) => gameState.getGameplayViewCircle(playerId),
    onEquipmentCombatUpdatesApplied: ({ playerId, activationTick, updates }) => {
      appliedEquipmentUpdates.push({
        activationTick,
        kinds: updates.map((update) => update.kind)
      });
      for (const update of updates) {
        if (update.kind !== "kit_activation") continue;
        const applied = equipment.markActivationApplied(
          playerId,
          update.requestId,
          activationTick
        );
        registry.send(playerId, {
          type: "COMBAT_KIT_ACTIVATED",
          requestId: applied.requestId,
          kitIndex: applied.kitIndex,
          inventoryRevision: applied.inventoryRevision,
          activeRevision: applied.activeRevision,
          activationTick: applied.activationTick,
          replayed: applied.replayed,
          equipment: applied.equipment
        });
      }
    }
  });
  const playerService = {
    loadPlayer: vi.fn(async () => playerRecord()),
    markOnline: vi.fn(async () => undefined),
    persistPlayerSnapshot: vi.fn(async () => undefined),
    markOffline: vi.fn(async () => undefined)
  } as unknown as PlayerService;
  const authService = {
    sessionCookieName: "aa_session_dev",
    assertOrigin: vi.fn(),
    authenticateSession: vi.fn(async () => ({
      sessionId: "session-1",
      account: {
        id: "account-1",
        status: "active",
        trustTier: "new",
        riskScore: 0,
        createdAt: new Date(),
        lastLoginAt: null
      },
      player: {
        id: "player-1",
        accountId: "account-1",
        displayName: "Ash"
      },
      deviceInstallationId: "device-1",
      csrfToken: "csrf"
    })),
    recordConnectionEvent: vi.fn(async () => undefined),
    requireGameplayReady: vi.fn(),
    developerCapabilities: vi.fn(() => []),
    hasDeveloperCapability: vi.fn(() => false),
    authorizeDeveloperCommand: vi.fn(async () => undefined),
    recordDeveloperCommandResult: vi.fn(async () => undefined)
  } as unknown as AuthService;
  const progression = {
    getOrCreate: vi.fn(async () => ({
      playerId: "player-1",
      totalXp: 0,
      level: options.level ?? 0,
      curveVersion: 1,
      persistenceVersion: 1,
      xpIntoLevel: 0,
      xpForNextLevel: 100,
      nextLevelTotalXp: 100,
      atCap: false,
      pveStats: {
        maxHealth: 100,
        attackPower: 10,
        defense: 0,
        attackIntervalMs: 2_000,
        attackRangeM: 75
      }
    }))
  } as unknown as ProgressionService;
  const combatProfiles = {
    getOrCreate: vi.fn(async () => ({
      playerId: "player-1",
      maxHealth: 100,
      currentHealth: 100,
      baseAttackDamage: 10,
      defense: 0,
      persistenceVersion: 1
    })),
    persistProfiles: vi.fn(async () => undefined)
  } as unknown as CombatProfileService;
  const manorRuntime = options.manor ? new ManorRuntime() : undefined;
  const manorPresence = options.manor ? {
    load: vi.fn(async () => null),
    status: vi.fn(async () => null),
    listBuiltNear: vi.fn(async () => []),
    builtManor: vi.fn(async (manorId: string) => manorId ===
      "00000000-0000-4000-8000-000000000077"
      ? {
          manorId,
          ownerPlayerId: "owner-player",
          ownerUsername: "Owner",
          regionCode: null,
          lat: 35,
          lon: -106,
          sourceFlagId: null,
          builtAt: "2026-07-29T00:00:00.000Z",
          placementRevision: 1
        }
      : null)
  } as unknown as ManorPresenceService : undefined;

  await app.register(cookie);
  installAuthGuard(app, config, authService);
  await registerRealtime({
      infrastructure: {
          app: app,
          registry: registry,
          logger: logger,
          config: config
      },
      authority: {
          gameState: gameState,
          flagService: { listFlags: vi.fn(async () => []) } as unknown as FlagService,
          playerService: playerService,
          auth: authService,
      },
      capabilities: {
          ...worldBootstrapLocationFixtures(),
          combat: combat,
          combatProfiles: combatProfiles,
          progression: progression,
          equipment: equipment as unknown as EquipmentService,
          manorPresence,
          manorRuntime
      }
  });
  await app.ready();
  const messages: ServerMessage[] = [];
  const rawMessages: string[] = [];
  const openSocket = async () => {
    const opened = await app.injectWS("/ws", {
      headers: {
        origin: config.CLIENT_ORIGIN,
        cookie: "aa_session_dev=test-session"
      }
    });
    opened.on("message", (data) => {
      rawMessages.push(data.toString());
      messages.push(JSON.parse(data.toString()) as ServerMessage);
    });
    return opened;
  };
  let socket = await openSocket();

  return {
    app,
    get socket() {
      return socket;
    },
    messages,
    rawMessages,
    reconnect: async () => {
      socket = await openSocket();
      return socket;
    },
    combat,
    equipment,
    appliedEquipmentUpdates,
    currentSnapshot: () => current,
    pendingActivation: () => pending,
    enterManor: (accessSource: ManorOccupantAccessSource) => manorRuntime!.restore(
      "player-1",
      "00000000-0000-4000-8000-000000000077",
      accessSource,
      { x: MANOR_SMITH.x, y: MANOR_SMITH.y + 80 }
    ),
    ejectManor: (sessionId: string) => manorRuntime!.exit("player-1", sessionId),
    close: async () => {
      socket.terminate();
      await vi.waitFor(() => {
        expect(equipment.flushAndRelease).toHaveBeenCalled();
      });
      await app.close();
    }
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function equipmentSnapshot(input: {
  activeMelee: "starter_sword" | "training_axe";
  activeKitIndex: 1 | 2;
  activeRevision: number;
  checkpointRevision?: number;
  inventoryRevision?: number;
  readiedWeaponSlot?: "melee" | "secondary";
  swordLevel?: number;
  characterLevel?: number;
}): EquipmentSnapshotV2 {
  const breastPlateId = requireEquipmentDefinition("breast_plate").definitionId;
  const descriptors = [
    ["training_heavy_helm", IDS.helm, 0],
    [breastPlateId, IDS.chest, 0],
    ["training_heavy_gloves", IDS.gloves, 0],
    ["training_heavy_boots", IDS.boots, 0],
    ["training_ring", IDS.ring, 0],
    ["starter_sword", IDS.sword, input.swordLevel ?? 0],
    ["starter_bow", IDS.bow, 0],
    ["training_axe", IDS.axe, 5],
    ["training_shield", IDS.shield, 0]
  ] as const;
  const savedKitIndices: Record<string, CombatKitIndex[]> = {
    starter_sword: [1],
    god_sword: [],
    starter_bow: [1, 2],
    starter_staff: [],
    starter_shuriken: [],
    starter_wand: [],
    padded_tunic: [],
    chain_armor: [],
    training_axe: [2],
    training_heavy_helm: [1, 2, 3],
    [breastPlateId]: [1, 2, 3],
    training_heavy_gloves: [1, 2, 3],
    training_heavy_boots: [1, 2, 3],
    training_light_hood: [],
    training_light_gloves: [],
    training_light_boots: [],
    training_ring: [1, 2, 3],
    chopping_ring: [],
    mining_ring: [],
    attack_ring: [],
    training_shield: [3],
    ranged_shield: []
  };
  const instances = descriptors.map(([definitionId, instanceId, itemLevel]) => {
    const definition = requireEquipmentDefinition(definitionId);
    const equippedSlot =
      definitionId === input.activeMelee
        ? "melee"
        : definitionId === "starter_bow"
          ? "secondary"
          : definitionId.startsWith("training_heavy_") ||
              definitionId === breastPlateId ||
              definitionId === "training_ring"
            ? definition.slot
            : null;
    const derived = resolveEquipmentItemDerivedStats({
      item: { instanceId, definition, itemLevel },
      slot: definition.slot,
      classId: "warrior"
    });
    return {
      instanceId,
      definitionId,
      displayName: definition.displayName,
      ownerPlayerId: "player-1",
      location: equippedSlot === null ? "inventory" : "equipped",
      equippedSlot,
      itemLevel,
      maximumItemLevel: MAX_EQUIPMENT_LEVEL,
      condition: 100,
      maximumCondition: 100,
      category: definition.category,
      balanceVersion: EQUIPMENT_BALANCE_VERSION,
      enchantmentIdentity: null,
      attackPowerBonus: Math.max(0, Math.round(derived.pveAttackContribution)),
      defenseBonus: Math.max(0, Math.round(derived.pveDefenseContribution)),
      weaponCategory: definition.weaponCategory,
      armorCategory: definition.armorCategory,
      twoHanded: definition.twoHanded,
      savedKitIndices: savedKitIndices[definitionId] ?? [],
      derived,
      nextUpgradeLevel: itemLevel >= MAX_EQUIPMENT_LEVEL ? null : itemLevel + 1,
      nextUpgradeCost: itemLevel >= MAX_EQUIPMENT_LEVEL ? null : String(equipmentUpgradeCost(itemLevel)),
      upgradeDisabledReason: itemLevel >= MAX_EQUIPMENT_LEVEL ? "maximum_level" : null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    } satisfies EquipmentInstanceV2;
  });
  const byDefinition = new Map(instances.map((item) => [item.definitionId, item]));
  const active = {
    head: byDefinition.get("training_heavy_helm")!,
    chest: byDefinition.get(breastPlateId)!,
    gloves: byDefinition.get("training_heavy_gloves")!,
    boots: byDefinition.get("training_heavy_boots")!,
    ring: byDefinition.get("training_ring")!,
    ring_2: null,
    melee: byDefinition.get(input.activeMelee)!,
    secondary: byDefinition.get("starter_bow")!,
    tool_axe: null,
    tool_pickaxe: null,
    tool_fishing_pole: null
  } satisfies EquipmentSlotRecord<EquipmentInstanceV2 | null>;
  const balanceLoadout: ActiveEquipmentLoadout = {
    active: Object.fromEntries(EQUIPMENT_SLOTS.map((slot) => {
      const item = active[slot];
      return [slot, item === null ? null : {
        instanceId: item.instanceId,
        definition: requireEquipmentDefinition(item.definitionId),
        itemLevel: item.itemLevel
      }];
    })) as ActiveEquipmentLoadout["active"],
    readiedWeaponSlot: input.readiedWeaponSlot ?? "melee"
  };
  const derivedStats = resolveEquipmentCombatStats({
    context: "pve",
    characterLevel: input.characterLevel ?? 0,
    classId: "warrior",
    classRank: 0,
    loadout: balanceLoadout
  });
  const kitItems = (
    melee: EquipmentInstanceV2,
    secondary: EquipmentInstanceV2
  ): EquipmentSlotRecord<EquipmentInstanceV2 | null> => ({
    ...active,
    melee,
    secondary
  });
  const emptyKit = emptyEquipmentSlots<EquipmentInstanceV2 | null>(null);
  const kits: EquipmentSnapshotV2["kits"] = [
    {
      kitIndex: 1,
      name: "Sword",
      readiedWeaponSlot: "melee",
      items: kitItems(
        byDefinition.get("starter_sword")!,
        byDefinition.get("starter_bow")!
      ),
      valid: true,
      invalidReason: null,
      revision: 1
    },
    {
      kitIndex: 2,
      name: "Axe",
      readiedWeaponSlot: "melee",
      items: kitItems(
        byDefinition.get("training_axe")!,
        byDefinition.get("starter_bow")!
      ),
      valid: true,
      invalidReason: null,
      revision: 1
    },
    {
      kitIndex: 3,
      name: "Invalid shield",
      readiedWeaponSlot: "secondary",
      items: kitItems(
        byDefinition.get("starter_sword")!,
        byDefinition.get("training_shield")!
      ),
      valid: false,
      invalidReason: "readied_secondary_not_ranged",
      revision: 1
    },
    ...([4, 5, 6] as const).map((kitIndex) => ({
      kitIndex,
      name: `Kit ${kitIndex}`,
      readiedWeaponSlot: "melee" as const,
      items: { ...emptyKit },
      valid: false,
      invalidReason: "incomplete" as const,
      revision: 0
    }))
  ];
  const totalDefenseBonus = Math.max(
    0,
    Math.round(EQUIPMENT_SLOTS.reduce(
      (total, slot) => total + (active[slot]?.derived.pveDefenseContribution ?? 0),
      0
    ))
  );
  return {
    snapshotVersion: 2,
    balanceVersion: EQUIPMENT_BALANCE_VERSION,
    playerId: "player-1",
    characterLevel: input.characterLevel ?? 25,
    repairMessage: null,
    instances,
    active,
    readiedWeaponSlot: input.readiedWeaponSlot ?? "melee",
    activeKitIndex: input.activeKitIndex,
    kits,
    inventoryRevision: input.inventoryRevision ?? 7,
    activeRevision: input.activeRevision,
    checkpointRevision: input.checkpointRevision ?? 3,
    derivedStats,
    weapon: active[input.readiedWeaponSlot ?? "melee"],
    chest: active.chest,
    totalAttackPowerBonus: Math.max(
      0,
      Math.round(
        active[input.readiedWeaponSlot ?? "melee"]?.derived.pveAttackContribution ?? 0
      )
    ),
    totalDefenseBonus
  };
}

const IDS = {
  helm: "00000000-0000-4000-8000-000000000001",
  chest: "00000000-0000-4000-8000-000000000002",
  gloves: "00000000-0000-4000-8000-000000000003",
  boots: "00000000-0000-4000-8000-000000000004",
  ring: "00000000-0000-4000-8000-000000000005",
  sword: "00000000-0000-4000-8000-000000000006",
  bow: "00000000-0000-4000-8000-000000000007",
  axe: "00000000-0000-4000-8000-000000000008",
  shield: "00000000-0000-4000-8000-000000000009"
} as const;

function hello(): string {
  return JSON.stringify({ type: "HELLO" } satisfies ClientMessage);
}

function playerRecord(): PlayerRecord {
  return {
    playerId: "player-1",
    username: "Ash",
    displayColor: "#38bdf8",
    regionCode: "NM",
    position: { lat: 35.0844, lon: -106.6504 },
    anchor: { lat: 35.0844, lon: -106.6504 },
    moveLeashRadiusM: 900,
    movementRevision: 0,
    target: null,
    online: true,
    updatedAt: new Date("2026-07-09T00:00:00.000Z")
  };
}

function messageForRequest<
  Type extends ServerMessage["type"]
>(
  messages: ServerMessage[],
  type: Type,
  requestId: string
): Extract<ServerMessage, { type: Type }> | undefined {
  return messages.find((message): message is Extract<ServerMessage, { type: Type }> =>
    message.type === type &&
    "requestId" in message &&
    message.requestId === requestId
  );
}

async function waitForMessage<Type extends ServerMessage["type"]>(
  messages: ServerMessage[],
  type: Type
): Promise<Extract<ServerMessage, { type: Type }>> {
  await vi.waitFor(() => {
    expect(messages.some((message) => message.type === type)).toBe(true);
  });
  return messages.find(
    (message): message is Extract<ServerMessage, { type: Type }> => message.type === type
  )!;
}

async function waitForRequestMessage<Type extends ServerMessage["type"]>(
  messages: ServerMessage[],
  type: Type,
  requestId: string
): Promise<Extract<ServerMessage, { type: Type }>> {
  await vi.waitFor(() => {
    expect(messageForRequest(messages, type, requestId), JSON.stringify(messages.filter((message) => message.type === "ERROR"))).toBeDefined();
  });
  return messageForRequest(messages, type, requestId)!;
}
