# Compact prompts, targeting, and interaction feedback

Use this standard for clickable world objects and players, compact action prompts or confirmations,
multi-target selection, and other short interaction surfaces. Canonical components own structure,
hierarchy, materials, responsive presentation, interaction containment, focus, and accessibility;
feature code supplies domain data and callbacks.

## Player-facing copy

Ordinary player UI must read like final in-world game copy. Use direct nouns, actions, and status. Never narrate the server, client, database, authority, or other implementation mechanics unless a technical recovery error truly requires it. Omit eyebrow, subtitle, detail, or body text when it merely restates the current destination, a visible value or action, or the mechanic itself.

## Compact interaction UI

Use compact UI for doors, portals, chests, smithing stations, harvestables, mines, mobs, NPCs, dungeon fixtures, small confirmations, and overlapping-target selection.

Canonical components:

- `apps/client/src/ui/GameActionPrompt.tsx`
  - `GameActionPrompt`
  - `GameConfirmationPrompt`
  - `GamePromptAction`
- `apps/client/src/ui/GameTargetPicker.tsx`
  - `GameTargetPicker`
  - `GameInteractionRow`
- Compatibility adapters:
  - `apps/client/src/ui/MobileWorldActionSheet.tsx`
  - `apps/client/src/ui/MobileWorldTargetPicker.tsx`

The compatibility adapters delegate to the canonical components. New domain code should prefer the canonical names.

A feature may provide:

- display name;
- category;
- one short detail or status when it adds information;
- actions and callbacks;
- enabled and busy data (an action that is not enabled is not shown);
- primary, secondary, or destructive action tone.

The component owns:

- a see-through parchment leaf in a gilded frame: the active theme's paper tinted translucent over a lightly
  blurred world, a 6px frame with a brass double rule and corner brackets, and a soft drop shadow
  (`--aa-prompt-*`, `--aa-brass*` tokens in `menuAppearance.css`);
- serif small-caps title over a brass rule with a centre diamond, and a compact uppercase category;
- dense spacing and responsive width;
- vertically stacked actions;
- full-width plaque bars for every popup action (the Giving Tree **Chop** prompt is the reference).
  One action is one full-width bar; two or three actions split that same bar into equal segments
  side by side; four or more use two-per-row split rows, an odd last action spanning the row.
  Never small centred buttons or wrapped rows. A quiet full-width text **Cancel** row comes last
  (never a corner X);
- focus and Escape behavior;
- busy presentation (only a running action stays visible, disabled);
- keyboard and touch targets;
- pointer-event containment.

### Visual contract

The canonical direction is the existing overlapping-target menu: one see-through parchment leaf in a gilded frame in the active Light/Dark appearance (translucent parchment in Light, smoky walnut in Dark), brass double rule with corner brackets, plaque action rows, and a quiet Cancel row. Phone prompts are `min(316px, 100% - 48px)` wide and sit just above the dock, with Cancel clearing
the Menu button. The surface stays light enough (about 40% tint, 3px blur) to read the world behind it. Titles, details, messages, and action labels wrap within the surface rather than clipping. Single-action prompts show the target name; multi-target pickers show the concise heading **Choose Target** (or a specific equivalent such as **Choose Destination** or **Choose Item**). Both use the same theme-aware surface material. Keep a descriptive accessible dialog name distinct from the visible heading. Light-theme Skills/progression art is rendered as dark ink; dark theme art follows the active walnut treatment.

On desktop, ordinary movable `GameActionPrompt` instances are housed by `DesktopWindow` with the compact 352px default width, 260 × 140 minimum bounds, and session-local movement/resize behavior. Their desktop resize affordance is four invisible corner hit areas with matching diagonal cursors and focus-visible outlines; decorative rivets and visible bottom-right resize artwork are excluded. Arrow keys operate on the selected title-bar or corner control in 10px steps, or 40px with Shift; resizing keeps the opposite corner fixed under the minimum, viewport, and HUD clamps. `GameConfirmationPrompt` is an explicitly modal compact surface: it contains focus, blocks pointer input behind its backdrop, and remains cancellable with Escape unless its action is busy. The prompt container is focused by script (Escape, focus return) but is not a keyboard stop, so it never draws a focus outline; only its buttons and the window's move/resize controls show `:focus-visible` rings. Gallery samples and other intentionally inline previews set `movable={false}` so they do not escape their host surface.

The former large **Exterior Door** dialog is an anti-reference. Do not recreate its oversized centered panel, explanatory paragraph, giant pale side-by-side buttons, weak hierarchy, or generic browser-dialog appearance.

Single-action prompts normally read:

```text
Manor Door
PORTAL

[ Leave Manor ]

[ Cancel ]
```

When a compact access prompt changes among three mutually exclusive modes, omit the current mode
and present the other two as equal actions in one seamless two-column frame with a single divider.
Do not style either alternative as selected or pressed.

Do not explain mechanics the player can see. Use **Cancel** to dismiss uncommitted interaction intent. Use **Close** only for a read-only surface with no pending intent. World activity timer plates use the current theme's paper, text, and brass tokens rather than a fixed light or dark panel.

### Phone world-target sheet (`compact`)

`MobileWorldActionSheet` (trees, mines, creatures, flags, and dropped items on phones) sets
`compact` and `dismissOnOutsideClick` on `GameActionPrompt`. It keeps the 44px touch height and:

- uses the standard phone prompt width;
- uses a one-line title that ellipsizes rather than wrapping;
- ends with the standard quiet **Cancel** row, after the actions in reading and tab order;
- closes on a tap outside the sheet through the dismiss layer, which absorbs that tap so it never
  also moves the character, and on Escape.

```text
Giving Tree (Fruiting)
[ Chop ] [ Gather Berries ]
          Cancel
```

`compact` is presentation only and affects only this non-floating phone sheet.

Choosing an approach-based action closes the prompt before movement begins. Movement or portal authority remains outside the component.

Selecting a building, station, or similar world object never starts movement or performs its
operation directly. Selection first opens the canonical action prompt or target picker. The player
must choose the intended action there; only that explicit action may begin approach movement, and
the operational UI opens after arrival. There are no one-touch building actions.

A new manual movement intent, including double-tap walk, supersedes the whole pending approach action. It closes any remaining prompt, clears feature pending or busy presentation, and cancels the authoritative approach or portal transition before the new movement is sent. A late arrival or transition plan must not reopen the destination. Never leave the original prompt visible as a disabled, opaque, or greyed-out approach status panel.

### No visible scrollbars, content-sized prompts

The game UI never draws a native scrollbar: a global rule in `medievalFinish.css` hides scrollbars on every game scroll container (Studio excluded) while wheel, touch, drag, and keyboard scrolling keep working. Do not add `scrollbar-width`, `scrollbar-color`, or `::-webkit-scrollbar` styling to game UI. Compact prompts size to their content and never scroll at normal content; only very long content may scroll, and it never shows a bar. A compact prompt closes when its action is chosen. Tapping the same target again while that action walks up or runs reopens the prompt with the action named in progress (**Chopping**, **Mining**, **Gathering**, **Gathering Berries**) and disabled; a node's other action (such as **Chop** beside **Gathering Berries**) keeps its normal label and switches to it. **Cancel** stays enabled: it stops the action, not just the prompt. Identical for overworld and dungeon nodes. Combat **Attack** stays available on a target that is already being fought.

### Target selection

`GameTargetPicker` preserves:

- a clickable detail area;
- a separate optional quick action;
- an accessible category (screen-reader only; the name and action already make it visible);
- dynamic target count, shown as a small pill beside the heading so players know to scroll;
- accessible unavailable reasons;
- mobile-safe hit areas;
- one Cancel control.

World picker rows are not numbered. Each row is one continuous rounded pill split into even halves:
the info half (name, then one line of distance · detail) and the quick-action half, in the same
fill behind a hairline divider. When
known, compact rounded distance such as **30m** leads the info line; an injured combat target appends its rounded health such as
**30m 45%**, while full-health and non-combat targets omit health. The row the player is acting on
(the mob being fought, the node being gathered) shows a small gold dot before its name. Hover or focus-within previews
exactly one matching world target with the supplied compact gold anchor chevron centered at the
target's exact map anchor. The chevron keeps a fixed screen-size visible footprint at 75% opacity
and remains on the last positively previewed choice after pointer or focus leaves until another
choice is previewed. It appears only while **Choose Target** is open, and disappears immediately on
selection, action, Cancel, outside release, or any other picker close; no additional dynamic-entity
selection circle is drawn. A pointer or touch press belongs to its originally pressed control. A
normal click or tap without meaningful movement activates only that control. Movement beyond the
small activation threshold or release over another control cancels activation and leaves the picker
open; pointer cancel performs no action. Release outside the popup still cancels the picker without
activating the world beneath it. Disabled or busy quick actions never activate or fall through to
detail selection. Repeated world targets with the
same presented identity are ordered nearest-to-player at picker-open time while category order and
different identities retain their positions. Tree varieties and dropped-item variants remain
distinct. The stored picker order does not reshuffle as the player moves, and selection remains
explicit rather than automatic.

Map gesture ownership follows the same explicit-intent rule. A normal single map click or tap is
confirmed after the **Double-tap window** (100ms by default, 50-200ms in Settings > Map, stored per
device); only the map highlight shows until then, so the menu and the mob HP bar appear together.
A second primary click before confirmation, or within the 300ms recognition window after it, inside
the screen tolerance is the double-click movement gesture. Native map panning is separate from that click
recognizer: once the pointer passes the map's small native movement threshold, dragging begins
immediately and never waits for the 300ms window or the double-click screen tolerance. Drawing, target placement, teleport, developer
spawn, and selected planner-build actions own the clicks they consume; repeated taps remain with
the active action, and a trailing native `dblclick` after a one-shot action exits is still consumed
by that gesture. Do not exempt ordinary world entities or every empty ruler-map click from movement:
only the active action's concrete target or placement route owns the event. Each action keeps its
own pending-request and duplicate-suppression guard.

When a picker includes a bulk footer action such as **Take All**, the target list is its only
vertical scroll region. The bulk action and **Cancel** remain pinned in the footer while item rows
scroll. On phone, the picker reserves at most five canonical row-heights in total: three
visible item rows plus the **Take All** and **Cancel** rows, with the heading and compact panel
spacing kept outside that row budget. Further rows scroll by touch with no visible scrollbar or
reserved gutter. Desktop pickers remain compact and bounded; their rows scroll with no visible scrollbar either.

A row may add at most one concise detail string from the existing target snapshot. Use it for
information that helps distinguish or understand the target: combat level (as **Lv N**, omitted at
level 0), personal-flag access and toll, structure ownership, or collectible resource type. It
follows distance and injured health on the info line after a middle dot and ellipsizes if long. Canonical action verbs are
**Travel** for world relocation, **Chop** for plain trees, **Gather** for fruiting Giving Trees and other resources and mines, and
**Take** for dropped items. All simple picker quick actions take the right half of their row, including Attack, Chop,
Gather, and Take. Siege deployment retains its separate, more complex controls. A fruiting Giving
Tree uses **Gather**, which gathers berries; its detail area opens the full prompt with Chop. Special state and access actions such as **Request Access**, **Start
Event**, and **Claim Mine** keep their specific labels. World travel prompts use **Travel** with
**Cancel** to dismiss the selection.

On phone, **Tap assistance** controls only the padding used to gather assisted world-object
candidates: **Precise** is 6px, **Standard** is 12px, and **Large** is 20px. Standard is the
default and preserves the canonical current behavior. Larger assistance makes small world objects
easier to tap, but may show **Choose Target** more often in crowded areas. The setting does not
change base hitboxes, target ordering, action prompts, or desktop picking.

Desktop and phone consume the same target and action data. Responsive styling must not fork game logic.

### Skill System V3 action controls

Skill System V3's combat surface is the canonical action-slot presentation. It shows one
target-driven **Basic Attack** and two durable **General 1** and **General 2** slots. The first
five classes have no equipable class techniques; Druid Replenish is used from its class detail
with a selected friendly target. General assignments are sourced from the shared V3 skill
snapshot and are independent of inventory indexes, backpack capacity, and item occupancy. Desktop
uses Q/W for the General slots; phone keeps the compact 44px controls and the same action
callbacks and cooldown/targeting state.

The current V3 policy has exactly two General Active slots. Eight slots are a documented future
ceiling/extension point only; this presentation must not add executable lock state, fragments,
entitlements, or access reduction. Assignment, reconnect, stale-action rejection, and server
authority remain owned by `player_general_active_loadouts`, SkillService, and the existing V3
protocol.

## Confirmation and feedback

- Use `GameConfirmationPrompt` for small interaction confirmation.
- Its optional `cancelLabel` changes contextual negative copy while retaining `Cancel` as the default.
- Confirmation prompts use a modal dialog with focus containment and a backdrop; Escape invokes the cancel callback unless the confirmation action is busy.
- Put destructive intent in the action label and destructive tone.
- Never use `window.alert`, `window.confirm`, or `window.prompt`.
- Busy actions cannot double-submit.
- Unavailable actions are hidden, never shown disabled: no greyed **Use** or **Drop**, no
  explanatory text under any action button. A countdown or in-progress state is a busy action;
  loss-of-control (`forced`) prompts keep their one recovery action visible. Information the
  player needs goes in the message above the actions, not under a button.
- Use an error status for a failed/unavailable interaction; do not turn simple prompts into paragraphs.
- Transient news is a one-line notice and reward/drop/XP feedback is a loot-feed row; both render in their HUD lane, never as a stacked box or merged paragraph ([HUD lanes](HUD_LANES.md)).
- Long errors, forms, recovery workflows, and detailed results belong in an app surface.

Server-authoritative loss-of-control states may use the explicit `forced` mode on
`GameActionPrompt`. This narrowly scoped exception keeps the canonical compact leather prompt at
the top layer, traps focus, contains pointer input, and omits Cancel, outside-click, and Escape
dismissal. It presents one recovery action while leaving the world visible through a restrained
state-transition darkening and blur. Ordinary compact prompts remain nonmodal and retain their
normal cancellation behavior.

## Player tap menu

Tapping another player opens `apps/client/src/ui/PlayerTapMenu.tsx` on the standard popup (opened
by `SocialProfileOverlay`; the phone Contacts profile page keeps its app shell). Header: name,
**Level N · Class**, and the PvP status line (Fighting, Your aggressor, You struck them · blocked 21h).
The only actions are **Attack** and **View Profile**, sharing one split bar (no Message). Attack
follows `playerRelation`: enemy (marked, your aggressor, fighting, or at war) attacks at once and lists the usable
skills as split rows below (see Attackable target skills); friend (party, friends, same city or
kingdom) has no Attack; neutral asks first (**Attack Name?**), then lists the skills. Skills are
the player's own targetable skills and the active pet's abilities, using the existing cooldown
state. Attack and the skills are hidden when `pvpAttackVerdict` refuses; a neutral confirm says they get one swing; the trust shield is
server-side only and answered by the server error.

## Attackable target skills

Every popup for something you can attack (monster, animal, or a player who is an enemy or a
confirmed neutral) lists every targetable skill you can use on it, below the Attack bar, in split
rows of three segments with an odd remainder filling its row (`skills` on `GameActionPrompt`,
`attackSkillActions` in `App.tsx`). The set is: Shield Charge (needs a Shield and melee stance),
Blight Strike (learned and in the General loadout), Ninja Shadow Mark (equipped), Edict Stride,
the active pet's `enemy` abilities (only `hitsPlayers` ones on a player), and the Net on monsters
(not bosses) with its carried count. Passives, self, area and position skills are never listed.
A skill that is not learned, equipped or allowed is hidden; one that is cooling down stays visible
and disabled with the remaining seconds inside its segment (`cooling`), the one exception to
hide-unavailable. Each skill uses its existing activation path with the target entity id.
