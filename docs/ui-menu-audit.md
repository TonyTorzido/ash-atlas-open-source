# UI and menu audit

Audit baseline: `cbcd55e`, captured at 1280×720 before implementation.

## Highest-value findings

1. The persistent HUD competes for the same vertical space: the top bar, chat bar, progression/combat controls, resource panel, debug panel, and bottom action bar overlap at a common laptop-height viewport.
2. Inventory and Flags are positioned panels rather than modal surfaces. They have no click-blocking scrim, dialog semantics, focus entry/restoration, or contained keyboard navigation; Inventory handles Escape only through an app-wide shortcut.
3. Major launchers are only partially exclusive. Market closes Inventory and Flags, but opening Inventory or Flags does not close the other major menus, and selecting a flag can leave the list open over its detail panel.
4. Close controls vary between `x`, `×`, and `Close`, with inconsistent target sizes and focus treatment.
5. Several panels use `100vh` and absolute top/bottom offsets. This is fragile at short heights and browser zoom, while Classes and Market already demonstrate the safer fixed-scrim/internal-scroll pattern.
6. Modal dialogs prevent pointer click-through visually, but lack consistent Escape handling, initial focus, focus containment, and focus restoration.
7. Development panels are correctly gated by the server-provided development-tools flag; that behavior should be preserved.

## Conservative scope

Adopt a shared focus/keyboard behavior and modal-surface styling incrementally for Inventory, Flags, and the small confirmation/quantity dialogs; keep the map, top chat bar, game mechanics, and the established medieval/dark palette unchanged.
