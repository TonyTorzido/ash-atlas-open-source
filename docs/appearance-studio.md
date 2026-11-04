# Ash Atlas Studio

Ash Atlas Studio has these workspaces: **Appearance** authors layered player and boss artwork,
**Game PNGs** inventories and previews the PNGs used by the client, player renderer, and installed
web app, **Interiors** authors every interior kind (dungeons, Manors, the Greenhouse and the Salon:
room graph, shapes, Walk Test and Manor decoration overlays), **Flags** authors territory structures,
and **Progression Icons** manually aligns atlas cells used by skills, classes, and professions. It runs as a React/Pixi
interface with a loopback-only Node bridge; it does not start the game, World API, PostgreSQL, or an
SSH connection.

## Starter dungeons and manor floors

In **Interiors**, choose **+ New interior** with the Dungeon kind, create a dungeon, import room art through **+ Add PNG**, and use the
canvas's existing anchors, walkable polygons, colliders, and paired connections. **Enemies**
supports fixed canvas placements or N enemies in a selected spawnable zone and encounter wave.
Random positions are seeded once per run; retries keep that run's positions. To summon miniboss
adds, place the leader first, select it under **Spawn timing**, and choose its health threshold.
Adds appear once per encounter attempt and must be defeated before that wave clears.

**Resources** supports fixed nodes and random-count zones, including wood, ore, stone, coal, iron,
sulfur, flax fiber, and balsam resin. Import/select object PNGs for trees, plants, or mining nodes.
Resource-zone geometry can copy a room polygon, then be edited with the usual canvas tools.
**Chests & Loot** configures chest PNG, spawn percentage, all five rarity percentages totaling 100%,
and each rarity's slot count and weighted item pool. Picks allow replacement and duplicate items
stack. The server evaluates spawn → rarity → loot slots and uses the existing transactional,
per-player/per-run reward-source claim. **Logic → Fight cleared → chest appears** replaces previous
reveal actions for the selected chest while retaining unrelated actions and stable trigger IDs.

**Game entrance** is visible in Simple mode. Add/edit the entrance and select or upload its PNG.
The existing Developer → Dungeons placement tools remain responsible for eligible land near lakes;
Studio does not bypass placement checks. Cistern Warrens remains structure-bound. Save writes the
isolated worktree, not a running remote server. **Play Test** checks layout and event wiring;
seeded enemy positions and health-triggered adds can also be simulated with explicit damage shortcuts. Combat, resource settlement and economic rolls require a saved game run. The Saved game test checklist describes entry through Developer → Dungeons and the universal portal.

In **Interiors**, on a Manor space, the starter template includes Upstairs and Basement hallways with six room doors
each. The first room on each floor is open; the remaining five begin locked. **Add upstairs +
basement** seeds that same paired graph for another template without duplicating an existing graph.
Room tabs retain direct manipulation of anchors and polygons; choose a room PNG and edit **Door
locked** on its anchor. Until art is supplied, labelled layout diagrams show the canonical hotspots.
Walk Test follows paired arrival anchors and displays locks, but is not an authorization test.
Published rooms use the universal portal/location system, including movement and return routing.

## Launching

Run this from an isolated appearance-authoring worktree:

```powershell
pnpm appearance:studio
```

The permanent official checkout keeps `http://127.0.0.1:5285`. Linked feature worktrees derive a
stable port in `25285-45284` from their registered identity or canonical worktree/branch identity.
Every Studio binds only to `127.0.0.1`; `0.0.0.0` is never used.

On Windows, `tools\appearance-studio\Run Appearance Studio.cmd` validates Node 24 and pnpm 11.10.0,
captures the exact worktree, branch, and commit, then starts only the Studio. Before any browser is
opened, the launcher verifies `/api/session` reports that exact startup identity. An already-running
exact Studio is reused. A different or stale Studio on the selected port is left running and the
launcher fails with its PID plus the expected and actual worktree identities.

Generate an external feature launcher with an explicit registered identity and deterministic port:

```powershell
.\tools\appearance-studio\new-worktree-launcher.ps1 `
  -WorktreePath 'C:\Users\dev\Documents\worktrees\my-feature__t333' `
  -Identity 'my-feature-t333-runtime' `
  -OutputPath 'C:\Users\dev\Documents\Ash Atlas Feature Launchers\Active\Run Appearance Studio - My Feature [t333].cmd'
```

Generated launchers pass the expected worktree, current branch, current commit, registered identity,
and selected port into the same identity-aware server coordinator. They never kill a listener.

Create new authoring work through the repository's `atree` workflow from the current immutable
immutable Integration Test generation. Saving is refused on `master`, `integration/test`, immutable
test tags, detached heads, unapproved branch names, and the permanent checkout. The studio shows
the resolved repository, worktree, branch, exact SHA, and write status. The browser title and page
header also show the worktree and branch so a stale tab is immediately visible.

## Authoring an appearance

The player Library has two explicit areas. **Player Overlays** organizes standalone content under
the visual targets Face, Mask, Hair, Beard, and Legs. Chest armor, gloves, boots, and shields are
equipment-backed and are authored only under **Gear**. The fixed whole-player template remains the
base player model below all equipment and is not an overlay. It is one canonical **Base Body / Player
Base** template with three linked skin-tone asset slots (Light, Medium, Dark); all three share the same
pose transforms, rig anchors, and frame layout. The Base Body import replaces the selected pose's
canonical asset, while a skin-tone import replaces only its selected tone link. Face contains one
canonical family and one active appearance, authored from the combined eyebrows, eyes, nose, and
mouth PNG. Beard is an independent face overlay family. Standalone Pants authored under Legs enter
the preview's Salon styles and render on the canonical Legs layer.
Each gear family shows its visual-only **Player overlay** target: weapons use None and retain their
hand pivots, poses, projectiles, and gems; shields use Shield; head armor defaults to Hair. Changing
this target does not change an equipment slot, stat, gameplay family, or server authority.

1. Select the mechanical equipment family and drop or choose a transparent PNG. The family owns
   the slot, combat stats, upgrade curve, class affinity, and Damage Matrix identity.
2. The bridge validates it and stages it outside Git. Staged PNGs survive a Studio bridge restart
   for seven days, but do not appear under `packages/player-renderer/src/assets/player-appearance/`
   until Save succeeds. Inventory artwork remains separate.
3. The new appearance inherits the relevant family preset: sword, axe, bow, staff, shield, armor,
   gloves, boots, or back item.
4. Choose an anchor. Anchors are points on a versioned body and pose; offsets are canonical
   player-local pixels, with positive X right and positive Y down.
5. Drag or use arrows for one-pixel nudges and Shift+arrows for five pixels. Rotation is degrees.
   Scale can be flipped by sign. Pivot X/Y are normalized source-texture coordinates and compensate
   for transparent padding.
6. Choose a named layer. Forward/backward moves through the canonical layer order rather than
   inventing numeric z-indexes.
7. Save. The complete catalog and item variants are validated against the session's exact
   worktree, branch, commit, and catalog revision. One cross-process lock rejects overlapping
   saves. PNGs and changed JSON files publish as one recoverable transaction: an interruption
   restores every prior destination, and the next bridge start completes rollback before serving.
   Reloading reads the same placement.

Gloves and boots use one transparent right-side PNG for both visible sides. The Right part keeps
the source orientation on `right_hand` or `right_foot`; the Left part starts horizontally mirrored
on `left_hand` or `left_foot`. The side tabs edit independent placement transforms. Replacing the
PNG updates both part asset keys together without resetting either side's authored placement.

Weapons and armor also expose a **Gem** preview target. The **Gem preview** selector can display any
supported gemstone, all using the same dimensions, and the selected overlay can be dragged to the
intended socket or positioned with normalized X/Y controls. New weapons default to their authored
rotation pivot; armor defaults to the center of its PNG. **Universal Gem Size** changes the rendered
size for all gemstones. The separate **Core Hues** workspace assigns one universal weapon tint to
each core (for example, Venom's Poisoned hue). Selecting a core in the appearance preview shows
that tint without recoloring the gemstone itself.

Weapon appearances can opt into **Ranged visual (projectile on hit)**. This is presentation-only
and does not change combat range, damage, or targeting. Drop a second transparent PNG into the
projectile slot, then use the Projectile, Impact Point, and Tail Point preview modes. The red Impact
Point is pinned to the struck character; the cyan Tail Point defines the PNG's authored forward
axis. Offset, rotation, independent X/Y scale, flips, actual scale, direction presets, and the target
character overlay use the same geometry as the game. On each confirmed hit, the client aims the
Tail-to-Impact axis toward the target, follows that character's movement, and removes the visual.
Projectile PNGs are stored under `projectiles` and publish in the same recoverable transaction as
the appearance catalog. Legacy projectile entries retain their prior centered, right-facing defaults
until an author saves a projectile transform.

Unsaved browser edits are kept in a recovery draft keyed to the exact worktree and branch. A page
reload restores that draft only while its base catalog revision still matches disk. Network and
validation failures retain the visible dirty state. If edits continue while a save is in flight,
the save response advances the disk revision without replacing those newer edits.

Physical item variants store a stable family ID, item role, display name, appearance, and economic
metadata. `stock` is the ordinary family item; `cosmetic` is a named visual item; `special` and
`developer` are explicit nonstandard content. Cosmetic records cannot override weapon category,
armor category, Damage Matrix identity, combat stats, upgrades, switching, movement, or rewards.
Mechanically different equipment must use another family. Published item IDs remain permanent even
after their sale or authoring availability ends.

When a stock Gear item has no artwork yet, as with Chainmail Armor, its existing-item editor states
that no artwork exists. Clicking the drop zone to choose a PNG or dropping one there creates the
item's first appearance through the normal existing-item workflow.

The existing-item editor can attach a limited personal-Gold sale to a cosmetic variant. Price,
UTC start, and UTC end live in the item-variant catalog; Save rejects malformed or reversed windows,
and the game server rechecks the active window and authoritative wallet inside the purchase
transaction. Retirement and sale expiry hide acquisition without invalidating owned items.

The Studio reads this catalog from the selected worktree, not PostgreSQL. The server projects each
equipment item's family and role into `item_definitions` and refuses startup if that durable catalog
does not match the compiled shared definitions.

The canonical catalog is
`packages/shared/src/data/player-appearance-catalog.json`. Approved asset roots are `bodies`,
`weapons`, `armor/head`, `armor/chest`, `armor/gloves`, `armor/boots`, `shields`, `projectiles`,
`enhancements/gems`, and `cosmetics`.
The game and studio both use `@ash-atlas/player-renderer`, so anchor resolution, transforms, pivots,
layers, body fallback, and texture behavior are identical.

Every saved player appearance—including stock equipment and weapons, faces, skins, standalone
styles, Player Overlays, and linked item variants—uses **Remove Appearance** rather than physical
deletion. Removal hides it from normal appearance and existing-item menus while preserving its
catalog identity, artwork, existing player selections, and owned or equipped items. Linked item
variants are retired with the appearance, and Salon content moves to the retired state. Enable
**Show removed appearances** to inspect and **Restore Appearance** to make one selectable again. A
never-published draft can still be deleted outright before Save.

## Authoring game PNGs

The **Game PNGs** workspace inventories every PNG under the canonical client asset, installed app
icon, player appearance, and boss appearance roots. Search and category filters expose the source
path, intrinsic dimensions, content hash, and every known production usage. One PNG can have
multiple usage tabs when the game renders it differently, such as city and shrine artwork on the
world and on the World Map.

Discovery is recursive and runs against the currently selected worktree. **Refresh PNGs** reruns it
without changing the selected PNG when that file still exists. Use **File > Open Ash Atlas
Worktree** to switch the branch/worktree; opening it triggers discovery for the new worktree, so
there is no separate branch selector.

The **AtlasPNGS inbox** below the filters also checks the top level of the user's
`Documents/AtlasPNGS` folder on every refresh. Valid PNGs appear with their proposed canonical
client asset target (including a uniquely matching registered nested slot such as
`apps/client/src/assets/structures/loom.png`), so new art can be selected with **Import to Worktree**;
the existing **Save to Worktree** action then publishes it. Inbox discovery never copies files or
changes the source folder by itself. Non-PNGs, nested files, invalid PNGs, ambiguous names that
normalize to one target, and targets already containing different bytes are shown as unavailable;
this prevents an external file from silently overwriting tracked art.

Optional live labels, categories, and editor usages are read from
`packages/shared/src/data/runtime-png-asset-metadata.json` on every inventory load. Updating that
worktree-owned registry does not require rebuilding Studio. Older worktrees without the file and
new PNGs without an entry remain auto-discovered, generically described, and replaceable. Invalid
registry paths, shapes, discovered-file references, or presentation editor keys fail inventory
loading rather than silently binding the wrong editor.

Registered production slots remain visible in Game PNGs when their PNG bytes are missing. Every new
player-visible game entity or art identity—including items, resources, drops, collectibles, mobs,
animals, NPCs, buildings, facilities, structures, projectiles, effects, and equivalent content—must
register an independently editable slot naming its exact production path and usage before feature
acceptance; Studio then exposes **Add Exact PNG**. Runtime fallback is allowed only for safe
rendering while art is missing. A shared or generic placeholder does not satisfy registration, and
missing existing Game PNG coverage is a defect rather than an exemption.

The playground shows the selected production size and geometry. Assets with several usages open
their first editable sprite or fixed-size usage by default, while every recursively discovered PNG
continues to support **Replace Exact PNG** at its canonical path. Dog baby, adult, and elder artwork
shares the editable world-dog sprite presentation. Any other game PNG can be used as
a translucent, Studio-only comparison overlay, including a player body, so scale and placement can
be judged in context. Dragging the overlay moves it independently for preview only; **Reset
position** returns it to centered and bottom-aligned, and the offset is never saved. **Actual
pixels** removes fit-to-preview scaling. For canonical sprite and fixed-size usages, the cyan
anchor ring and gold hit-center diamond can be dragged independently while the gold outline shows
the clickable area. Both sprite and fixed editors expose production **Width (px)** and **Height
(px)**. **Lock proportions** defaults on when the current geometry matches the intrinsic PNG aspect
ratio; locked edits keep that ratio, while unlocked edits allow independent horizontal stretching.
Turning the lock on after distortion repairs width immediately while preserving height. Sprite
width is stored as a horizontal scale factor, so world zoom and authored height remain independent.
Numeric controls also edit normalized anchor and hit-center coordinates, hit shape, and either
circle radius in pixels or rectangle width/height as frame proportions.

**World PNG Master Scale** applies one shared `0.25×`–`4.00×` multiplier after each eligible
usage's authored size. It scales in-world mobs and animals (including designated boss
compositions), resources, collectibles, drops, buildings, and structures without moving their map
coordinates or normalized anchors. Player presentation and the territory-flag family sprites
(`flag` and `buoy`) are excluded. Fixed presentations, including the Atlas Shrine and its World Map
marker, remain eligible. Per-usage width, height, stretch, anchor, and hit geometry remain independent.
Normalized rectangular hit areas follow the scaled frame, while eligible circular pixel radii
scale with the art.

Persistent world-building usages are labeled `world-object` in the metadata registry and use the
same map zoom curve as world sprites. World Map destination markers and transient feedback remain
`fixed` when their screen-stable presentation is intentional; the Studio bridge rejects a
world-building key declared with the fixed editor.

**Keep standardized** is an optional Studio display/input mode and defaults off. When enabled,
eligible Width and Height fields show final rendered pixels after World PNG Master Scale; entered
values are converted back to authored dimensions on save. Toggling it or changing master scale
does not rewrite every authored size, and player/flag/buoy fields remain raw.

**Replace Exact PNG** stages new bytes at the selected canonical path and therefore updates every
listed use of that path together. Item artwork has two permanent fields in the shared presentation
catalog: **Inventory/menu artwork size** (`inventoryHeightPx`, optional for backward compatibility)
drives `ItemArtwork` in inventory, menus, rewards, Creature Book, prompts, and both phone and
desktop UI; **Ground-drop size** (`baseHeightPx`) drives outdoor, Manor, and dungeon drops. A
missing inventory field safely falls back to the ground size, so existing production entries keep
their prior presentation. Ground drops use one player-relative visual-height helper and one
effective hit frame in all three locations; legacy items default to **Lock hitbox to ground size**,
while authors can unlock and persist normalized custom hit geometry.

The permanent owner is the **Appearance Studio → Game PNGs** inspector; the in-game Developer PNG
Lab remains a session-only placement viewer and its temporary multipliers never write this catalog.
Player or boss composition assets link back to the existing Appearance editors. When an item has
this shared-size usage, the inspector shows a concise **Permanent shared item-size preview** with
**Phone** and **Desktop** modes plus **Open large preview** for a resizable companion window. Each
mode uses the same Dungeon Walk Test device dimensions and shows the selected PNG in a
production-shaped inventory row plus a Manor Lobby floor-drop scene with the current canonical
`PlayerRenderer` reference, quantity label, and clipping boundaries. Inventory uses the
mobile-equivalent 34px art frame in both modes; ground art is sized against the canonical player,
not a location-specific 44px constant. The inline and companion previews render the unsaved draft
values directly, so editing either size updates its corresponding context immediately without
creating phone, desktop, inventory, Manor, or dungeon overrides.

Save publishes staged PNG replacements and `packages/shared/src/data/runtime-png-presentation.json`
as one recoverable transaction. The client renderer and in-game PNG Lab consume that same
presentation catalog, so saved sizes and hitbox behavior are not Studio-only preview values.

## Interiors

**Interiors** is the unified workspace (the DungeonStudio shell, renamed InteriorStudio) for every
interior kind: Dungeons, Manors, Greenhouse and Salon. The space picker groups spaces by kind and
**+ New interior** asks for the kind. Encounters, Resources, Chests & Loot, Logic, Play Test and
Dungeon Flow are dungeon-only; other kinds show Room, Objects, Portals and Layout, and edit what the
room canvas supports (rooms, anchors, colliders, zones, layers, objects, portals, floors, walls,
click areas). Outside Simple mode every kind also has a **Shapes** tab and a **Walk Test** tab.
**Shapes** draws Floor (walkable), Wall (back/left/right, with image mapping), Click area (bound to an
anchor, with an interaction label) and Collider polygons on the room canvas: click vertices, then click
the first vertex, press Enter or use **Close Shape**; Esc cancels, Delete retires the selection,
vertices drag and edit numerically. Anchors take a role (Spawn, Portal, Message, Point); a Portal
anchor is paired with a new anchor in another room (or a world exit) and both portal records are
created together. Drawn geometry is stored in the view sidecar `interiorAuthoring` (keyed space and
room) and merged into the room on export; untouched rooms publish byte-identical. A dungeon's automatic
inset floor is replaced by its first drawn floor. **Walk Test** walks the exact player over the drawn
floors (the only walkable surface) with colliders, click-area messages and portal doors between rooms,
plus the Manor overlay toggles; dungeon Play Test is unchanged. Kind modules are kept as authored. Saves go through
`GET /api/interior-catalog` and `POST /api/interior-catalog/:spaceId/publish` (one space, plus
companion spaces when shared library art changes several): catalog and space revision conflicts,
retire-never-delete ids, a new revision for every changed room/space (Manor also a new published
revision id; the Studio bumps them on Save) and catalog-wide validation. Drafts are recovered per
worktree, branch and catalog revision for all kinds. The former Dungeons, Manors and
Greenhouses workspaces and their `/api/dungeon-catalog`, `/api/manor-template-catalog` and
`/api/greenhouse-studio-catalog` routes are gone; a saved session that last used one opens Interiors.
The Greenhouse's Farm Plot/water-tank templates and plant stage art are edited on its Planters tab;
its exterior, floor and door PNGs are replaced through the **Game PNGs** workspace.

## Authoring dungeons

Open **Interiors** and pick a dungeon to select a dungeon and room from the horizontal room graph. Published dungeon,
room, portal, object, zone, anchor, and prefab IDs are permanent; retire published content instead
of deleting it. **Archive dungeon** hides a saved creator dungeon and removes its world entrance while retaining rooms, art and reward identities for existing runs. Cistern Warrens is protected. Cancel dismisses the confirmation; Revert cancels the draft archive before Save. A new draft room can be removed until it is first published. The room inspector
edits its name, true logical width and height, fixed-center camera zoom limits, environment/audio
metadata, named anchors, rectangular colliders and zones, typed objects, fixed drawing layers, and
portal connections and conditions. The prefab library supplies reusable room objects without
creating feature-private movement or transfer behavior.

**Duplicate dungeon** makes an editable copy of the room graph and logic, with independent loot tables and no automatic world placement. Dungeon settings include an editable display name; internal IDs remain stable. The saved **Example - Slime Dungeon Template** is an authoring reference, not production content: two waves, a Slime Miniboss with health-triggered random Slime adds, ore resources, and a completion-gated chest. Its world binding is disconnected, its per-rarity art slots are empty, and its stock chest is only a placeholder. Add your own PNG art and explicitly bind a copied dungeon before live testing.

Interior Studio opens dungeon spaces in **Simple** mode. Its five plain-language steps guide a basic dungeon from
**Room Look** through **Enemies**, **Chest**, **Finish Room**, and **Play Test** without changing the
catalog merely by navigating. Simple mode keeps technical rules, collision, zones, and raw setup
details out of the way. Switch to **Advanced** to restore the complete authoring surface, including
portal connections, encounter details, logic, collision, zones, debug overlays, and technical
fields.

**Player notices.** The server automatically tells players when something they did changes the dungeon: a
door or passage opens (including a flag-gated door), an encounter is defeated, a hidden chest or object
appears, or the dungeon is completed. Several changes from one action merge into one short HUD line.
To control the wording, add a `show_message` trigger action (Advanced, trigger **Actions**: **Show message**
with a text of up to 140 characters and an info/success/warning tone) or, in Simple mode, fill
**Message when cleared** on the Finish Room recipe. An authored message replaces the automatic notice for
the same trigger, and trigger scope decides who sees it (player, party, or everyone in the instance).

Advanced mode also exposes **Resources** and **Chests & Loot**. Choose an eligible shared ground resource to
place a fixed resource node or a deterministic spawn zone with min/max counts, spacing, seed,
yield, reset, and respawn settings. Nodes and zones are shown on the authoring canvas and use the
same inventory harvest authority in the game. The **Reward tables** editor creates and edits the
durable reward records used by encounter and trigger settlement; it does not grant rewards from
the Studio itself. The **Boss library** lists the dungeon bosses the server registers
(`DUNGEON_BOSS_DEFINITIONS` in `packages/shared/src/dungeonBossDefinitions.ts`, the single source for
server and Studio) and adds one as a dungeon template, so an encounter references a shared
BossDefinition rather than copying controller code. Besides `xoral` and `sewer_rat_miniboss` there are
generic bosses `dungeon_slime_miniboss`, `dungeon_fire_bird`, `dungeon_ice_bird`,
`dungeon_lightning_bird`, `dungeon_ogre`, `dungeon_orc_brute`, `dungeon_bear`, `dungeon_alligator`
and `dungeon_skeleton` (cone-cleave "dungeon" controller, no dedicated boss art; they use the mob's
art). Dungeon boss defeats settle through the normal authoritative defeat settlement for the mob's
archetype and ignore the reward-policy object, so add dungeon rewards with a chest and reward table.
**Boss rule:** a boss encounter must contain exactly one non-summoned mob (the boss). Put trash waves
in a separate encounter and chain it (trash `encounter_state completed` -> `start_encounter` boss);
catalog validation and the Encounter editor both flag violations. **Reload from disk** (Dungeons,
advanced) re-reads the catalog after an outside edit such as the scaffolder, confirming before it
discards unsaved edits. Encounter settings include formation hints and linked aggro for an
existing spawn group.

The **Cistern Warrens** dungeon is structure-bound: constructed Cistern Warrens structures resolve their
entrance through the universal portal/location system and all use the canonical `cistern_warrens` room
graph. Its Game entrance card is informational and intentionally has no latitude/longitude form;
do not create a fake overworld entrance. Add a room, then use the existing Portals/Connections
tools to extend the graph from Sewer Entrance, Sewer Depths, or another authored sewer space.

Prefab **Replace art** stages a PNG replacement while preserving placement IDs, object state-art
variants, and authored collider identity. The editor scales default rectangular collider geometry
as sizing assistance and publishes the replacement in the same recoverable save transaction as the
catalog. Save validates the complete catalog, then reload the published revision before an author
uses the Walk Test; the isolated preview remains local and never bypasses the universal portal or
location system.

The authoring canvas preserves the room's true aspect ratio. Use click or drag to place the selected
record, drag empty canvas to pan, and use the canvas-local wheel, plus/minus, and **Reset View**
controls to inspect it without changing the surrounding Studio or browser zoom. Debug
toggles show anchors, collision, zones, portals, and the navigation route. On a phone-sized window,
the room rail scrolls horizontally while each library, canvas, inspector, and validation panel owns
only its own intentional content scroll.

For a dungeon with one active room, Simple mode's Room Tools include **Finish this room**. Place the
room art, one or more enemies, and a Treasure Chest, then choose **Set up combat and chest**. The
generated recipe starts combat on room entry, locks the existing universal room-to-world portal
while the encounter is active, exposes the initially unavailable chest when combat completes, and
completes the dungeon. The chest grants the catalog's basic dungeon reward through the authoritative
server inventory and wallet transaction, with a durable player-once claim that reconnects and retries
cannot duplicate. Advanced mode presents the same action as **One-room quick setup** with its
technical readiness details.

**Walk Test** is a local preview of the saved or unsaved catalog. Double-click or double-tap a
walkable location to move using the shared indoor navigation and collision rules. Reaching an
enabled room portal traverses to its catalog destination and arrival anchor; it does not implement
a runtime entry, location commit, return-position, scene-swap, or exit pipeline. Runtime dungeons
must still use the universal portal and location system. The in-game camera stays fixed and never
automatically follows the player. The author may independently pan and zoom the Walk Test viewport
with canvas drag, wheel, plus/minus, **Reset View**, or pinch; any area beyond the room renders black.

Unsaved dungeon edits are recovered from browser storage only for the exact worktree and branch and
only when the catalog revision on disk still matches the draft's base revision. Save validates the
entire catalog and stable IDs, then atomically replaces the single canonical file at
`packages/shared/src/data/interiors/` (one JSON per dungeon space plus `_library.json`); a revision conflict leaves the visible draft dirty.
Validation reports **Catalog valid** only for schema/catalog saveability. The separate readiness
summary reports whether the authored logic is ready for Walk Test and whether the dungeon has an
enabled world-to-room entrance binding. A wizard draft is intentionally saveable while its entrance
portal is disabled and therefore still reports **Needs world entrance binding**.

The in-game PNG Lab exposes the ground-drop control as a session-only live preview. It starts from
the catalog's official ground value, redraws the current world immediately, and Reset restores that
official value without a fetch, WebSocket message, or catalog write. The Game PNGs workspace edits
the persisted ground and optional inventory values instead; its preview scales eligible sprite and
fixed usages while leaving excluded usages unchanged, and **Save to Worktree** publishes them through
the existing recoverable runtime-PNG transaction and revision check.

The four goblin mob PNGs, Goblin Hall, and Goblin Market each have their own canonical production
presentation entry. Their initial values match the prior shared Ogre, City Hall, and City Market
values, but editing one goblin asset in Game PNGs now changes the independent key consumed by its
production renderer and reported by the in-game PNG catalog.

Dungeon keyboard movement belongs to the focused Play Test canvas; hidden Appearance shortcuts are disabled.
Workspace, dungeon, room, detail level and active task are recovered for the same browser tab and worktree.
Simple and Advanced retain the same task names. Resource polygon copying uses strict resource geometry.
Chest rarity art cards adapt to the inspector width; every rarity accepts the same validated PNG contract
(4 MiB, at most 4096 pixels per side and 16 million pixels total), with bounded automatic internal IDs.
Art assignment does not arm canvas placement. Loot weights also show the normalized chance per pick.

Slime and Slime Miniboss are authored dungeon combat definitions with Hunter XP and the existing
reward settlement path. They intentionally do not join Population V2 or Creature Book species, matching the existing dungeon-only sewer actors. Supply their final artwork through **Game
PNGs → Slime / Slime Miniboss → Add Exact PNG** at
`apps/client/src/assets/mobs/dungeon/slime.png` and
`apps/client/src/assets/mobs/dungeon/slime_miniboss.png`. Missing artwork uses the existing runtime
marker; these independent slots remain available before bytes exist.

## Scaffolding interiors from a spec

`pnpm interior:scaffold [--kind dungeon|manor] <spec.json> [--dry-run]` builds a new interior space from a
JSON spec so you can then place PNGs and tune it in the **Interiors** workspace. `--kind` defaults to
`dungeon`; `pnpm dungeon:scaffold <spec.json>` is the same as `--kind dungeon`. The scaffolder validates
with the same rules as the Studio publish (interior catalog rules, plus the Studio topology check for
dungeons and the Manor view parse for manors), refuses an existing space or room id, prints a summary,
and otherwise writes the new `data/interiors/<id>.json`, the bumped `_library.json` (`catalogRevision`)
and the generated `index.ts` together (all or nothing; it aborts if the files changed while writing).
`--dry-run` writes nothing. Then use Interiors -> **Reload from disk** (or restart the Studio). Errors list
spec paths, for example `rooms[3]: room "crypt_well" cannot be reached...`. Env `INTERIOR_DATA_DIR` points the
writer at another copy of `data/interiors` (trial runs). Examples: `tools/appearance-studio/interior-specs/example-crypt.json`
and `example-manor.json`. Code: `apps/appearance-studio/src/interiorScaffold.ts` (dispatcher, manor),
`dungeonScaffold.ts` (dungeon spec compiler), CLI `tools/appearance-studio/scaffold-interior.ts`.

All spec ids are `lower_snake_case`; unknown keys are rejected. Room ids are unique across the whole
catalog. Coordinates are room units; keep points 24+ from walls.

### Dungeon spec (`--kind dungeon`)

- `dungeon`: `{ id, name, description?, instancePolicy? (party_ephemeral), resetPolicy? (when_empty), theme?: {id, backgroundColor, floorColor, wallColor, accentColor} }`. `entranceRoom?` (default first room).
- `rooms[]`: `{ id, name, width? 1000, height? 1000 (320-4000), spawn?: {x,y}, anchors?: {name: {x,y,facing?}}, zones?: [{id, purpose? trigger|encounter_boundary|leash|safe|damage|restricted, rect:{x,y,width,height} | polygon:[{x,y}...]}], chests?: [{id, name?, at:{x,y}|anchor, reward?: {gold?, items?:[{itemId,quantity}]} | {table}, hidden?}], resourceNodes?: [{id, type, at, yield?:{min,max}}], resourceZones?: [{id, types[], rect|polygon, count?:{min,max}, spacing?, yield?, respawnSeconds?}] }`. Each room gets one rectangle floor inset by the player radius. Built-in anchors: `spawn`, and in the entrance room `entrance_escape` (world exit) and `death_recovery`.
- `doors[]`: `{ id?, from:{room, anchor?|at?}, to:{room, anchor?|at?}, oneWay? (false), label?, reverseLabel?, presentation?, locked?, gates?, conditions? }`. Omitted anchor/at picks an open walkable spot. Two-way doors create `<id>` and `<id>_back`. `locked: true` gates the door on flag `<id>_unlocked`; open it with `unlockDoor` in an encounter's `onComplete`.
- `encounters[]`: `{ id, name?, room, startOn?: "room_enter" | "manual" | {zoneEnter: zone} | {after: encounterId}, waves?: [{delayMs?, mobs:[{archetype, count?, at?:[{x,y}], zone?, visualScale?}]}], boss?: {template, at?|zone?, visualScale?}, rescue?: {timeLimitMs} (timed rescue: clearing the encounter in time frees a Valkyrie ally for the players in the room), lockDoors?: true | [doorIds], onComplete?: [...], boundary?, leash? }`. Mobs without `at`/`zone` spawn randomly in the encounter area. `boss.template` is a registered dungeon boss id (see the Boss library list) or an existing catalog template id. Trash `waves` plus a `boss` are auto-split into `<id>` (trash) and `<id>_boss`, chained; `after: "<id>"` and `onComplete` refer to the whole thing (the boss half). `lockDoors: true` locks every door leaving the room (and the world exit in the entrance room) while active.
- `onComplete` actions (one key each): `unlockDoor`, `revealChest`, `setFlag`, `completeDungeon: true`, `startEncounter`, `playCue`, `message` (1-140 characters, shown to players as a short HUD notice when the encounter is cleared; it replaces the automatic notices for that trigger), `raw` (any catalog trigger action, including `{"type":"show_message","text":"...","tone":"info|success|warning"}`).
- `triggers[]`: raw catalog triggers `{id, event, actions, scope?, repetition?, cooldownMs?, conditions?}` using real generated ids (room, encounter, chest, door portal ids). Generated trigger ids: `start_<encounter>`, `<encounter>_complete`, `<trash>_starts_<boss>`, `<chest>_reward`.
- Rewards come from chests (`reward`, granted on interact, once per player); encounters themselves grant nothing.

Left manual: art (rooms use the shared placeholder floor; doors and chests use placeholder prefabs;
colliders/walls), binding the world entrance (disabled, like the wizard; Developer App -> Spawning ->
Dungeon entrances), and a Play Test pass.

### Manor spec (`--kind manor`)

```json
{ "manor": { "id": "my_manor", "name": "My Manor", "description?": "", "theme?": { "id?": "", "backgroundColor?": "#071116", "floorColor?": "#182a2d", "wallColor?": "#405052", "floorAssetKey?": "" }, "playerPlacement?": true },
  "entranceRoom?": "lobby", "exit?": { "x": 830, "y": 830 },
  "rooms": [ { "id": "lobby", "name": "Lobby", "width?": 1254, "height?": 1254, "spawn?": { "x": 627, "y": 1100, "facing?": 0 },
      "floors?": [ { "id?": "floor", "polygon": [{ "x": 0, "y": 0 }] } ],
      "walls?": [ { "id": "back_wall", "kind": "back_wall|left_wall|right_wall", "polygon": [{ "x": 0, "y": 0 }], "image?": [{ "u": 0, "v": 0 }], "transform?": { "offsetU?": 0, "offsetV?": 0, "scaleU?": 1, "scaleV?": 1, "rotationDeg?": 0 } } ],
      "colliders?": [ { "id": "fireplace", "rect": { "x": 0, "y": 0, "width": 10, "height": 10 } } ],
      "anchors?": { "notice_board": { "x": 300, "y": 700, "type?": "point|message|portal", "facing?": 0, "message?": "text (message anchors)" } } } ],
  "doors?": [ { "id?": "lobby_to_hall", "from": { "room": "lobby", "at": { "x": 1100, "y": 1000 } }, "to": { "room": "hall", "at": { "x": 500, "y": 880 } }, "label?": "", "reverseLabel?": "", "locked?": false } ],
  "stations?": { "smith?": { "x": 0, "y": 0 }, "jewel?": false } }
```

(`?` marks optional keys; drop it from real specs. `stations: false` removes all stations.)

- Room ids must be new catalog-wide (prefix them). Default floor: one rectangle inset by the player radius; default spawn: (width/2, height-154), anchor id `spawn`. Floors are the only walkable area; colliders are polygons (a `rect` is converted). Walls are optional; `image` defaults to the polygon bounding box mapped to 0..1.
- Anchor types: `point` (default; what objects reference), `message` (needs `message`), `portal` (must be used by a door via `anchor`). `spawn`, `world_exit` and `station_*` are reserved names.
- Doors are always two-way. With `at`, the scaffolder creates portal anchors `<id>` (from side) and `<id>_back` (to side; `id` defaults to `<from>_to_<to>`), two reciprocal portal records (`<room>-<anchor>`, runtime id `manor:<manor>:room:<room>:<anchor>`) and a click area per anchor. `label` / `reverseLabel` default to "Go to <room name>". `locked` disables only the from-side portal (the return stays open). Door anchors must be on a floor and reachable from the room spawn.
- The entrance room (default first) holds the world exit (anchor `world_exit`, portal + click area; default at the lobby exit door 830,830, override with `exit`) and the four stations (chest, smith, jewel, breeder) at the current lobby positions; `stations` overrides positions per kind or drops them with `false` (positions must fit inside the room). Players arriving from the world start at the entrance room's spawn.
- `playerPlacement` (default true) enables player decoration placement. No art or decoration definitions are created; add those in the Interiors workspace.
- Output is an `owner_persistent` manor space with revision `<id>-v1`, `publishedRevisionId` `<id>-r1`, room revisions `<room>-v1`.

## Authoring manors

Open **Interiors** and pick a Manor space to edit its rooms (stored in
`packages/shared/src/data/interiors/manor_*.json` and the shared `_library.json`). The lobby starts from the approved Manor
floor PNG under `apps/client/src/assets/structures/manor-floor.png`; the source art remains
unchanged. Rooms own their dimensions, camera, authored floor surfaces (the sole walkable
navigation surfaces), polygon colliders, independently authored back/left/right wall placement
surfaces, typed anchors, and Door Click Areas (the compatible `portalHotspots` catalog field).
Published template and room IDs are stable, and every changed template requires a new revision
identity before Save can publish it.

The Author canvas uses connected vertices for arbitrary simple polygons. Select and drag a shape or
anchor, click the highlighted first vertex or **Close Shape** to finish every polygon tool, and use
the inspector to edit room vertices and wall normalized image mapping. Anchors are typed as **Spawn**,
**Portal**, or **Message**. A Portal destination pairs both anchors across the selected template and
converts a spawn or message destination to Portal; a Message anchor has editable text and no
destination. Door Click Areas are explicit clickable/interaction polygons that bind to a Portal or
Message anchor. **Walk Test** uses the canonical PlayerRenderer and shared
indoor movement/collision profile locally, including player-radius clearance, floor-only navigation,
elapsed-time movement, and optional feet, collision, navigation, hotspot/anchor, logical-coordinate,
rendered-dimension, and camera-scale overlays. Manor exit is self-click only and has no exit anchor.
Tapping a Message-bound Door Click Area opens the authored text in the canonical compact read-only
prompt with **Close**.
**Decoration Test** is a Studio-only draft/recovery overlay. Start with **Add Floor**, **Add Back
Wall**, or **Add Side Wall** (then choose Left or Right); after choosing a surface, load its PNG.
Drag/reselect and edit X/Y, size, scale, rotation, reset transform, normalized polygon footprint,
z-order, optional collision, and preview player ordering. Side-wall art is authored from the left
source; Right mirrors that source at render time while leaving footprint coordinates unchanged.
Invalid drags, drops, and numeric edits are rejected with status feedback; full transformed polygon
containment is validated for concave surfaces. These drafts never create inventory, database,
economy, or production placement state.

## Authoring a designated boss

Bosses remain in the separate **Bosses** workspace. **Weapon** positions the selected pose layer;
**Weapon Pivot** exposes a red handle that can be dragged onto the desired rotation point while the
weapon stays visually fixed. **Master Size** scales that boss body and weapon together and never
changes Player Master Scale. Boss Master Size requires desktop contract 9 / Studio 1.9 and a
content batch created from that contract or newer.

## Aligning progression icons

The **Progression Icons** workspace lists every general skill, class, profession, and profession
skill from the shared atlas registry. Select an icon, drag its artwork inside the clipped square,
and adjust scale or normalized X/Y offsets. The 32px, 48px, and 64px previews use the same render
math as the game. **Reset selected** restores the neutral centered transform; Revert discards all
unsaved alignment edits. Save validates the exact registry key set, worktree identity, and catalog
revision before atomically writing
`packages/shared/src/data/progression-icon-presentation.json`.

## Live content and desktop updates

Catalog JSON, item-variant JSON, and appearance PNG changes are live worktree content. They do not
require a desktop rebuild: reopening or reloading the selected worktree reads those files directly.
**Finish Batch** accepts the canonical Studio-authored Game PNG and runtime geometry content,
progression presentation content, and existing appearance content while refusing unrelated
worktree files. Studio integrations and deployments do not publish patch notes by default.
Patch notes require an explicit user request and user supplied wording for that publication;
never substitute **Improved Visuals** or internal commit summaries.

Changes to Studio UI or bridge code, catalog schema/validation, renderer behavior, hard-coded
equipment definitions, authoring categories, or other code bundled into the desktop application are
desktop-contract changes. A contract change must update all three together:

1. `APPEARANCE_STUDIO_CONTRACT_VERSION` and its minimum desktop version in
   `apps/appearance-studio/src/desktopContracts.ts`;
2. `config/appearance-studio.compatibility.json`; and
3. the desktop package version in `apps/appearance-studio/package.json`.

The Studio build verifies those values before compiling. Startup reads compatibility metadata before
parsing catalog content. An older desktop therefore shows **Appearance Studio update required** and
does not open, replace, or fall back from the worktree catalog.

Desktop-only lifecycle and packaging fixes can advance the desktop package patch version without
changing the contract or catalog compatibility metadata. The current `1.56.0` package includes the
bundled DungeonStudio, Manor Studio, shared item-size authoring, and Eyes/Nose/Mouth face-feature
anchor and area authoring at contract `56` and requires desktop version `1.56.0`.

`pnpm --filter @ash-atlas/appearance-studio desktop:stage` remains available on a task worktree for
focused verification. An installable `desktop:package` is stricter: it succeeds only from a clean
local `integration/test` that exactly matches `origin/integration/test` and has exactly one immutable
generation tag. Staged application metadata records the source SHA, dirty state, desktop contract,
and minimum version; it records a generation only for an exact clean integration source. Fetch and
integrate the contract change first; never install a desktop package built directly from a feature
branch.

`desktop:package` preserves `apps/appearance-studio/out/installer` between runs so Squirrel can use
the newest prior full package as its delta baseline, then prunes older full/delta payloads and stale
manifest entries. The bounded directory retains only that baseline, the current full/delta output,
the current Setup executable, and `RELEASES`. Before the first `1.41.0` package, seed that generated
directory from an installed `1.40.3` package, then build from the canonical clean
`integration/test` checkout:

```powershell
$releaseDirectory = Join-Path $PWD 'apps/appearance-studio/out/installer'
New-Item -ItemType Directory -Force $releaseDirectory | Out-Null
Copy-Item (Join-Path $env:LOCALAPPDATA 'AshAtlasAppearanceStudio/packages/AshAtlasAppearanceStudio-1.40.3-full.nupkg') $releaseDirectory
Copy-Item (Join-Path $env:LOCALAPPDATA 'AshAtlasAppearanceStudio/packages/RELEASES') $releaseDirectory
pnpm appearance:studio:desktop
```

The script always retains a full package for fresh installs and recovery. When a prior lower full
package is present, it enables Squirrel delta generation and reports the emitted delta; without one,
it clearly reports a full-only fallback. Publish the generated `RELEASES`, full package, delta, and
Setup executable together. The internal executable and delta member names contain no whitespace,
because Squirrel's delta checksum-entry parser treats spaces as field separators; the displayed
product and Setup names remain `Ash Atlas Appearance Studio`. To apply the published update through Squirrel, use the repository
wrapper. It stops only Studio processes in the exact per-user install root before updating, then
removes superseded app directories and consumed deltas while the files are unlocked:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/appearance-studio/update-installed.ps1 `
  -ReleaseUrl '<release-url>'
```

On Windows, Squirrel install, update, uninstall, and obsolete lifecycle launches are short-lived
installer events. They create or remove the Studio shortcut when required, then exit without opening
the Studio window or starting its local bridge. After a normal Studio launch or successful
install/update event, best-effort cleanup prunes stale app versions and old full package payloads;
once the current full package exists it removes stale delta artifacts too, while retaining deltas
when a package is still in flight. `Update.exe` and the current app executable remain in place.

## Connecting to a server

Enter a local, test, or production Ash Atlas origin and select **Authorize**. The studio generates
state and PKCE proof, opens the server's normal logged-in browser route, and accepts only an exact
`127.0.0.1` callback on official port `5285` or the dedicated feature range. `localhost`,
`0.0.0.0`, public hosts, and ports outside that range are rejected. The server requires the verified
`developer:appearance-studio` capability and returns a single-use code. The local bridge exchanges
it for a short-lived, narrowly scoped token held only in process memory.

The remote API is read-only apart from token revocation. It reports release SHA, catalog revision,
equipment definitions, bodies/poses, compatibility, and only the connected developer player's
authoritative appearance. The studio warns when local and remote content differ. Disconnecting or
closing erases the local token and attempts server revocation. Remote authorization is independent
of local worktree persistence: a game-server restart or revoked/expired remote token changes the
remote panel to authorization-required, while the loopback bridge and unsaved local draft remain
available. A loopback bridge restart rotates its local CSRF token; the client refreshes that token
and retries only an explicitly rejected, therefore known-unapplied, mutation.

Production file writes are deliberately unsupported. Save always changes the isolated local
worktree; review, integration into `integration/test`, generation tagging, publication, and
deployment remain the normal Ash Atlas workflow, preserving release identity and rollback.
Desktop integration and publication commands resolve exactly one dedicated local `integration/test`
worktree and run its canonical release script. They never use an older permanent `master` checkout
merely because it appears first in Git's worktree list.

## Driving the Studio from code

**Find the port.** The official checkout uses `http://127.0.0.1:5285`; a feature worktree derives a stable
port in `25285-45284` and the server prints it (`Server listening at http://127.0.0.1:<port>`). Confirm you
reached the right Studio with `GET /api/session`: it returns `origin`, `workspace` (`worktreePath`, `branch`,
`commitSha`, `writesAllowed`, `writeBlockReason`) and the server identity. Write endpoints need the session's
`csrfToken` and an `Origin` equal to `origin`; the GETs below only reject a foreign `Origin`.

**Read endpoints** (all in `apps/appearance-studio/src/bridge.ts`):

| GET | Returns |
| --- | --- |
| `/api/session` | worktree identity, write permission, CSRF token |
| `/api/catalog` | player appearance catalog |
| `/api/item-variants` | item variant catalog |
| `/api/boss-catalog` | boss appearance catalog |
| `/api/interior-catalog` | all interior spaces plus library (revisions) |
| `/api/runtime-assets` | game PNG inventory and presentation catalog (a few seconds on a cold tree) |
| `/api/runtime-assets/inbox` | PNGs waiting in `Documents/AtlasPNGS` |
| `/api/progression-icons` | progression icon inventory and transforms |
| `/api/territory-structures` | Flags catalog and available pieces |
| `/api/desktop/status`, `/api/desktop/release-status` | desktop publishing state |
| `/api/remote/status` | selected-server connection |
| `/runtime-assets/<repo-relative png>` | a game PNG (staged edits included) |

**Where each workspace's data lives** (relative to the worktree root):

| Workspace | Files |
| --- | --- |
| Appearance | `packages/shared/src/data/player-appearance-catalog.json`, `item-variant-catalog.json`, `boss-appearance-catalog.json`; art in `packages/player-renderer/src/assets/player-appearance` and `boss-appearance` |
| Game PNGs | the PNGs under `apps/client/src/assets`, `apps/client/public` and the appearance art roots; sizes/anchors in `packages/shared/src/data/runtime-png-presentation.json` and `runtime-png-asset-metadata.json` |
| Flags | `packages/shared/src/data/territory-structure-catalog.json` (pieces are Game PNGs) |
| Interiors | `packages/shared/src/data/interiors/<id>.json`, `_library.json`, generated `index.ts` |
| Progression Icons | `packages/shared/src/data/progression-icon-presentation.json` |

**Create an interior without the UI:** `pnpm interior:scaffold [--kind dungeon|manor] <spec.json> [--dry-run]`
(see "Scaffolding interiors from a spec"), then use Interiors -> Reload from disk.

**Test ids.** Every primary control, panel and list item carries `data-testid` in kebab-case, prefixed
by its workspace: `studio-*` for the shared shell (`studio-tab-<workspace>`, `studio-undo`, `studio-redo`,
`studio-revert`, `studio-save`, `studio-publish`, `studio-server`, `studio-drawer`, `studio-status-bar`),
then `appearance-*`, `boss-*`, `assets-*`, `flags-*`, `interiors-*` and `progression-*`. List items append
their id, for example `assets-item-<asset id>`, `interiors-room-<room id>`, `flags-structure-soft_flag`,
`progression-icon-<icon key>`. Workspace ids for `studio-tab-*`: `appearance`, `assets`, `flags`, `interiors`,
`progression-icons`. The Save button's `title` states why it is disabled (read-only reason, validation,
nothing to save). The page never scrolls; panels scroll internally.

## Verification

```powershell
pnpm appearance:catalog:verify
pnpm appearance:studio:build
pnpm --filter @ash-atlas/appearance-studio desktop:stage
pnpm test:appearance-studio-launcher
pnpm --filter @ash-atlas/appearance-studio test
pnpm --filter @ash-atlas/player-renderer test
```

The client production build also runs catalog verification, so an unsafe key, malformed catalog,
missing file, corrupt PNG, or excessive PNG size/dimensions fails before bundling.
