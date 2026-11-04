# UI, menu, and hotbar audit — open decisions only

## Audit scope

This is a decision-level audit of the player menu, app-shell migration, gameplay HUD, and feature
hotbar. It records inconsistencies that need an owner or product/data-model decision; it is not a
catalogue of every CSS difference or a request to rewrite working domain controls.

The current feature work already uses the canonical `GameAppShell` and `GameAppTabs` contract for
the migrated Inventory, Market, profile/social, Build/Furnace, and related app surfaces. The rows
below are the remaining boundaries where a consolidation or acceptance decision is needed. The
hotbar continues to use canonical consumable and fishing callbacks rather than introducing a second
gameplay authority.

## User goal and accessibility target

Players should be able to inspect and manage inventory, equipment, protection rules, crafting, and
ten utility hotbar cells in five paired rows with the same readable hierarchy on desktop and narrow touch layouts. The
target is keyboard-accessible, focus-visible controls with approximately 44px touch targets,
explicit loading/empty/disabled/error state copy, one intentional content scroller per app, and
contextual Close/Back actions that do not change domain authority.

## Evidence and limits

- Canonical shell and tokens: `apps/client/src/ui/GameAppShell.tsx` and
  `apps/client/src/ashAtlasTheme.css`.
- Menu routing and compatibility IDs: `apps/client/src/mobileGameMenu.ts`,
  `apps/client/src/ui/PhoneHud.tsx`, and the `phoneDestinations` wiring in `apps/client/src/App.tsx`.
- Hotbar and input paths: `apps/client/src/ui/Hotbar.tsx`,
  `apps/client/src/hotbar/hotbarModel.ts`, `apps/client/src/ui/CombatKitHotbar.tsx`,
  `apps/client/src/ui/WarriorQuickSlots.tsx`, and App-level keyboard handling.
- Action and persistence paths: `apps/client/src/client/domains/harvestingClient.ts`,
  `apps/client/src/gameClient.ts`, `apps/client/src/profiles/profileClient.ts`,
  `apps/server/src/http/hotbarRoutes.ts`, and the canonical WebSocket action handlers.
- Catalog/data-model evidence: `packages/shared/src/inventoryCatalog.ts`.
- Downstream reference: `apps/client/src/ui/UiStandardsGallery.tsx` and its focused tests.
- The audit combines source/focused-test evidence with the certified feature-runtime pass below.
  The pure-touch key-label behavior remains unit/source verified because viewport emulation did not
  emulate a touch pointer; no broader viewport claim is inferred beyond the recorded checks.

## Historical verification: `MENU-01`

The exact feature runtime `menu-hotbar-modernize-t1163-b9ec018e70` was previously inspected at
`http://127.0.0.1:41129` on certified SHA `48f118a59dc03a54cc135f518b95d877a84e3548`. That
snapshot is historical evidence only: it captured the superseded six-slot rail and visible reserved
core slot. Current ten-cell behavior is covered by the certified runtime evidence below.

### Current runtime evidence

Runtime `quickslot-pack-freedom-t1169-24c88e1594` was checked at SHA
`36d0c71d893ff30adf9a53899051104123834bd3`. Desktop live QA showed four default paired rows
immediately beneath Party, locked slots with the shared lock glyph, and two unlocked right slots
with the plus glyph. Settings Off hid both the hotbar and its toggle while Flag/Locate/Heal
remained available. Row count 4 and row positions 0/21/42/63 were observed. Responsive
mobile/tablet placement is supported by the shared layout/source and focused tests; no live 390px
IAB viewport check is claimed here.

- The historical desktop and narrow checks found no document overflow, but their six-slot/core
  geometry is not evidence for the current ten-cell rails.
- The source/focused tests now require five left and five right utility slots, no visible core slot,
  and a strict ten-slot write payload with six-slot/eight-slot read normalization. App owns a default-open
  visibility toggle beside Heal; it remains reachable when Heal is unavailable so hidden rails can
  always be reopened.
- Empty slots announce as enabled and open/cancel the picker normally; the internal reserved core
  invariant remains schema-protected without a rendered button.
- Mobile Game Menu, Inventory, and Crafting were inspected live. They showed canonical headings and
  tablists, readable content, and no console warnings or errors.
- The separate migration integration test passed `1/1`; that result is recorded as integration
  evidence, not as additional UI proof.
- Pure-touch key-label hiding remains unit/source verified because this viewport emulation did not
  emulate a touch pointer.

## Open decision register

| ID | Screen/menu | File/component | Inconsistency or outdated behavior | Current behavior | Why unchanged | Recommended change | Severity | Approx. scope |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `MENU-02` | Phone Game Menu and direct destination shortcuts | `mobileGameMenu.ts`, `PhoneHud.tsx`, `App.tsx` `phoneDestinations` | The canonical root exposes housed apps such as Inventory, Progression, Encyclopedia, Messages, Party, Pets, World Map, Construction, Rankings, Crafting, City, Kingdom, and Land Management, while destination/history registries still retain IDs such as contacts, tolls, achievements, patch-notes, and other legacy direct routes. Those IDs can look like dead menu items or obsolete options even when they are compatibility paths. | Root rendering is filtered to the canonical menu. Some omitted destinations remain reachable through callbacks, history, or direct shortcuts, and some are now housed inside another app. | Removing IDs or aliases without tracing persisted history and external shortcuts could strand a valid route or break an owner callback. | Mark compatibility-only IDs as non-player-facing, expose each housed destination once under its canonical app, then remove aliases after callers and history migration are verified. Keep a short compatibility window if persisted links require it. | Medium | Medium routing/history cleanup. |
| `MENU-03` | Miscellaneous settings and Developer App diagnostics | `PhoneHud.tsx` `MiscellaneousDestination`, `DeveloperToolsPanel.tsx`, `App.tsx` | `Show Zoom Level` is presented in both phone Miscellaneous settings and the owner-only Developer Tools view. The duplicate label suggests two settings even though both are tied to the same zoom-indicator preference. | Both controls are capability-gated and currently read/write the shared `zoomIndicatorEnabled` state; phone settings also contain default zoom and tap-assistance controls. | The owner view may intentionally expose a diagnostic toggle while the phone surface exposes player settings. Removing one without deciding ownership could hide a needed diagnostic or leave a misleading duplicate. | Choose one source of truth and define the visibility rule: either link the owner diagnostic to the player setting or keep it explicitly diagnostic with distinct copy and a read-only/player-setting boundary. | Low/Medium | Small settings ownership and copy change. |
| `MENU-04` | Desktop gameplay navigation and phone gameplay HUD | `BottomActionBar.tsx`, `PhoneHud.tsx` `legacy-controls-left/right`, `App.tsx` | The old action drawer and legacy HUD buttons coexist conceptually with the canonical Game Menu and new hotbar. Several actions are repeated across those surfaces, and the old drawer uses its own pill/drawer chrome. | Desktop still renders the Bottom Action Bar with profile, character, inventory, skills, pets, rankings, flags, kingdom, market, tolls, and building actions. The drawer is hidden on phone; phone retains only legacy recenter, flag/planning, and Heal controls alongside the utility hotbar. The App-owned hotbar toggle stays beside Heal when rows are configured and remains reachable without Heal in non-combat gameplay; all four controls use fully opaque surfaces. | These callbacks are still operational and some actions have no one-to-one hotbar replacement. Immediate removal would risk losing placement or navigation affordances and would make shortcut compatibility unclear. | Treat this as a risky consolidation candidate: map every legacy action to the canonical app menu or an explicit gameplay action, preserve recenter/placement actions as actions rather than destinations, then deprecate duplicate launchers after a desktop/phone smoke pass. | High | Medium/large HUD and shortcut migration. |
| `MENU-05` | Furnace recipe selection | `apps/client/src/ui/FurnacePrompt.tsx` `furnace-recipe-tabs` | The outer prompt uses `GameAppShell`, but the recipe rail is a one-off tab-like control with bespoke artwork, `aria-pressed` buttons, and station-specific typography instead of `GameAppTabs`. | The custom selector is readable and carries recipe-specific visual/quantity context; it is not a second domain authority. | A mechanical tab swap could lose the rich recipe affordance or change keyboard/touch semantics in a dense station prompt. | Decide whether the selector is a true tab set. If so, adapt it to canonical `GameAppTabs` subtabs while preserving recipe artwork and disabled/loading states; otherwise document it as an approved selector exception and test its focus order. | Medium | Medium component adaptation and focused UI test. |
| `MENU-06` | Developer-only legacy progression panel | `WarriorClassPanel.tsx`, `ClassesPanel.tsx`, progression styles | The compatibility panel still has `class-selector` and `class-detail-tabs` rails plus legacy Georgia/ui-monospace sizing that diverges from the tokenized app shell and V3 progression presentation. This is a one-off tab/typography implementation. | Normal progression uses the V3 panel; the older `ClassesPanel` path is mounted only when the developer progression view is opened, and its API remains useful to tests/owner tooling. | It is an owner/dev compatibility surface, so deleting it or rewriting it during a player-menu migration has a larger regression surface than the visible benefit. | Decide a retirement owner/date. Until retirement, either mark it explicitly dev-only or route its outer shell and tab semantics through canonical primitives without changing progression behavior. | Low/Medium | Medium compatibility-panel cleanup. |
| `MENU-07` | Confirmation and action prompts across apps | `GameActionPrompt.tsx`, `ConfirmDialog.tsx`, raw modal scrims in app panels | Canonical `GameActionPrompt`/`GameConfirmationPrompt` coexist with `ConfirmDialog` and several feature-specific modal/drawer scrims. Focus, outside-dismiss, scrolling, and visual treatment therefore vary by caller. | `ConfirmDialog` is still used by City Warehouse, Flags, Kingdom, Manor Storage, Social Profile, and owner tooling; other flows use the canonical prompt or bespoke role-dialog markup. | Some dense owner panels and domain-specific prompts need different layout/confirmation semantics. A wholesale replacement could alter focus return, async state, or outside-dismiss behavior. | Define one approved modal adapter with explicit exceptions. Migrate high-traffic player confirmations from `ConfirmDialog` first, preserve special owner/dense dialogs only when their exception is recorded, and verify focus/escape/async behavior. | High | Medium/large modal consolidation. |
| `MENU-08` | Global keyboard shortcuts and hotbar activation | `input/keybindRegistry.ts`, `Hotbar.tsx`, `CombatKitHotbar.tsx`, `WarriorQuickSlots.tsx`, App key handlers | Key ownership remains distributed across the hotbar, Combat Kit, Warrior quick slots, and App shortcuts. There is no full remapping screen or registry for every shortcut. | The utility hotbar now has named `hotbar.slot.1`–`hotbar.slot.10` actions, plain `1–5`, `6–9`, and `0` defaults, and one guarded App-level activation path; Hotbar is presentational for keyboard handling and hides visual key labels in pure touch mode. Combat Kit and Warrior slots retain their separate established bindings. | The named hotbar registry and prompt/input guards make the current defaults safe; expanding every shortcut into a remapping system would be a product and persistence change, not a safe follow-up edit. | Expand the registry and add a visible conflict matrix only if remapping is approved. Persist remaps through the profile settings authority and expose reset/defaults; until then document the reserved keys and keep legacy aliases intentionally temporary. | Medium | Medium input/settings work. |
| `MENU-09` | Hotbar settings persistence versus gameplay activation | `hotbarRoutes.ts`, `profileClient.ts`, canonical WebSocket action handlers | The hotbar settings mutation is HTTP while activation travels through existing WebSocket gameplay actions. This is a transport split that could be mistaken for duplicated backend action paths. | `GET/PATCH /api/profile/me/hotbar` owns durable bindings with revision/CSRF/rate-limit checks. Hotbar activation calls the existing `USE_CONSUMABLE` and fishing/rod callbacks; no second gameplay handler was verified. | Keeping profile persistence and gameplay authority on their established transports preserves authorization and idempotency. Combining them would broaden the change without evidence of duplicate gameplay behavior. | Keep activation on canonical action paths. Later, if needed, share client request/error/revision infrastructure for profile mutations only; do not create a hotbar-specific gameplay command merely to unify transports. | Medium | Medium client/API infrastructure follow-up, not a gameplay rewrite. |
| `MENU-10` | Hotbar item picker and contextual materials | `inventoryCatalog.ts`, hotbar model/UI, `harvestingClient.ts`, `gameClient.ts`, server consumable handler | The catalog classifies `repair_kit` and `torch` as `kind: "consumable"`, so picker eligibility includes them, but the generic `USE_CONSUMABLE` schema/handler supports only `simple_food` and `balsam_resin`. Repair Kit and Torch are consumed only in contextual authoritative equipment/flag actions. | The hotbar intentionally retains those bindings as visible/unavailable rather than inventing a context-free action. The ordinary generic food/resin and fishing actions continue through their canonical callbacks. | A context-free “use” action would need a safe target and authoritative semantics; silently hiding the bindings would make catalog eligibility and saved assignments harder to understand. | Make the product/data-model decision explicitly: either add an explicit quick-use capability/command with safe target semantics, or reclassify contextual materials out of generic consumable eligibility. Add focused allowed/unavailable tests for both items whichever option is chosen. | High | Medium/large inventory/action contract change. |
| `MENU-11` | Developer App navigation and UI Standards boundary | `DeveloperToolsPanel.tsx`, `UiStandardsGallery.tsx`, canonical shell primitives | Developer tooling still has a bespoke tab/header system while the downstream UI Standards gallery documents the canonical shell and primitives. This is a risky consolidation candidate because owner tools are denser and capability-gated, not ordinary player menus. | UI Standards demonstrates the canonical primitives; Developer App remains on its existing owner-only controls and is not required for player navigation. | Treating owner tooling as player UI could force unrelated diagnostic layout changes and expand this feature beyond the player-facing menu/hotbar decision. | Record whether Developer App chrome is in scope for the design-system standard. If yes, migrate it in a separate owner-tool task; if no, keep the exception explicit in UI Standards and avoid pretending the two systems are interchangeable. | Low/Medium | Medium owner-tool design task. |

## Coverage conclusions and confirmed non-findings

`MENU-10` is resolved by the current contract: the picker offers only Balsam Resin and usable
Fishing Rods, while retained legacy Torch/simple-food bindings remain safely unavailable rather
than acquiring an invented context-free action.

- `MENU-01` has historical desktop and narrow runtime evidence plus the current desktop runtime
  evidence above; the ten-cell/core-hidden layout is resolved. Responsive mobile/tablet placement
  is supported by shared layout/source and focused tests, while pure-touch label behavior remains
  explicitly limited to unit/source evidence.
- Dead-looking menu items and obsolete options are covered by `MENU-02`, with compatibility/history
  risk called out rather than declaring an option dead from its omission in the root menu.
- Duplicate settings are covered by `MENU-03`. The duplicate `Show Zoom Level` controls are the
  only verified same-preference setting duplication in the reviewed surfaces.
- Divergent typography and one-off tabs are concrete in `MENU-05` and `MENU-06`; no broad font or
  spacing laundry list is being proposed.
- Competing modal systems and old HUD controls are explicit consolidation candidates in `MENU-07`
  and `MENU-04`. The recommendation is an ownership/adapter decision before mass migration.
- Keyboard/input conflicts and obsolete hotkeys are covered by `MENU-08`. The hotbar's ten named
  actions now have a small default/conflict registry, but a full remapping screen and all-shortcut
  registry do not currently exist; repeat, editable-target, composition, and modal guards remain
  accepted safety behavior.
- No duplicated gameplay backend action path was verified. `MENU-09` records the HTTP profile
  persistence versus WebSocket activation boundary without misclassifying it as duplicate authority.
- The reserved core slot remains protected internally but is no longer rendered; stable binding
  references and zero-quantity behavior are intentionally represented as state rather than fake
  actions, and hotbar persistence remains server-authoritative. Legacy six-slot/eight-slot rows
  normalize on read while writes remain strict ten-slot payloads. No separate unresolved defect was found in
  those contracts in this source review.
- Hotbar row count and each row's vertical anchor are profile-owned persisted settings: the
  default is four of five paired rows, while Settings & Support can choose Off through five and
  place each selected row independently between Party and the bottom action controls. The
  App-owned toggle is transient open/retracted state; it remains available beside Heal whenever
  rows are configured and disappears when row count is Off. Desktop and phone render the same
  ten-cell paired-row model, with only the bottom two right cells actionable by default. This is
  resolved behavior, not an open product decision.
- Gear-scroll is represented only as a future-compatible binding shape; no fake gear action or
  context-free Repair Kit/Torch action is introduced. The picker offers only Balsam Resin and
  usable Fishing Rods; legacy Torch/simple-food bindings remain safely unavailable if encountered
  in persisted rows. The explicit capability decision is resolved by the current action contract.
- Backpack progression is resolved as one real persistent `player_backpack_instances` item with
  `Backpack +0` through `Backpack +10`, zero own weight, and +5 kg per level. Fresh bags are crafted
  from Crafting for 80 Leather + 2,000 Gold; enhancement actions are exposed from the Inventory
  item detail. Every non-destroyed owned instance contributes cumulatively, including manor storage
  and rows left in the legacy equipped location; there is no equip gate or equip/unequip UI, and
  migration 0849 gifts legacy instances to +10 without changing ownership or custody. Historical
  named definition IDs remain only for database/event compatibility; there is no separate tier UI.

## Verification for this audit update

This document update is intentionally limited to evidence-backed decision rows and the resolved
hotbar visibility contract. Focused client tests cover the toggle, artwork, and responsive style
assertions; the required repository check is `git diff --check`. The certified runtime evidence and
separate `1/1` migration integration result are recorded above; runtime/browser QA for the current
tip remains with the feature owner.
