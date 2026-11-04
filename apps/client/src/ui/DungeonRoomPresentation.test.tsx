// @vitest-environment jsdom

import {
  CISTERN_WARRENS_DUNGEON,
  DUNGEON_CATALOG,
  MOB_ARCHETYPE_KEYS,
  dungeonLocalToCombatPosition,
  type CombatEntitySnapshot,
  type DungeonObjectSnapshot,
  type DungeonPrefabDefinition,
  type DungeonSnapshot
} from "@ash-atlas/shared";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CombatPresentationController } from "../combat/combatPresentation.js";
import { IndoorPresentationClock } from "./IndoorPresentationClock.js";
import { MOB_ARTWORK_URLS, mobArtworkKey } from "../map/mobArtwork.js";
import {
  DUNGEON_LAYER_ORDER,
  DungeonEnemyLayer,
  DungeonRoomPresentation,
  dungeonAssetPublicUrl,
  dungeonEnemySpriteUrl,
  dungeonObjectAssetUrl,
  dungeonPortalBarricades
} from "./DungeonRoomPresentation.js";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("DungeonRoomPresentation", () => {
  it("strips the public repository prefix and renders strict authored layer order", () => {
    vi.stubEnv("BASE_URL", "/");
    expect(dungeonAssetPublicUrl(
      "apps/client/public/assets/dungeons/shared/chest-closed.png"
    )).toBe("/assets/dungeons/shared/chest-closed.png");
    expect(dungeonAssetPublicUrl("../outside.png")).toBeNull();

    const view = render(<DungeonRoomPresentation
      snapshot={presentationSnapshot()}
      actors={<span data-testid="actors">Actors</span>}
      onSelectObject={vi.fn()}
    />);
    expect(Array.from(view.container.querySelectorAll("[data-dungeon-layer]"), (node) =>
      node.getAttribute("data-dungeon-layer"))).toEqual(DUNGEON_LAYER_ORDER);
    expect(view.container.querySelector("[data-dungeon-layer=actors] [data-testid=actors]")).toBeTruthy();
    const tile = view.container.querySelector<HTMLElement>(".dungeon-authored-placement-tile")!;
    const placement = presentationSnapshot().room.layers.background[0]!;
    const prefab = presentationSnapshot().prefabs.find(
      (candidate) => candidate.id === placement.prefabId
    )!;
    expect(tile.style.width).toBe(`${placement.width / presentationSnapshot().roomWidth * 100}%`);
    expect(tile.style.height).toBe(`${placement.height / presentationSnapshot().roomHeight * 100}%`);
    expect(tile.style.backgroundSize).toBe(
      `${prefab.defaultWidth / placement.width * 100}% ${prefab.defaultHeight / placement.height * 100}%`
    );
  });

  it.each(["/", "/play/"])("serves authored backgrounds and object art under %s", (baseUrl) => {
    vi.stubEnv("BASE_URL", baseUrl);
    const snapshot = presentationSnapshot();
    const openChest = snapshot.objects[0]!;
    snapshot.objects.push({ ...openChest, id: "chest-2", name: "Closed Chest", state: "closed" });
    const view = render(<DungeonRoomPresentation
      snapshot={snapshot}
      actors={null}
      onSelectObject={vi.fn()}
    />);

    const tile = view.container.querySelector<HTMLElement>(".dungeon-authored-placement-tile")!;
    expect(tile.style.backgroundImage).toBe(`url("${baseUrl}assets/dungeons/cistern_warrens/sewer-floor.png")`);
    expect(view.getByRole("button", { name: openChest.name }).querySelector("img")?.getAttribute("src"))
      .toBe(`${baseUrl}assets/dungeons/shared/chest-open.png`);
    expect(view.getByRole("button", { name: "Closed Chest" }).querySelector("img")?.getAttribute("src"))
      .toBe(`${baseUrl}assets/dungeons/shared/chest-closed.png`);
    expect(dungeonAssetPublicUrl("../outside.png")).toBeNull();
  });

  it("uses object state art and authored object transforms", () => {
    const snapshot = presentationSnapshot();
    const prefab = snapshot.prefabs[0]!;
    const object = snapshot.objects[0]!;
    expect(dungeonObjectAssetUrl(object, prefab)).toBe(
      "/assets/dungeons/shared/chest-open.png"
    );
    const view = render(<DungeonRoomPresentation
      snapshot={snapshot}
      actors={null}
      onSelectObject={vi.fn()}
    />);
    const button = view.getByRole("button", { name: object.name });
    expect(button.querySelector("img")?.getAttribute("src")).toBe(
      "/assets/dungeons/shared/chest-open.png"
    );
    expect(button.style.transform).toContain("rotate(15deg)");
    expect(button.style.transform).toContain("scale(-1, 1)");
    expect(button.style.opacity).toBe("0.75");
    expect(button.getAttribute("data-object-available")).toBe("true");
  });

  it("draws the dungeon's barricade over a portal only while its lock is held", () => {
    vi.stubEnv("BASE_URL", "/");
    const base = presentationSnapshot();
    const door: DungeonObjectSnapshot = {
      id: "pass_to_pit_object", kind: "portal", name: "Go East", x: 1570, y: 350, available: true, state: "closed",
      prefabId: "sewer_door", prefabRevision: "sewer-door-v1", layerId: "actors", interactionRadius: 110,
      rotationDeg: 0, opacity: 0, flipX: false, flipY: false, zIndex: 0, portalId: "dungeon:cave:pass_to_pit"
    };
    const snapshot = (locked: boolean): DungeonSnapshot => ({
      ...base, dungeonId: "fangrock_cavern", objects: [door], portalLocks: { "dungeon:cave:pass_to_pit": locked }
    });
    expect(dungeonPortalBarricades(snapshot(true))).toEqual([{
      portalId: "dungeon:cave:pass_to_pit", x: 1570, y: 350,
      assetKey: "apps/client/public/assets/dungeons/fangrock_cavern/rockfall-barricade.png"
    }]);
    expect(dungeonPortalBarricades(snapshot(false))).toEqual([]);
    expect(dungeonPortalBarricades({ ...snapshot(true), dungeonId: "no_art_dungeon" })).toEqual([]);

    const view = render(<DungeonRoomPresentation snapshot={snapshot(true)} actors={null} onSelectObject={vi.fn()} />);
    const barricade = view.container.querySelector<HTMLImageElement>("[data-dungeon-layer=actors] .dungeon-portal-barricade")!;
    expect(barricade.getAttribute("src")).toBe("/assets/dungeons/fangrock_cavern/rockfall-barricade.png");
    expect(barricade.getAttribute("data-portal-id")).toBe("dungeon:cave:pass_to_pit");
    view.rerender(<DungeonRoomPresentation snapshot={snapshot(false)} actors={null} onSelectObject={vi.fn()} />);
    expect(view.container.querySelector(".dungeon-portal-barricade")).toBeNull();
  });

  it("keeps completion-gated chests absent until the server reveals them", () => {
    const snapshot = presentationSnapshot();
    snapshot.objects[0]!.available = false;
    const view = render(<DungeonRoomPresentation snapshot={snapshot} actors={null} onSelectObject={vi.fn()} />);
    expect(view.queryByRole("button", { name: snapshot.objects[0]!.name })).toBeNull();
    snapshot.objects[0]!.available = true;
    view.rerender(<DungeonRoomPresentation snapshot={snapshot} actors={null} onSelectObject={vi.fn()} />);
    expect(view.getByRole("button", { name: snapshot.objects[0]!.name })).toBeTruthy();
  });

  it("prefers the server-selected rarity PNG over legacy state art", () => {
    const snapshot = presentationSnapshot();
    const object = snapshot.objects[0]!;
    object.rarity = "legendary";
    object.assetKey = "apps/client/public/assets/dungeons/custom/legendary-chest.png";
    const prefab = snapshot.prefabs[0]!;
    expect(dungeonObjectAssetUrl(object, prefab)).toBe(
      "/assets/dungeons/custom/legendary-chest.png"
    );
  });

  it("reuses the centralized overworld mob sprite source and goblin variants", () => {
    expect(dungeonEnemySpriteUrl("wolf")).toBe(MOB_ARTWORK_URLS.wolf);
    expect(mobArtworkKey("goblin", "goblin")).toBe("goblinBasic");
    expect(mobArtworkKey("goblin", "goblin_warrior")).toBe("goblinWarrior");
  });

  it("renders every encounter mob from canonical combat artwork without copied silhouettes", () => {
    const enemies = MOB_ARCHETYPE_KEYS.map((archetype, index) => ({
      entityId: `enemy-${index}`, spawnId: `spawn-${index}`, encounterId: "encounter",
      archetype, name: archetype, x: 100 + index, y: 200, currentHealth: 10,
      maxHealth: 10, lifeState: "alive" as const, targetEntityId: null, visualScale: 1
    }));
    const combatEntities = enemies.map((enemy): CombatEntitySnapshot => ({
      entityId: enemy.entityId,
      kind: "mob",
      archetypeKey: enemy.archetype,
      name: enemy.name,
      level: 1,
      regionCode: "interior:sewer:sewer-1",
      zoneId: "interior:sewer:sewer-1:hatch_landing",
      ...dungeonLocalToCombatPosition(enemy.x, enemy.y),
      maxHealth: enemy.maxHealth,
      currentHealth: enemy.currentHealth,
      lifeState: "alive",
      activityState: "idle",
      targetEntityId: null,
      revision: 1
    }));
    const view = render(<DungeonEnemyLayer
      enemies={enemies}
      roomWidth={1000}
      roomHeight={1000}
      playerVisualHeight={35}
      combatEntities={combatEntities}
    />);
    expect(view.container.querySelectorAll("[data-enemy-archetype]")).toHaveLength(
      MOB_ARCHETYPE_KEYS.length
    );
    expect(view.container.querySelectorAll("[data-mob-silhouette]")).toHaveLength(0);
    expect(view.container.querySelector("[data-mob-artwork-key=goblinBasic]")).toBeTruthy();
  });

  it("aims the dungeon strike presentation at the authoritative target", () => {
    const combatPresentation = new CombatPresentationController();
    const mobPosition = dungeonLocalToCombatPosition(100, 100);
    const targetPosition = dungeonLocalToCombatPosition(140, 100);
    const mob: CombatEntitySnapshot = {
      entityId: "enemy-1",
      kind: "mob",
      archetypeKey: "wolf",
      name: "Wolf",
      level: 1,
      regionCode: "interior:sewer:sewer-1",
      zoneId: "interior:sewer:sewer-1:hatch_landing",
      ...mobPosition,
      maxHealth: 10,
      currentHealth: 10,
      lifeState: "alive",
      activityState: "attacking",
      targetEntityId: "player-1",
      revision: 1
    };
    const target: CombatEntitySnapshot = {
      entityId: "player-1",
      kind: "player",
      archetypeKey: null,
      name: "Player",
      level: 1,
      regionCode: "interior:sewer:sewer-1",
      zoneId: "interior:sewer:sewer-1:hatch_landing",
      ...targetPosition,
      maxHealth: 100,
      currentHealth: 100,
      lifeState: "alive",
      activityState: "idle",
      targetEntityId: null,
      revision: 1
    };
    const nowMs = performance.now();
    combatPresentation.enqueueCombatEvents([{
      eventId: "hit-1",
      type: "ATTACK_LANDED",
      tick: 1,
      sourceEntityId: mob.entityId,
      targetEntityId: target.entityId
    }], { localPlayerId: target.entityId, nowMs });

    const view = render(<DungeonEnemyLayer
      enemies={[{
        entityId: mob.entityId,
        spawnId: "spawn-1",
        encounterId: "encounter",
        archetype: "wolf",
        name: mob.name,
        x: 100,
        y: 100,
        currentHealth: 10,
        maxHealth: 10,
        lifeState: "alive",
        targetEntityId: target.entityId,
        visualScale: 1
      }]}
      roomWidth={1_000}
      roomHeight={1_000}
      playerVisualHeight={35}
      combatEntities={[mob, target]}
      combatPresentation={combatPresentation}
    />);
    const presentation = view.container.querySelector<HTMLElement>(
      ".dungeon-enemy-presentation"
    )!;
    expect(presentation.dataset.combatPose).toBe("attack_action");
    expect(presentation.style.getPropertyValue("--dungeon-attack-direction-x"))
      .toBe("1");
    expect(presentation.style.getPropertyValue("--dungeon-attack-direction-y"))
      .toBe("0");
    expect(view.container.querySelector(".dungeon-enemy")?.className)
      .toContain("dungeon-enemy-pose-attack_action");
  });

  it("draws an elite larger, with an Elite name, text badges and a visible shield state", () => {
    const render1 = (elite: { modifiers: string[]; shieldActive?: boolean } | undefined) => {
      const mob: CombatEntitySnapshot = {
        entityId: "enemy-1", kind: "mob", archetypeKey: "wolf", name: "Wolf", level: 1,
        regionCode: "interior:test", zoneId: "interior:test:room", ...dungeonLocalToCombatPosition(100, 100),
        maxHealth: 10, currentHealth: 10, lifeState: "alive", activityState: "idle", targetEntityId: null, revision: 1
      };
      return render(<DungeonEnemyLayer
        enemies={[{
          entityId: "enemy-1", spawnId: "spawn-1", encounterId: "encounter", archetype: "wolf", name: "Wolf",
          x: 100, y: 100, currentHealth: 10, maxHealth: 10, lifeState: "alive", targetEntityId: null,
          visualScale: 1, ...(elite ? { elite } : {})
        }]}
        roomWidth={1_000} roomHeight={1_000} playerVisualHeight={35} combatEntities={[mob]}
      />);
    };
    const plain = render1(undefined);
    const plainHeight = parseFloat(plain.container.querySelector<HTMLElement>(".dungeon-enemy-presentation")!.style.height);
    expect(plain.container.querySelector(".dungeon-enemy-elite")).toBeNull();
    cleanup();
    const elite = render1({ modifiers: ["shielded", "hardy"], shieldActive: true });
    const eliteHeight = parseFloat(elite.container.querySelector<HTMLElement>(".dungeon-enemy-presentation")!.style.height);
    expect(eliteHeight / plainHeight).toBeCloseTo(1.15, 2);
    expect(elite.container.querySelector(".dungeon-enemy-elite-name")?.textContent).toBe("Elite Wolf");
    expect(Array.from(elite.container.querySelectorAll(".dungeon-enemy-elite-badge")).map((badge) => badge.textContent))
      .toEqual(["Shield", "Hardy"]);
    expect(elite.container.querySelector(".dungeon-enemy-presentation")?.className).toContain("dungeon-enemy-shielded");
  });

  it("draws the Corrupted Core faint and untargetable while possessing, and glowing and targetable once exposed", () => {
    const renderCore = (phaseId: string) => {
      const mob = {
        entityId: "core-1", kind: "mob", archetypeKey: "corrupted_core", name: "The Corrupted Core", level: 25,
        regionCode: "interior:test", zoneId: "interior:test:room", ...dungeonLocalToCombatPosition(100, 100),
        maxHealth: 10, currentHealth: 10, lifeState: "alive", activityState: "idle", targetEntityId: null, revision: 1,
        bossEncounter: { phaseId }
      } as unknown as CombatEntitySnapshot;
      return render(<DungeonEnemyLayer
        enemies={[{
          entityId: "core-1", spawnId: "spawn-1", encounterId: "encounter", archetype: "corrupted_core", name: "The Corrupted Core",
          x: 100, y: 100, currentHealth: 10, maxHealth: 10, lifeState: "alive", targetEntityId: null, visualScale: 1
        }]}
        roomWidth={1_000} roomHeight={1_000} playerVisualHeight={35} combatEntities={[mob]} onSelectEnemy={() => undefined}
      />);
    };
    const hidden = renderCore("possessing_2");
    expect(hidden.container.querySelector(".dungeon-enemy-presentation")?.className).toContain("dungeon-enemy-core-possessing");
    expect(hidden.container.querySelector(".dungeon-enemy-target")).toBeNull();
    cleanup();
    const exposed = renderCore("enraged_exposed_1");
    expect(exposed.container.querySelector(".dungeon-enemy-presentation")?.className).toContain("dungeon-enemy-core-exposed");
    expect(exposed.container.querySelector(".dungeon-enemy-target")).not.toBeNull();
  });

  it("uses an optional host clock for attack poses without changing canonical attack duration", () => {
    const presentation = new CombatPresentationController();
    let virtualNow = 1000;
    const clock = () => virtualNow;
    const enemy = { entityId: "wolf", spawnId: "spawn", encounterId: "encounter", archetype: "wolf" as const, name: "Wolf", x: 100, y: 100, currentHealth: 10, maxHealth: 10, lifeState: "alive" as const, targetEntityId: "player", visualScale: 1 };
    const mob: CombatEntitySnapshot = { ...dungeonLocalToCombatPosition(100, 100), entityId: "wolf", kind: "mob", archetypeKey: "wolf", name: "Wolf", level: 1, regionCode: "interior:test", zoneId: "interior:test:room", currentHealth: 10, maxHealth: 10, lifeState: "alive", activityState: "attacking", targetEntityId: "player", revision: 1 };
    presentation.enqueueCombatEvents([{ eventId: "strike", type: "ATTACK_LANDED", tick: 1, sourceEntityId: "wolf", targetEntityId: "player" }], { localPlayerId: "player", nowMs: virtualNow });
    const scene = () => <IndoorPresentationClock.Provider value={clock}><DungeonEnemyLayer enemies={[enemy]} roomWidth={1000} roomHeight={1000} playerVisualHeight={35} combatEntities={[mob]} combatPresentation={presentation} /></IndoorPresentationClock.Provider>;
    const view = render(scene());
    const pose = () => view.container.querySelector(".dungeon-enemy-presentation")?.getAttribute("data-combat-pose");
    expect(pose()).toBe("attack_action");
    view.rerender(scene()); // A paused host does not advance its clock.
    expect(pose()).toBe("attack_action");
    virtualNow = 2000;
    view.rerender(scene());
    expect(pose()).toBe("combat_ready");
  });
});

function presentationSnapshot(): DungeonSnapshot {
  const baseRoom = CISTERN_WARRENS_DUNGEON.rooms[0]!;
  // The tiled sewer_floor prefab is retained in the library; it exercises the tile renderer.
  const basePlacement = { ...baseRoom.layers.background[0]!, prefabId: "sewer_floor", prefabRevision: "sewer-floor-v1" };
  const layers = Object.fromEntries(DUNGEON_LAYER_ORDER.map((layerId, index) => [
    layerId,
    [{ ...basePlacement, id: `placement-${layerId}`, zIndex: 5 - index }]
  ])) as DungeonSnapshot["room"]["layers"];
  const prefab: DungeonPrefabDefinition = {
    ...DUNGEON_CATALOG.prefabs.find((candidate) => candidate.id === "dungeon_chest")!,
    stateAssets: [{
      stateId: "open",
      assetKey: "apps/client/public/assets/dungeons/shared/chest-open.png"
    }]
  };
  const floorPrefab = DUNGEON_CATALOG.prefabs.find(
    (candidate) => candidate.id === basePlacement.prefabId
  )!;
  const object: DungeonObjectSnapshot = {
    id: "chest-1", kind: "chest", name: "Treasure Chest", x: 400, y: 450,
    available: true, state: "open", prefabId: prefab.id, prefabRevision: prefab.revision,
    layerId: "actors", interactionRadius: 80, rotationDeg: 15, opacity: .75,
    flipX: true, flipY: false, zIndex: 9
  };
  return {
    snapshotKind: "full", catalogRevision: DUNGEON_CATALOG.catalogRevision,
    sceneRevision: "test-scene-revision",
    dungeonId: "cistern_warrens", dungeonRevision: "v2", entranceId: "sewer-entrance",
    name: "Cistern Warrens", description: "Municipal drainage tunnels.",
    instancePolicy: "shared_persistent", sewerId: "sewer-1",
    portalId: "sewer:sewer-1:world-to-entrance", presentation: "hatch", assetKey: null,
    cityId: "city-1", cityName: "City", sessionId: "session-1",
    instanceId: "sewer:1", spaceId: baseRoom.id, roomWidth: baseRoom.width,
    roomHeight: baseRoom.height, playerVisualHeight: 35, camera: baseRoom.camera,
    environment: {
      ...CISTERN_WARRENS_DUNGEON.environment, ...baseRoom.environment
    },
    player: {
      playerId: "player-1", name: "Player", displayColor: null, x: 100, y: 100,
      targetX: null, targetY: null, targetEntityId: null, movementSpeed: 130,
      movementRevision: 1, currentHealth: 100, maxHealth: 100
    },
    occupants: [], room: { ...baseRoom, layers }, prefabs: [prefab, floorPrefab], enemies: [],
    objects: [object], telegraphs: [], encounters: [], triggers: [], dungeonFlags: {},
    portalLocks: {}, completed: false, resetDeadline: null, cues: [], status: "Active", serverTime: 1
  };
}
