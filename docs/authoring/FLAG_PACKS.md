# Standardized territory flag packs

## Start here

The single authoring manifest and Stock template is
`packages/shared/src/data/territory-structure-catalog.json`. Do not copy coordinates from renderer
branches or make another manifest. Studio → **Flags** reads and saves this file. The schema,
validator, clone helper and runtime resolver are in `packages/shared/src/territoryStructures.ts`.
The game and Studio both compose it through `apps/client/src/map/territoryStructureRenderer.ts`.

“Flag-pack crafting” means developer asset authoring, not player crafting recipes. All four types
are required in each pack: `soft_flag`, `bastion_flag`, `tower`, `atlas_shrine`.

## Exact Stock anatomy

Paths below are relative to `apps/client/src/assets/`. Each PNG's existing alpha channel defines
its visible shape. Transparent pixels may retain RGB artwork: inspect with transparency enabled,
not an RGB-only image dump. There is no separate runtime mask, empty flag, perimeter, outline or
pole sprite beyond these components. Fine edge pixels belong to the authored PNG alpha.

| Type | Back PNG: hardware/body, original colors | Front PNG: cloth, control-color tint | Canvas |
| --- | --- | --- | --- |
| Soft Flag | `flags/default-hardware.png`: wooden pole and fittings | `flags/default-cloth.png`: shaded cloth | both 241 × 320 |
| Bastion Flag | `flags/bastion-hardware.png`: pole, fittings and stone base | `flags/bastion-cloth.png`: shaded cloth | both 344 × 320 |
| Tower | `flags/tower-hardware.png`: tower and flagpole | `flags/tower-cloth.png`: pennant cloth | both 281 × 320 |
| Atlas Shrine | `structures/atlas-shrine.png`: complete shrine | none | 1024 × 1024 |

The paired PNGs share their authored canvas and registration. Preserve that alignment when replacing
bytes; dimensions in the manifest are local renderer pixels, not source-PNG pixel dimensions.
Stock flags use root scale 0.8; the shrine uses 1.0. All artwork is static (`animation: "none"`).

Every visual also has two non-PNG attachments:

- `burning`: generated orange/gold flame geometry, shown only by burning state.
- `emblem`: white text containing the first character of the kingdom emblem, shown only with an
  emblem. This is not a separate emblem PNG or cloth mask.

Attachments follow the same root and expose position, scale and layer order. They cannot be deleted,
recolored or permanently hidden by a cosmetic pack. Studio's state toggles are preview-only.

## Studio workflow

1. Open the intended worktree in Studio and select **Flags → New pack / Clone Stock**. Supply a
   unique lowercase ID and readable name. Optionally choose a fixed cloth color. The clone contains
   all four types and references proven Stock PNGs; it does not duplicate image files.
2. Select a type and a **Components / Layers** row. Inspect its thumbnail, exact path, role, stable
   component key and actual visibility/tint behavior. **Solo selected component** and cyan selection
   bounds inspect that part without changing saved visibility or gameplay geometry.
3. Edit name, role, PNG path, width/height, normalized anchor, offsets, component scale, visibility,
   tint and layer order. Add PNG components, duplicate, move backward/forward or remove draft
   pieces. At least one visible `hardware` and `cloth` must remain for each flag/tower; shrine needs
   a visible `shrine`. Optional ornament uses `decoration`. Revert restores the saved catalog.
4. Choose **Original PNG colors**, **Ownership / control color** or **Fixed cosmetic color**.
   Tint multiplies RGB while retaining source alpha/shading; it is not a flat fill or selective
   color replacement. White returns the original colors. Fixed cloth color intentionally stops
   following control color for that piece, without changing actual ownership.
5. For new artwork, place separate PNGs under `apps/client/src/assets/flags/<pack-id>/`. Preserve
   existing runtime paths; the shrine's legacy path remains valid. The catalog registers each used
   PNG in Game PNGs and `flagArtwork.ts` bundles flags subdirectories automatically. Game PNGs owns
   replacing PNG bytes. **Reload asset list** discovers new files without discarding draft edits.
6. **Use pack in game** changes `defaultPackId`, independently of the inspected pack. **Save to
   Worktree** validates all packs and PNGs and atomically persists through existing workspace,
   branch/SHA, revision and CSRF guards. Reload the game after saving. Merely selecting a pack or
   changing the control-color preview does not change the game default.

Save does not commit, push, integrate, sell or assign a pack to a player. The default is global
presentation; future per-player pack selection can use the existing resolver's `packId` parameter.

## Catalog contract

- `structures[type]` owns the immutable `(0,0)` world ground anchor and independent interaction
  rectangle. Cosmetic operations do not alter it. Interaction edits are deliberate cross-pack edits.
- `packs[id].structures[type]` owns `id: "<pack-id>.<type>"`, root transform, PNG `pieces`,
  state attachment registration and static animation. Each component has a unique stable ID.
- Root and component/attachment scales are 0.1–4. Width/height are positive. Positions and layer
  numbers are finite and bounded. `anchorX/Y` are 0–1. Higher `zIndex` draws in front; equal layers
  retain array order, then burning/emblem insertion order.
- Roles are semantic authoring/validation labels, not masks. Visibility is saved for PNG components;
  mandatory roles must have at least one visible piece. Burning/emblem visibility is gameplay-owned.
- Schema v2 adds explicit component roles/names, scale/visibility/fixed tint and `defaultPackId`.
  The parser upgrades prior v1 feature catalogs without discarding their transforms or tap geometry.
- Gameplay type, footprint, anchor, ownership, health, siege, burning state, tower effects, shrine
  travel, placement, buoy and kingdom-seat behavior do not belong to a cosmetic pack.

## Deterministic commands

Run from the task worktree. The script resolves its own repository root and calls the same shared
clone/schema/asset validation used by Studio; it is not a parallel format.

```powershell
pnpm exec tsx tools/flag-pack/flag-pack.ts validate
pnpm exec tsx tools/flag-pack/flag-pack.ts clone --id violet-banner --name "Violet Banner" --cloth-color "#b65de3"
```

Clone is a dry run unless `--write` is supplied. `--write` adds only the new pack and increments the
revision; it refuses an existing ID, invalid catalog or missing PNGs. It does not activate the pack.
Writes use the real Studio publisher and its writable-worktree, revision, lock and atomic-save guards.
Use Studio for activation and detailed component editing. Do not run a direct-file command while a
Studio draft is open; reload Studio afterward. Direct catalog edits should also increment `revision`
so existing Studio drafts cannot silently overwrite them.

## Proportional verification

Run the validator and inspect the exact diff. Preview all four types in Studio at base, nearer and
farther map zoom: normal and solo components, selected/piece bounds, anchor, independent tap bounds,
control colors, burning and emblem. Test one save/reload and confirm intended active/default pack.
Confirm readable keyboard controls and a narrow layout if the UI changed. The canonical game
runtime must be ready at the exact pushed SHA before handoff; do not integrate protected branches.

For schema/helper changes, run shared `src/territoryStructures.test.ts`; for renderer changes, client
`src/map/flagArtwork.test.ts`; for editor changes, Studio `src/TerritoryStudio.test.tsx`; for save
changes, Studio `src/bridge.test.ts -t "saves canonical Flags"`. Run affected typechecks and
`git diff --check`; build when imports/asset bundling changed. Follow repository proportional checks,
not unrelated full suites.
