# Player-facing UI design system

This page is the stable foundation and index for player-facing UI standards. Ash Atlas uses two
interface families. A feature supplies domain data and callbacks; canonical components own structure,
hierarchy, materials, responsive presentation, interaction containment, focus, and accessibility.

The visual foundation remains `docs/ui/DESIGN.md` and `apps/client/src/ashAtlasTheme.css`. Use
existing tokens rather than hardcoding nearby browns, golds, text colors, spacing, borders, or
radii.

App shells and timer plates paint an opaque grained active-theme paper surface; compact prompts use the
see-through parchment leaf in a gilded frame from `COMPACT_PROMPTS_AND_TARGETING.md`. Every framed surface
(prompts, dialogs, auth, desktop windows, HUD notices) shares the same brass double rule, carved plaque
buttons and plaque tabs from `medievalFinish.css`; do not invent a second finish. Values
over semantic bars stay directly on the paper or bar surface; do not add separate brown or black
number boxes.

Existing green health/status indicators are approved exceptions to the ordinary interface palette,
as listed in `docs/ui/DESIGN.md`. Preserve their current canonical styles and tokens for health,
presence, successful actions, readiness, progress, protection, beneficial effects and class/item
identity. Panels, navigation, focus and selection keep the medieval palette; this is not approval
for new green treatments. The source guard retains narrow exceptions for these existing declarations
and literal world artwork.

## Standards index

Read only the focused standard that matches the feature, plus the [feature acceptance checklist](FEATURE_ACCEPTANCE_CHECKLIST.md):

- [Compact prompts, targeting, and interaction feedback](COMPACT_PROMPTS_AND_TARGETING.md)
  — prompts, confirmations, target pickers, compact action copy, skill controls, and interaction feedback.
- [App shells, menus, and navigation](APP_SHELLS_MENUS_AND_NAVIGATION.md)
  — readable apps, `GameAppShell`, phone Game Menu, housed tabs, progression browsers, and scroll ownership.
- [Timers, progress, and asynchronous status](TIMERS_PROGRESS_AND_ASYNC_STATUS.md)
  — authoritative deadlines, countdowns, cooldowns, progress, reconnect, retry, and loading/failure states.
- [World presentation and Game PNGs](WORLD_PRESENTATION_AND_GAME_PNG.md)
  — labels, world zoom geometry, renderer ownership, and canonical independently editable Game PNG slots.
- [Responsive and accessibility](RESPONSIVE_AND_ACCESSIBILITY.md)
  — shared desktop/phone behavior, accessible state, safe areas, focus, and forbidden presentation patterns.
- [HUD lanes, notices, and the loot feed](HUD_LANES.md)
  — fixed non-overlapping lanes for notices and reward feedback on desktop and phone.

Use [portals and interiors](PORTALS_AND_INTERIORS.md) for enterable locations and
[flag travel and arrival](FLAG_TRAVEL_AND_ARRIVAL.md) for world-to-world flag travel. The
[Build Bible README](README.md) is the 30-second routing page.

## Canonical component quick lookup

| Need | Canonical implementation | Focused standard |
| --- | --- | --- |
| Shared desktop window geometry | `apps/client/src/ui/DesktopWindow.tsx` | [App shells](APP_SHELLS_MENUS_AND_NAVIGATION.md) |
| Compact action or confirmation | `apps/client/src/ui/GameActionPrompt.tsx` | [Compact prompts](COMPACT_PROMPTS_AND_TARGETING.md) |
| Overlapping world targets | `apps/client/src/ui/GameTargetPicker.tsx` | [Compact prompts](COMPACT_PROMPTS_AND_TARGETING.md) |
| Readable app or ledger surface | `apps/client/src/ui/GameAppShell.tsx`, `DestinationShell.tsx` | [App shells](APP_SHELLS_MENUS_AND_NAVIGATION.md) |
| Shared menu heading, copy, control, state, divider, or scroll region | `GameAppSectionHeader`, `GameAppText`, `GameAppButton`, `GameAppIconButton`, `GameAppCloseButton`, `GameAppBackButton`, `GameAppState`, `GameAppDivider`, `GameAppScrollRegion` in `GameAppShell.tsx` | [App shells](APP_SHELLS_MENUS_AND_NAVIGATION.md) |
| Phone root navigation | `apps/client/src/mobileGameMenu.ts`, `apps/client/src/ui/PhoneHud.tsx` | [App shells](APP_SHELLS_MENUS_AND_NAVIGATION.md) |
| Connection or startup recovery | `apps/client/src/ui/PlannedUpdateStatus.tsx`, `ConnectionRecoveryScreen.tsx` | [Timers/status](TIMERS_PROGRESS_AND_ASYNC_STATUS.md) |
| World progress or deadline | `apps/client/src/flags/flagBuildCountdown.ts`, `apps/client/src/collectibles/harvest.ts` | [Timers/status](TIMERS_PROGRESS_AND_ASYNC_STATUS.md) |
| Notices and loot/XP feed | `apps/client/src/hudLanes.css`, `ui/HudNoticeLane.tsx`, `ui/CombatRewardHud.tsx` | [HUD lanes](HUD_LANES.md) |
| World labels and PNG geometry | `apps/client/src/map/worldPngPresentation.ts` | [World presentation](WORLD_PRESENTATION_AND_GAME_PNG.md) |

`DesktopWindow` owns the shared desktop chrome for app shells, chat, and ordinary compact prompts.
Its unused title bar remains draggable with the subtle functional `⠿` glyph. Four invisible corner
hit areas provide resize affordances with matching diagonal cursors and focus-visible outlines;
decorative rivets and visible bottom-right resize artwork are not part of the UI contract. Arrow
keys operate on the selected title-bar or corner control in 10px steps, or 40px with Shift, while
the opposite corner remains fixed and normal minimum, viewport, and HUD bounds continue to apply.
Phone and tablet presentations remain handle-free.

## Shared foundation

Ordinary player UI must read like final in-world game copy. Use direct nouns, actions, and status;
never narrate server, client, database, or authority mechanics unless a technical recovery error
truly requires it. Responsive presentation may change layout, but desktop and phone consume the same
action model and authoritative state. Developer App → UI Standards is the live downstream reference
for canonical components and presentations.

## Compatibility forwarding

The former monolithic standard was split into the focused documents above. These short sections
preserve the old file's common headings and anchors for existing links; the linked document is the
single normative source.

## Player-facing copy

See [Player-facing copy](COMPACT_PROMPTS_AND_TARGETING.md#player-facing-copy).

## Compact interaction UI

See [Compact interaction UI](COMPACT_PROMPTS_AND_TARGETING.md#compact-interaction-ui).

### Visual contract

See [Visual contract](COMPACT_PROMPTS_AND_TARGETING.md#visual-contract).

### Target selection

See [Target selection](COMPACT_PROMPTS_AND_TARGETING.md#target-selection).

### Skill System V3 action controls

See [Skill System V3 action controls](COMPACT_PROMPTS_AND_TARGETING.md#skill-system-v3-action-controls).

## World labels

See [World labels](WORLD_PRESENTATION_AND_GAME_PNG.md#world-labels).

## World PNG presentation zoom

See [World PNG presentation zoom](WORLD_PRESENTATION_AND_GAME_PNG.md#world-png-presentation-zoom).

## Game PNG registration

See [Game PNG registration](WORLD_PRESENTATION_AND_GAME_PNG.md#game-png-registration).

## Full-screen app and readable UI

See [Full-screen app and readable UI](APP_SHELLS_MENUS_AND_NAVIGATION.md#full-screen-app-and-readable-ui).

### Game Menu navigation root

See [Game Menu navigation root](APP_SHELLS_MENUS_AND_NAVIGATION.md#game-menu-navigation-root).

### Mandatory production JSX contract

See [Mandatory production JSX contract](APP_SHELLS_MENUS_AND_NAVIGATION.md#mandatory-production-jsx-contract).

### Visual reference and hierarchy

See [Visual reference and hierarchy](APP_SHELLS_MENUS_AND_NAVIGATION.md#visual-reference-and-hierarchy).

### Scrolling and pinned controls

See [Scrolling and pinned controls](APP_SHELLS_MENUS_AND_NAVIGATION.md#scrolling-and-pinned-controls).

### Progression browsers

See [Progression browsers](APP_SHELLS_MENUS_AND_NAVIGATION.md#progression-browsers).

## Confirmation and feedback

See [Confirmation and feedback](COMPACT_PROMPTS_AND_TARGETING.md#confirmation-and-feedback).

## Responsive and accessibility rules

See [Responsive and accessibility rules](RESPONSIVE_AND_ACCESSIBILITY.md#responsive-and-accessibility-rules).

## Forbidden patterns

See [Forbidden patterns](RESPONSIVE_AND_ACCESSIBILITY.md#forbidden-patterns).

## Live reference

The Build Bible UI contract and the canonical components and styles it names are authoritative.
Developer App → UI Standards is their downstream live reference: it renders the real canonical
compact prompt, confirmation, target picker, app header, tabs, cards, states, actions, and footer.
Any relevant UI standard, canonical component, or presentation change must update this gallery in
the same change. The gallery is capability-gated with the existing Developer App and is not
available to ordinary players.

## HUD chrome

HUD chrome follows the Game Menu recipe: quick-slot tiles are gilded parchment plaques (brass edge, inner brass rule, corner brackets, flush to the screen edge) with menu-ink glyphs; locked slots are recessed engraved sockets with a small brass lock instead of a ghost.
The dock keeps one icon | meter | value grid on both sides with 16px ink icons, distinct fills (HP green, XP brass, hunger amber, carry bronze, full red), the combat state label as the value at rest (timer meter only while active), and gold as a plain coin plus value aligned with the carry row (no pill). Gauges are 9px grooves with faint quarter ticks. On the phone dock the left ledger is HP (value inside a taller bar) over XP, and the right is bag weight and gold on one line (separated by a small brass diamond) over the hunger bar, mirrored so XP and hunger read as a pair; XP and hunger are bars only. The touch dock runs edge to edge with no map gap at the sides or bottom: on iOS its lower corners are the display radius itself (inset 0) and readouts are padded clear of the curve, on Android it is square at the bottom. Menu and both ledgers give a pressed response (the medallion sinks and springs back, ledgers darken) without changing tap or hold behaviour.
The chat strip has a thin brass inner rule and a bronze presence dot.

Combat state (aggression or protection) shows nothing at ease: no label, no row.
While active it is a ring around the phone Menu medallion (a recessed groove that drains clockwise from 12 o'clock, ember red for aggression, pale gold for protection) with a hanging brass-edged seconds tag at the top that pulses gently in the last 3 seconds, and on PC a chip on the adventurer card; the PC bottom bar is one framed unit (nav, a brass-soft divider, carry and gold) and its Settings button reads Settings.
PC chat is capped at 620px and the adventurer card, chat and bar share the brass corner brackets.
