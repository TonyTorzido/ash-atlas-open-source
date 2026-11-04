# Ash Atlas Build Bible

This is the 30-second start page for player-facing work. The Build Bible is the mandatory routing
guide for player-facing Ash Atlas work; it turns stable product and architecture decisions into
short, discoverable standards so feature prompts do not need to repeat them.

Before implementing a new player-facing feature or substantially changing an existing one, read
this page and every standard mapped to the feature. Identify the feature shape, inspect the current
implementation paths named by those standards, then use the [feature acceptance checklist](FEATURE_ACCEPTANCE_CHECKLIST.md).
Repository code and canonical components are the implementation source of truth. Screenshots support
visual direction but never replace reusable components.

If documentation and code disagree, stop and reconcile them. Do not silently follow one, invent a
third interpretation, or document code that does not exist. The Build Bible UI contract and the
canonical components and styles it names are authoritative. Developer App → UI Standards is their
downstream live reference; any relevant UI standard, canonical component, or presentation change
must update that gallery in the same change.

## Decision router

| Feature shape | Read this standard or architecture |
| --- | --- |
| Clickable object/player, compact prompt/confirmation, or multi-target selection | [Compact prompts, targeting, and interaction feedback](COMPACT_PROMPTS_AND_TARGETING.md) |
| Full-screen/readable interface, app, ledger, menu, tab rail, or progression browser | [App shells, menus, and navigation](APP_SHELLS_MENUS_AND_NAVIGATION.md) |
| Timer, deadline, cooldown, progress bar, loading, retry, reconnect, or async status | [Timers, progress, and asynchronous status](TIMERS_PROGRESS_AND_ASYNC_STATUS.md) |
| World label, map object, persistent facility, world PNG, or new visible art identity | [World presentation and Game PNGs](WORLD_PRESENTATION_AND_GAME_PNG.md) |
| Responsive layout, accessibility, focus, safe area, or shared desktop/phone behavior | [Responsive and accessibility](RESPONSIVE_AND_ACCESSIBILITY.md) |
| Transient HUD feedback: notices, toasts, loot/XP/drop feed, or anything placed on the gameplay HUD | [HUD lanes, notices, and the loot feed](HUD_LANES.md) |
| Building, cave, room, floor, shop, dungeon, or any enterable location | [Portals and interiors](PORTALS_AND_INTERIORS.md) |
| World-to-interior or interior-to-interior movement | [Portals and interiors](PORTALS_AND_INTERIORS.md) |
| Flag Quick Jump, World Map flag travel, party travel, Auto-Follow, or invite arrival | [Flag travel and arrival](FLAG_TRAVEL_AND_ARRIVAL.md) |
| New or rebalanced world mob | [Adding a Population V2 mob](../population-v2-adding-a-mob.md) plus [Game PNG registration](WORLD_PRESENTATION_AND_GAME_PNG.md#game-png-registration) |
| New player-facing feature or substantial legacy-UI update | [Feature acceptance checklist](FEATURE_ACCEPTANCE_CHECKLIST.md) and all applicable standards |

Every new player-visible game entity or art identity—items, resources, drops, collectibles,
mobs/animals/NPCs, buildings/facilities/structures, projectiles/effects, and equivalents—must use
the Game PNG registration rule before acceptance, even when final bytes do not yet exist.

Any newly created player-facing interface must follow the Build Bible. An existing interface
substantially touched by a feature must be migrated to the applicable standard unless that
migration is demonstrably independent and recorded as a separate task. Small unrelated fixes must
not expand into broad UI rewrites.

## Canonical component quick lookup

- Compact prompt/confirmation: `apps/client/src/ui/GameActionPrompt.tsx`
- Target picker: `apps/client/src/ui/GameTargetPicker.tsx`
- Readable app shell/tabs/cards: `apps/client/src/ui/GameAppShell.tsx`
- Phone root navigation: `apps/client/src/mobileGameMenu.ts` and `apps/client/src/ui/PhoneHud.tsx`
- Recovery/status: `apps/client/src/ui/PlannedUpdateStatus.tsx`, `ConnectionRecoveryScreen.tsx`,
  and `PopulationPreparationNotice.tsx`
- World PNG presentation: `apps/client/src/map/worldPngPresentation.ts` and the
  [world presentation standard](WORLD_PRESENTATION_AND_GAME_PNG.md)

## Before coding

1. Classify the feature with the router and read this page plus every linked standard that applies.
2. Inspect the named canonical component, helper, registry, and current usage before designing a
   new path. Use the universal portal architecture for enterable locations.
3. Confirm authoritative data, responsive behavior, accessibility, and any required Game PNG slot;
   resolve documentation/code disagreement before editing.

## Before completion

1. Check the applicable [acceptance checklist](FEATURE_ACCEPTANCE_CHECKLIST.md), including focused
   tests, authoritative state/recovery, exact art paths/usages, and desktop/phone behavior.
2. Inspect the focused diff, run proportional verification, and require `git diff --check`.
3. Update Developer App → UI Standards in the same change when a relevant UI standard, canonical
   component, or presentation changes; it is the downstream live reference for the Build Bible.

Permanent rules belong here or in the architecture document this page routes to. Feature prompts
should name categories and required behavior, not reproduce standards. Small unrelated fixes must
not expand into broad UI rewrites.

## Supporting sources

- Visual foundation: `docs/ui/DESIGN.md`
- UI tokens and materials: `apps/client/src/ashAtlasTheme.css`
- Portal architecture: `docs/architecture/UNIVERSAL_PORTAL_AND_LOCATION_SYSTEM.md`
- World relocation architecture: `docs/architecture/authoritative-relocation.md`
- Live component reference: Developer App → UI Standards (developer access only)
