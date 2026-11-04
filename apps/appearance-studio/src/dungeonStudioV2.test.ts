import { DUNGEON_CATALOG, dungeonCatalogValidationIssues, type BossDefinition } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { configureChestReward } from "./DungeonStarterTools.js";
import {
  DUNGEON_WALK_TEST_PRESETS,
  createDungeonFromWizard,
  duplicateDungeon,
  createDungeonObject,
  createDungeonResourceNode,
  createDungeonResourceSpawnZone,
  createMobPlacement,
  disconnectDungeonWorldEntrance,
  dungeonGameViewReport,
  oneRoomCombatReadiness,
  moveDungeonMobGroup,
  replaceDungeonPrefabArt,
  saveDungeonWorldEntrance,
  selectDungeonBossTemplate,
  createDungeonRewardTable,
  updateDungeonRewardTable,
  wireOneRoomCombatFlow
} from "./dungeonStudioV2.js";

describe("Dungeon Studio game view checks", () => {
  it("duplicates a template with independent loot and no automatic world placement", () => {
    const original = structuredClone(DUNGEON_CATALOG);
    const source = original.dungeons.find((dungeon) => dungeon.name === "Example - Slime Dungeon Template")!;
    expect(source.rewardTableIds.length).toBeGreaterThan(0);
    const { catalog, dungeonId } = duplicateDungeon(original, source.id);
    const copy = catalog.dungeons.find((dungeon) => dungeon.id === dungeonId)!;
    expect(copy.rooms).toHaveLength(source.rooms.length);
    expect(copy.encounters).toEqual(source.encounters);
    expect(copy.portals.filter((portal) => portal.source.kind === "world").every((portal) => !portal.enabled)).toBe(true);
    expect(catalog.entrances).toEqual(original.entrances);
    expect(copy.rewardTableIds.every((id) => !source.rewardTableIds.includes(id))).toBe(true);
    expect(catalog.dungeons.find((dungeon) => dungeon.id === source.id)).toEqual(source);
    expect(dungeonCatalogValidationIssues(catalog)).toEqual([]);
    expect(original).toEqual(DUNGEON_CATALOG);
    const longName = structuredClone(original);
    longName.dungeons.find((dungeon) => dungeon.id === source.id)!.name = "A".repeat(80);
    const boundedCopy = duplicateDungeon(longName, source.id);
    expect(boundedCopy.catalog.dungeons.find((dungeon) => dungeon.id === boundedCopy.dungeonId)!.name.length).toBe(80);
    expect(dungeonCatalogValidationIssues(boundedCopy.catalog)).toEqual([]);
  });
  it("authors deterministic resource nodes and zones, reward tables, boss templates, and mob groups", () => {
    const catalog = structuredClone(DUNGEON_CATALOG);
    const dungeon = catalog.dungeons.find((entry) => entry.id === "cistern_warrens")!;
    const room = dungeon.rooms[0]!;
    const node = createDungeonResourceNode({ id: "test_resource", anchorId: room.spawnAnchorId, resourceType: "wood", minYield: 1, maxYield: 3, respawnSeconds: 60, resetOnRun: true, interactionRadius: 72 });
    const zone = createDungeonResourceSpawnZone({ id: "test_resource_zone", shape: { id: "test_resource_zone", retired: false, kind: "rectangle", x: 100, y: 100, width: 300, height: 250 }, resourceTypes: ["wood", "ore"], minCount: 2, maxCount: 5, minimumSpacing: 80, seed: 42, respawnSeconds: 90, resetOnRun: true, interactionRadius: 72 });
    room.resourceNodes = [node];
    room.resourceSpawnZones = [zone];
    expect(dungeonCatalogValidationIssues(catalog)).toEqual([]);

    const rewardCatalog = createDungeonRewardTable(catalog, { id: "test_reward", gold: 25, items: [{ itemId: "wood", quantity: 2 }] });
    const editedRewards = updateDungeonRewardTable(rewardCatalog, "test_reward", { gold: 50 });
    expect(editedRewards.rewardTables.find((table) => table.id === "test_reward")).toMatchObject({ gold: 50, revision: "2" });
    const definition: BossDefinition = { id: "test_boss", revision: 3, archetypeKey: "goblin", controllerId: "test_controller", rewardPolicy: { id: "test_policy", minimumContribution: 1 }, displayName: "Test Boss" };
    const withBoss = selectDungeonBossTemplate(editedRewards, { id: "test_boss_template", definition });
    expect(withBoss.bossTemplateIds).toContain("test_boss_template");

    const mobs = room.mobs.filter((mob) => !mob.retired);
    if (mobs.length >= 2) {
      const group = mobs[0]!.spawnGroupId;
      const before = { ...room.anchors.find((anchor) => anchor.id === mobs[0]!.anchorId)! };
      moveDungeonMobGroup(dungeon, room.id, group, { x: 10, y: 15 });
      const after = room.anchors.find((anchor) => anchor.id === mobs[0]!.anchorId)!;
      expect(after).toMatchObject({ x: before.x + 10, y: before.y + 15 });
    }
  });

  it("keeps authored placements and collider identities when replacing prefab art", () => {
    const catalog = structuredClone(DUNGEON_CATALOG);
    const prefab = catalog.prefabs.find((candidate) => candidate.id === "dungeon_chest")!;
    const placement = Object.values(catalog.dungeons.find((entry) => entry.id === "cistern_warrens")!.rooms[0]!.layers).flat().find((value) => value.prefabId === prefab.id);
    const object = catalog.dungeons.find((entry) => entry.id === "cistern_warrens")!.rooms[0]!.objects.find((value) => value.prefabId === prefab.id);
    const oldPlacementId = placement?.id;
    const oldObjectId = object?.id;
    const oldColliderId = prefab.defaultColliders[0]?.id;
    const next = replaceDungeonPrefabArt(catalog, prefab.id, prefab.assetKey, prefab.nativeWidth * 2, prefab.nativeHeight * 2);
    expect(next.catalogRevision).toBe(catalog.catalogRevision + 1);
    expect(next.prefabs.find((candidate) => candidate.id === prefab.id)?.revision).not.toBe(prefab.revision);
    expect(oldPlacementId === undefined || Object.values(next.dungeons.find((entry) => entry.id === "cistern_warrens")!.rooms[0]!.layers).flat().find((value) => value.id === oldPlacementId)).toBeTruthy();
    expect(oldObjectId === undefined || next.dungeons.find((entry) => entry.id === "cistern_warrens")!.rooms[0]!.objects.find((value) => value.id === oldObjectId)).toBeTruthy();
    expect(next.prefabs.find((candidate) => candidate.id === prefab.id)?.defaultColliders[0]?.id).toBe(oldColliderId);
  });

  it("keeps the standard sewer room quiet on the default phone portrait approximation", () => {
    const dungeon = DUNGEON_CATALOG.dungeons.find((entry) => entry.id === "cistern_warrens")!;
    const room = dungeon.rooms.find((candidate) => candidate.id === "hatch_landing")!;
    const report = dungeonGameViewReport(room, DUNGEON_CATALOG.prefabs, dungeon.encounters, "phone_portrait");

    expect(report.preset).toBe(DUNGEON_WALK_TEST_PRESETS.phone_portrait);
    expect(report.playerHeightAtDefaultZoomPx).toBeCloseTo(27.3);
    expect(report.playerHeightAtMinimumZoomPx).toBeCloseTo(13.65);
    expect(report.visibleRoomCoveragePercent).toBe(100);
    expect(report.blackSpacePercent).toBeCloseTo(37.096, 2);
    expect(report.warnings).toEqual([]);
  });

  it("reports conservative advisory warnings without mutating the room", () => {
    const catalog = structuredClone(DUNGEON_CATALOG);
    const dungeon = catalog.dungeons.find((entry) => entry.id === "cistern_warrens")!;
    const room = dungeon.rooms.find((candidate) => candidate.id === "overflow_channel")!;
    const originalWidth = room.width;
    room.width = 4_000;
    room.anchors.find((anchor) => anchor.id === room.spawnAnchorId)!.x = 10;
    const object = room.objects.find((candidate) => candidate.available && candidate.type !== "decoration")!;
    object.interactionRadius = 20;
    const prefab = catalog.prefabs.find((candidate) => candidate.id === object.prefabId)!;
    prefab.defaultWidth = 20;
    prefab.defaultHeight = 20;
    dungeon.encounters.find((encounter) => encounter.roomId === room.id)!.waves[0]!.mobSpawnIds =
      Array.from({ length: 40 }, (_, index) => `mob_${index}`);
    const authoredRoom = structuredClone(room);

    const report = dungeonGameViewReport(room, catalog.prefabs, dungeon.encounters, "phone_portrait");
    expect(report.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining([
      "player_too_small",
      "excessive_black_space",
      "spawn_near_bounds",
      "interaction_reach_too_small",
      "high_wave_density",
      "important_art_too_small"
    ]));
    expect(originalWidth).toBe(1_600);
    expect(room).toEqual(authoredRoom);
  });

  it("offers a tablet preset and derives semantic object defaults from built-in prefab names", () => {
    expect(DUNGEON_WALK_TEST_PRESETS.tablet).toMatchObject({ playableWidthPx: 1024, playableHeightPx: 720 });
    const expectations = new Map([
      ["dungeon_chest", { type: "chest", initialState: "closed" }],
      ["dungeon_lever", { type: "switch", initialState: "off" }],
      ["dungeon_pressure_plate", { type: "switch", initialState: "released" }],
      ["sewer_door", { type: "door", initialState: "closed" }],
      ["sewer_exit_ladder", { type: "exit_ladder", initialState: "idle" }]
    ]);
    for (const [prefabId, expectation] of expectations) {
      const prefab = DUNGEON_CATALOG.prefabs.find((value) => value.id === prefabId)!;
      expect(createDungeonObject(prefab, `test_${prefabId}`, "anchor", prefab.name)).toMatchObject(expectation);
    }
    const portalPrefab = DUNGEON_CATALOG.prefabs.find((value) => value.id === "sewer_door")!;
    expect(createDungeonObject(portalPrefab, "portal", "anchor", portalPrefab.name, "portal-id")).toMatchObject({ type: "portal", initialState: "closed" });
  });

  it("reports live binding only for the production-bound canonical dungeon entrance", () => {
    const cisternWarrens = structuredClone(DUNGEON_CATALOG.dungeons.find((dungeon) => dungeon.id === "cistern_warrens")!);
    const entrance = cisternWarrens.rooms.find((room) => room.id === cisternWarrens.entrance.roomId)!;
    expect(oneRoomCombatReadiness(cisternWarrens, entrance, DUNGEON_CATALOG).liveWorldBound).toBe(true);
    const unboundCatalog = structuredClone(DUNGEON_CATALOG);
    unboundCatalog.entrances = [];
    const unboundCisternWarrens = unboundCatalog.dungeons.find((dungeon) => dungeon.id === "cistern_warrens")!;
    const unboundEntrance = unboundCisternWarrens.rooms.find((room) => room.id === unboundCisternWarrens.entrance.roomId)!;
    const unboundNonEntrance = unboundCisternWarrens.rooms.find((room) => room.id !== unboundCisternWarrens.entrance.roomId)!;
    unboundCisternWarrens.portals.find((portal) => portal.id === unboundCisternWarrens.entrance.portalId)!.enabled = false;
    expect(oneRoomCombatReadiness(unboundCisternWarrens, unboundEntrance, unboundCatalog).liveWorldBound).toBe(false);
    unboundCisternWarrens.portals.find((portal) => portal.id === unboundCisternWarrens.entrance.portalId)!.enabled = true;
    expect(oneRoomCombatReadiness(unboundCisternWarrens, unboundEntrance, unboundCatalog).liveWorldBound).toBe(false);
    unboundCatalog.entrances.push({
      id: "sewer_hatch", dungeonId: cisternWarrens.id, revision: "sewer-hatch-v1", retired: false,
      name: "Sewer Hatch", description: "A test world binding.", lat: 0, lon: 0,
      interactionRadiusM: 2, footprintRadiusM: 1, portalId: cisternWarrens.entrance.portalId,
      portalRevision: cisternWarrens.revision, interactionLabel: "Enter sewer", presentation: "hatch", assetKey: null
    });
    expect(oneRoomCombatReadiness(unboundCisternWarrens, unboundEntrance, unboundCatalog).liveWorldBound).toBe(true);
    expect(oneRoomCombatReadiness(unboundCisternWarrens, unboundNonEntrance, unboundCatalog).liveWorldBound).toBe(true);

    const catalog = structuredClone(DUNGEON_CATALOG);
    const draft = createDungeonFromWizard(catalog, {
      name: "Enabled Draft", themeId: "stone", backgroundColor: "#071116", floorColor: "#182a2d",
      wallColor: "#405052", accentColor: "#8fbc8f", instancePolicy: "party_ephemeral",
      resetPolicy: "when_empty", width: 1000, height: 1000
    });
    draft.portals.find((portal) => portal.id === draft.entrance.portalId)!.enabled = true;
    expect(oneRoomCombatReadiness(draft, draft.rooms[0]!, catalog).liveWorldBound).toBe(false);
  });

  it("adds, edits, and retires one stable catalog-backed world entrance", () => {
    const catalog = structuredClone(DUNGEON_CATALOG);
    const dungeon = catalog.dungeons.find((entry) => entry.id === "cistern_warrens")!;
    const room = dungeon.rooms.find((candidate) => candidate.id === dungeon.entrance.roomId)!;
    const portal = dungeon.portals.find((candidate) => candidate.id === dungeon.entrance.portalId)!;
    portal.enabled = false;
    catalog.entrances = [];

    saveDungeonWorldEntrance(catalog, dungeon.id, {
      name: "Old Sewer Hatch", description: "A hatch beside the old road.", lat: 39.5, lon: -105.25,
      assetKey: "apps/client/public/assets/dungeons/shared/orc-cave-entrance.png"
    });
    const entrance = catalog.entrances[0]!;
    const createdRevision = entrance.revision;
    const createdPortalRevision = entrance.portalRevision;
    expect(entrance).toMatchObject({ dungeonId: dungeon.id, retired: false, interactionRadiusM: 95, footprintRadiusM: 35, presentation: "cave" });
    expect(portal).toMatchObject({ enabled: true, interactionLabel: `Enter ${dungeon.name}` });
    expect(oneRoomCombatReadiness(dungeon, room, catalog).liveWorldBound).toBe(true);

    saveDungeonWorldEntrance(catalog, dungeon.id, {
      name: "Stone Sewer Door", description: "A stone doorway near the river.", lat: 40, lon: -104.75,
      assetKey: "apps/client/public/assets/dungeons/cistern_warrens/sewer-door.png"
    });
    expect(catalog.entrances).toHaveLength(1);
    expect(catalog.entrances[0]).toMatchObject({ id: entrance.id, revision: `${entrance.id}-v2`, portalRevision: `${portal.id}-v2`, lat: 40, lon: -104.75, assetKey: "apps/client/public/assets/dungeons/cistern_warrens/sewer-door.png" });
    expect(catalog.entrances[0]!.revision).not.toBe(createdRevision);
    expect(catalog.entrances[0]!.portalRevision).not.toBe(createdPortalRevision);

    disconnectDungeonWorldEntrance(catalog, dungeon.id);
    expect(catalog.entrances[0]?.retired).toBe(true);
    expect(catalog.entrances[0]).toMatchObject({ id: entrance.id, revision: `${entrance.id}-v3`, portalRevision: `${portal.id}-v3` });
    expect(portal.enabled).toBe(false);
    expect(oneRoomCombatReadiness(dungeon, room, catalog).liveWorldBound).toBe(false);
  });

  it("wires an idempotent one-room combat flow while preserving unrelated logic", () => {
    const catalog = structuredClone(DUNGEON_CATALOG);
    const dungeon = createDungeonFromWizard(catalog, {
      name: "Quick Crypt", themeId: "stone", backgroundColor: "#071116", floorColor: "#182a2d",
      wallColor: "#405052", accentColor: "#8fbc8f", instancePolicy: "party_ephemeral",
      resetPolicy: "when_empty", width: 1000, height: 1000
    });
    const room = dungeon.rooms[0]!;
    room.zones.push(
      { id: "quick_boundary", retired: false, kind: "rectangle", purpose: "encounter_boundary", x: 0, y: 0, width: 1000, height: 1000 },
      { id: "quick_leash", retired: false, kind: "rectangle", purpose: "leash", x: 0, y: 0, width: 1000, height: 1000 }
    );
    room.anchors.push(
      { id: "quick_mob_anchor", retired: false, x: 400, y: 400 },
      { id: "quick_chest_anchor", retired: false, x: 600, y: 400 }
    );
    room.mobs.push(createMobPlacement("goblin", "quick_goblin", "quick_mob_anchor", "quick_encounter", "quick_leash"));
    dungeon.encounters.push({
      id: "quick_encounter", retired: false, name: "Quick encounter", roomId: room.id,
      boundaryZoneId: "quick_boundary", leashZoneId: "quick_leash",
      waves: [{ id: "wave_1", mobSpawnIds: ["quick_goblin"], delayMs: 0 }],
      completion: "all_spawned_mobs_defeated", reset: { onPartyWipe: true, delayMs: 1500 },
      retry: { allowed: true, maxAttempts: null }, lockPortalIds: []
    });
    const chestPrefab = catalog.prefabs.find((prefab) => prefab.id === "dungeon_chest")!;
    room.objects.push(createDungeonObject(chestPrefab, "quick_chest", "quick_chest_anchor", "Treasure Chest"));
    const unrelated = {
      id: "authored_ambience", retired: false, enabled: true, scope: "instance" as const,
      repetition: "once" as const, cooldownMs: 0, event: { type: "timer" as const, delayMs: 500 },
      conditions: { mode: "all" as const, items: [] }, actions: [{ type: "play_cue" as const, cueId: "crypt_rumble" }]
    };
    dungeon.triggers.push(unrelated);
    catalog.dungeons.push(dungeon);

    // The creator can configure the chest before using quick setup. One chest still pays once.
    const chestFirstCatalog = structuredClone(catalog);
    const chestFirst = chestFirstCatalog.dungeons.find((candidate) => candidate.id === dungeon.id)!;
    const chestFirstRoom = chestFirst.rooms[0]!;
    configureChestReward(chestFirstCatalog, chestFirst, chestFirstRoom, "quick_chest");
    wireOneRoomCombatFlow(chestFirst, chestFirstRoom);
    wireOneRoomCombatFlow(chestFirst, chestFirstRoom);
    const payouts = chestFirst.triggers.filter((trigger) => !trigger.retired && trigger.enabled && trigger.event.type === "object_interact" && trigger.event.objectId === "quick_chest")
      .flatMap((trigger) => trigger.actions.filter((action) => action.type === "grant_reward"));
    expect(payouts).toHaveLength(1);
    expect(payouts[0]).toMatchObject({ rewardTableId: chestFirstRoom.objects.find((object) => object.id === "quick_chest")!.rewardTableId });
    expect(dungeonCatalogValidationIssues(chestFirstCatalog)).toEqual([]);

    expect(oneRoomCombatReadiness(dungeon, room)).toMatchObject({
      mobBackedEncounter: true, chestStartsUnavailable: false, roomEnterStartsEncounter: false,
      walkTestReady: false, liveWorldBound: false
    });
    expect(wireOneRoomCombatFlow(dungeon, room)).toBe(true);
    const once = structuredClone(dungeon);
    expect(wireOneRoomCombatFlow(dungeon, room)).toBe(true);
    expect(dungeon).toEqual(once);
    expect(dungeon.triggers).toContainEqual(unrelated);
    expect(dungeon.triggers.filter((trigger) => trigger.id.startsWith("one_room_"))).toHaveLength(3);
    expect(dungeon.rewardTableIds).toContain("basic_dungeon_chest");
    expect(dungeon.triggers).toContainEqual(expect.objectContaining({
      scope: "instance",
      event: { type: "room_clear", roomId: room.id },
      actions: [
        { type: "set_object_available", roomId: room.id, objectId: "quick_chest", available: true },
        { type: "complete_dungeon" }
      ]
    }));
    expect(dungeon.triggers).toContainEqual(expect.objectContaining({
      scope: "player",
      repetition: "once",
      event: { type: "object_interact", roomId: room.id, objectId: "quick_chest" },
      actions: [{ type: "grant_reward", rewardTableId: "basic_dungeon_chest" }]
    }));
    expect(dungeonCatalogValidationIssues(catalog)).toEqual([]);

    const readiness = oneRoomCombatReadiness(dungeon, room, catalog);
    expect(readiness).toMatchObject({
      chestStartsUnavailable: true, roomEnterStartsEncounter: true, escapeLockedDuringEncounter: true,
      clearExposesChest: true, dungeonCompletionAction: true, walkTestReady: true,
      liveWorldBound: false, lootRewardConfigured: true, lootRuntimeReady: true
    });
    dungeon.encounters.find((candidate) => candidate.id === "quick_encounter")!.rewardTableId = "quick_reward";
    expect(oneRoomCombatReadiness(dungeon, room, catalog)).toMatchObject({ lootRewardConfigured: true, lootRuntimeReady: true });
    delete dungeon.encounters.find((candidate) => candidate.id === "quick_encounter")!.rewardTableId;
  });
});
