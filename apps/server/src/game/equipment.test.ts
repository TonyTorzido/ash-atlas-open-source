import {
  equipmentSnapshotSchema,
  type EquipmentLocation
} from "@ash-atlas/shared";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  EquipmentError,
  EquipmentService,
  projectEquipmentUpgradeEligibility,
  type EquipmentManorSmithContext
} from "./equipment.js";

describe("EquipmentService authoritative runtime", () => {
  it("reprojects every item when character level changes from 12 to 13", async () => {
    const service = new EquipmentService(createRuntimeDatabase({
      characterLevel: 12,
      itemLevelByInstanceId: Object.fromEntries(
        Object.values(IDS).map((instanceId) => [instanceId, 12])
      )
    }).pool);
    const levelTwelve = await service.connectRuntime("p1");
    expect(levelTwelve.instances.every((item) =>
      item.nextUpgradeLevel === 13
      && item.upgradeDisabledReason === null
    )).toBe(true);

    const levelThirteen = service.setRuntimeContext("p1", {
      context: "pve",
      characterLevel: 13,
      classId: "warrior",
      classRank: 0
    });
    expect(levelThirteen.characterLevel).toBe(13);
    expect(levelThirteen.instances.every((item) =>
      item.nextUpgradeLevel === 13
      && item.nextUpgradeCost !== null
      && item.upgradeDisabledReason === null
    )).toBe(true);
  });

  it.each([
    "manor_storage",
    "world_drop",
    "market_escrow",
    "market_collection"
  ] as const)("preserves %s and rejects non-carried equipment use", async (location) => {
    const database = createRuntimeDatabase({
      locationByInstanceId: { [IDS.axe]: location }
    });
    const service = new EquipmentService(database.pool);

    const connected = await service.connectRuntime("p1");
    expect(equipmentSnapshotSchema.safeParse(connected).success).toBe(true);
    expect(connected.kits[0]?.items.melee).toMatchObject({ location, equippedSlot: null });
    if (location === "manor_storage" || location === "world_drop") {
      expect(connected.instances.find((item) => item.instanceId === IDS.axe)).toMatchObject({
        location,
        equippedSlot: null
      });
    } else {
      expect(connected.instances.some((item) => item.instanceId === IDS.axe)).toBe(false);
    }
    expect(connected.kits[0]).toMatchObject({
      valid: false,
      invalidReason: "not_carried"
    });

    const refreshed = service.setRuntimeContext("p1", {
      context: "pve",
      characterLevel: 25,
      classId: "druid",
      classRank: 2
    });
    expect(equipmentSnapshotSchema.safeParse(refreshed).success).toBe(true);
    expect(refreshed.kits[0]?.items.melee).toMatchObject({ location, equippedSlot: null });
    expect(refreshed.kits[0]).toMatchObject({
      valid: false,
      invalidReason: "not_carried"
    });

    await expect(service.stageKitActivation("p1", {
      requestId: "stored-kit",
      kitIndex: 1,
      expectedInventoryRevision: 7
    })).rejects.toEqual(expect.objectContaining({
      code: "EQUIPMENT_KIT_INVALID",
      invalidReason: "not_carried"
    }));
    await expect(service.equip(
      "p1",
      IDS.axe,
      "melee",
      "stored-equip"
    )).rejects.toEqual(expect.objectContaining({
      code: "EQUIPMENT_NOT_CARRIED"
    }));
    await expect(service.upgrade(
      {
        playerId: "p1",
        accountId: "00000000-0000-4000-8000-000000000099"
      },
      IDS.axe,
      0,
      "stored-upgrade",
      undefined,
      manorSmithAuthority()
    )).rejects.toEqual(expect.objectContaining({
      code: "EQUIPMENT_NOT_CARRIED"
    }));
    expect(service.runtimeSnapshot("p1")?.kits[0]?.items.melee).toMatchObject({
      location,
      itemLevel: 0
    });
  });

  it("allows upgrades beyond character level while preserving the Level-25 maximum", () => {
    expect(projectEquipmentUpgradeEligibility({
      itemLevel: 24,
      characterLevel: 1,
      owned: true,
      destroyed: false
    })).toMatchObject({
      nextUpgradeLevel: 25,
      upgradeDisabledReason: null
    });
    expect(projectEquipmentUpgradeEligibility({
      itemLevel: 24,
      characterLevel: 25,
      owned: true,
      destroyed: false
    })).toMatchObject({ nextUpgradeLevel: 25, upgradeDisabledReason: null });
    expect(projectEquipmentUpgradeEligibility({
      itemLevel: 25,
      characterLevel: 25,
      owned: true,
      destroyed: false
    })).toEqual({
      nextUpgradeLevel: null,
      nextUpgradeCost: null,
      upgradeDisabledReason: "maximum_level"
    });
  });

  it("loads explicit level 0, reserves activation durably, and applies it without tick-path DB I/O", async () => {
    const database = createRuntimeDatabase();
    const service = new EquipmentService(database.pool);
    const connected = await service.connectRuntime("p1", {
      context: "pvp_open_world",
      characterLevel: 12,
      classId: "warrior",
      classRank: 7
    });

    expect(connected.snapshotVersion).toBe(2);
    expect(connected.kits).toHaveLength(6);
    expect(connected.kits[0]).toMatchObject({
      kitIndex: 1,
      valid: true,
      invalidReason: null,
      readiedWeaponSlot: "secondary"
    });
    expect(connected.kits[1]).toMatchObject({
      kitIndex: 2,
      valid: false,
      invalidReason: "readied_secondary_not_ranged"
    });
    expect(connected.instances.every((item) => item.itemLevel === 0)).toBe(true);
    expect(connected.instances.find((item) => item.definitionId === "training_axe"))
      .toMatchObject({ itemLevel: 0, nextUpgradeLevel: 1, nextUpgradeCost: "10" });
    expect(connected.active.melee?.definitionId).toBe("starter_sword");

    const staged = await service.stageKitActivation("p1", {
      requestId: "activate-one",
      kitIndex: 1,
      expectedInventoryRevision: 7
    });
    expect(staged).toMatchObject({
      requestId: "activate-one",
      kitIndex: 1,
      inventoryRevision: 7,
      activeRevision: 4,
      activationTick: null,
      replayed: false
    });
    expect(staged.equipment.active.melee?.definitionId).toBe("training_axe");
    expect(staged.equipment.readiedWeaponSlot).toBe("secondary");
    expect(Object.isFrozen(staged.equipment)).toBe(true);

    expect((await service.stageKitActivation("p1", {
      requestId: "activate-one",
      kitIndex: 1,
      expectedInventoryRevision: 7
    })).replayed).toBe(true);
    service.setRuntimeContext("p1", {
      context: "pvp_open_world",
      characterLevel: 25,
      classId: "warrior",
      classRank: 15
    });
    expect(service.runtimeSnapshot("p1")?.derivedStats.characterLevel).toBe(25);
    expect(service.pendingActivation("p1")?.equipment.derivedStats).toMatchObject({
      characterLevel: 25,
      classRank: 15
    });
    await expect(service.stageKitActivation("p1", {
      requestId: "stale",
      kitIndex: 1,
      expectedInventoryRevision: 6
    })).rejects.toEqual(expect.objectContaining({
      code: "EQUIPMENT_ACTIVATION_PENDING"
    }));

    const queryCountBeforeApply = database.queryCount();
    const applied = service.markActivationApplied("p1", "activate-one", 42);
    expect(database.queryCount()).toBe(queryCountBeforeApply);
    expect(applied).toMatchObject({
      activationTick: 42,
      activeRevision: 4,
      replayed: false
    });
    expect(service.runtimeSnapshot("p1")?.active.melee?.definitionId).toBe("training_axe");
    expect(service.peekDirtyCheckpoints()).toEqual([
      expect.objectContaining({
        playerId: "p1",
        inventoryRevision: 7,
        activeRevision: 4,
        readiedWeaponSlot: "secondary"
      })
    ]);

    await service.flushDirtyCheckpoints();
    expect(service.peekDirtyCheckpoints()).toEqual([]);
    expect(service.runtimeSnapshot("p1")?.checkpointRevision).toBe(4);
    expect(database.checkpointWrites()).toBe(1);
  });

  it("projects the persisted ranged weapon as the authoritative readied weapon", async () => {
    const database = createRuntimeDatabase({ persistedReadiedWeaponSlot: "secondary" });
    const service = new EquipmentService(database.pool);

    const snapshot = await service.connectRuntime("p1", {
      context: "pve",
      characterLevel: 25,
      classId: "ninja",
      classRank: 1
    });

    expect(snapshot).toMatchObject({
      readiedWeaponSlot: "secondary",
      weapon: { definitionId: "starter_bow" },
      derivedStats: {
        readiedWeaponSlot: "secondary",
        readiedWeaponCategory: "bow",
        attackRangeM: 300
      }
    });
  });

  it("rejects stale revisions and invalid shield readiness precisely", async () => {
    const service = new EquipmentService(createRuntimeDatabase().pool);
    await service.connectRuntime("p1");

    await expect(service.stageKitActivation("p1", {
      requestId: "stale",
      kitIndex: 1,
      expectedInventoryRevision: 0
    })).rejects.toEqual(expect.objectContaining({
      code: "EQUIPMENT_STALE_INVENTORY_REVISION"
    }));
    await expect(service.stageKitActivation("p1", {
      requestId: "shield",
      kitIndex: 2,
      expectedInventoryRevision: 7
    })).rejects.toEqual(expect.objectContaining({
      code: "EQUIPMENT_KIT_INVALID",
      invalidReason: "readied_secondary_not_ranged"
    }));
  });

  it("retains a saved-kit reference when its equipment instance is missing", async () => {
    const database = createRuntimeDatabase({
      missingEquipmentInstanceId: IDS.helm
    });
    const service = new EquipmentService(database.pool);

    const snapshot = await service.connectRuntime("p1");

    expect(snapshot.kits[0]).toMatchObject({
      valid: false,
      invalidReason: "missing_item",
      items: { head: null }
    });
    expect(database.kitReferenceCount(1)).toBe(7);
  });

  it("advances active revisions only when the upgraded instance is active", async () => {
    const database = createRuntimeDatabase();
    const service = new EquipmentService(database.pool);
    await service.connectRuntime("p1");

    const activeUpgrade = await service.upgrade(
      {
        playerId: "p1",
        accountId: "00000000-0000-4000-8000-000000000099"
      },
      IDS.bow,
      0,
      "active-upgrade",
      {
        context: "pvp_open_world",
        characterLevel: 1,
        classId: "warrior",
        classRank: 1
      },
      manorSmithAuthority()
    );
    expect(activeUpgrade.equipment).toMatchObject({
      inventoryRevision: 8,
      activeRevision: 4,
      checkpointRevision: 4
    });

    const inventoryUpgrade = await service.upgrade(
      {
        playerId: "p1",
        accountId: "00000000-0000-4000-8000-000000000099"
      },
      IDS.axe,
      0,
      "inventory-upgrade",
      {
        context: "pvp_open_world",
        characterLevel: 1,
        classId: "warrior",
        classRank: 1
      },
      manorSmithAuthority()
    );
    expect(inventoryUpgrade.equipment).toMatchObject({
      inventoryRevision: 9,
      activeRevision: 4,
      checkpointRevision: 4
    });
  });

  it("records stable manor smith authority and rechecks the runtime fence before spending", async () => {
    const database = createRuntimeDatabase();
    const service = new EquipmentService(database.pool);
    await service.connectRuntime("p1");
    const authorize = vi.fn(async () => undefined);

    await service.upgrade(
      {
        playerId: "p1",
        accountId: "00000000-0000-4000-8000-000000000099"
      },
      IDS.axe,
      0,
      "manor-smith-upgrade",
      {
        context: "pvp_open_world",
        characterLevel: 1,
        classId: "warrior",
        classRank: 1
      },
      {
        kind: "manor_smith",
        manorId: "00000000-0000-4000-8000-000000000077",
        manorSessionId: "00000000-0000-4000-8000-000000000066",
        movementSequence: 4,
        authorize
      }
    );

    expect(authorize).toHaveBeenCalledOnce();
    expect(database.cityFacilityAuthorizations()).toBe(0);
    expect(database.lastUpgradeAuthority()).toEqual({
      facilityStructureId: null,
      authorityKind: "manor_smith",
      authoritySource: "00000000-0000-4000-8000-000000000077",
      runtimeAuthoritySessionId: "00000000-0000-4000-8000-000000000066",
      movementSequence: 4
    });
  });

  it("bounds connected authoritative runtime state", async () => {
    const database = createRuntimeDatabase();
    const service = new EquipmentService(database.pool, { runtimeCapacity: 1 });
    await service.connectRuntime("p1");
    await expect(service.connectRuntime("p2")).rejects.toEqual(expect.objectContaining({
      code: "EQUIPMENT_RUNTIME_CAPACITY"
    }));
    await service.flushAndRelease("p1");
    expect(service.runtimeSnapshot("p1")).toBeNull();
  });

  it("abandons an unapplied staged activation when releasing a connection", async () => {
    const database = createRuntimeDatabase();
    const service = new EquipmentService(database.pool);
    await service.connectRuntime("p1");
    await service.stageKitActivation("p1", {
      requestId: "disconnect-before-tick",
      kitIndex: 1,
      expectedInventoryRevision: 7
    });

    await service.flushAndRelease("p1");

    expect(service.runtimeSnapshot("p1")).toBeNull();
    expect(database.checkpointWrites()).toBe(0);
  });

  it("restages a durable pending request after disconnect and replays its completed result", async () => {
    const database = createRuntimeDatabase({ validSecondKit: true });
    const firstRuntime = new EquipmentService(database.pool);
    await firstRuntime.connectRuntime("p1");
    await firstRuntime.stageKitActivation("p1", {
      requestId: "disconnect-durable-activation",
      kitIndex: 1,
      expectedInventoryRevision: 7
    });
    await firstRuntime.flushAndRelease("p1");

    const reconnectedRuntime = new EquipmentService(database.pool);
    await reconnectedRuntime.connectRuntime("p1");
    const restaged = await reconnectedRuntime.stageKitActivation("p1", {
      requestId: "disconnect-durable-activation",
      kitIndex: 1,
      expectedInventoryRevision: 7
    });
    expect(restaged).toMatchObject({
      activationTick: null,
      replayed: true,
      activeRevision: 4
    });
    reconnectedRuntime.markActivationApplied("p1", restaged.requestId, 27);
    await reconnectedRuntime.flushDirtyCheckpoints();
    await reconnectedRuntime.flushAndRelease("p1");

    const finalRuntime = new EquipmentService(database.pool);
    const finalSnapshot = await finalRuntime.connectRuntime("p1");
    const replay = await finalRuntime.stageKitActivation("p1", {
      requestId: "disconnect-durable-activation",
      kitIndex: 1,
      expectedInventoryRevision: 7
    });
    expect(replay).toMatchObject({
      activationTick: 27,
      replayed: true,
      activeRevision: 4
    });
    expect(finalSnapshot).toMatchObject({
      activeKitIndex: 1,
      activeRevision: 4,
      checkpointRevision: 4
    });
    expect(finalRuntime.pendingActivation("p1")).toBeNull();
    expect(finalRuntime.peekDirtyCheckpoints()).toEqual([]);
    expect(database.checkpointWrites()).toBe(1);
  });

  it("completes every coalesced activation once and never reactivates an older replay", async () => {
    const database = createRuntimeDatabase({ validSecondKit: true });
    const service = new EquipmentService(database.pool);
    await service.connectRuntime("p1");

    const first = await service.stageKitActivation("p1", {
      requestId: "coalesced-one",
      kitIndex: 1,
      expectedInventoryRevision: 7
    });
    service.markActivationApplied("p1", first.requestId, 40);
    const second = await service.stageKitActivation("p1", {
      requestId: "coalesced-two",
      kitIndex: 2,
      expectedInventoryRevision: 7
    });
    service.markActivationApplied("p1", second.requestId, 41);
    expect(service.peekDirtyCheckpoints()[0]?.activations.map(
      (activation) => activation.requestId
    )).toEqual(["coalesced-one", "coalesced-two"]);

    await service.flushDirtyCheckpoints();
    await service.flushAndRelease("p1");

    const reconnected = new EquipmentService(database.pool);
    const snapshot = await reconnected.connectRuntime("p1");
    const firstReplay = await reconnected.stageKitActivation("p1", {
      requestId: "coalesced-one",
      kitIndex: 1,
      expectedInventoryRevision: 7
    });
    const secondReplay = await reconnected.stageKitActivation("p1", {
      requestId: "coalesced-two",
      kitIndex: 2,
      expectedInventoryRevision: 7
    });
    expect(firstReplay).toMatchObject({ activationTick: 40, replayed: true });
    expect(secondReplay).toMatchObject({ activationTick: 41, replayed: true });
    expect(snapshot).toMatchObject({
      activeKitIndex: 2,
      activeRevision: 5,
      checkpointRevision: 5
    });
    expect(reconnected.pendingActivation("p1")).toBeNull();
    expect(reconnected.peekDirtyCheckpoints()).toEqual([]);
    expect(database.checkpointWrites()).toBe(1);
  });

  it("prunes older completions when a newer activation is staged during checkpoint I/O", async () => {
    let releaseCheckpoint!: () => void;
    const checkpointGate = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve;
    });
    const database = createRuntimeDatabase({
      validSecondKit: true,
      checkpointCompletionGate: checkpointGate
    });
    const service = new EquipmentService(database.pool);
    await service.connectRuntime("p1");
    const first = await service.stageKitActivation("p1", {
      requestId: "overlap-one",
      kitIndex: 1,
      expectedInventoryRevision: 7
    });
    service.markActivationApplied("p1", first.requestId, 70);

    const firstFlush = service.flushDirtyCheckpoints();
    await vi.waitFor(() => {
      expect(database.checkpointWrites()).toBe(1);
    });
    const second = await service.stageKitActivation("p1", {
      requestId: "overlap-two",
      kitIndex: 2,
      expectedInventoryRevision: 7
    });
    service.markActivationApplied("p1", second.requestId, 71);
    releaseCheckpoint();
    await firstFlush;

    expect(service.peekDirtyCheckpoints()).toEqual([
      expect.objectContaining({
        activeRevision: 5,
        activations: [
          expect.objectContaining({ requestId: "overlap-two" })
        ]
      })
    ]);
    await service.flushDirtyCheckpoints();
    expect(service.peekDirtyCheckpoints()).toEqual([]);
    expect(database.checkpointWrites()).toBe(2);
  });

  it("bounds unapplied activation completions before reserving another request", async () => {
    const database = createRuntimeDatabase({ validSecondKit: true });
    const service = new EquipmentService(database.pool);
    await service.connectRuntime("p1");
    for (let offset = 0; offset < 64; offset += 1) {
      const staged = await service.stageKitActivation("p1", {
        requestId: `bounded-${offset}`,
        kitIndex: offset % 2 === 0 ? 1 : 2,
        expectedInventoryRevision: 7
      });
      service.markActivationApplied("p1", staged.requestId, 100 + offset);
    }
    const queryCountAtCapacity = database.queryCount();
    await expect(service.stageKitActivation("p1", {
      requestId: "bounded-overflow",
      kitIndex: 1,
      expectedInventoryRevision: 7
    })).rejects.toEqual(expect.objectContaining({
      code: "EQUIPMENT_RUNTIME_CAPACITY"
    }));
    expect(database.queryCount()).toBe(queryCountAtCapacity);
    expect(service.peekDirtyCheckpoints()[0]?.activations).toHaveLength(64);
  });

  it("clears only an invalid persisted active marker and preserves the partial owned loadout", async () => {
    const database = createRuntimeDatabase({
      missingEquipmentInstanceId: IDS.helm,
      persistedActiveKitIndex: 1,
      persistedReadiedWeaponSlot: "secondary"
    });
    const service = new EquipmentService(database.pool);

    const snapshot = await service.connectRuntime("p1");

    expect(snapshot.activeKitIndex).toBeNull();
    expect(snapshot.kits[0]).toMatchObject({
      valid: false,
      invalidReason: "missing_item"
    });
    expect(snapshot.active).toMatchObject({
      head: null,
      chest: { instanceId: IDS.chest },
      gloves: { instanceId: IDS.gloves },
      boots: { instanceId: IDS.boots },
      ring: { instanceId: IDS.ring },
      melee: { instanceId: IDS.sword },
      secondary: { instanceId: IDS.bow }
    });
    expect(snapshot.readiedWeaponSlot).toBe("secondary");
    expect(database.persistedState()).toEqual({
      activeKitIndex: null,
      readiedWeaponSlot: "secondary"
    });
    expect(database.stateRepairWrites()).toBe(1);
    expect(database.equipmentCount()).toBe(8);
    expect(database.kitReferenceCount(1)).toBe(7);
    expect(database.checkpointWrites()).toBe(0);
  });

  it("preserves +25 equipment on a level-one character through reconnect", async () => {
    const database = createRuntimeDatabase({
      characterLevel: 1,
      persistedActiveKitIndex: 1,
      persistedReadiedWeaponSlot: "secondary",
      itemLevelByInstanceId: {
        [IDS.chest]: 25
      }
    });
    const service = new EquipmentService(database.pool);

    const snapshot = await service.connectRuntime("p1");

    expect(snapshot).toMatchObject({
      characterLevel: 1,
      inventoryRevision: 7,
      activeRevision: 3,
      checkpointRevision: 3,
      activeKitIndex: null,
      readiedWeaponSlot: "secondary",
      repairMessage: null,
      active: {
        chest: { itemLevel: 25 }
      }
    });
    expect(snapshot.instances.find((item) => item.instanceId === IDS.chest))
      .toMatchObject({
        location: "equipped",
        equippedSlot: "chest",
        itemLevel: 25
      });
    expect(snapshot.kits[0]).toMatchObject({
      valid: true,
      invalidReason: null,
      items: {
        chest: {
          instanceId: IDS.chest,
          itemLevel: 25
        }
      }
    });
    expect(database.kitReferenceCount(1)).toBe(7);
  });

  it("upgrades anywhere above character level with the existing gold transaction", async () => {
    const database = createRuntimeDatabase({ characterLevel: 0 });
    const service = new EquipmentService(database.pool);
    await service.connectRuntime("p1");

    await expect(service.upgrade(
      {
        playerId: "p1",
        accountId: "00000000-0000-4000-8000-000000000099"
      },
      IDS.bow,
      0,
      "inventory-upgrade",
      {
        context: "pvp_open_world",
        characterLevel: 25,
        classId: "warrior",
        classRank: 15
      }
    )).resolves.toMatchObject({ levelBefore: 0, levelAfter: 1, goldCost: "10", goldBalance: "90" });
    expect(service.runtimeSnapshot("p1")).toMatchObject({
      characterLevel: 0,
      inventoryRevision: 8,
      activeRevision: 4,
      checkpointRevision: 4
    });
  });

  it("exposes stable error codes", () => {
    const error = new EquipmentError(
      "EQUIPMENT_STALE_LEVEL",
      "stale"
    );
    expect(error).toMatchObject({
      name: "EquipmentError",
      code: "EQUIPMENT_STALE_LEVEL",
      invalidReason: null
    });
  });
});

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

type EquipmentTestRow = {
  instance_id: string;
  definition_id: string;
  owner_player_id: string;
  location: EquipmentLocation;
  equipped_slot: string | null;
  item_level: number;
  balance_version: number;
  enchantment_identity: null;
  created_at: Date;
  updated_at: Date;
};

function manorSmithAuthority(): EquipmentManorSmithContext {
  return {
    kind: "manor_smith",
    manorId: "00000000-0000-4000-8000-000000000077",
    manorSessionId: "00000000-0000-4000-8000-000000000066",
    movementSequence: 4,
    authorize: vi.fn(async () => undefined)
  };
}

function createRuntimeDatabase(options?: {
  missingEquipmentInstanceId?: string;
  validSecondKit?: boolean;
  persistedActiveKitIndex?: number | null;
  persistedReadiedWeaponSlot?: "melee" | "secondary";
  checkpointCompletionGate?: Promise<void>;
  characterLevel?: number;
  itemLevelByInstanceId?: Partial<Record<string, number>>;
  locationByInstanceId?: Partial<Record<string, EquipmentLocation>>;
}): {
  pool: pg.Pool;
  queryCount(): number;
  checkpointWrites(): number;
  kitReferenceCount(kitIndex: number): number;
  equipmentCount(): number;
  persistedState(): {
    activeKitIndex: number | null;
    readiedWeaponSlot: "melee" | "secondary";
  };
  stateRepairWrites(): number;
  cityFacilityAuthorizations(): number;
  lastUpgradeAuthority(): {
    facilityStructureId: string | null;
    authorityKind: string;
    authoritySource: string | null;
    runtimeAuthoritySessionId: string | null;
    movementSequence: number | null;
  } | null;
} {
  let queries = 0;
  let checkpointWrites = 0;
  let stateRepairWrites = 0;
  let inventoryRevision = 7;
  let activeRevision = 3;
  let checkpointRevision = 3;
  let readiedWeaponSlot: "melee" | "secondary" =
    options?.persistedReadiedWeaponSlot ?? "melee";
  let activeKitIndex: number | null = options?.persistedActiveKitIndex ?? null;
  const characterLevel = options?.characterLevel ?? 25;
  let currentCombatGearLevel = 0;
  let unlockedCombatGearLevel = 0;
  let walletBalance = 100n;
  let walletVersion = 0n;
  let cityFacilityAuthorizations = 0;
  let lastUpgradeAuthority: {
    facilityStructureId: string | null;
    authorityKind: string;
    authoritySource: string | null;
    runtimeAuthoritySessionId: string | null;
    movementSequence: number | null;
  } | null = null;
  const upgradeOperations = new Set<string>();
  const kitOperations = new Map<string, {
    player_id: string;
    request_id: string;
    action: "activate";
    kit_index: number;
    payload: string;
    result: unknown;
    completed_at: Date | null;
  }>();
  const walletEvents = new Set<string>();
  const now = new Date(0);
  const equipment: EquipmentTestRow[] = [
    row(IDS.helm, "training_heavy_helm", "head"),
    row(IDS.chest, "breast_plate", "chest"),
    row(IDS.gloves, "training_heavy_gloves", "gloves"),
    row(IDS.boots, "training_heavy_boots", "boots"),
    row(IDS.ring, "training_ring", "ring"),
    row(IDS.sword, "starter_sword", "melee"),
    row(IDS.bow, "starter_bow", "secondary"),
    row(IDS.axe, "training_axe", null),
    row(IDS.shield, "training_shield", null)
  ].filter((item) => item.instance_id !== options?.missingEquipmentInstanceId);
  for (const item of equipment) {
    item.item_level = options?.itemLevelByInstanceId?.[item.instance_id] ?? 0;
    const location = options?.locationByInstanceId?.[item.instance_id];
    if (location) {
      item.location = location;
      if (location !== "equipped") item.equipped_slot = null;
    }
  }
  const kits = Array.from({ length: 6 }, (_, offset) => ({
    kit_index: offset + 1,
    name: `Kit ${offset + 1}`,
    readied_weapon_slot:
      offset === 0
        ? "secondary"
        : offset === 1 && !options?.validSecondKit
          ? "secondary"
          : "melee",
    revision: offset < 2 ? "1" : "0"
  }));
  const sharedKitReferences = [
    ["head", IDS.helm],
    ["chest", IDS.chest],
    ["gloves", IDS.gloves],
    ["boots", IDS.boots],
    ["ring", IDS.ring],
    ["melee", IDS.axe]
  ] as const;
  const kitItems = [
    ...sharedKitReferences.map(([equipment_slot, instance_id]) => ({
      kit_index: 1,
      equipment_slot,
      instance_id
    })),
    { kit_index: 1, equipment_slot: "secondary", instance_id: IDS.bow },
    ...sharedKitReferences.map(([equipment_slot, instance_id]) => ({
      kit_index: 2,
      equipment_slot,
      instance_id
    })),
    { kit_index: 2, equipment_slot: "secondary", instance_id: IDS.shield }
  ];

  const query = async <Row>(
    text: string,
    values?: readonly unknown[]
  ): Promise<{
    rows: Row[];
    rowCount: number;
  }> => {
    queries += 1;
    if (text === "SELECT player_id FROM player_equipment_state WHERE player_id = $1 FOR UPDATE") return one<Row>({ player_id: "p1" });
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return empty<Row>();
    if (text.includes("INSERT INTO player_progression_profiles")) return empty<Row>();
    if (text.includes("INSERT INTO equipment_operations")) {
      return one<Row>({ operation_key: values?.[0] });
    }
    if (text.includes("INSERT INTO player_equipment_state")) {
      return one<Row>({ player_id: "p1" });
    }
    if (text.includes("INSERT INTO combat_kits")) return empty<Row>();
    if (text.includes("INSERT INTO combat_kit_operations")) {
      const operationKey = String(values?.[0]);
      if (kitOperations.has(operationKey)) return empty<Row>();
      kitOperations.set(operationKey, {
        player_id: String(values?.[1]),
        request_id: String(values?.[2]),
        action: "activate",
        kit_index: Number(values?.[3]),
        payload: String(values?.[4]),
        result: null,
        completed_at: null
      });
      return one<Row>({ operation_key: operationKey });
    }
    if (text.includes("FROM combat_kit_operations")) {
      const operation = kitOperations.get(String(values?.[0]));
      return operation
        ? one<Row>({
            ...operation,
            payload_matches:
              values?.[1] === undefined ||
              operation.payload === String(values[1])
          })
        : empty<Row>();
    }
    if (text.includes("UPDATE combat_kit_operations")) {
      const operation = kitOperations.get(String(values?.[0]));
      if (!operation || operation.completed_at) return empty<Row>();
      await options?.checkpointCompletionGate;
      operation.result = JSON.parse(String(values?.[1]));
      operation.completed_at = now;
      return one<Row>({ operation_key: values?.[0] });
    }
    if (text.includes("INSERT INTO equipment_upgrade_operations")) {
      const operationKey = String(values?.[0]);
      if (upgradeOperations.has(operationKey)) return empty<Row>();
      upgradeOperations.add(operationKey);
      lastUpgradeAuthority = {
        facilityStructureId: values?.[6] === null ? null : String(values?.[6]),
        authorityKind: String(values?.[7]),
        authoritySource: values?.[8] === null ? null : String(values?.[8]),
        runtimeAuthoritySessionId: values?.[9] === null ? null : String(values?.[9]),
        movementSequence: values?.[10] === null ? null : Number(values?.[10])
      };
      return one<Row>({ operation_key: operationKey });
    }
    if (text.includes("FROM city_structures facility")) {
      cityFacilityAuthorizations += 1;
      return one<Row>({
        structure_id: "00000000-0000-4000-8000-000000000088",
        structure_type: "weaponsmith",
        tier: 1
      });
    }
    if (
      text.includes("FROM equipment_instances") &&
      text.includes("WHERE instance_id = $1") &&
      text.includes("FOR NO KEY UPDATE")
    ) {
      const item = equipment.find((candidate) => candidate.instance_id === values?.[0]);
      return item ? one<Row>(item) : empty<Row>();
    }
    if (
      text.includes("FROM equipment_instances") &&
      text.includes("WHERE instance_id = $1") &&
      text.includes("FOR UPDATE")
    ) {
      const item = equipment.find((candidate) => candidate.instance_id === values?.[0]);
      return item ? one<Row>(item) : empty<Row>();
    }
    if (text.includes("INSERT INTO player_wallets")) return empty<Row>();
    if (text.includes("FROM player_wallets") && text.includes("FOR UPDATE")) {
      return one<Row>({
        gold_balance: walletBalance.toString(),
        version: walletVersion.toString()
      });
    }
    if (text.includes("FROM wallet_events")) return empty<Row>();
    if (text.includes("UPDATE player_wallets")) {
      walletBalance -= BigInt(String(values?.[2]));
      walletVersion += 1n;
      return one<Row>({
        gold_balance: walletBalance.toString(),
        version: walletVersion.toString()
      });
    }
    if (text.includes("INSERT INTO wallet_events")) {
      walletEvents.add(String(values?.[0]));
      return empty<Row>();
    }
    if (
      text.includes("UPDATE equipment_instances") &&
      text.includes("SET item_level = item_level + 1")
    ) {
      const item = equipment.find((candidate) => candidate.instance_id === values?.[0]);
      if (!item || item.item_level !== values?.[1]) return empty<Row>();
      item.item_level += 1;
      return one<Row>({ item_level: item.item_level });
    }
    if (
      text.includes("UPDATE player_equipment_state") &&
      text.includes("checkpoint_revision = active_revision + 1")
    ) {
      inventoryRevision += 1;
      activeRevision += 1;
      checkpointRevision = activeRevision;
      activeKitIndex = null;
      readiedWeaponSlot = "melee";
      return one<Row>({
        inventory_revision: String(inventoryRevision),
        active_revision: String(activeRevision),
        checkpoint_revision: String(checkpointRevision)
      });
    }
    if (
      text.includes("UPDATE player_equipment_state") &&
      text.includes("inventory_revision = inventory_revision + 1")
    ) {
      inventoryRevision += 1;
      const activeDelta = Number(values?.[1] ?? 0);
      activeRevision += activeDelta;
      checkpointRevision += activeDelta;
      return empty<Row>();
    }
    if (
      text.includes("FROM player_equipment_state") &&
      text.includes("inventory_revision::text")
    ) {
      return one<Row>({
        inventory_revision: String(inventoryRevision),
        active_revision: String(activeRevision),
        checkpoint_revision: String(checkpointRevision),
        readied_weapon_slot: readiedWeaponSlot,
        active_kit_index: activeKitIndex,
        current_combat_gear_level: currentCombatGearLevel,
        unlocked_combat_gear_level: unlockedCombatGearLevel,
        challenge_profile_version: 2,
        character_level: characterLevel
      });
    }
    if (
      text.includes("SELECT level") &&
      text.includes("FROM player_progression_profiles")
    ) {
      return one<Row>({ level: characterLevel });
    }
    if (
      text.includes("UPDATE player_equipment_state equipment") &&
      text.includes("current_combat_gear_level")
    ) {
      const levelBySlot = new Map(
        equipment
          .filter((item) => item.location === "equipped" && item.equipped_slot)
          .map((item) => [item.equipped_slot!, item.item_level])
      );
      currentCombatGearLevel = Math.floor(
        ((levelBySlot.get("melee") ?? 0) +
          (levelBySlot.get("chest") ?? 0) +
          (levelBySlot.get("secondary") ?? 0)) / 3
      );
      unlockedCombatGearLevel = Math.max(
        unlockedCombatGearLevel,
        currentCombatGearLevel
      );
      return one<Row>({
        current_combat_gear_level: currentCombatGearLevel,
        unlocked_combat_gear_level: unlockedCombatGearLevel,
        challenge_profile_version: 2
      });
    }
    if (text.includes("FROM equipment_instances") && text.includes("owner_player_id = $1")) {
      return many<Row>(equipment);
    }
    if (text.includes("FROM equipment_instances") && text.includes("ANY($1::uuid[])")) {
      return many<Row>(equipment.filter((item) => Object.values(IDS).includes(
        item.instance_id as (typeof IDS)[keyof typeof IDS]
      )));
    }
    if (text.includes("FROM combat_kits")) return many<Row>(kits);
    if (text.includes("FROM combat_kit_items")) return many<Row>(kitItems);
    if (text.includes("SELECT achievement_id FROM player_achievements")) return empty<Row>();
    if (text.includes("SELECT 1 FROM player_achievements")) return empty<Row>();
    if (text.includes("UPDATE equipment_upgrade_operations")) return empty<Row>();
    if (
      text.includes("UPDATE player_equipment_state") &&
      text.includes("SET active_revision = $2::bigint")
    ) {
      activeRevision = Number(values?.[1]);
      checkpointRevision = Number(values?.[1]);
      readiedWeaponSlot = values?.[2] as "melee" | "secondary";
      activeKitIndex = values?.[3] as number | null;
      return empty<Row>();
    }
    if (
      text.includes("UPDATE player_equipment_state") &&
      text.includes("SET active_kit_index = $2")
    ) {
      activeKitIndex = values?.[1] as number | null;
      readiedWeaponSlot = values?.[2] as "melee" | "secondary";
      stateRepairWrites += 1;
      return empty<Row>();
    }
    if (
      text.includes("UPDATE equipment_instances") &&
      text.includes("location = 'inventory'") &&
      text.includes("owner_player_id = $1")
    ) {
      const selectedIds = new Set((values?.[1] as string[] | undefined) ?? []);
      for (const item of equipment) {
        if (
          item.owner_player_id !== values?.[0] ||
          item.location !== "equipped" ||
          (selectedIds.size > 0 && !selectedIds.has(item.instance_id))
        ) continue;
        item.location = "inventory";
        item.equipped_slot = null;
      }
      return empty<Row>();
    }
    if (text.includes("UPDATE equipment_instances AS equipment")) {
      const selectedIds = values?.[1] as string[];
      const selectedSlots = values?.[2] as string[];
      selectedIds.forEach((instanceId, index) => {
        const item = equipment.find((candidate) => candidate.instance_id === instanceId);
        if (!item) return;
        item.location = "equipped";
        item.equipped_slot = selectedSlots[index] ?? null;
      });
      checkpointWrites += 1;
      return empty<Row>();
    }
    if (
      text.includes("UPDATE equipment_instances") ||
      text.includes("UPDATE player_equipment_state") ||
      text.includes("INSERT INTO equipment_audit_events")
    ) {
      return empty<Row>();
    }
    throw new Error(`Unhandled equipment runtime test query: ${text}`);
  };
  const pool = {
    connect: async () => ({
      query,
      release: () => undefined
    })
  } as unknown as pg.Pool;
  return {
    pool,
    queryCount: () => queries,
    checkpointWrites: () => checkpointWrites,
    kitReferenceCount: (kitIndex) => kitItems.filter(
      (reference) => reference.kit_index === kitIndex
    ).length,
    equipmentCount: () => equipment.length,
    persistedState: () => ({ activeKitIndex, readiedWeaponSlot }),
    stateRepairWrites: () => stateRepairWrites,
    cityFacilityAuthorizations: () => cityFacilityAuthorizations,
    lastUpgradeAuthority: () => lastUpgradeAuthority
  };

  function row(
    instance_id: string,
    definition_id: string,
    equipped_slot: string | null
  ): EquipmentTestRow {
    return {
      instance_id,
      definition_id,
      owner_player_id: "p1",
      location: equipped_slot ? "equipped" : "inventory",
      equipped_slot,
      item_level: 0,
      balance_version: 1,
      enchantment_identity: null,
      created_at: now,
      updated_at: now
    };
  }
}

function one<Row>(row: unknown): { rows: Row[]; rowCount: number } {
  return { rows: [row as Row], rowCount: 1 };
}

function many<Row>(rows: unknown[]): { rows: Row[]; rowCount: number } {
  return { rows: rows as Row[], rowCount: rows.length };
}

function empty<Row>(): { rows: Row[]; rowCount: number } {
  return { rows: [], rowCount: 0 };
}
