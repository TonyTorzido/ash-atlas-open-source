// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DUNGEON_CATALOG, dungeonCatalogValidationIssues } from "@ash-atlas/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addRandomMobGroup, configureChestReward, DungeonChestTools, DungeonCompletionTools } from "./DungeonStarterTools.js";

afterEach(cleanup);

describe("starter dungeon recipes", () => {
  it("creates N stable mob placements and a per-chest five-rarity reward table", () => {
    const catalog = structuredClone(DUNGEON_CATALOG);
    const dungeon = catalog.dungeons.find((entry) => entry.id === "cistern_warrens")!;
    const room = dungeon.rooms.find((candidate) => candidate.objects.some((object) => object.type === "chest" && !object.spawnGroup))!;
    const encounter = dungeon.encounters.find((candidate) => candidate.roomId === room.id)!;
    const before = room.mobs.length;
    addRandomMobGroup(dungeon, room, "goblin", 3, encounter.boundaryZoneId, encounter.id, 0);
    expect(room.mobs).toHaveLength(before + 3);
    expect(new Set(room.mobs.slice(before).map((mob) => mob.id)).size).toBe(3);
    expect(room.mobs.slice(before).every((mob) => mob.randomSpawnZoneId === encounter.boundaryZoneId)).toBe(true);
    const chest = room.objects.find((object) => object.type === "chest" && !object.spawnGroup)!;
    configureChestReward(catalog, dungeon, room, chest.id);
    const table = catalog.rewardTables.find((candidate) => candidate.id === chest.rewardTableId)!;
    expect(table.chestLoot!.rarities.reduce((total, rarity) => total + rarity.chance, 0)).toBe(100);
    expect(table.chestLoot!.rarities).toHaveLength(5);
    expect(dungeonCatalogValidationIssues(catalog)).toEqual([]);
  });

  it("shows five rarity art slots with previews and stages a rarity PNG assignment", () => {
    const catalog = structuredClone(DUNGEON_CATALOG);
    const dungeon = catalog.dungeons.find((entry) => entry.id === "cistern_warrens")!;
    const room = dungeon.rooms.find((candidate) => candidate.objects.some((object) => object.type === "chest" && !object.spawnGroup))!;
    room.objects = room.objects.filter((object) => !object.spawnGroup); // one chest keeps the five-slot panel unambiguous
    const chest = room.objects.find((object) => object.type === "chest" && !object.spawnGroup)!;
    configureChestReward(catalog, dungeon, room, chest.id);
    const table = catalog.rewardTables.find((candidate) => candidate.id === chest.rewardTableId)!;
    const onImport = vi.fn(async (_file: File, _options: unknown, onImported?: (assetKey: string) => void) => {
      onImported?.("apps/client/public/assets/dungeons/custom/legendary-chest.png");
      return true;
    });
    render(<DungeonChestTools
      catalog={catalog}
      dungeon={dungeon}
      room={room}
      disabled={false}
      onUpdate={(edit) => edit(catalog)}
      onImport={onImport}
    />);

    expect(screen.getByRole("region", { name: `${chest.name} artwork by rarity` })).toBeTruthy();
    expect(screen.getAllByRole("article")).toHaveLength(5);
    expect(screen.getByRole("img", { name: "common chest preview" })).toBeTruthy();
    const upload = screen.getByLabelText("Upload legendary chest PNG");
    fireEvent.change(upload, { target: { files: [new File(["png"], "legendary.png", { type: "image/png" })] } });
    expect(onImport).toHaveBeenCalledTimes(1);
    expect(table.chestLoot!.rarities.find((rarity) => rarity.rarity === "legendary")?.assetKey)
      .toBe("apps/client/public/assets/dungeons/custom/legendary-chest.png");
  });

  it("replaces old reveal actions without deleting stable triggers or unrelated actions", () => {
    const catalog = structuredClone(DUNGEON_CATALOG);
    const dungeon = catalog.dungeons.find((entry) => entry.id === "cistern_warrens")!;
    const room = dungeon.rooms.find((candidate) => candidate.objects.some((object) => object.type === "chest" && !object.spawnGroup))!;
    const chest = room.objects.find((object) => object.type === "chest" && !object.spawnGroup)!;
    const old = dungeon.triggers.find((trigger) => trigger.actions.some((action) => action.type === "set_object_available" && action.objectId === chest.id))!;
    const unrelated = old.actions.filter((action) => action.type !== "set_object_available");
    const encounter = dungeon.encounters.find((candidate) => candidate.roomId === room.id)!;
    render(<DungeonCompletionTools catalog={catalog} dungeon={dungeon} room={room} disabled={false} onUpdate={(edit) => edit(catalog)} />);
    fireEvent.click(screen.getByRole("button", { name: "Set completion event" }));
    fireEvent.click(screen.getByRole("button", { name: "Set completion event" }));
    expect(dungeon.triggers.some((trigger) => trigger.id === old.id)).toBe(true);
    expect(old.actions).toEqual(unrelated);
    expect(chest.available).toBe(false);
    const reveals = dungeon.triggers.filter((trigger) => !trigger.retired && trigger.actions.some((action) => action.type === "set_object_available" && action.objectId === chest.id && action.available));
    expect(reveals).toHaveLength(1);
    expect(reveals[0]!.event).toEqual({ type: "encounter_state", encounterId: encounter.id, state: "completed" });
    expect(dungeonCatalogValidationIssues(catalog)).toEqual([]);
  });

  it("adds an optional 'Message when cleared' show_message action to the completion recipe", () => {
    const catalog = structuredClone(DUNGEON_CATALOG);
    const dungeon = catalog.dungeons.find((entry) => entry.id === "cistern_warrens")!;
    const room = dungeon.rooms.find((candidate) => candidate.objects.some((object) => object.type === "chest" && !object.spawnGroup))!;
    const chest = room.objects.find((object) => object.type === "chest" && !object.spawnGroup)!;
    render(<DungeonCompletionTools catalog={catalog} dungeon={dungeon} room={room} disabled={false} onUpdate={(edit) => edit(catalog)} />);
    fireEvent.change(screen.getByLabelText("Message when cleared (optional)"), { target: { value: "  The vault unseals.  " } });
    fireEvent.click(screen.getByRole("button", { name: "Set completion event" }));
    const recipe = dungeon.triggers.find((trigger) => !trigger.retired && trigger.actions.some((action) => action.type === "set_object_available" && action.objectId === chest.id && action.available))!;
    expect(recipe.actions).toContainEqual({ type: "show_message", text: "The vault unseals.", tone: "success" });
    expect(dungeonCatalogValidationIssues(catalog)).toEqual([]);
  });
});
