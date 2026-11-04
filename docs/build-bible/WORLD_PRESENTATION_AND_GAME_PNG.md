# World presentation and Game PNGs

Use this standard for world labels, persistent world artwork, interaction geometry, and production
Game PNG authoring. World presentation remains tied to the canonical PNG presentation catalog and
the owning renderer.

## World edge

The playable world ends at ±85° latitude (`WORLD_EDGE_MAX_ABS_LATITUDE` in
`packages/shared/src/geo.ts`), just inside the Web Mercator limit. The server refuses explicit
moves, travel, and flag placement past it and clamps system positions (arrival scatter, GPS
relocation, portal and manor returns, developer teleports, legacy saved positions) onto it. The
client resolves a tap past the edge onto the edge, like the movement leash, and shows
**The map ends here — beyond lies only fog.** Both the World Map globe and the gameplay map draw
static dark ink fog caps (`apps/client/src/map/worldEdgeFog.ts`) that fade in over the last degree
before the edge and are opaque beyond it, above the base land, OSM detail, and environment
overlays.

## World labels

City and active city-structure labels sit outside their interaction geometry. Position each label
from the exact unassisted base hitbox authored for that object: use the circle's bottom point or the
rectangle's bottom-center, then add a 2px gap. Labels anchor from top-center, grow downward, and
never receive pointer input. Do not substitute sprite-size offsets or change the hitbox to make room
for text.

City names use one 12px bold sans-serif line. Active city structures use a 10px bold canonical
title-cased type or name, with an optional 8px supporting line directly below it. Personal City
Houses, Mayor Houses, and Oil Wells show the owner possessive on that supporting line; district
monuments show `Tier N`; other current structures add no metadata. Primary text uses the canonical
primary parchment color, supporting text uses muted parchment, and both use a narrow deep-ink
stroke with a restrained deep-ink shadow for world readability.
These font sizes stay in screen pixels during live and cached camera transforms,
including global-to-local zooms; label offsets follow the current scaled hitbox.

World sprite sizing, hit radii, and the persistent-detail fade below use the latitude-normalized
ground-scale zoom `zoom + log2(1 / cos(latitude))` (map-center latitude, cosine clamped to 0.01;
`apps/client/src/map/groundScaleZoom.ts`) instead of the raw MapLibre zoom, because Web Mercator
magnifies ground by 1 / cos(latitude). The same ground framing therefore renders the same sprite
pixel size at the equator, 60 degrees, and 85 degrees. Tile levels and the globe band (zoom 8 to 4)
36px marker contract stay on the raw camera zoom.

The camera itself is offset the same way (`apps/client/src/map/groundScaleCamera.ts`). Every zoom the game
reasons about (defaults, preferences, limits, thresholds, the zoom indicator) is a ground zoom, and the zoom
handed to MapLibre is `cameraZoom = groundZoom - log2(1 / cos(latitude))` (latitude clamped to 85 degrees).
A 500 m circle, the player and a mob therefore measure the same pixels at every latitude (verified within 1% of
the equator from 0 to 85 degrees, north and south, by `full-app-tests/groundScaleCamera.spec.ts`). The user's
chosen ground zoom is kept in `desiredGroundZoomRef` (set by wheel, pinch and +/- zoom gestures): programmatic
centre changes (joystick and R3 follow, recenter, travel, teleport) convert it at the destination latitude, and an
idle correction runs at most once per second, never while a gesture or programmatic move owns the camera. Camera
min zoom is floored at 2 (a world smaller than the viewport would be re-centred on the equator). The projection
band is now `vertical-perspective` at camera zoom 9 and Mercator from 10 (previously 11 to 12), so every gameplay
framing, including the 80 to 85 degree default (camera zoom 11.5 to 12.5), renders pure Mercator.

Accepted limitation: the 125 m water squares (`water-visual-tiles-v1`) only exist from camera zoom
12, and MapLibre cannot draw a vector source below its minzoom. Near the poles an equator-like
framing needs a lower camera zoom (about 12 at 82.8 degrees, 11.5 at the 85-degree world edge), so
there, when zoomed out that far, lake/river/coast squares are not drawn while ground-scaled sprites
still are. Gameplay water stays World-authoritative and the low-zoom ocean fill and coastline still
render. This affects only uninhabited ice poleward of about 82.8 degrees; generating z9–z11 water
tiles was judged not worth the data cost.

Persistent low-level world detail is hidden at map zoom 13 or below. Remote player name labels and
eligible mob overhead health bars fade in with clamped smoothstep easing from zoom 13 to full opacity
at zoom 13.5, and reverse directly from current map zoom when zooming out. The local player never
receives a world-space health bar, and full-health passive mobs plus context-free remote players and
military groups stay hidden; non-player bars appear only while damaged or when authoritative
selection/target/activity state exposes active context. Local player names and mob names remain hidden.
Idle mobs show nothing besides their health bar. While a mob is counting down to attack
(acquiring) or to lose interest (disengaging), a 22px round badge (mobAttackCountdown.ts) floats
above its head: dark token, gilded rim, a 3px sweep that drains clockwise, and the whole seconds
remaining in bold. The sweep is amber, or red only when the mob's target is the local player. The
last second of an acquisition pulses gently (steady under reduced motion); disengage uses a dimmer
sweep and never pulses. Observers show nothing. The floating label is ambient speech only and sits
above the badge when both show.
World health bars are 54x7 for mobs, 50x7 for players and 80x8 for bosses, with a gilded 1px rim
and a clipped-corner frame. Fill color follows relationship to the local player: players and
companions green, engaged mobs (a target, chasing/attacking, or a combat acquisition countdown) red,
other mobs muted sand. The damage trail is bright warm, holds 150ms and drains over 300ms; reduced
motion snaps it.
From map zoom 8 down to
zoom 4, both gameplay and standalone World Map player
presentations use one smooth transition into the shared 36px visible-art screen-space marker. Both
paths calibrate the PlayerRenderer root against its authored 42px body and actual appearance
overall scale so the final visible art is 36px; the standalone marker frame remains 36px. Player
overhead health bars are hidden throughout that transition and marker mode, while closer map zooms
retain the normal local player size and health presentation. In the overlapping globe band, both
paths use the same absolute MapLibre globe camera values without changing the intentional gameplay
zoom floor. When shells have different usable viewport sizes or center latitudes, normalized globe
framing is compared as `2^zoom / (cos(latitude) * min(usable width, usable height))`; the equivalent
camera zoom compensates those viewport differences without treating either map's floor as a zoom
offset. City labels,
including NPC Goblin Villages, do not use this zoom fade. Every active city-structure
label does use it, including markets, houses, wells, warehouses, kennels, salons, and monuments;
their artwork and interaction geometry remain tied to the shared PNG presentation contract. Transient combat feedback such as damage
and reward floaters also remains independent of persistent-detail zoom visibility.

## World PNG presentation zoom

World Map destination PNGs and destination clusters have transparent button hit targets in every
UI profile, including the shared phone-style shell on desktop. Do not paint an opaque card behind
the art or cluster badge. Name labels and count badges retain their own readable surfaces.

Persistent world buildings and facilities use the shared `WORLD_OBJECT_ZOOM_POLICY` from the
runtime PNG presentation catalog. At the policy's base zoom, each asset uses its authored width,
height, anchor, and interaction geometry; moving the map zoom scales the rendered frame and its
pixel circle radius together with the curve (`zoomStrength` 0.70389327891398, a 25% minimum floor,
and no upper cap). This contract applies equally to Tannery, Loom, Cistern Warrens, city
facilities, resources rendered as structures, and future persistent world PNGs. Do not add a
per-building fixed-size exception or a second zoom curve.

Client world renderers must use `ZoomScaledWorldPngPresentation`,
`worldPngDimensionsForZoom`, and `worldPngInteractionHitBox`; authored anchors and normalized
rectangle geometry remain the source of truth as the frame scales. A persistent circular hit area
must scale from its authored pixel radius so it stays aligned with the art. The Appearance Studio
metadata editor marks these fixed catalog entries as `world-object` and rejects a persistent world
key declared as `fixed`; destination markers, map-only markers, and transient feedback may remain
fixed when their presentation is intentionally screen-stable. New PNG usage metadata must select
the presentation kind that matches the renderer so uploaded artwork cannot opt into inconsistent
zoom behavior.

## Territory structure authoring

Studio → Flags owns the complete Soft Flag, Bastion Flag, Tower, and Atlas Shrine definitions in
`packages/shared/src/data/territory-structure-catalog.json`. Structure types own a fixed (0, 0)
ground anchor and an independent rectangle in local renderer pixels; cosmetic packs own the root
scale/offsets, ordered PNG children, and burning/emblem attachment registration. Root changes apply
to every child around that anchor without moving world coordinates or scaling the interaction area.
Stock's three flags use a 0.8 master scale; shrine registration is preserved.

The game and Studio share `createTerritoryStructureRoot`. Their existing outer flag presentation
applies the shared world-object zoom policy once to the root and type-owned interaction rectangle,
including cached map transforms. All ordinary land-flag picking uses that full rectangle, with the
existing phone assistance added by the target picker. Buoy and kingdom-seat presentation, action
selection, ownership, health, placement, burning and siege authority remain their existing systems.
Game PNGs owns replacement PNG bytes; Flags owns composition and interaction. World Map destination
marker sizing remains a separate marker usage. Studio previews expose the same composition, anchor,
interaction and piece bounds, plus state tint/burning/emblem previews.

Flags → Components / Layers displays each actual PNG with its role, exact production path, alpha
transparency, order, visibility, registration, scale and original/control/fixed tint. It also shows
the procedural burning indicator and text emblem; their visibility remains driven by gameplay
state, not a cosmetic toggle. Component selection/solo and guide overlays are preview-only.
Required visible hardware and cloth (or shrine body) roles are validated before saving.
New pack / Clone Stock creates all four types together. `defaultPackId` selects the global cosmetic
default for the game; it does not assign player entitlements or change type-owned geometry.
The canonical manifest, exact Stock anatomy and developer workflow are documented in
[`docs/authoring/FLAG_PACKS.md`](../authoring/FLAG_PACKS.md).
Keep stable PNG paths in place.

## Game PNG registration

Every new player-visible game entity or art identity—including items, resources, drops,
collectibles, mobs, animals, NPCs, buildings, facilities, structures, projectiles, effects, and
equivalent content—must register a canonical, independently editable Game PNG slot before feature
acceptance. The shared runtime PNG registry must name the exact production path and production
usage, and the slot must be discoverable in Game PNGs on the feature branch with **Add Exact PNG**
available even when the final PNG bytes do not exist.

A fallback is permitted only to keep runtime rendering safe while the registered art is missing. A
shared or generic placeholder does not satisfy the registration or its production usage. Missing
registration or missing existing Game PNG coverage is a defect to fix, not a valid exemption.
