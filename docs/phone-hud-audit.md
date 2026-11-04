# Phone HUD working audit

## Existing interface inventory

- Always-visible state: health, class resource (Rage/Focus/Conviction/Faith), XP/level, class name, connection state, and chat preview/unread count.
- Immediate actions: class normal actives, next-attack empowers, Taunt, attack/stop attack, harvest, pick up, visit a flag/city, cancel a flag build, build flag, and water-collection mode.
- Contextual actions: attack, harvest, pickup all/amount, flag visit/delete, city visit, and selected-object dismissal.
- Utility/navigation: own profile and social view, inventory/equipment, classes/loadout, flags, kingdom, market, recenter, auto-jump preference, account/logout, and phone handedness.
- Temporary feedback: status toast, damage/healing world ticks, recording badge, harvesting/building/teleport status, cooldown overlays, disabled reasons, confirmations, and errors.
- Full interfaces: chat, inventory/equipment, classes, profile/social, kingdom, market, flag list/management, developer tools, performance tools, and developer console.
- Development-only controls: grants, mob spawning, teleport, progression adjustment, world/resource/debug overlays, performance recording, and console.
- Desktop keyboard equivalents: `F` build flag, `I` inventory, `M` market, `Escape` close/cancel, plus existing developer shortcuts.

## Phone placement decisions

- Left edge: next-attack empowers; then world/context actions such as cancel build, build flag, and water collection. Left-handed mode mirrors the action rails.
- Right edge: normal actives and Taunt; then the highest-priority selected-target action (attack/stop, harvest, pickup, or visit).
- Contextual-only: attack/stop, harvest, pickup all/amount, visit flag/city, delete flag, and target dismissal. They disappear with selection.
- Overflow: direct rails show at most three presentation-model actions per side. Lower-priority pickup amount, delete, founding, and any excess context actions enter the compact overflow sheet.
- Bottom utility drawer: Profile & Social, Inventory & Gear, Classes, Flags, Kingdom, Market, recenter, auto-jump, account/logout, phone handedness, and development tools only in development.
- Player state: compact health/resource/XP cluster on the lower-left safe edge; aggression appears there only while authoritative combat state exposes it.
- Layout response: rails rebalance whenever context appears/disappears; center remains pointer-transparent and available to the map. Open drawers/panels are the only full interaction blockers.
