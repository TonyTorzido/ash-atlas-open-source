# HUD lanes, notices, and the loot feed

Transient gameplay feedback lives in fixed lanes so it never covers a persistent HUD surface. The
lane geometry is one stylesheet, `apps/client/src/hudLanes.css`; the live reference is Developer App
-> UI Standards -> HUD lanes.

## Rules

- Nothing transient may overlap the chat bar, party widget, unit frame, hotbars/quick slots, or the
  bottom bar (dock on phone, command bar and pack frame on desktop).
- Never place feedback with ad-hoc pixel offsets in a feature. Use a lane.
- No native scrollbars inside lanes; lanes size to their content and never scroll.
- Desktop and phone consume the same data; only the lane anchor changes.

## Lane map

| Lane | Desktop (`data-presentation="desktop"`) | Phone (`touch`) |
| --- | --- | --- |
| Chat bar | top-centre plaque | full-width strip across the top |
| Unit frame / party | unit frame top-left, party widget under it | party launcher top-left under chat; expanded panel 14rem wide |
| Notice lane | top-centre directly under the chat plaque, width bounded between the unit frame and the right edge (max 440px) | top-centre under the chat strip, clear of the party launcher and zoom readout (max 300px); while the party panel is expanded it drops to the slot above the dock timers |
| Loot feed | right side, bottom-anchored above the pack frame and inside the right quick-slot column, newest row at the bottom (260px) | right side under the chat strip and zoom readout, clear of the quick-slot rail (210px) |
| Activity timers / population notice | bottom-centre above the command bar | bottom-centre above the dock |
| Hotbars / quick slots | left and right edge columns under the unit frame | left and right edge rails |
| Bottom bar | command bar + pack frame | dock |

The activity slot also hosts the Glimmer level-up button (`LevelUpReadyButton.tsx`, shown only
while the level-up fee is on and the next level's XP is banked): one 44px plaque reading
**Level up ready** over the Glimmer price; it opens a `GameConfirmationPrompt` with a quiet Cancel.

## Notices (`HudNoticeLane.tsx`)

- One short line per notice; max 3 stacked; each fades after about 3.5 seconds.
- Merge only exact duplicates (same text and tone): the row counts up and its timer restarts.
- Tone is `info`, `success`, or `warning`; it only changes the accent edge.
- The lane also hosts the announcement and flag-burn notices; they are positioned by the lane, not by
  their own offsets.
- `role="status"` and `aria-live="polite"`; reduced motion removes the slide.
- Dungeon notice text is produced by the server (`summarizeAutoNotices` in `apps/server/src/game/dungeon.ts`):
  announce a door once (skip the reciprocal back-direction portal and doors that do not leave the
  audience's current rooms), short copy such as `Boss defeated: The Ossuary Lord` or
  `Bone Guard defeated — Crypt Gatehouse is open.`, and `Dungeon complete.` as its own line.
  Authored `show_message` text still replaces automatic notices for the same burst.

## Loot feed (`CombatRewardHud.tsx`, `combat/lootFeed.ts`)

- Every reward source enqueues floating feedback of the reward family (mob drops, harvest gains,
  ground pickups, dungeon chests, gold, character/class/profession XP); the feed is the only place
  it renders. Floating in-world combat numbers are separate and unchanged.
- Rows are compact: small item icon plus `Iron Shield ×1`, coin glyph plus `+14 Gold`, subtle
  text-only XP rows such as `+20 Hunter XP`. Give a reward its `subject` (item or skill name) and `icon`
  when enqueuing so it renders as a structured row.
- Identical rewards inside a short window merge into one row and count up; at most five rows; rows
  fade and slide out. `role="log"` with `aria-live="polite"`.

## Loot cards (`CombatRewardHud.tsx`, `combat/lootCards.ts`)

- Mob kills (`COMBAT_REWARD_GRANTED`) and freshly claimed dungeon chests (`DUNGEON_REWARD_GRANTED`) reveal
  as one card each, in the loot lane above the feed rows. Their item and gold floaters are not also
  sent to the feed; XP and harvest rows stay in the feed.
- A card lists gold first, then items by rarity, each with artwork, name, quantity and a rarity tint
  (`data-rarity`). Items that landed on the ground (full pack) say "On the ground"; tap them on the map.
- Cards pop in, last about 5s (bosses 7.5s with a larger legendary-accent card headed "Boss defeated"),
  stack at most 3 and never take pointer input. Replays and empty chest claims show no card; the
  dungeon notice already says why.
- A chest the player has looted reads as spent (dimmed) in their snapshot; opening it pops the sprite
  with a short glow. Open-chest art would replace the dimming via the prefab `looted` state asset.

## HUD chrome

HUD chrome follows the Game Menu recipe: quick-slot tiles are gilded parchment plaques (brass edge, inner brass rule, corner brackets, flush to the screen edge) with menu-ink glyphs; locked slots are recessed engraved sockets with a small brass lock instead of a ghost.
The dock keeps one icon | meter | value grid on both sides with 16px ink icons, distinct fills (HP green, XP brass, hunger amber, carry bronze, full red), the combat state label as the value at rest (timer meter only while active), and gold as a plain coin plus value aligned with the carry row (no pill). Gauges are 9px grooves with faint quarter ticks. On the phone dock the left ledger is HP (value inside a taller bar) over XP, and the right is bag weight and gold on one line (separated by a small brass diamond) over the hunger bar, mirrored so XP and hunger read as a pair; XP and hunger are bars only. The touch dock runs edge to edge with no map gap at the sides or bottom: on iOS its lower corners are the display radius itself (inset 0) and readouts are padded clear of the curve, on Android it is square at the bottom. Menu and both ledgers give a pressed response (the medallion sinks and springs back, ledgers darken) without changing tap or hold behaviour.
The chat strip has a thin brass inner rule and a bronze presence dot.

Combat state (aggression or protection) shows nothing at ease: no label, no row. Afloat (water travel) is the one persistent state in that slot: when no combat state is active the phone tag reads Afloat (no ring, sea-blue underline) and the PC adventurer card shows an Afloat text chip; an active combat state takes the slot until it ends.
While active it is a ring around the phone Menu medallion (a recessed groove that drains clockwise from 12 o'clock, ember red for aggression, pale gold for protection) with a hanging brass-edged seconds tag at the top that pulses gently in the last 3 seconds, and on PC a chip on the adventurer card; the PC bottom bar is one framed unit (nav, a brass-soft divider, carry and gold) and its Settings button reads Settings.
PC chat is capped at 620px and the adventurer card, chat and bar share the brass corner brackets.
