# Responsive and accessibility

Use this standard across every player-facing surface. Responsive presentation may change layout,
but desktop and phone must consume the same action model and authoritative state.

## Responsive and accessibility rules

- Use one action model for desktop and phone.
- Keep compact prompts nonmodal and no larger than their content requires.
- Keep app surfaces modal where the underlying screen must not receive input.
- Preserve approximately 44 CSS-pixel touch targets.
- Provide accessible names for prompts and dialogs.
- Keep visible focus, Escape behavior, and disabled semantics.
- Stop pointer and click events at the interface boundary.
- Preserve safe areas, scroll containment, and fixed navigation.
- Respect reduced-motion preferences.
- Place transient feedback in a HUD lane; never overlap the chat bar, party widget, unit frame, hotbars, or bottom bar ([HUD lanes](HUD_LANES.md)).

## Forbidden patterns

- Feature-private prompt markup or CSS duplicating canonical behavior
- Stock browser/system-looking dialogs
- Giant white, gray, or beige action buttons
- Oversized side-by-side buttons in a simple compact prompt
- Redundant instructional paragraphs
- Arbitrary feature class names used to create another theme
- Inconsistent Cancel/Close semantics
- Separate phone and desktop interaction logic when responsive presentation suffices
- Hardcoded feature colors where tokens exist
- Management interfaces outside the canonical app shell
- Pointer events leaking into the map or scene
- Direct action on selection when the feature requires an action prompt
- One-touch building or station selection that starts movement or an operation
- Direct portal transition from an object click

## Gameplay utility hotbar

The utility hotbar uses one responsive DOM/action model across phone, tablet, and desktop. It
contains five possible paired rows (ten player slots) and defaults to four visible rows. The first
row begins just below the Party surface, while each row keeps an independent persisted vertical
anchor; visible anchors are normalized to maintain a readable gap and may sit as low as just above
the dock. Settings & Support exposes Off and 1–5 visible rows plus an **Adjust
Slots** action whenever rows are enabled. Adjust Slots closes the menu and opens a safe-area-aware
editor over the real gameplay track: paired rows are highlighted in place and can be dragged or
focused and moved with arrow/Page/Home/End keys. Accept commits the complete draft once; Cancel
discards it. The editor blocks map and slot actions until it closes. Every viewport measures the
live usable track, down to just above the dock, while keeping
the handles across the track's usable width and normalizing visible rows to preserve their gap and
prevent overlap. Holding the dock's bag retracts or restores the configured rows.

Settings & Support uses the same `GameAppShell` and `GameAppTabs` primitives as other readable
phone apps: Gameplay, Support, Account, and About are housed primary sections with contextual
compact subtabs. The shell header and safe-area-aware Back / Return footer stay fixed while the
destination body owns the only scroll region. Shell entry focuses the dialog container, never a
native select; Visible rows and Tap assistance therefore open only on an explicit tap. On phone,
the live editor keeps its measured paired-row handles over the gameplay track and moves Accept / Cancel
into the compact safe-area-aware lower HUD space that is hidden for the duration of editing. Desktop
retains the full editor panel and the same keyboard controls.

Only Giving Berry, Fishing Rod, and the Flag / Buoy builder have a context-free quick action. Empty and locked cells are
visually more transparent than assigned cells; assigned item artwork uses the existing PNG artwork
and the Fishing Rod label must never expose a raw numeric or instance identifier. By default the
bottom two visible rows are unlocked on both sides (four cells); every other cell is
disabled with an accessible locked state. Keyboard, pointer, and touch activation must use the same
guarded callbacks at every breakpoint.

## Inventory and backpacks on narrow layouts

Inventory's secondary categories use the canonical `GameAppTabs` subtabs rail with horizontal
scrolling on phone when the labels cannot fit. Keep each tab cell approximately 44px touch-safe,
preserve visible focus, and prevent label clipping or document-level horizontal overflow. Do not
show a Backpack count badge. Every non-destroyed owned backpack contributes its capacity
cumulatively, including instances in manor storage and rows left in the legacy equipped location;
there is no backpack equip/unequip control or capacity gate.

Favorite stars occupy a dedicated rightmost 44px column after the item action. Narrow rows reflow
quantity and weight below the item name; long names and details wrap inside their remaining space.
The padded capacity summary grows with its values and may wrap the current/maximum weight.

Kitchen ingredient rows reserve separate artwork, flexible copy, and selection columns. Compact
Kitchen uses the shell body as its single vertical scroller, including ingredients and the selected
recipe; neither the ingredient list nor the recipe creates a nested scroll trap.

Party shows only actual members as compact rows and summarizes empty capacity once. Roster and
invitation/settings panels sit side by side when space allows and stack on phone, with the shell
body owning vertical scrolling and its navigation remaining fixed.

The bottom HUD uses the active menu parchment. Touch uses a
52px footprint plus the safe-area inset. HP/EXP/Hunger sit on the left; a slightly raised 54px circular Menu
medallion sits in the center; player state, carry kg, and gold sit on the right. Each side is a
ledger of three rows: icon, 6px recessed semantic meter, right-aligned tabular value at 12–14px.
Large carry values use compact notation while accessible names and titles retain exact values. The
economy panel retains its Inventory action. Dock gestures replace the floating Locate and quick-slot toggle: tapping the vitals recenters the map and holding them opens the World Map; tapping the bag opens Inventory and holding it shows or hides the quick slots; tapping Menu opens the Game Menu and holding it opens the player's chosen shortcut app (a picker on first hold; Settings & Support › Utility Hotbar changes it). On desktop a right-click performs the hold. Flag/buoy build and Heal are quick slots, not floating buttons: the bottom row starts with the Flag / Buoy builder on the left (tap places, hold opens planning mode) and Giving Berry on the right. Only planning mode floats its own tools, including Exit, and the quick slots hide while it is open. The builder glyph is a plain flag (or buoy) in the player's chosen flag color. Tapping an empty unlocked slot opens a two-step picker: first groups (Building, Healing, Fishing, plus Gear or Other items when carried; empty groups are greyed as None on you), then what the player carries in that group. Move and Clear appear only for a filled slot. There is no extra navigation row or
Items button inside the dock. On phones the tray reaches the physical bottom
edge through the safe area and never leaves a gap beneath itself; on iOS (native app, installed web
app, and Safari) it hugs the display with lower corners that follow the screen curve. Only content
reserves the bottom inset. Wider touch screens (over 700px) use a bounded floating tray.
The same three-zone composition fits 320px phones, landscape safe areas, and tablets, with bounded
centered content on larger touch screens. Passive areas remain pointer-transparent. Safe-area ownership,
callbacks, status authority, and touch/full-screen behavior remain unchanged.
Desktop has no full-width bar or Menu button: a top-left unit frame (portrait medallion and level
badge over the HP/EXP/Hunger ledger) with the party roster and quick slots below it, a top-centre
chat plaque, a centered one-row command bar of icon-over-label buttons, and a bottom-right pack
frame. Desktop quick slots are compact 52px square action buttons inset from the window edge and
show their keyboard key. Desktop keeps browser page zoom (Ctrl+wheel and Ctrl +/−) so players can
enlarge the interface; Ctrl+wheel over the active map zooms the map instead, and touch keeps its
page-zoom guard.
Settings & Support › Gameplay › Appearance offers a desktop-only **Interface size** slider
(50–150% in 5% steps, applied on release so the window does not rescale mid-drag), stored per device. One CSS `zoom` scales the HUD, chat, quick slots, party, and every
`DesktopWindow` together and never the map. The effective size shrinks only as far as needed to keep
a 1100 × 600 scaled layout (never below 100% unless chosen), and the command bar's label tiers
follow the scaled width. Desktop geometry that reads screen pixels and writes CSS pixels (window
bounds and pointer deltas, quick-slot row measurement) divides by the active scale. Below 1180px the command bar shows icons only, keeping names in accessible names and
hover titles. Touch
screens retain the same action data and status semantics.

Desktop presentation is resolved once by `uiEnvironment`: at least 1100 × 600 CSS pixels, fine
pointer, and no touch/coarse capability. Tablets and hybrid touch devices retain touch behavior.
Desktop fills the browser viewport; compact/wide playable-stage framing is touch-only. Desktop
apps, chat, and ordinary compact prompts use bounded `DesktopWindow` frames. The unused title-bar
area moves the window and retains the subtle functional `⠿` glyph. All desktop menus and windows
use four invisible corner resize hit areas with matching diagonal cursors and focus-visible outlines;
decorative rivets and visible bottom-right resize artwork are not part of the contract. Arrow keys
operate on the selected title-bar or corner control in 10px steps, or 40px with Shift. Resizing
keeps the opposite corner fixed while minimum, viewport, and HUD clamps constrain the result.
Normal windows clamp to 420 × 360; compact prompts clamp to 260 × 140 and use a 352px
natural-height default. Bounds are clamped above the HUD, persist across close/reopen for the
session, and reset on reload. Messages and Atlas Chats retain their existing dismiss/minimize
controls. Touch apps/chat retain full-screen navigation, keyboard protection, and remain handle-free
with safe-area behavior unchanged.

Item Protection is a bounded shell with visible, focusable tabs outside one contained item scroller;
the header, tab rail, and footer remain fixed while the active tab's rows scroll. The equivalent
Backpacks group is uncapped: identical entries may display as ×N while every instance identity and
its existing actions remain available.

Item pictures shown without a visible name (material chips, item icons in recipes, costs, rewards) get
their display name from the shared `ItemArtwork` / `MaterialChip` components via `ItemNameTooltip.tsx`: a
small tooltip on hover or focus, and on touch after a ~450ms long press (no context menu or text selection,
the following click is swallowed, release or a tap elsewhere dismisses it). It is portaled to the body, so
scroll containers never clip it. Card status marks (`CraftStatusMark`) sit unboxed at the end of the
`GameAppCard` title row; do not place them on their own row.
