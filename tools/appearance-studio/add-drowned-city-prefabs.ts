import path from "node:path";
import { fileURLToPath } from "node:url";

import { INTERIOR_DATA_RELATIVE_DIR, type InteriorLibrary } from "../../packages/shared/src/index.js";
import { applyInteriorWrites, planInteriorSpaceWrites } from "../../apps/appearance-studio/src/interiorCatalogStore.js";
import { readDungeonInteriorFiles } from "../../apps/appearance-studio/src/dungeonInteriorStore.js";

/**
 * One-off: registers the Drowned City floors, props and world entrance template in the interior
 * library (art drop drowned-city-01, MANIFEST.md sizes). Idempotent: existing ids are replaced.
 * Run with `pnpm exec tsx tools/appearance-studio/add-drowned-city-prefabs.ts`, then scaffold.
 */
const root = fileURLToPath(new URL("../..", import.meta.url));
const directory = path.join(root, INTERIOR_DATA_RELATIVE_DIR);
const ART = "apps/client/public/assets/dungeons/drowned_city";
type Prefab = InteriorLibrary["prefabs"][number];

const base = (id: string, name: string, file: string): Pick<Prefab, "id" | "name" | "assetKey" | "retired" | "revision" | "defaultOpacity" | "defaultRotationDeg" | "defaultFlipX" | "defaultFlipY" | "defaultColliders"> => ({
  id, name, assetKey: `${ART}/${file}`, retired: false, revision: `${id}-v1`,
  defaultOpacity: 1, defaultRotationDeg: 0, defaultFlipX: false, defaultFlipY: false, defaultColliders: []
});

function floor(id: string, name: string, file: string, width: number, height: number, pxPerUnit: number): Prefab {
  return {
    ...base(id, name, file), type: "surface", renderMode: "stretch", defaultLayerId: "background",
    defaultWidth: width, defaultHeight: height,
    nativeWidth: Math.round(width * pxPerUnit), nativeHeight: Math.round(height * pxPerUnit),
    pivotX: 0, pivotY: 0, stateAssets: []
  };
}

function prop(
  id: string, name: string, file: string, type: "object" | "decoration", size: number,
  options: Readonly<{ native?: number; layer?: Prefab["defaultLayerId"]; states?: Readonly<Record<string, string>>; radius?: number }> = {}
): Prefab {
  return {
    ...base(id, name, file), type, renderMode: "sprite", defaultLayerId: options.layer ?? "actors",
    defaultWidth: size, defaultHeight: size, nativeWidth: options.native ?? 512, nativeHeight: options.native ?? 512,
    pivotX: 0.5, pivotY: 0.5,
    stateAssets: Object.entries(options.states ?? {}).map(([stateId, stateFile]) => ({ stateId, assetKey: `${ART}/${stateFile}` })) as Prefab["stateAssets"],
    ...(options.radius ? { interactionRadius: options.radius } : {})
  };
}

const W = 1.28; // 1600-unit rooms
const S = 2048 / 1200; // 1200-unit rooms
const B = 2048 / 1400; // 1400-unit rooms
const prefabs: Prefab[] = [
  floor("dc_sunken_stair_floor", "Sunken Stair Floor", "sunken-stair-floor.png", 1000, 1000, 2),
  floor("dc_drowned_causeway_floor", "Drowned Causeway Floor", "drowned-causeway-floor.png", 1600, 800, W),
  floor("dc_flooded_plaza_floor", "Flooded Plaza Floor", "flooded-plaza-floor.png", 1200, 1200, S),
  floor("dc_circle_of_tides_floor", "Circle of Tides Floor", "circle-of-tides-floor.png", 1600, 1600, W),
  ...(["obs", "kelp", "harbor"] as const).flatMap((wing) => {
    const label = { obs: "Observatory", kelp: "Kelp", harbor: "Harbor" }[wing];
    return [
      floor(`dc_${wing}_street_floor`, `${label} Street Floor`, `${wing}-street-floor.png`, 1600, 800, W),
      floor(`dc_${wing}_square_floor`, `${label} Square Floor`, `${wing}-square-floor.png`, 1200, 1200, S),
      floor(`dc_${wing}_warden_hall_floor`, `${label} Warden Hall Floor`, `${wing}-warden-hall-floor.png`, 1200, 1200, S),
      floor(`dc_${wing}_boss_floor`, `${label} Boss Floor`, `${wing}-boss-floor.png`, 1400, 1400, B)
    ];
  }),
  floor("dc_past_street_floor", "Past Street Floor", "past-street-floor.png", 1600, 800, W),
  floor("dc_past_square_floor", "Past Square Floor", "past-square-floor.png", 1200, 1200, S),
  floor("dc_abyssal_sanctum_floor", "Abyssal Sanctum Floor", "abyssal-sanctum-floor.png", 1600, 1600, W),
  // Content fits 310 of 512 px for a 140-unit doorway: 512 px = ~230 units.
  prop("dc_floodgate", "Floodgate", "floodgate-closed.png", "object", 230, { states: { open: "floodgate-open.png" } }),
  prop("dc_time_rift", "Time Rift", "time-rift-dormant.png", "object", 260, { layer: "below_player", states: { open: "time-rift-open.png" } }),
  prop("dc_return_rift", "Return Rift", "return-rift.png", "object", 260, { layer: "below_player" }),
  prop("dc_tide_switch", "Tide Switch", "tide-switch-off.png", "object", 170, { states: { on: "tide-switch-on.png" }, radius: 110 }),
  prop("dc_abyssal_gate", "Abyssal Gate", "abyssal-gate-sealed.png", "object", 300, { layer: "below_player", states: { open: "abyssal-gate-open.png" } }),
  prop("dc_tidecraft_altar", "Tidecraft Altar", "tidecraft-altar.png", "object", 190, { radius: 110 }),
  prop("dc_tide_bomb", "Tide Bomb", "tide-bomb.png", "object", 150, { radius: 110 }),
  prop("dc_abyssal_arm", "Abyssal Arm", "abyssal-arm-intact.png", "object", 300, { layer: "below_player", states: { destroyed: "abyssal-arm-bombed.png" }, radius: 140 }),
  prop("dc_drowned_citizen", "Drowned Citizen", "drowned-citizen.png", "object", 112, { native: 1024, radius: 110 }),
  // Lit thirds of the hub circle: 1200 px = the painted 600-unit circle, placed at the hub centre.
  ...(["west", "north", "east"] as const).map((side) =>
    prop(`dc_circle_segment_${side}`, `Lit Tide Circle (${side})`, `circle-segment-${side}-lit.png`, "object", 600, { native: 1200, layer: "below_player" }))
];

const entrance: InteriorLibrary["entrances"][number] = {
  id: "drowned_city_world_entrance",
  dungeonId: "drowned_city",
  revision: "drowned_city_world_entrance-v1",
  // A template: every Drowned City site places it (DungeonRuntime resolves `drowned_*` entrance ids).
  retired: true,
  name: "The Drowned City",
  description: "A broken spire breaks the waves; steps lead down into the drowned streets. Level 32, entered afloat, no re-entry.",
  lat: 0,
  lon: 0,
  interactionRadiusM: 95,
  footprintRadiusM: 35,
  portalId: "drowned_city_world_to_entrance",
  portalRevision: "drowned_city_world_to_entrance-v1",
  interactionLabel: "Enter the Drowned City",
  presentation: "stairs",
  assetKey: `${ART}/entrance.png`,
  preloadSceneKey: "drowned_city/dc_sunken_stair"
};

const before = await readDungeonInteriorFiles(directory);
const library = structuredClone(before.interior.library);
const ids = new Set(prefabs.map((prefab) => prefab.id));
library.prefabs = [...library.prefabs.filter((prefab) => !ids.has(prefab.id)), ...prefabs];
// The entrance names the dungeon, so it is added once the dungeon has been scaffolded (run again).
if (before.interior.spaces.some((space) => space.id === entrance.dungeonId)) {
  library.entrances = [...library.entrances.filter((candidate) => candidate.id !== entrance.id), entrance];
}
library.catalogRevision += 1;
const writes = planInteriorSpaceWrites(before.texts, before.interior, [], library);
const outcome = await applyInteriorWrites(directory, before.texts, writes);
if (!outcome.ok) throw new Error(outcome.reason);
console.log(`Registered ${prefabs.length} prefabs and the entrance template (${writes.map((write) => write.fileName).join(", ")}).`);
