# Ash Atlas Interface Design

Ash Atlas uses a medieval field-kit visual system: an old kingdom ledger, worn travel case, and practical equipment tray. Medieval materials are dominant. Ordinary interface chrome avoids green. Literal world content such as map terrain, vegetation, poison, radiation, and dungeon creatures may use green; the existing health and status indicators below are explicit UI exceptions.

The implementation lives primarily in `apps/client/src/ashAtlasTheme.css`. Existing game authority, safe-area handling, mobile keyboard behavior, chat anchoring, and navigation history remain owned by their established systems.

## Palette and materials

| Role | Token | Value |
| --- | --- | --- |
| Deep ink | `--aa-ui-ink-950` | `#0d0b08` |
| Raised ink | `--aa-ui-ink-900` | `#12100c` |
| Deep leather | `--aa-ui-leather-900` | `#18110d` |
| Worn leather | `--aa-ui-leather-800` | `#271b14` |
| Raised leather | `--aa-ui-leather-700` | `#35251b` |
| Dark wood | `--aa-ui-wood-800` | `#342319` |
| Raised wood | `--aa-ui-wood-700` | `#493121` |
| Light parchment | `--aa-ui-parchment-100` | `#e7dcc2` |
| Medium parchment | `--aa-ui-parchment-200` | `#d2bf98` |
| Muted parchment | `--aa-ui-parchment-300` | `#b49d75` |
| Active bronze | `--aa-ui-active-bronze` | `#c49a59` |
| Bronze | `--aa-ui-bronze-500` | `#97703d` |
| Dark bronze | `--aa-ui-bronze-700` | `#624728` |
| Iron | `--aa-ui-iron-500` | `#5d5b52` |
| Primary text | `--aa-ui-text` | `#eee5d3` |
| Bright value text | `--aa-ui-text-bright` | `#ffffff` |
| Muted text | `--aa-ui-text-muted` | `#aa9e87` |
| Danger | `--aa-ui-danger` | `#a65347` |

Material backgrounds use `--aa-ui-material-ink`, `--aa-ui-material-leather`, and `--aa-ui-material-wood`. Bronze communicates selection and action, parchment communicates focus and hierarchy, iron communicates inactive structure, and muted red-brown communicates danger. The automated `noGreenUi.test.ts` guard scans ordinary component and stylesheet sources for legacy green semantics and green-hued color literals. It retains explicit exceptions for world artwork and the existing approved health/status declarations; whole UI stylesheets are not exempt.

### Existing health and status exceptions

Keep the established green player, party, and pet health fills; online presence; successful action and readiness feedback; positive stat changes; protection and beneficial effects; travel/construction progress; test-access status; kingdom deposits; and class/item-rarity indicators. These communicate a specific health, identity, or status value. Reuse their current tokens and canonical styles. This approval preserves existing indicators; it does not make green a general panel, action, focus, selected, unread, or navigation color. New green treatments require an explicit design update.

## Typography, spacing, and controls

- The system sans-serif stack remains the body, message, value, and control face.
- Georgia or the established serif stack is used for screen and section titles.
- Section labels use restrained uppercase tracking; body copy stays compact and readable.
- Mobile text-entry controls remain at least `16px`.
- Shared spacing steps are 4, 6, 8, 12, 16, 20, and 24 pixels.
- Controls use 4px radii and major panels use 6px; large rounded cards and pills are avoided. Framed surfaces
  (popups, dialogs, auth, desktop windows) carry a restrained brass double rule with corner brackets, buttons are
  carved plaques, and paper carries a light parchment grain (`--aa-brass`, `--aa-plaque-*`, `--aa-grain`,
  `--aa-vignette` in `menuAppearance.css`; shared rules in `medievalFinish.css`). Both Light parchment and Dark
  walnut use the same recipe.
- Touch targets remain approximately 44 CSS pixels where practical.
- Focus uses a light parchment outline. Active state uses a narrow bronze edge, never a glow.

## Destination information architecture

Profile, Character, and Inventory are separate destinations on phone and desktop.

- **Profile** owns identity and social information only: name, portrait, biography, kingdom, settlement, relationships, recent players, messaging, and moderation actions.
- **Character** owns the authoritative seven-slot equipment loadout, occupied and empty states, compatible-item selection, derived combat stats, readied-weapon controls, and collapsed combat kits. Slot selection shows only owned equipment compatible with that slot.
- **Inventory** owns the complete authoritative item collection. Its default All filter displays each resource stack once and each non-destroyed equipment instance once. Equipment and Resources filters narrow the same collection; a stable detail pane exposes only actions valid for the selected item.

Every major destination uses the same shell contract: active-theme paper body, shared header, serif title, brass divider, close or Back control, separately scrolling content, keyboard focus containment, and safe-area padding. On phones and tablets it retains the existing full-screen, safe-area-aware presentation; on desktop it becomes a bounded `DesktopWindow` using the same component and information architecture rather than a separate product.

## Parchment field-command touch controls

The touch HUD is a set of floating parchment-and-brass control islands, not a continuous enclosing
rail. It uses a roughly 108px bottom footprint plus the physical phone/tablet safe-area inset and
keeps the original glyphs, actions, callbacks, status authority, and touch targets. Actual map remains
visible around and between the islands; those gaps are pointer-transparent. Do not add a decorative
Ash Atlas label.

- Top bar (not the screen-top chat bar): HP, EXP, and Hunger stay in one horizontal three-vital
  strip. Heart, experience, and food glyphs identify the values without relying on visible labels.
  Semantic numerals sit above thin bars; HP uses the stronger 14px value treatment while EXP and
  Hunger use quieter 12px values in the same system-sans family. Semantic bars use softened
  active-theme ink and existing health, experience, and hunger semantics. Values never sit inside
  separate brown or black boxes; full authoritative values and labels remain accessible.
- Upper readout: state, carry, and Gold share one quieter compact row with their authoritative glyphs,
  timer/progress semantics, and readable hierarchy. Active Light parchment and Dark walnut tokens own
  the paper, text, rules, and timer surfaces; semantic status colors remain the documented exceptions.
- Dock controls: the vitals (tap recenter, hold World Map), the Menu medallion (tap menu, hold the
  player's shortcut app), and the bag (tap Inventory, hold show/hide quick slots). Flag/buoy build and
  Heal are quick slots (bottom row by default), never floating buttons; rows can sit just above the dock.
- Desktop: use an approximately 88px footprint with compact parchment readout islands for Adventurer,
  vitals, and economy above complete individual command buttons, without a desktop Menu button. HP,
  EXP, and Hunger numerals sit above thin semantic bars rather than inside boxed fills. World artwork
  and compact object prompts keep their canonical presentation.

World overhead health bars follow the shared zoom/fade curve but are state-driven: the local player never receives a world-space bar, and full-health passive mobs plus context-free remote players and military groups remain hidden. Remote non-player bars appear only while damaged or when the authoritative combat/selection state exposes a target or active engagement; structure bars retain their existing damaged/active rules.

## Inventory artwork

Resources and starter equipment use a cohesive set of generated 256×256 transparent PNG icons: wood, stone, food, leather, ore, water, sword, bow, staff, tunic, coin, satchel, and a generic iron shield fallback. The images are grounded medieval objects, contain no text or green UI coloration, preserve transparent outer borders, and remain readable at compact HUD or inventory sizes.

## Chat and messaging

Public chat remains a full-screen opaque ledger on phones. Direct Messages remains a distinct opaque conversation ledger. Existing channel selection, follow-live behavior, unseen-message identity, history anchors, keyboard behavior, focus retention, and composer geometry are locked. Interface chrome uses bronze, parchment, iron, and muted red-brown; established online-presence indicators retain green.

On phone, confirmed keyboard dismissal presents the final full-height chat frame and bottom safe-area composer position in the first post-blur frame. Viewport telemetry and timeout fallback may settle afterward, but must not create an intermediate bottom gap, a later composer movement, or document-level scrolling; only the message region owns chat scrolling.

## Prohibited patterns

- No green ordinary interface chrome, including action, focus, selected, unread, or navigation states. Only the documented existing health/status indicators and literal world artwork are exceptions.
- No overt lore-revealing symbols, futuristic iconography, neon panels, terminal grids, or large glows.
- No generic mobile-app navigation bar or modern SaaS dashboard styling.
- No excessive pills, giant ornate frames, fake gemstones, skull decoration, raster textures, decorative backdrop blur, decorative animation, or new external fonts and UI frameworks. Restrained backdrop blur is allowed only for a forced loss-of-control state-transition layer; ordinary decorative blur remains prohibited.
- No decorative rivets or visible bottom-right resize artwork on menus or windows; desktop `DesktopWindow` uses four invisible corner hit areas with matching diagonal cursors and focus-visible outlines, while phone and tablet windows remain handle-free.
- No decoration-driven viewport listeners, observers, bottom margins, or transforms that compete with safe-area and keyboard systems.
