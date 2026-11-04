import { describe, expect, it } from "vitest";

import {
  CISTERN_WARRENS_DUNGEON,
  DUNGEON_CHEST_RARITIES,
  DUNGEON_CATALOG,
  cisternWarrensRoomDefinition,
  dungeonCatalogValidationIssues,
  dungeonDefinition,
  developerDungeonEntranceTemplates,
  isCisternWarrensSpaceId,
  parseDungeonCatalog,
  type DungeonCatalog
} from "./dungeonCatalog.js";

/** The dungeons view is alphabetical by id, so never assume the sewer is first. */
const sewerOf = (catalog: DungeonCatalog) => catalog.dungeons.find((dungeon) => dungeon.id === "cistern_warrens")!;

describe("dungeon catalog", () => {
  it("parses the canonical catalog and exposes stable lookup helpers", () => {
    expect(DUNGEON_CATALOG.schemaVersion).toBe(2);
    expect(parseDungeonCatalog(structuredClone(DUNGEON_CATALOG))).toEqual(DUNGEON_CATALOG);
    expect(dungeonDefinition("cistern_warrens")).toBe(CISTERN_WARRENS_DUNGEON);
    expect(cisternWarrensRoomDefinition("overflow_channel").width).toBe(1_600);
    expect(DUNGEON_CATALOG.prefabs).toContainEqual(expect.objectContaining({
      id: "dungeon_chest", revision: "dungeon-chest-v2", type: "object",
      retired: false, defaultWidth: 92, defaultHeight: 74, defaultLayerId: "actors",
      assetKey: "apps/client/public/assets/dungeons/shared/chest-closed.png"
    }));
    expect(DUNGEON_CATALOG.entrances).toContainEqual(expect.objectContaining({
      id: "cistern_warrens_world_entrance",
      dungeonId: "cistern_warrens",
      portalId: "world-to-entrance",
      name: "Cistern Warrens Entrance",
      interactionLabel: "Enter Cistern Warrens",
      lat: 61.6667,
      lon: -114.0,
      assetKey: "apps/client/public/assets/dungeons/cistern_warrens/entrance.png",
      retired: false
    }));
    expect(cisternWarrensRoomDefinition("hatch_landing").layers.background[0]).toMatchObject({
      x: 0, y: 0, width: 1_000, height: 1_000,
      rotationDeg: 0, opacity: 1, flipX: false, flipY: false, zIndex: 0
    });
    expect(isCisternWarrensSpaceId("hatch_landing")).toBe(true);
    expect(isCisternWarrensSpaceId("unknown_room")).toBe(false);
  });

  it("defaults source-controlled entrances and reward definitions for recovered catalogs", () => {
    const legacy = structuredClone(DUNGEON_CATALOG) as Partial<DungeonCatalog>;
    legacy.dungeons = [structuredClone(CISTERN_WARRENS_DUNGEON)];
    delete legacy.entrances;
    delete legacy.rewardTables;
    legacy.rewardTableIds = [];
    for (const dungeon of legacy.dungeons ?? []) {
      dungeon.rewardTableIds = [];
      dungeon.triggers = dungeon.triggers.filter((trigger) =>
        !trigger.actions.some((action) => action.type === "grant_reward" || action.type === "grant_run_reward"));
      for (const room of dungeon.rooms) for (const object of room.objects) delete object.rewardTableId;
    }
    expect(parseDungeonCatalog(legacy)).toMatchObject({ entrances: [], rewardTables: [] });
  });

  it("retains a retired entrance identity while disabling its world portal", () => {
    const catalog = structuredClone(DUNGEON_CATALOG);
    const entrance = catalog.entrances[0]!;
    const dungeon = catalog.dungeons.find((candidate) => candidate.id === entrance.dungeonId)!;
    const portal = dungeon.portals.find((candidate) => candidate.id === entrance.portalId)!;
    entrance.retired = true;
    portal.enabled = false;
    expect(dungeonCatalogValidationIssues(catalog)).toEqual([]);
    entrance.retired = false;
    expect(dungeonCatalogValidationIssues(catalog)).toEqual(expect.arrayContaining([expect.objectContaining({ path: "entrances.0.portalId" })]));
  });

  it("rejects instance reward triggers whose events cannot identify a player", () => {
    const events = [
      { type: "timer", delayMs: 0 },
      { type: "encounter_state", encounterId: "overflow-rats", state: "completed" },
      { type: "room_clear", roomId: "overflow_channel" },
      { type: "dungeon_flag", flagId: "cleared", value: true }
    ] as const;
    for (const event of events) {
      const catalog = structuredClone(DUNGEON_CATALOG);
      const dungeon = sewerOf(catalog);
      dungeon.rewardTableIds = ["basic_dungeon_chest"];
      const trigger = dungeon.triggers[0]!;
      trigger.scope = "instance";
      trigger.event = event;
      trigger.actions = [{ type: "grant_reward", rewardTableId: "basic_dungeon_chest" }];
      expect(dungeonCatalogValidationIssues(catalog)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringContaining("actions.0"),
          message: "instance-scoped reward trigger cannot resolve a player identity"
        })
      ]));
    }

    const playerTimer = structuredClone(DUNGEON_CATALOG);
    sewerOf(playerTimer).rewardTableIds = [...sewerOf(playerTimer).rewardTableIds, "basic_dungeon_chest"];
    sewerOf(playerTimer).triggers[0] = {
      ...sewerOf(playerTimer).triggers[0]!, scope: "player",
      event: { type: "timer", delayMs: 0 },
      actions: [{ type: "grant_reward", rewardTableId: "basic_dungeon_chest" }]
    };
    expect(dungeonCatalogValidationIssues(playerTimer)).toEqual([]);
  });

  it("preserves the authored Sewer anchors, objects, rooms, and portal content", () => {
    const hatch = cisternWarrensRoomDefinition("hatch_landing");
    const overflow = cisternWarrensRoomDefinition("overflow_channel");
    const warden = cisternWarrensRoomDefinition("warden_junction");
    const brood = cisternWarrensRoomDefinition("brood_chamber");
    expect(CISTERN_WARRENS_DUNGEON.rooms.map((room) => room.id)).toEqual([
      "hatch_landing", "overflow_channel", "turtle_cistern", "warden_junction", "webbed_tunnels", "brood_chamber"
    ]);
    expect(hatch).toMatchObject({
      width: 1_000, height: 1_000, spawnAnchorId: "spawn",
      anchors: expect.arrayContaining([
        expect.objectContaining({ id: "spawn", x: 500, y: 200 }),
        expect.objectContaining({ id: "world_exit", x: 500, y: 60, facing: -Math.PI / 2 }),
        expect.objectContaining({ id: "door_e", x: 950, y: 475, facing: 0 })
      ]),
      objects: expect.arrayContaining([
        expect.objectContaining({ id: "world-exit", portalId: "entrance-to-world", opacity: 0 }),
        expect.objectContaining({ id: "door-e", portalId: "hatch-to-overflow" })
      ])
    });
    expect(overflow).toMatchObject({
      width: 1_600, height: 800,
      layers: { background: [expect.objectContaining({ prefabId: "overflow_channel_floor", width: 1_600, height: 800 })] },
      colliders: expect.arrayContaining([
        expect.objectContaining({ id: "water_west", x: 200, y: 310, width: 280, height: 180 })
      ]),
      mobs: expect.arrayContaining([expect.objectContaining({ id: "overflow-rat-1", archetype: "sewer_rat" })])
    });
    expect(warden).toMatchObject({
      anchors: expect.arrayContaining([expect.objectContaining({ id: "boss_spawn", x: 500, y: 420 })]),
      mobs: expect.arrayContaining([
        expect.objectContaining({ id: "warden-escort-1", archetype: "sewer_rat" }),
        expect.objectContaining({ id: "rat-warden-boss", archetype: "sewer_rat_miniboss" })
      ])
    });
    expect(brood).toMatchObject({
      width: 1_400, height: 1_400,
      objects: expect.arrayContaining([
        expect.objectContaining({ id: "exit-ladder", portalId: "brood-to-world", prefabId: "sewer_exit_ladder" }),
        expect.objectContaining({ id: "brood-chest", prefabId: "dungeon_chest", available: false })
      ])
    });
    expect(CISTERN_WARRENS_DUNGEON.revision).toBe("cistern-warrens-v2");
    expect(CISTERN_WARRENS_DUNGEON.portals.map((portal) => ({
      id: portal.id,
      access: portal.accessPolicyId,
      preload: portal.preloadSceneKey,
      enabled: portal.enabled
    }))).toEqual([
      { id: "world-to-entrance", access: "sewer-entry", preload: "cistern_warrens/hatch_landing", enabled: true },
      { id: "entrance-to-world", access: undefined, preload: "world", enabled: true },
      { id: "hatch-to-overflow", access: undefined, preload: "cistern_warrens/overflow_channel", enabled: true },
      { id: "overflow-to-hatch", access: undefined, preload: "cistern_warrens/hatch_landing", enabled: true },
      { id: "overflow-to-cistern", access: undefined, preload: "cistern_warrens/turtle_cistern", enabled: true },
      { id: "cistern-to-overflow", access: undefined, preload: "cistern_warrens/overflow_channel", enabled: true },
      { id: "cistern-to-warden", access: undefined, preload: "cistern_warrens/warden_junction", enabled: true },
      { id: "warden-to-cistern", access: undefined, preload: "cistern_warrens/turtle_cistern", enabled: true },
      { id: "warden-to-webbed", access: undefined, preload: "cistern_warrens/webbed_tunnels", enabled: true },
      { id: "webbed-to-warden", access: undefined, preload: "cistern_warrens/warden_junction", enabled: true },
      { id: "webbed-to-brood", access: undefined, preload: "cistern_warrens/brood_chamber", enabled: true },
      { id: "brood-to-webbed", access: undefined, preload: "cistern_warrens/webbed_tunnels", enabled: true },
      { id: "brood-to-world", access: undefined, preload: "world", enabled: true }
    ]);
  });

  it("reports duplicate IDs, geometry bounds, broken references, and invalid graph recovery", () => {
    const duplicate = structuredClone(DUNGEON_CATALOG);
    sewerOf(duplicate).rooms.push(structuredClone(sewerOf(duplicate).rooms[0]!));
    expect(dungeonCatalogValidationIssues(duplicate)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining("duplicate ID") })
    ]));

    const outside = structuredClone(DUNGEON_CATALOG);
    sewerOf(outside).rooms[0]!.anchors[0]!.x = 1_001;
    expect(dungeonCatalogValidationIssues(outside)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "is outside room bounds" })
    ]));

    const reciprocal = structuredClone(DUNGEON_CATALOG);
    sewerOf(reciprocal).portals[0]!.reciprocalPortalId = "hatch-to-overflow";
    expect(dungeonCatalogValidationIssues(reciprocal)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "does not define a reciprocal edge" })
    ]));

    const stalePrefab = structuredClone(DUNGEON_CATALOG);
    sewerOf(stalePrefab).rooms[0]!.objects[0]!.prefabRevision = "stale-revision";
    expect(dungeonCatalogValidationIssues(stalePrefab)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "does not match the current prefab revision" })
    ]));

    const isolated = structuredClone(DUNGEON_CATALOG);
    sewerOf(isolated).portals
      .find((portal) => portal.id === "hatch-to-overflow")!.enabled = false;
    expect(dungeonCatalogValidationIssues(isolated)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "active room is unreachable from the entrance" })
    ]));

    const trapped = structuredClone(DUNGEON_CATALOG);
    for (const portal of sewerOf(trapped).portals) {
      if (portal.id === "entrance-to-world" || portal.id === "brood-to-world") portal.enabled = false;
    }
    expect(dungeonCatalogValidationIssues(trapped)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "active room has no recovery path to world" })
    ]));

    const gatedPortal = structuredClone(DUNGEON_CATALOG);
    sewerOf(gatedPortal).portals[1]!.conditions = ["unlocked"];
    sewerOf(gatedPortal).portals[1]!.gates = [
      { type: "item_owned", itemId: "rusty-key", quantity: 1 },
      { type: "quest_flag", flagId: "sewer-key", value: true }
    ];
    expect(dungeonCatalogValidationIssues(gatedPortal)).toEqual([]);
  });

  it("rejects unsafe active portal triggers, conditions, rooms, and prefab kinds", () => {
    const conditions = structuredClone(DUNGEON_CATALOG);
    sewerOf(conditions).portals[1]!.conditions = ["always", "always"];
    expect(dungeonCatalogValidationIssues(conditions)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "conditions must be unique" })
    ]));
    const emptyConditions = structuredClone(DUNGEON_CATALOG);
    sewerOf(emptyConditions).portals[1]!.conditions = [];
    expect(dungeonCatalogValidationIssues(emptyConditions)).not.toEqual([]);

    const inactive = structuredClone(DUNGEON_CATALOG);
    sewerOf(inactive).rooms[0]!.active = false;
    expect(dungeonCatalogValidationIssues(inactive)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "references inactive room hatch_landing" }),
      expect.objectContaining({ message: "active room is unreachable from the entrance" })
    ]));

    const remoteTrigger = structuredClone(DUNGEON_CATALOG);
    sewerOf(remoteTrigger).rooms[0]!.objects[0]!.anchorId = "world_entry_arrival";
    expect(dungeonCatalogValidationIssues(remoteTrigger)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "must reference a portal sourced from the same room and anchor"
      })
    ]));

    const invisibleTrigger = structuredClone(DUNGEON_CATALOG);
    sewerOf(invisibleTrigger).rooms[0]!.objects[1]!.retired = true;
    expect(dungeonCatalogValidationIssues(invisibleTrigger)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "enabled room-source portals require exactly one non-retired source-room portal object"
      })
    ]));

    const layerPrefab = structuredClone(DUNGEON_CATALOG);
    const placement = sewerOf(layerPrefab).rooms[0]!.layers.background[0]!;
    placement.prefabId = "sewer_door";
    placement.prefabRevision = "sewer-door-v1";
    expect(dungeonCatalogValidationIssues(layerPrefab)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "layer placements require a surface or decoration prefab"
      })
    ]));

    const portalPrefab = structuredClone(DUNGEON_CATALOG);
    const portalObject = sewerOf(portalPrefab).rooms[0]!.objects[0]!;
    portalObject.prefabId = "hatch_landing_floor";
    portalObject.prefabRevision = "hatch-landing-floor-v1";
    expect(dungeonCatalogValidationIssues(portalPrefab)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "portal objects require a portal prefab" })
    ]));

    const nonPortalPrefab = structuredClone(DUNGEON_CATALOG);
    sewerOf(nonPortalPrefab).rooms[0]!.objects[0]!.type = "valve";
    expect(dungeonCatalogValidationIssues(nonPortalPrefab)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "non-portal objects require an object prefab" })
    ]));

    const surfaceObject = structuredClone(DUNGEON_CATALOG);
    const surfaceBackedValve = sewerOf(surfaceObject).rooms[0]!.objects[0]!;
    surfaceBackedValve.type = "valve";
    surfaceBackedValve.prefabId = "hatch_landing_floor";
    surfaceBackedValve.prefabRevision = "hatch-landing-floor-v1";
    expect(dungeonCatalogValidationIssues(surfaceObject)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "non-portal objects require an object prefab" })
    ]));
  });

  it("enforces configured world entry, escape, available traversal, and renderer colors", () => {
    const entrance = structuredClone(DUNGEON_CATALOG);
    const entrancePortal = sewerOf(entrance).portals
      .find((portal) => portal.id === "world-to-entrance")!;
    entrancePortal.destination = {
      kind: "room", roomId: "overflow_channel", anchorId: "door_w"
    };
    entrancePortal.destinationArrivalAnchorId = "arrive_w";
    expect(dungeonCatalogValidationIssues(entrance)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "must enter from world into the configured entrance room and arrival anchor"
      })
    ]));

    const escape = structuredClone(DUNGEON_CATALOG);
    sewerOf(escape).portals
      .find((portal) => portal.id === "entrance-to-world")!.enabled = false;
    expect(dungeonCatalogValidationIssues(escape)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "must be an enabled portal from an active room to world"
      })
    ]));

    const unavailable = structuredClone(DUNGEON_CATALOG);
    sewerOf(unavailable).rooms[0]!.objects
      .find((object) => object.portalId === "entrance-to-world")!.available = false;
    sewerOf(unavailable).rooms.find((room) => room.id === "brood_chamber")!.objects
      .find((object) => object.portalId === "brood-to-world")!.available = false;
    expect(dungeonCatalogValidationIssues(unavailable)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "enabled room-source portals require an available source-room portal object"
      }),
      expect.objectContaining({ message: "active room has no recovery path to world" })
    ]));

    const blockedRoom = structuredClone(DUNGEON_CATALOG);
    sewerOf(blockedRoom).rooms[0]!.objects
      .find((object) => object.portalId === "hatch-to-overflow")!.available = false;
    expect(dungeonCatalogValidationIssues(blockedRoom)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "active room is unreachable from the entrance" })
    ]));

    const color = structuredClone(DUNGEON_CATALOG);
    sewerOf(color).environment.backgroundColor = "#fff";
    expect(dungeonCatalogValidationIssues(color)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "must be a six-digit hex color" })
    ]));
  });

  it("validates v2 assets, polygon geometry, encounters, mobs, and trigger references", () => {
    const valid = catalogWithEncounter();
    expect(dungeonCatalogValidationIssues(valid)).toEqual([]);

    const asset = structuredClone(valid);
    asset.prefabs[0]!.assetKey = "assets/floor.jpg";
    expect(dungeonCatalogValidationIssues(asset)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining("PNG under") })
    ]));
    const stateAsset = structuredClone(valid);
    stateAsset.prefabs[1]!.stateAssets.push({ stateId: "open", assetKey: "portal-open.svg" });
    expect(dungeonCatalogValidationIssues(stateAsset)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining("PNG under") })
    ]));

    const rarityArt = structuredClone(valid);
    const reward = rarityArt.rewardTables[0]!;
    reward.items = [];
    reward.chestLoot = {
      rarities: DUNGEON_CHEST_RARITIES.map((rarity) => ({
        rarity, chance: 20, slots: 1,
        ...(rarity === "legendary"
          ? { assetKey: "apps/client/public/assets/dungeons/shared/chest-closed.png" }
          : {}),
        loot: [{ itemId: "coal", weight: 1, minQuantity: 1, maxQuantity: 1 }]
      }))
    };
    expect(dungeonCatalogValidationIssues(rarityArt)).toEqual([]);
    reward.chestLoot.rarities[0]!.assetKey =
      "apps/client/public/assets/dungeons/custom/missing-chest.png";
    expect(dungeonCatalogValidationIssues(rarityArt)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "rewardTables.0.chestLoot.rarities.0.assetKey", message: "references a missing active dungeon prefab asset" })
    ]));

    const polygon = structuredClone(valid);
    sewerOf(polygon).rooms[0]!.colliders.push({
      id: "crossed", retired: false, kind: "polygon",
      points: [{ x: 200, y: 200 }, { x: 300, y: 300 }, { x: 200, y: 300 }, { x: 300, y: 200 }]
    });
    expect(dungeonCatalogValidationIssues(polygon)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "polygon must have non-zero area" })
    ]));
    const blockedSpawn = structuredClone(valid);
    sewerOf(blockedSpawn).rooms[0]!.colliders.push({
      id: "spawn_blocker", retired: false, kind: "polygon",
      points: [{ x: 450, y: 150 }, { x: 550, y: 150 }, { x: 550, y: 250 }, { x: 450, y: 250 }]
    });
    expect(dungeonCatalogValidationIssues(blockedSpawn)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "spawn anchor is not walkable" })
    ]));

    const blockedFormation = structuredClone(valid);
    const formationRoom = sewerOf(blockedFormation).rooms[0]!;
    const formationEncounter = sewerOf(blockedFormation).encounters[0]!;
    const firstPlacement = formationRoom.mobs[0]!;
    formationRoom.mobs.push({ ...firstPlacement, id: "wolf_two" });
    formationEncounter.waves[0]!.mobSpawnIds.push("wolf_two");
    formationEncounter.groupControls = { formation: "line", linkedAggro: false };
    formationRoom.colliders.push({
      id: "formation_blocker", retired: false, kind: "rectangle", x: 460, y: 400, width: 20, height: 100
    });
    expect(dungeonCatalogValidationIssues(blockedFormation)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "formation-adjusted spawn position is not walkable" })
    ]));

    const ambiguousBoss = structuredClone(DUNGEON_CATALOG);
    const bossDungeon = ambiguousBoss.dungeons.find((dungeon) => dungeon.id === "cistern_warrens")!;
    const bossRoom = bossDungeon.rooms.find((room) => room.id === "warden_junction")!;
    const bossEncounter = bossDungeon.encounters.find((encounter) => encounter.id === "rat-warden")!;
    const secondBoss = { ...bossRoom.mobs.find((mob) => mob.id === "rat-warden-boss")!, id: "rat-warden-boss-two" };
    bossRoom.mobs.push(secondBoss);
    bossEncounter.waves[0]!.mobSpawnIds.push(secondBoss.id);
    expect(dungeonCatalogValidationIssues(ambiguousBoss)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: expect.stringContaining("bossTemplateId"),
        message: "requires exactly one non-summoned mob placement in its encounter (the boss). Move trash waves into a separate encounter and chain it: when that encounter completes, start the boss encounter."
      })
    ]));

    const wave = structuredClone(valid);
    sewerOf(wave).encounters[0]!.waves[0]!.mobSpawnIds = ["missing_mob"];
    expect(dungeonCatalogValidationIssues(wave)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "references a missing mob placement for this room, encounter, and wave"
      })
    ]));

    const deadTrigger = structuredClone(valid);
    sewerOf(deadTrigger).triggers[0]!.actions = [{
      type: "set_object_state", roomId: "hatch_landing",
      objectId: "missing_object", state: "open"
    }];
    expect(dungeonCatalogValidationIssues(deadTrigger)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "references a missing object" })
    ]));

    for (const unsupportedEvent of [
      { type: "item_owned", itemId: "test_item", quantity: 1 },
      { type: "quest_flag", flagId: "test_quest", value: true }
    ]) {
      const invalidEvent = structuredClone(valid);
      (sewerOf(invalidEvent).triggers[0] as unknown as { event: unknown }).event = unsupportedEvent;
      expect(dungeonCatalogValidationIssues(invalidEvent)).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: expect.stringContaining("event.type") })
      ]));
    }
    const authorityConditions = structuredClone(valid);
    sewerOf(authorityConditions).triggers[0]!.conditions.items = [
      { type: "item_owned", itemId: "test_item", quantity: 1 },
      { type: "quest_flag", flagId: "test_quest", value: true }
    ];
    expect(dungeonCatalogValidationIssues(authorityConditions)).toEqual([]);

    const availabilityAction = structuredClone(valid);
    sewerOf(availabilityAction).triggers[0]!.actions = [{
      type: "set_object_available", roomId: "hatch_landing",
      objectId: "world-exit", available: false
    }];
    expect(dungeonCatalogValidationIssues(availabilityAction)).toEqual([]);
    sewerOf(availabilityAction).triggers[0]!.actions = [{
      type: "set_object_available", roomId: "hatch_landing",
      objectId: "missing_object", available: true
    }];
    expect(dungeonCatalogValidationIssues(availabilityAction)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "references a missing object" })
    ]));

    const cycle = structuredClone(valid);
    sewerOf(cycle).triggers.push({
      id: "cycle_b", retired: false, enabled: true, scope: "instance",
      repetition: "once", cooldownMs: 0, event: { type: "timer", delayMs: 0 },
      conditions: { mode: "all", items: [] },
      actions: [{ type: "enable_trigger", triggerId: "encounter_start", enabled: true }]
    });
    sewerOf(cycle).triggers.find((trigger) => trigger.id === "encounter_start")!.actions = [
      { type: "enable_trigger", triggerId: "cycle_b", enabled: true }
    ];
    expect(dungeonCatalogValidationIssues(cycle)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "trigger enable graph contains a cycle" })
    ]));

    const encounterCycle = structuredClone(valid);
    sewerOf(encounterCycle).triggers.push({
      id: "encounter_cycle", retired: false, enabled: true, scope: "instance",
      repetition: "repeat", cooldownMs: 0,
      event: { type: "encounter_state", encounterId: "wolf_encounter", state: "completed" },
      conditions: { mode: "all", items: [] },
      actions: [{ type: "start_encounter", encounterId: "wolf_encounter" }]
    });
    expect(dungeonCatalogValidationIssues(encounterCycle)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "encounter trigger graph contains a cycle" })
    ]));
  });
});

describe("show_message trigger action", () => {
  const withMessage = (text: string, tone?: string): DungeonCatalog => {
    const catalog = catalogWithEncounter();
    sewerOf(catalog).triggers.find((trigger) => trigger.id === "encounter_start")!.actions.push(
      { type: "show_message", text, ...(tone ? { tone } : {}) } as never
    );
    return catalog;
  };

  it("accepts 1-140 character messages with an optional tone", () => {
    expect(() => parseDungeonCatalog(withMessage("The Ossuary door grinds open.", "info"))).not.toThrow();
    expect(() => parseDungeonCatalog(withMessage("x".repeat(140)))).not.toThrow();
  });

  it("rejects empty, oversized and unknown-tone messages", () => {
    expect(() => parseDungeonCatalog(withMessage("   "))).toThrow();
    expect(() => parseDungeonCatalog(withMessage("x".repeat(141)))).toThrow();
    expect(() => parseDungeonCatalog(withMessage("ok", "loud"))).toThrow();
  });
});

function catalogWithEncounter(): DungeonCatalog {
  const catalog = structuredClone(DUNGEON_CATALOG);
  const dungeon = sewerOf(catalog);
  const room = dungeon.rooms[0]!;
  room.zones.push(
    { id: "encounter_area", retired: false, kind: "rectangle", purpose: "encounter_boundary", x: 300, y: 300, width: 300, height: 300 },
    { id: "encounter_leash", retired: false, kind: "polygon", purpose: "leash",
      points: [{ x: 250, y: 250 }, { x: 650, y: 250 }, { x: 650, y: 650 }, { x: 250, y: 650 }] }
  );
  room.anchors.push({ id: "wolf_spawn", retired: false, x: 450, y: 450, facing: 0 });
  room.mobs.push({
    id: "wolf_one", retired: false, archetype: "wolf", anchorId: "wolf_spawn", facing: 0,
    encounterId: "wolf_encounter", spawnGroupId: "wolves", waveIndex: 1,
    leashZoneId: "encounter_leash", visualScale: 1
  });
  dungeon.encounters.push({
    id: "wolf_encounter", retired: false, name: "Wolf Encounter",
    roomId: room.id, boundaryZoneId: "encounter_area", leashZoneId: "encounter_leash",
    waves: [{ id: "wave_one", mobSpawnIds: ["wolf_one"], delayMs: 0 }],
    completion: "all_spawned_mobs_defeated",
    reset: { onPartyWipe: true, delayMs: 1_000 },
    retry: { allowed: true, maxAttempts: null }, lockPortalIds: []
  });
  dungeon.triggers.push({
    id: "encounter_start", retired: false, enabled: true, scope: "instance",
    repetition: "once", cooldownMs: 0,
    event: { type: "zone_enter", roomId: room.id, zoneId: "encounter_area" },
    conditions: { mode: "all", items: [] },
    actions: [{ type: "start_encounter", encounterId: "wolf_encounter" }]
  });
  return catalog;
}

describe("developer dungeon entrance templates", () => {
  it("never expose the scaffold draft label on a developer entrance", () => {
    const templates = developerDungeonEntranceTemplates(DUNGEON_CATALOG);
    for (const id of ["fangrock_cavern", "the_eyrie", "blightwood_grove"]) {
      const template = templates.find((candidate) => candidate.dungeonId === id)!;
      expect(template.interactionLabel).toMatch(/^Enter /);
    }
    expect(templates.some((template) => /^draft/i.test(template.interactionLabel))).toBe(false);
  });
});
