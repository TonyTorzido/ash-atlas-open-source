# Add a new manor in Studio

A manor type is its own interior (its own rooms, floor pictures, walls, doors
and map building). Every player manor uses one type; existing manors use the
Timber Manor (`manor_lobby`), which stays the default no matter how many types
exist. The shipped types are Timber Manor, Samurai Manor and Haunted Manor.

## Steps

1. Open Ash Atlas Studio, go to **Interiors**, and choose **+ New interior**.
   Pick **Manor**, type the manor name (for example "Desert Manor") and create
   it. Studio makes the space with one room (the lobby) and a front door to
   the world.
2. **Interior** tab, **Overworld building**: choose the building PNG. Use a
   square PNG like the others (1254 x 1254, building standing on the bottom
   edge). **Map size** scales it on the map (1 = Timber Manor size).
3. Add the rooms (lobby is already there): **+ Room** for the upstairs
   hallway, each private room and the lower room. Rename any room with
   **Room name** in the **Room** tab (that name is what Studio lists and the
   default button label).
4. For every room, **Room** tab, **Floor art**: choose that room's floor PNG
   (lobby.png, hall.png, room.png for rooms on the right side of the hallway,
   room-left.png for rooms on the left side, lower.png). Each room has its own
   entry, so rooms can share a PNG and still keep separate furniture.
5. **Floors & Walls** tab: draw the walkable floor polygon over the floor in
   the picture, and the wall surfaces where wall decorations may hang. Room
   shapes can be anything; nothing assumes the Timber Manor layout.
6. Doors, in **Floors & Walls** (the Anchor inspector):
   - Pick the **Anchor** tool and click on the doorway to drop an anchor
     (or select an existing anchor in the **Anchors** list). Set **Anchor
     role** to **Portal**.
   - Under **Destinations**, one row per place the door leads:
     **Destination room** (any room of this manor, or **Outside (leave
     Manor)** in the entrance room), **Destination anchor** (an existing
     anchor there, or "New anchor in <room>"), and **Button label**: the text
     on the button in the door popup (e.g. "Upstairs", "Lower Room",
     "Basement"; empty = the room name, or "Leave Manor" for Outside).
   - **+ Add destination** adds another row; **−** removes one.
   - Press **Save door**. Studio creates every link both ways. A new return
     anchor in the other room is selected right away so you can drag it onto
     the doorway there; saving the same door again reuses the doors that
     already lead back to it.
   - Example lobby: the left door gets two destinations, Upstairs Hallway
     ("Upstairs") and the lower room ("Basement"); the right door gets
     Outside (leave Manor). Outside makes that door the only way out (there is
     no tap-yourself exit).
   - Draw a **Click Area** over each door in the art and bind it to the door
     anchor; its name is the popup title.
   - In the game, a door with one destination shows one button with its label;
     a door with several shows one button per destination plus Cancel.
   - **Doors & Exits** lists the same links; each has a **Door label** field,
     and **From door** + **Connect rooms** there can also add a destination.
7. Lobby stations (smith, jeweler, breeder) are station objects in the lobby
   and can be moved in **Objects & Doors**. The seeded Samurai and Haunted
   lobbies carry them; Studio cannot add a new station object yet, so a manor
   made from **+ New interior** has no stations until one is added in the
   data (copy the three `station_*` anchors, `manor_*` objects and click areas
   from `manor_lobby.json`).
8. Use **Walk Test** to walk through every door, then **Save to Worktree**
   so the PNGs and the interior are written to the worktree.

## Editing tips

- The three shipped manors start from layouts measured from their floor
  pictures (floor outline, walls, every door with a click area, spawn just
  inside each room's entrance). Adjust them rather than starting over.
- Dragging anchors and polygon points follows the cursor. **Snap** (canvas
  toolbar) is off by default; when on it uses a fine 5-unit grid. Hold
  **Shift** while dragging to switch snapping for that drag.
- Give anchors a **Name** in the Anchor inspector ("Left door", "Exit",
  "Stairs", "Door 1"...); the canvas and lists show it. Selecting an anchor
  from **Objects & Doors** shows the same inspector (name, role,
  destinations, Save door).
- If Studio finds unsaved edits from an older version of the interiors, it
  asks: **Discard old draft** or **Restore anyway** (it never brings old
  layouts back silently). **Revert** throws the draft away.

## In the game: Manor skins

- Every Manor type except the default Timber Manor is sold as a **skin**:
  an inventory item called "<Manor type name> Skin" (for example "Samurai
  Manor Skin"). A new Manor type made in Studio becomes a skin automatically;
  no code or migration is needed.
- **Price:** Interior tab, **Overworld building**, **Skin price** (Glimmer;
  500 until you change it). Players buy skins with Glimmer from the **Skins
  Shop** (desktop manor prompt **Skins Shop**, or the phone manor sheet's
  middle button); the shop only buys, and the skin lands in their inventory.
- Skins work like equipment. Open the skin in the **Inventory** and choose
  **Equip on Manor**: the item stays in the inventory, marked **Equipped**,
  and the Manor switches to that skin. **Unequip** goes back to the default
  Timber Manor. Equipping another skin just switches; the old one stays in
  the inventory, unequipped.
- An equipped skin cannot be dropped, traded on the market, gifted, stored or
  otherwise removed; the player is told to unequip it first. The database
  enforces this for every path, so a Manor can never keep a skin its owner no
  longer holds. Unequipped skins are normal items (drop, market, gifts).
- Equipping works anywhere (world or inside the Manor). Guests inside refuse
  the change; if only the owner is inside, the Manor switches and the owner
  is moved to the new skin's lobby spawn.
- Decorations stay in the rooms of the skin they were placed in. While another
  skin is equipped they are hidden (not deleted, not counted) and they come
  back when that skin is equipped again.
- Inside, the **Decorations** button (top right) works in every room;
  decorations go into the room you are standing in.
- Testing: grant a skin with the developer package grant (Developer, Packages:
  search "Skin" and pick the Manor type as the variant).

## Where things live

- Interior data: `packages/shared/src/data/interiors/<manor id>.json`
  (floor art = the room's `<room id>_floor_art` background placement;
  map building = `modules.manor.exteriorAssetKey`).
- Studio-imported PNGs: `apps/client/public/assets/...`; seeded art:
  `apps/client/src/assets/manors/<type>/`.
- Equipped skin: `player_manors.manor_type_id` (migration 1081); skin items and purchases: migration 1082;
  equip model, equipped-skin guard and the return of previously installed skins: migration 1083.
