# Player-facing feature acceptance checklist

Use only the sections that match the feature. This checklist does not require unrelated suites, migrations, or broad redesign.

## UI

- [ ] Uses `GameActionPrompt`, `GameTargetPicker`, `GameConfirmationPrompt`, or `GameAppShell` as applicable
- [ ] Does not duplicate prompt layout or styling
- [ ] Compact UI matches the dense Choose Target family in the active Light/Dark theme
- [ ] Does not resemble the former large Exterior Door dialog
- [ ] Has clear primary, secondary, destructive, and Cancel hierarchy
- [ ] Handles relevant disabled, busy, loading, error, and reconnect states
- [ ] Uses the same action data on desktop and phone
- [ ] Covers no more gameplay than necessary
- [ ] Uses concise labels without redundant instructions
- [ ] Uses finished player-facing language without implementation narration or repeated visible context
- [ ] States the destination once; eyebrow and subtitle text each add information when present
- [ ] Uses canonical tokens, typography, surfaces, borders, spacing, and controls
- [ ] Houses related selectors and contextual status in one intentional control surface
- [ ] Preserves keyboard, focus, touch, safe-area, and scrolling behavior
- [ ] Insets primary tab rails from the header/content and makes the selected cell unmistakable at rest
- [ ] Uses the shared scrollable housed tab option when a long tab set cannot preserve readable ~44px cells
- [ ] Distinguishes the item being inspected from the item or slot currently applied
- [ ] Keeps pinned tabs opaque and prevents scrolling content from showing behind or between them
- [ ] Prevents pointer events from leaking into the scene
- [ ] Uses Cancel for uncommitted intent and Close only for read-only dismissal
- [ ] Uses no raw browser alert, confirm, or prompt
- [ ] Developer gallery examples use the real components
- [ ] Relevant UI standard, canonical component, and presentation changes update Developer App → UI Standards in the same change

## Game PNG identity and authoring

- [ ] Every new player-visible game entity or art identity—including items, resources, drops, collectibles, mobs, animals, NPCs, buildings, facilities, structures, projectiles, effects, and equivalent content—has a canonical, independently editable Game PNG slot before acceptance
- [ ] The slot names its exact production path and production usage, is discoverable in Game PNGs on the feature branch, and exposes **Add Exact PNG** even when final PNG bytes do not exist
- [ ] Runtime fallback is used only for safe rendering while art is missing; a shared or generic placeholder does not satisfy registration
- [ ] Missing registration or missing existing Game PNG coverage is treated as a defect, not a valid exemption

## Timers, progress, and asynchronous status

- [ ] Reads `docs/build-bible/TIMERS_PROGRESS_AND_ASYNC_STATUS.md` for every deadline, cooldown, progress, retry, reconnect, loading, or async status surface
- [ ] Server-authoritative deadlines and state transitions remain the source of gameplay truth; local intervals only refresh display or bounded reconciliation
- [ ] Client display derives from synchronized server time or a translated authoritative deadline and does not commit success when a local timer reaches zero
- [ ] Progress is determinate only when total/completed values are authoritative, clamped, and exposed through the correct progressbar semantics
- [ ] Pending, active, paused/reconnecting, completed/ready, failed/unavailable, and stale/degraded states are distinct wherever the operation can enter them
- [ ] Background resume, reconnect, stale authority, malformed payload, retry, and timer cleanup behavior are checked for the operation
- [ ] Timer and progress status has an accessible name, truthful live/alert semantics, and a visible desktop/phone placement owned by the canonical surface
- [ ] No feature-private or lying countdown/retry loop duplicates an existing helper or creates separate desktop and phone timer truth

## Portal or enterable location

- [ ] Reads `docs/architecture/UNIVERSAL_PORTAL_AND_LOCATION_SYSTEM.md`
- [ ] Portal is an interactable object
- [ ] Object click only selects and opens canonical actions
- [ ] Action selection closes the prompt before approach
- [ ] Manual movement closes any remaining prompt and cancels the complete pending approach or portal action, including late-plan races
- [ ] Universal portal state owns pending, busy, failure, and cancellation UI; the feature has no separate `Entering...` latch
- [ ] Uses `USE_PORTAL` and an exact portal definition
- [ ] Uses exact approach, threshold, and paired arrival anchors
- [ ] Exterior anchor uses its canonical spatial-package region, not a region inferred from its enclosing city or owner
- [ ] Requires no second click
- [ ] Preloads the destination during approach
- [ ] Keeps the source visible until the threshold/commit boundary
- [ ] Uses the brief canonical transition cover
- [ ] Preserves player identity and durable gameplay state
- [ ] Same-instance room travel preserves the instance and domain session
- [ ] Reconnect restores canonical location and space
- [ ] Interior bootstrap does not wait for a world-only player snapshot
- [ ] Actor protocol projections preserve canonical appearance
- [ ] Player has one canonical location and spatial membership
- [ ] Adds no feature-specific movement, transfer, return, scene-swap, or exit pipeline
- [ ] Domain projection handlers do not move the actor, transfer spaces, restore world position, or change spatial membership

## World-to-world flag travel

- [ ] Reads `docs/build-bible/FLAG_TRAVEL_AND_ARRIVAL.md`
- [ ] Prepared, reserved, click, and retry coordinates do not place or present the player
- [ ] A committed flag relocation releases without waiting for Population V2 visible readiness
- [ ] `FLAG_VISITED` is the single authoritative local-player placement
- [ ] Flag scope publication is independent of Population V2 readiness
- [ ] Late entity baselines require current connection and world-view authority revisions
- [ ] Population, resource, combat, and scope handlers never move the actor or replace the anchor
- [ ] Party Auto-Follow starts behind the leader without waiting for leader population readiness
- [ ] Auto-Follow revalidates party, connection, and relocation authority before follower commit
- [ ] Retry, cancellation, reconnect, and superseding travel preserve one authoritative placement
- [ ] Focused WebSocket tests hold readiness unresolved and prove arrival, flags, and movement release

## Focused verification

- [ ] Focused diff inspected
- [ ] `git diff --check` passes
- [ ] Fast existing tests protecting changed behavior pass
- [ ] Affected package typecheck passes when TypeScript behavior or contracts changed
- [ ] Desktop and phone interaction are checked when visible behavior changed
- [ ] Build is run only when imports, exports, dependencies, bundling, or known build behavior require it
