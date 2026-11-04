# App shells, menus, and navigation

Use this standard for inventory, storage contents, build catalogs, management, Salon catalogs,
complex crafting, journals, long readable information, multi-step forms, and progression browsers.
Canonical shells own page structure, hierarchy, responsive presentation, focus, scrolling, and
navigation behavior; feature code supplies domain data and callbacks.

## Menu appearance

Light parchment is the default for every menu, app, dialog, popover, and HUD control. Cream/tan
paper, warm brown text, and muted brass rules form one layered surface; black or near-black
navigation rails and empty panels are not part of this theme. Dark walnut uses deep warm brown
paper, ivory text, and restrained brass accents. Neither theme recolors world/map artwork or
redefines semantic health, rarity, presence, warning, or progress states.

`apps/client/src/menuAppearance.css` owns the semantic page, paper, raised, pressed, text, muted,
accent, rule, and status-surface tokens. Existing `--aa-ui-*` material names remain compatibility
aliases, including compact prompts and Messages; new UI must consume these shared tokens.
Do not introduce a feature-local fixed palette. Shared cards, tabs, buttons, fields, lists,
footers and overlays inherit the active theme.
Body, supporting, field-label and read-only text use semantic text/muted tokens, not pale fixed
colors or opacity. Light text and muted text maintain at least 4.5:1 against every paper state.
Disabled controls remain readable; their disabled semantics, quiet fill and border distinguish
availability. Values over health/XP/hunger bars remain directly on the active theme paper or bar
surface with no separate brown or black value box; softened theme ink and semantic fills preserve
legibility even when a bar is empty or bright.

Settings & Support → Gameplay → Appearance exposes **Light parchment** and **Dark walnut**.
`ui/menuTheme.ts` applies the choice immediately and stores it per player on the current device,
restoring it on reconnect/reload; unavailable browser storage still permits a session-only choice.

## Ledger app header

Every Game Menu app's phone header is one anatomy at 64px: a brass-ringed medallion with the app's
Game Menu glyph, no section eyebrow above the title (the
title matches the tile label), and one status figure at the right (`headerStatus`: value + label)
or the app's single header action. Descriptive subtitles render as an italic intro line at the top
of the page. Pass `menuId` to `PhoneMenuDestinationShell`/`GameAppShell`.

The Game Menu's Adventurer plate shows an arched, brass-ringed portrait (kept above the screen grain),
the name in serif over a class plaque, four one-line stat chips with duotone glyphs (KD, Gold,
Health, Pack) and inset Hunger and XP gauges; the card keeps a fixed height because the portrait
canvas sizes itself from its box.

## Standard app anatomy

Every menu and app is built from the same parts at the same sizes. The tokens live at the bottom of
`apps/client/src/medievalFinish.css` (`--aa-type-page/section/card/body/meta/label/value/button`,
`--aa-kit-body-pad/section-gap/card-pad/card-gap/row-min/control/control-compact`); the components
are in `ui/GameAppShell.tsx`.

- Page header: title in `--aa-type-page` (20px small-caps) with an optional eyebrow/subtitle and the brass diamond rule.
- Tabs: `GameAppTabs` (`housed` = primary, `subtabs` = secondary). Scrollable subtabs fit when they can and scroll without a bar when they cannot.
- Body: 12px padding, 16px between sections. Section: `GameAppSectionHeader` (`--aa-type-section`, optional eyebrow, meta, action).
- Card: `GameAppCard`, 12px padding, 8px gap, title `--aa-type-card`, optional badge.
- Row: `.game-app-row`, 48px minimum, 36px leading art, title plus one meta line, trailing value or compact action.
- Stats: `.game-app-stats` on a flat `dl` (label `--aa-type-label` left, value `--aa-type-value` right).
- Buttons: 44px plaques (`primary`, standard, `destructive`, `quiet`); `.game-app-button-compact` (36px) only for inline row actions.
- Badge: `.game-app-badge` (11px caps); counts use the brass seal `.game-app-count`.
- Inputs: 44px, paper inset, 4px radius, 16px text. Empty and status states: `GameAppEmptyState`/`GameAppState`.
- Phone navigation: no footer bar. **Return to Game** is a text-only, 48px-tall plaque (150-172px wide by screen width) floating at the exact horizontal centre above the safe area, with or without Back; **Back** (only inside a sub-app) is a same-height plaque with a chevron and "Back" filling the space from the left margin to 8px before Return (up to 120px), and chevron-only when that space is too narrow (under about 370px wide). Both reuse the Game Menu directory card's edges (control radius, plaque-edge border, parchment leaf with `--aa-grain`, brass hairline and corner brackets), never rounded or pill corners, and never clip or overlap. The bottom band is exactly as tall as the top header bar (both use `--phone-menu-bar-h`, 64px), with the 48px buttons vertically centred (8px above and below); the safe-area inset sits extra below the band, and the body ends at the band's top so the last row stays reachable. The page colour and `--aa-grain` are painted once on the full-height phone layer; the scroll body and footer band paint no fill, border or shadow, so the band is seamless. Never an X glyph or compass glyph. **Desktop navigation rule:** a window opened from the dock or command row is top-level. It has no Back to a Game Menu and no "Return to Game" (phone language); its single footer action is a centred text **Close**. Back appears only for a real in-app sub-page (Item Protection, a profession or pet detail), is labelled with the parent ("Back to Inventory") and returns to that parent page, with Close beside it leaving the app. A window that has its own primary action row keeps it, and Close sits at the right of the same 64px band. Esc closes a top-level window and steps back inside a sub-page; the dock icon toggles its window; a dock click never opens the Game Menu window as an intermediate parent. Phone-only wording (tap, hold, swipe) and controls (Tap assistance, two-finger zoom) are hidden or reworded on desktop ("Click to place", "Double-click the leader"; the Hotbar flag builder reads "Click to place · hold to plan"). Windows opened from an in-world scene (Manor stations, Salon styling, Oil Well) are top-level too: "Back to Manor" and "Back to Salon" show no Back on desktop. A window with its own action row (Jewel Station, Furnace) keeps that row on the left and Close at the right of the same seamless 64px band. No window control uses an X glyph: close controls are text ("Close" / "Dismiss", class `menu-text-close`).

New screens adopt these parts instead of adding bespoke fonts, paddings, radii or colours; semantic
colours (health, presence, rarity, danger, success) stay as they are.

## Desktop and touch presentation

`uiEnvironment.resolveUiPresentation` owns the presentation decision: at least 1100 × 600 CSS
pixels, a fine pointer, and no touch/coarse-pointer capability enables desktop. Phones, tablets,
hybrid touch devices, and smaller windows retain touch presentation; no user-agent checks are used.
Desktop uses the entire browser viewport: both the rendered stage and environment viewport
measurements fill it. The bounded compact/wide stage is retained only for touch presentation.

F1 → Developer View → Presentation preview exposes Auto / Desktop / Mobile to developers.
The centralized environment override recomposes HUD, menus and chat immediately; it does not
emulate a phone viewport or alter input capabilities. Resize the window for narrow-width QA.
This preview is memory-only: reload, sign out, or loss of developer access restores Auto.
Player detection and persisted player preferences are unchanged.

Desktop has no full-width bar; the HUD sits on the corners of the map like a PC game. A top-left
unit frame (portrait medallion with a bronze level badge that opens Loadout, above the
HP/EXP/Hunger ledger with a thicker HP meter) anchors the party roster and quick-slot track below
it. Chat is a bounded top-centre plaque rather than a full-width strip. The bottom edge (about 92px)
holds a centered command bar holding every destination and utility as one
row of icon-over-label buttons (utilities after a hairline divider), which slides left instead of
overlapping on narrow windows, and a bottom-right pack frame for
state, carry, and gold. The ledgers use the touch dock's row grammar. Below 1180px wide the command
bar drops visible label text; names stay in the accessible name and hover title and badges stay on
the icon. It reuses destination definitions, badges, disabled states, group prompts, and callbacks;
there is no desktop Menu button. Touch uses a 52px footprint plus its safe-area inset, with three
zones on one parchment tray: HP/EXP/Hunger on the left, a slightly raised 54px circular Menu medallion in
the center, and player state, carry kg, and gold on the right. Both side zones use one ledger row
grammar: icon, 6px recessed semantic meter, then a right-aligned tabular value (12–14px); gold has
a dotted leader instead of a meter, and the state row is a text-free aggro meter (empty at rest, red while aggressive, white while protected). Large carry values compact
with exact values retained in the accessible name and title. The economy readout retains its
Inventory action. Dock gestures replace the floating Locate and quick-slot toggle: tapping the vitals recenters the map and holding them opens the World Map; tapping the bag opens Inventory and holding it shows or hides the quick slots; tapping Menu opens the Game Menu and holding it opens the player's chosen shortcut app (a picker on first hold; Settings & Support › Utility Hotbar changes it). On desktop a right-click performs the hold. Flag/buoy build and Heal are quick slots, not floating buttons: the bottom row starts with the Flag / Buoy builder on the left (tap places, hold opens planning mode) and Giving Berry on the right. Only planning mode floats its own tools, including Exit, and the quick slots hide while it is open. The builder glyph is a plain flag (or buoy) in the player's chosen flag color. Tapping an empty unlocked slot opens a two-step picker: first groups (Building, Healing, Fishing, plus Gear or Other items when carried; empty groups are greyed as None on you), then what the player carries in that group. Move and Clear appear only for a filled slot. A developer-only Gear slot preview (Settings › Utility Hotbar) shows the planned gear-set swap: touch-down opens a sideways fan of up to 3 sets in fixed order (set 1 nearest), slide and release to equip, a plain press leaves it open for tapping; nothing is equipped until gear sets exist. On phones the tray runs edge
to edge through the bottom safe area with curved upper corners and no gap beneath it; on iOS (native
app, installed web app, and Safari) it instead hugs the display with a 4px inset and lower corners
concentric with the screen curve, running under the home indicator. Wider touch screens (over
700px) show a bounded tray floating 10px above the edge. The footer has no extra navigation row or
Items button.
Desktop app shells, Messages/Atlas Chats, and ordinary compact action prompts all use the shared
`DesktopWindow` frame; touch and tablet apps remain full-screen or sheet compositions.
`desktopPresentation.css` owns these presentation differences. Desktop windows are bounded by the
viewport above the HUD (including short desktop viewports); header and footer remain visible while
the body scrolls.

On desktop the top-centre chat plaque stays visible and clickable while apps are open (phone still hides it behind full-screen apps); `DesktopWindow` clamps every window below the plaque, so windows cannot be moved or resized under it, and clicking the plaque opens Atlas Chats beside the open app without closing it. The unused title-bar area remains draggable and keeps the subtle functional `⠿` move glyph.
`DesktopWindow` exposes four invisible corner resize hit areas for every desktop menu and window;
each uses its matching diagonal resize cursor and a focus-visible outline, with no decorative rivets
or visible bottom-right resize artwork. Pointer resize and keyboard Arrow keys operate on the
selected corner; the default step is 10px and Shift uses 40px. The opposite corner stays fixed
while minimum bounds and viewport/HUD clamps constrain the result. Normal windows share a viewport
portal so dock and nested-app stacking contexts cannot bury them. Normal windows clamp to 420 × 360
minimums; compact prompts clamp to 260 × 140 and default to a 352px-wide natural-height frame.
Position and size are session-local per window key, surviving close/reopen but resetting on reload;
viewport resize reclamps them. Escape closes the focused window and restores focus when its owner
provides a close action. Touch/tablet windows are handle-free and retain their full-screen navigation
and keyboard protection. There is no new chat protocol or server preference.

## Full-screen app and readable UI

Use the app family for inventory, storage contents, build catalogs, management, Salon catalogs, complex crafting, journals, long readable information, and multi-step forms.

Touch and trackpad pinch must not scale the document UI; pinch over the game map and wheel zoom remain owned by the map, including Safari on Mac.

Canonical components live in `apps/client/src/ui/GameAppShell.tsx` and
`apps/client/src/ui/DesktopWindow.tsx`:

- `DesktopWindow`
- `GameAppShell`
- `GameAppHeader`
- `GameAppBody`
- `GameAppFooter`
- `GameAppTabs`
- `GameAppCard`
- `GameAppActionBar`
- `GameAppSectionHeader`, `GameAppText`, and `GameAppDivider`
- `GameAppButton`, `GameAppIconButton`, `GameAppCloseButton`, and `GameAppBackButton`
- `GameAppState` and `GameAppScrollRegion`
- `PhoneMenuFooter` and `PhoneMenuFooterButtons` from `apps/client/src/ui/PhoneMenuDestinationShell.tsx`

Readable chronological histories inside an app use the canonical `GameMessageBox` from
`apps/client/src/ui/GameMessageBox.tsx`. It owns the message surface, optional title and metadata,
preserved paragraph/newline content, and optional footer. Announcements, patch-note releases, and
direct-message bubbles reuse this component rather than defining separate readable-message cards.

Travel invitations that must not interrupt gameplay belong in the shared chat-adjacent HUD notice
stack beneath the chat bar. Player announcements use the global top-left HUD notice layer so they
remain visible above menus, app panels, scrims, and forced action or death presentations. Both
layers ignore pointer input outside each compact interactive notice. These notices must not add a
modal, scene blocker, outside-dismiss layer, or focus trap.

`apps/client/src/ui/DestinationShell.tsx` is the compatibility export for `GameAppShell`. On phone, the canonical shell delegates to `apps/client/src/ui/PhoneMenuDestinationShell.tsx`, preserving the existing Back, Return to Game, safe-area, scrolling, and modal-focus behavior.

An app may provide its title, eyebrow, concise subtitle, header action, tabs, cards or rows, requirement data, domain actions, and content. The shell owns the page frame, header/body/footer separation, focus containment, scroll ownership, `DesktopWindow` presentation on desktop, phone full-viewport presentation, Back behavior, and Return to Game behavior.

Section headings, body/helper copy, controls, dividers, states, and scroll regions use the shared
menu primitives listed above. `GameAppTabs` owns both the primary `housed` rail and secondary
`subtabs` rail; `GameAppButton` owns standard, primary, destructive, and quiet control treatments;
`GameAppState` owns loading, empty, disabled, and error presentation; and `GameAppScrollRegion`
marks the one intentional content scroller when a feature needs to retain its domain class. Close
and contextual Back actions use the canonical button primitives so desktop and phone targets remain
keyboard-accessible and approximately 44px on narrow layouts.

### Game Menu navigation root

The phone Game Menu is a navigation root, not an app surface. Its canonical source definitions are
`MOBILE_MENU_DESTINATIONS`, `MOBILE_MENU_ROOT_PRIMARY`, `MOBILE_MENU_ROOT_REALM`,
`MOBILE_MENU_ROOT`, `MOBILE_MENU_ROOT_UTILITIES`, and `DEFAULT_MOBILE_MENU_ORDER` in
`apps/client/src/mobileGameMenu.ts`. `MOBILE_MENU_CATEGORIES` remains only as a compatibility
type for older callers; it is not a player-facing directory. `MOBILE_MENU_ROOT_FOOTER` remains a
source-compatibility alias for the utility entries, not a rendered footer. `GameMenu` and the
`PhoneMenuDestination` state contract live in `apps/client/src/ui/PhoneHud.tsx`; `App.tsx` supplies
the destination callbacks, conditional entries, badges, accessible badge labels, and disabled
reasons. The drawer DOM contract is `.phone-menu-layer` → `.phone-menu-header` +
`.phone-menu-scroll` → the full-width `.phone-menu-profile` (when `profile` is supplied) and
`.phone-menu-root` containing `.phone-menu-primary-grid` and `.phone-menu-realm-grid`, followed by
the floating round Return to Game button in `.phone-menu-footer`. The root header places the authoritative
`.phone-menu-world-time` immediately left of compact `.phone-menu-header-action` Notice Board and
Settings & Support icon buttons. Root cells use `.phone-menu-item` with
`.phone-menu-label`, `.phone-menu-label-text`, inline `.phone-menu-unread-badge`, and
`.phone-menu-disabled-reason`. Geometry and Atlas-token materials are defined by these classes in
`apps/client/src/styles.css` and `apps/client/src/ashAtlasTheme.css`.

The root preserves the illustrated full-width Adventurer summary as its first entry. It uses the live
player model and available character summary, and opens the `character` destination with Loadout, Stats, and Kits housed tabs. Pets is a
direct root app. Inventory contains carried items; equipment actions stay in its compact item prompt. Beneath the
Adventurer card, the directory is one parchment sheet of twelve direct apps in three ruled
sections of four. Every tile opens its destination directly; there are no chooser popups:

```text
— Adventurer —  Inventory | Skills   | Pets  | Encyclopedia
— Fellowship —  Messages  | Contacts | Party | Rankings
— Realm —       Atlas     | Crafting | Construction | Land
```

Atlas opens the World Map, whose housed tabs carry City and Kingdom; Relocate is the World Map's
header action and keeps its cooldown label and disabled reason. Section names are inscribed in the
rule; columns are divided by faint ink lines; a tapped entry takes an ink wash. On phones the sheet
fills the page below the Adventurer plate and its rows grow into tall ledger cells; labels scale down
on narrow screens and never wrap. The root uses the duotone Game Menu glyphs (`ui/MenuDestinationGlyph.tsx`, Phosphor Icons duotone, MIT; the tint layer takes the theme brass) and the shared Atlas leather, bronze,
parchment, and ink materials; it must not resemble an operating-system or SaaS app grid. The directory uses a parchment atlas index with ink glyphs and fine horizontal rules. All
supplied cells remain complete touch targets with responsive three-column geometry,
visible focus, and a single `.phone-menu-scroll` owner. The root footer reserves room for one floating, safe-area-aware **Return to Game** text plaque (accessible name unchanged). Notice Board and Settings & Support remain compact,
keyboard-accessible header icon actions immediately beside the current day phase and time;
`miscellaneous` remains the compatibility route ID for Settings & Support, and Report a Bug remains
conditional on capability.

The root label-to-route contract is:

- **Inventory:** `equipment`
- **Crafting:** `crafting`
- **Progression:** `classes` (Skills, Professions, and Achievements are housed tabs)
- **Encyclopedia:** `creature-book`
- **Messages:** `messages`
- **Party:** `party`
- **Pets:** `pet-chamber`
- **World Map:** `world-map`
- **Construction:** `build`
- **Rankings:** `leaderboards`
- **City:** `city`
- **Kingdom:** `kingdom`
- **Land Management:** `flags` (the housed Access & Travel and Harvest Tolls app)
- **Notice Board:** `announcements` (the unified Announcements/Patch Notes shell)
- **Settings & Support:** `miscellaneous`

`GameMenu` filters the fixed root lists to destinations actually supplied to `PhoneHud`; it never
creates a second entry. Disabled destinations remain visible and inspectable in the direct root,
with their native disabled state, explicit accessible reason, and preserved capability gating.
Numeric destination `badgeCount` values retain their exact accessible labels and visual caps on the
direct tile. Notice Board combines numeric status from Announcements and Patch Notes into its header
badge without changing either read-receipt contract.

History preserves the shallow hierarchy: gameplay → root → app → an existing child detail. Direct
gameplay shortcuts preserve gameplay → root → app and return to the root. App tabs change the current
view without creating a category or extra history level; Realm and Notice Board tab switches use
replacement navigation. Legacy category markers are ignored when parsing history. Messages show the
Game Menu root underlay when opened through a direct shortcut. The header and footer remain fixed,
opaque, safe-area aware, and outside the single `.phone-menu-scroll` owner. The root footer is the
single Return to Game action; app shells retain their native **Back to Game Menu** and **Return to Game**
behavior.

Skills and professions share the single `classes` destination. Its canonical app surface is titled
**Skills & Professions** and keeps Skills, Professions, and Achievements as housed top-level tabs.
The Skills tab is one skill ledger: tier rows with a class-rank row between them; Profession XP and ranks remain independent from the character-level
Skill Point budget. The shared destination is navigation and presentation, not a merged progression
economy.

Inventory uses the direct `equipment` destination for items. Selecting equipment opens
`GameActionPrompt` with Equip/Unequip, Upgrade, and Drop. Upgrades use a compact gold confirmation
and work anywhere, independent of character level. Equip atomically replaces the same-slot item.
The Adventurer summary opens Loadout, Stats, and Kits in `CharacterPanel`; the live appearance is
centered with equipment flanking it. Kits save the currently equipped pieces, including partial sets.
Favorites use explicit star controls, sort first, and persist per player on this device; resource
favorites address item type/variant and unique favorites address their instance. Item Protection
uses housed Keep quantities and Equipment locks tabs with canonical controls. Items uses a vertical balance list with icon, name, quantity, and total
weight in kg. Server-provided current/maximum weight and its capacity bar remain outside the list
scroller together with the canonical compact category subtabs: All, Equipment, Resources,
Consumables, and owned Backpacks. The top summary card stacks the Carry weight row directly over
its capacity bar as one unit, then one row of three equal currency chips (gold coin Gold, spark
Glimmer, gem Lumen); a long value wraps to two lines inside its chip and never clips, truncates,
or scrolls. Protect (shield glyph plus label, accessible name Item Protection) and the
Storage/Manor action are compact, 44px-tall secondary buttons in the header's top-right action
slot; the Inventory header has no carried-kg status chip. Glimmer and Lumen stay off the dock and
HUD. On phone, this subtab rail is horizontally scrollable with
approximately 44px touch-safe cells; labels must remain readable and must never clip. Loadout, Stats, and Kits belong to the Adventurer destination, not an Inventory rail. Player inventories
have no numbered cells, move mode, split/restack controls, or empty-slot presentation. Equipment
instances remain separate, and quantity actions address the original balance identity. Backpacks
show their explicit +0 through +10 enhancement level and +5 kg-per-level capacity bonus; every
non-destroyed owned backpack adds capacity cumulatively, whether it is carried, a formerly equipped
legacy row, or in manor storage. There is no backpack equip limit or equip/unequip action. A fresh
Backpack +0 is crafted from 80 Leather and 2,000 Gold and has zero own weight. Physical manor/warehouse
storage uses the same kg list and capacity summary as carried inventory. Retained storage positions
are ordering metadata only; no storage grid, empty cell, or numbered slot may gate a transfer.

The gameplay utility hotbar is one responsive model shared by phone, tablet, and desktop. It has
five possible paired rows (ten player cells) and defaults to four visible rows, with the first row
beginning just below the Party surface and equal vertical spacing. Settings & Support persists a
row count of Off or 1–5 plus one independent vertical anchor for each possible row. When rows are
enabled, its **Adjust Slots** action closes the menu and opens a safe-area-aware editor over the
actual gameplay track; paired rows are highlighted in place and can be dragged or focused and moved
with keyboard controls. Accept commits the complete draft once and Cancel rolls it back. The editor
blocks map and slot actions. Every viewport measures the live usable gameplay track, including the
full safe vertical space down to just above the dock. Visible rows are normalized to
avoid overlap and retain their intentional gap while remaining movable throughout that measured
domain. Holding the dock's bag retracts and restores the configured rows. Only
Giving Berry, Fishing Rod, and the Flag / Buoy builder are actionable; assigned cells use opaque artwork,
while empty or locked cells are more transparent. By default the bottom two visible rows are unlocked on both sides (four cells); every other
cell stays locked.

Social Contacts owns Friends, Requests, Recent, Enemies, and Blocked
management; Messages remains the authoritative inbox for travel, party, Kingdom, and direct-message
requests. Party keeps roster, recruitment, and settings while linking incoming party requests to
Messages instead of duplicating the queue.

Inventory and Party use the canonical theme-aware folio material (`--aa-ui-material-folio`), muted
brass rules, and the active theme's text from the Game Menu/Loadout family. Inventory favorites remain
separate right-edge controls. Party renders only actual members, a single remaining-capacity
summary, and compact invitation/settings panels; never fill the viewport with vacant roster cards.

Notice Board is one shell with Announcements and Patch Notes tabs. Opening Patch Notes still marks
the current release read through the existing inbox receipt contract. Land Management is one direct
app with housed **Access & Travel** and **Harvest Tolls** tabs. Access & Travel uses
canonical subtabs for **Visit Tolls**, **Atlas Shrines**, and **Normal Passage**; visit defaults,
passage requests, and shrine travel remain their existing authoritative operations. Harvest Tolls
houses Mines and Oil Wells beneath its own canonical tabs. Construction placement remains in Build,
with no intermediate Holdings directory. Realm keeps Map, City, and Kingdom on a shared app-level
rail; Map may expand into its full-screen map presentation while City governance/status and Kingdom
governance/status remain separate surfaces.

Settings & Support (`miscellaneous`) is a canonical `GameAppShell` on phone. Its housed primary
rail groups **Gameplay**, **Support**, **Account**, and **About**; each active primary section uses
the canonical compact subtabs rail for Utility Hotbar / Map, Help / Diagnostics, Account / Delete
Account, or Credits / Legal. The shell owns the single body scroll region and its fixed footer keeps
the standard Back and Return to Game actions. Opening the app focuses the shell container rather
than a native form control, so Visible rows and other selects open only after an explicit player
tap. Utility Hotbar contains only the Off / 1–5 selector and the live **Adjust Slots** entry point;
per-row position sliders and synthetic previews are not part of Settings.

Unlike ordinary `GameAppShell`/Build destinations, this drawer has no player-facing category tabs,
large Build-sized cards, card descriptions, persistent selected state, destination reordering, or
OS/SaaS app-grid styling.

### Mandatory production JSX contract

Build-style ledger catalogs and management/settings screens must use the following production
primitive tree. The feature may replace the domain copy and data (`title`, `eyebrow`, `subtitle`,
tab data, card data, content, and action callbacks), but it must keep the `GameAppShell` →
`GameAppTabs` → card grid → `GameAppCard` → `GameAppActionBar` structure. Specialized app bodies
such as Market trading may replace the card grid with their canonical domain view, but they must
keep `GameAppShell` and the same `GameAppTabs` call shown below. The `housed` tab variant is
required for this menu family; do not substitute a private tab rail or feature-specific
card/action primitives.

```tsx
import {
  GameAppActionBar,
  GameAppCard,
  GameAppShell,
  GameAppTabs
} from "./GameAppShell.js";

return (
  <GameAppShell
    open={props.open}
    title="Feature"
    eyebrow="DOMAIN SCOPE"
    subtitle="Concise context."
    closeLabel="Close Feature"
    layout={props.layout}
    onClose={props.onClose}
  >
    <GameAppTabs
      tabs={tabs}
      activeTab={activeTab}
      ariaLabel="Feature sections"
      variant="housed"
      onChange={(id) => setActiveTab(id as FeatureTab)}
    />
    <section className="game-app-card-grid" aria-label="Feature records">
      <GameAppCard
        title={card.title}
        badge={card.badge}
        status={card.status}
        description={card.description}
        action={(
          <GameAppActionBar>
            <button type="button" onClick={card.onSave}>Save</button>
          </GameAppActionBar>
        )}
      >
        {card.content}
      </GameAppCard>
    </section>
  </GameAppShell>
);
```

The housed button surface is solid `var(--aa-ui-leather-800)` when unselected: it must not use a
grid, wood material, or `background-image`. Production styling remains centrally owned by the
canonical selectors in `apps/client/src/ashAtlasTheme.css`; feature code supplies domain copy,
data, and callbacks only and must not restyle those primitives.

When a destination needs fixed Back and Return to Game actions, use the canonical phone footer
button primitive in both presentations: `PhoneMenuFooter` owns the phone footer element, while
desktop `GameAppFooter` receives `PhoneMenuFooterButtons` directly. Do not wrap those buttons in a
feature `GameAppActionBar` or nest one footer inside another. Top-level housed app roots use
**Back to Main Menu** and invoke the shell's close/back-to-menu callback; child views use one
contextual Back action for their immediate parent.

### Visual reference and hierarchy

The Construction catalog is the visual reference for app surfaces: layered parchment fields in
the active light or dark palette, thin brass borders, a short upper-edge accent on major cards, serif
titles, bold sans-serif controls and data, muted supporting copy, and brass reserved for selected
or important information. Reuse the canonical shell, tokens, and components that produce this
family; do not copy feature-private Build markup or hardcoded colors.

The reference does not make every piece of its current copy or scrolling behavior canonical:

- State the destination once. Menu headers carry no eyebrow unless it names real scope or identity; subtitles add useful context,
  timing, or state. Do not stack a decorative ledger label, a second verb title, and generic
  instructions that merely restate the visible controls.
- The Construction destination uses the single page title **Construction**. It has no
  **Construction Ledger** eyebrow, separate **Build** title, or "choose a structure" subtitle.
- Use serif for page and card titles, bold sans-serif for controls and values, muted tan for
  supporting information, and bronze or gold sparingly for selection and priority.
- Quiet theme-matched parchment space may provide breathing room, but major controls and related status must
  not float as unrelated elements on it. House controls in the header, tab rail, action bar, or a
  warm ledger panel with a clear shared hierarchy.

Related selectors form one intentional control surface. If a destination has both a broad category
and a specific view, show a compact category selector first and update the specific selector from
that choice. Do not display several category headings and every subordinate choice as separate
groups scattered down the page. Put contextual status such as a reset countdown inside that same
selector panel instead of leaving it detached.

Dense records such as rankings belong to one app card with a title and concise context line. Use
subtle internal dividers between rows; do not render every record as a large bordered button. A
small first-, second-, and third-place treatment is acceptable when it does not compete with the
values or turn the table into ornament.

For a leaderboard, this means:

- current and previous periods use the canonical housed tab treatment, including Construction-style
  inset spacing below the header and an unmistakable selected surface;
- category choices such as Overall and Hunting occupy the first selector level;
- the second level contains only the metrics for the selected category;
- the remaining-time or reset status lives within the selector card; and
- the selected leaderboard is one card containing its title, period and player-count context, and
  lightly divided ranking rows.

### Scrolling and pinned controls

Every destination has one intentional content scroll owner. Header, persistent navigation, and
footer remain visually separate from scrolling content.

- Tabs that must remain available while content scrolls belong outside the scrolling region when
  the shell supports it. Otherwise make the complete tab rail sticky, including its padding and
  opaque material underlay.
- Give a primary tab rail a deliberate inset gutter between the header, tabs, and following
  content. Do not attach its button borders directly to the header divider or screen edges.
- A selected tab or selector cell must be obvious before interaction: use the raised-wood selected
  fill, active-bronze border, and canonical inset gold edge together. A border-color change alone,
  or two states with effectively the same fill, is not an acceptable selected treatment.
- `GameAppTabs` with the `housed` variant is the canonical equal-width raised-wood tab rail for
  short tab sets. Use its shared `scrollable` option for long sets that cannot preserve readable,
  touch-safe cells of about 44px. Feature code supplies tabs and state; it must not duplicate the
  housed button or selected-state styling.
- `GameAppTabs` with the `subtabs` variant is the canonical compact second-level selector beneath
  a housed primary rail. It preserves the same tab semantics, keyboard behavior, visible focus,
  approximately 44px touch targets, and unmistakable selected state. Use `scrollable` when a long
  subtab set cannot fit readable labels; keep `housed` as the destination's only primary rail. Every
  secondary choice below that rail uses this pattern, including Market category/order views and
  any future Encyclopedia appearance choices; do not create a private selector
  primitive or reuse `housed` for those secondary choices.
- When a selector can inspect one item while another remains applied, show both states without
  conflating them. The inspected item receives the full selected-cell treatment; the applied item
  receives a compact explicit badge such as **Equipped** or **Active**. Applied slot actions such as
  **Equipped 1** and **Equipped 2** retain the selected treatment even when disabled to prevent a
  redundant repeat action.
- A sticky rail must cover the full width and height through which content could pass, use the
  correct stacking order, and meet the surrounding surface without a transparent gap. Scrolling
  text, cards, icons, borders, and accents must never remain visible behind or between its buttons.
- Clip or scroll the content at the navigation boundary. Do not solve overlap by adding arbitrary
  page spacing or by making the controls translucent.
- Keep the canonical fixed footer outside the content scroller so Back and Return to Game remain
  stable and safe-area aware.

### Kitchen recipe browser

Kitchen uses Recipes and Queue as its housed primary tabs. Recipes uses the
canonical scrollable subtabs for Raw Ingredients (animal cuts and fish), Simple
(small catch and field provisions), Intermediate (hearty provisions), and Advanced
(elemental ingredients and essence). Categories organize existing inputs; recipe
yields and all output remain authoritative Simple Food. Retired species meat is
not a selectable recipe. Already queued historical work preserves its output.

### Progression browsers

Skill, class, profession, and similar progression catalogs use the canonical app shell. Combat
progression is one **skill ledger** on a single vertical scroll (no discipline grid or discipline
pages). The SP/active-class summary card stays pinned above the scroll. Skills are grouped in tier
rows, where a skill's tier is its prerequisite depth: tier 0 is the discipline gateways (every shared
general skill in the `gateway` category, so new disciplines need no new UI code), then tiers 1-4.
A row holds at most four skills on desktop and three on phone (the gateway row stays at four), ordered
by discipline and then by the presentation catalog in the panel. After tier N sits a **class-rank row**
for Rank N+1 of the active class, so the ladder reads T0, R1, T1, R2, T2, R3, T3, R4, T4, R5.
A class-rank row shows the class icon and name, **Rank k**, and a state (earned, next with
**x/y SP spent** against the 3/7/11/16/20 gates, or locked). It is display
only and never gates the skills around it. Tapping it opens the active class's detail sheet; with no
active class it reads **Choose a class to rank up** and opens the all-classes overview, and a retired
class keeps its retirement messaging in that overview. Combat menus never require pan, zoom, a
minimap, dragging, or a giant canvas.

A skill cell shows only the icon, the name, and a rank badge on the icon corner once learned, plus
an **Equipped N** badge for equipped actives. Three states come from the existing rules: learned
(bronze frame and badge), purchasable now (dashed bronze frame), and locked by an unmet prerequisite
(dimmed with a lock). Exact requirements, SP cost, and prerequisite progress (**Requires Archery
0/1**) live in the cell's accessible name and the detail sheet. Selecting a cell opens the detail
sheet; in skill and discipline details the ranks lay out side by side as **Level 1 / 2 / 3** columns
with earned levels lit and future levels muted, stacking when the sheet is too narrow.

The one-active-class rule copy must match server authority: buying Rank 1 of any class makes it the
active class and locks every other class; general skills stay open. Where full-build respec is
available the copy says Respec build resets all skills and classes; elsewhere it says the choice is
permanent. The summary card carries an **Active class** chip beside the SP counters; it opens an
overview of every class grouped by discipline, which is how every class stays reachable. Launch
classes use the shared gateway, total-spent 3/7/11/16/20 Character SP gates, one-SP rank costs, and
a Rank-1 confirmation. The level-10 launch exemption remains
server/shared authority. The Developer App's **Reveal all classes** view toggle lists the full class
roster for inspection only; purchases stay server-authoritative.

Gateway, skill, and class details open in a detail sheet without leaving the ledger: a bottom sheet
with a scrim on phone and a docked side panel on desktop. The sheet reuses the existing detailed
description, effects, requirements, equipment restrictions, and action surface without changing the
authoritative purchase or loadout operations, and has no close (x) control: it closes from the
footer Back, the scrim, and Escape on phone. The ledger underneath stays mounted and keeps its scroll
position. The shell footer Back reads **Back to Skills** while a detail is open and **Back to Game
Menu** otherwise.
Sheet motion is one fade plus a 12px rise over 160ms, with the scrim (a light warm ink at 26%, never
black) fading in step. Closing runs the same motion in reverse: `useRetainedSheet` keeps the sheet
mounted, inert, until it ends, and the docked desktop column stays until then. `prefers-reduced-motion`
removes the animation and unmounts immediately. Every `ProgressionDetailSheet` host uses the hook.

Rank lists use the shared `RankLadder` (`RankLadder.tsx`): the Class tab's Rank effects and every
profession detail show Earned, Current, Next, and Upcoming rows from one component (shown in
Developer App -> UI Standards).

Menu page and footer: the page colour is painted flat and the single grain texture is the screen-wide
overlay, so header, body, and footer share one texture. Scrolling content dissolves into the footer
through a short paper-coloured fade on the footer's top edge (phone screens and desktop windows).

Professions remain an independent housed tab and XP system laid out like Skills: every profession
sits on one page under Gathering, Crafting, and Trade & World headings, as cards with rank, an XP
meter, XP to the next rank, and the mastery title once mastered; Future Content professions follow
under **Coming soon**. There are no category subtabs, floating map nodes, or combat prerequisite
edges. Selecting a card opens its detail in the shared detail sheet (`ProgressionDetailSheet`), and
the footer reads **Back to Professions** while it is open. They are never inserted into a combat
gateway family.

Achievements use the same pattern: a prestige summary with honor chips, one compact search row
(search, difficulty, status), pinned goals, goals within reach, and a card grid of categories plus
quest journeys. A category page lists its goals as compact rows with a thin progress bar; a goal's
objectives, reward, and Pin action open in the detail sheet. The footer reads **Back to
Achievements** on a category page and **Back to <category>** while a goal is open. Each top-level Skills, Professions, and Achievements tab remains rooted at the
shared destination and uses **Back to Main Menu**; switching tabs is replacement navigation, not
a child-history step.

`apps/client/src/ui/ProgressionIcon.tsx` is the canonical progression icon frame. It accepts a normal
image source or cropped sprite source and coordinates, always receives alternative text and a size,
and may carry a stable icon key before art is assigned. Its neutral fallback derives deterministic
initials from that key or alternative text. Placeholder art must not imply availability or use an
unrelated success color. Progression controls retain approximately 44px targets, Ash materials,
readable rank dots and text state, an obvious selected focus ring, explicit applied badges, one
scroll owner per overview or detail, and no page-level horizontal overflow. Future sibling rows may
use a contained horizontal scroll owner when their content exceeds the available width. Progress, eligibility, application,
and inspection are independent presentation axes. Partially learned and maxed nodes use the existing
gold learned treatment, while important state is never color-only. Do not use a combat pan surface,
document zoom, freeform drag surface, geometry board, external icon framework, or separate phone
progression model. Keyboard focus follows normal DOM order. Server-authoritative points,
prerequisites, commitment, loadouts, cooldowns, XP, and disabled reasons remain domain data rather
than presentation state.

The Developer App → UI Standards gallery renders the real `GatewaySkillMenu` component and
`ProgressionIcon` contract.

## Back gestures (phone)

Menu depth lives in browser history (`useMobileGameMenuNavigation`). Android's system back reaches it through Capacitor `backButton`; mobile browsers use their own edge swipe. The iOS WKWebView shell has no history gesture, so `native/nativeEdgeSwipeBack.ts` steps back from a left-edge swipe (sub-app, Game Menu root, then game) using the same resolution as Android back.
