# Timers, progress, and asynchronous status

Use this standard for countdowns, cooldowns, construction or harvest progress, server work,
reconnect notices, retry states, and any player-visible operation that changes over time. The
server owns gameplay truth; the client owns only the local presentation of that truth.

## Canonical implementation sources

Reuse the current domain helpers and components when they match the operation:

- `apps/client/src/gameClient.ts::synchronizedNow` reconciles the client clock from `WELCOME` and
  `PONG` server times.
- `apps/client/src/flags/flagBuildCountdown.ts` owns server-deadline translation, remaining time,
  determinate progress, and authoritative completion for flag and founding construction.
- `apps/client/src/collectibles/harvest.ts` owns server-backed harvest session deadlines,
  `harvestRemainingMs`, `gatheringProgressForTask`, reconnect resume, and bounded completion retry.
- `apps/client/src/ui/CollectiblePrompt.tsx::formatRemainingDuration` formats repeatable resource
  readiness; `apps/client/src/collectibles/repeatableTimerReconciliation.ts` reconciles elapsed or
  malformed repeatable timers with bounded refresh.
- `apps/client/src/map/gatheringProgressPresentation.ts` owns the world gathering progress plate
  and its one-decimal remaining-time presentation.
- `apps/client/src/population/PopulationPreparationNotice.tsx` and
  `apps/client/src/population/usePopulationPreparationVisibility.ts` own determinate nearby-world
  preparation progress, delayed visibility, and stale recovery.
- `apps/client/src/ui/PlannedUpdateStatus.tsx`,
  `apps/client/src/ui/ConnectionRecoveryScreen.tsx`, and
  `apps/client/src/connectionRecoveryPresentation.ts` own planned-update, reconnect, offline,
  startup-failure, and ended recovery presentation.
- `apps/client/src/ui/ProgressionHud.tsx` and `HealthBarTrack` own player health, resource, and XP
  bars; `apps/client/src/ui/SkillSystemV3CombatControls.tsx` and
  `apps/client/src/ui/classCombatControlModel.ts` own cooldown and status-effect presentation.

Timer and progress plates inherit the active menu theme: paper, text, rule, and semantic bar tokens
change with Light parchment or Dark walnut. They must not introduce a fixed white, black, or brown
number box around a countdown or bar value.

There is no universal generic countdown or async-status component today. New work must use the
closest owning surface and a focused helper, or introduce a shared primitive only when multiple
domains genuinely need the same semantics. `WeeklyLeaderboardsPanel` currently counts down from
an API `remainingSeconds` snapshot and `KingdomPanel::ProjectCountdown` uses a local wall clock;
these are existing domain implementations, not general authority patterns to copy for new gameplay
deadlines.

## Server-authoritative deadlines

Authoritative operations must receive an explicit server deadline or state transition. Prefer
absolute server timestamps such as `startedAt`, `completesAt`, `expiresAt`, `cooldownEndsAt`, or
`repeatableReadyAt`, together with the server time used to interpret them. A local interval or
`setTimeout` may refresh presentation and schedule a retry, but it must never commit completion,
grant a reward, release a lock, or claim readiness by itself.

Use `GameClient.synchronizedNow()` for server-time comparisons after the connection has established
its clock offset. When a payload arrives, translate its server deadline to the local display clock
once, as `createFlagBuildCountdown` and `attachHarvestSession` do, then derive every frame from the
stored deadline. Do not add or subtract an arbitrary network-delay guess to make a timer appear to
finish earlier.

An authoritative completion message wins immediately. `completeFlagBuildCountdown` sets zero
remaining and full progress only after the server confirms completion; local expiry displays a
finalizing state and waits for authority. The same rule applies to cooldowns, harvest completion,
repeatable readiness, travel locks, and every other operation with a server outcome.

## Player construction contract

Ordinary player-built structures use one centralized authoritative 30-second construction
duration: Manor; Furnace, Tannery, Loom, and Kitchen; and city houses, facilities,
and upgrades. The server owns the absolute construction deadline; desktop, phone, and world
presentation continuously derive remaining time and progress from `GameClient.synchronizedNow()`
and that deadline. When local time reaches zero, the UI shows `Finalizing…` until the server
confirms completion and the structure becomes active. This contract does not redefine personal
flag builds, city founding or conversion, Kingdom projects, production or crafting jobs,
harvesting, travel, or combat and cooldown timers.

## Local display and reconciliation

Local time is a display clock, not a second authority. Recompute remaining time as a clamped
deadline difference; do not decrement a stored counter. A display update may run at a domain-appropriate
cadence—250ms for desktop Skill System V3 controls, 100ms for phone combat controls, 1 second for
coarser app countdowns, or the world overlay's existing render cadence—but the next value must be
derived from the deadline.

When a tab resumes, the device wakes from sleep, the connection changes, or the authoritative
revision changes, recalculate from the server-backed deadline and reconcile the operation. Harvest
uses `resumeHarvestTask`; repeatable collectibles use `repeatableTimerReconciliation` and its
5-second elapsed refresh; population preparation uses its operation and checkpoint authority. A
stale or malformed payload must remain visibly unresolved or unavailable and request bounded
reconciliation rather than being treated as ready.

Background and reconnect handling must preserve the operation's state:

- keep the last known operation visible only with a truthful pending or reconnecting label;
- do not show success because a hidden-tab timer elapsed;
- on reconnect, request or resume the authoritative session before enabling completion-dependent
  actions;
- cancel display timers and retry timers when the operation or component is gone;
- use `visibilitychange` and the existing connection recovery hooks where the domain needs an
  immediate refresh.

## Formatting precision

Choose precision from the action's urgency and duration, and use one formatter within a domain:

- short construction and aggressive windows use tenths with ceiling, such as `8.4s`, so the client
  never displays zero or completion early; `buildRemainingTimeLabel` returns `Finalizing…` at zero;
- combat cooldowns and compact status effects use whole seconds with ceiling, such as `3s`, while
  the button or status label remains understandable without the decorative number;
- harvest prompts use tenths during active work and `formatRemainingDuration` uses `m`/`s` or `h`/`m`
  for longer repeatable readiness;
- weekly or long-period app deadlines may use `d h`, `h m`, or `m` as the owning surface already
  does, but must not imply finer precision than the source supports.

Clamp negative values to zero. Use a distinct ready, finalizing, paused, unavailable, or failed
  label instead of silently replacing a completed timer with a misleading positive duration.

## Progress semantics

Determinate progress requires authoritative total and completed or elapsed values. Clamp the internal
ratio to `[0, 1]` and expose a matching `0`–`100` value through `role="progressbar"`,
`aria-valuemin`, `aria-valuemax`, and `aria-valuenow`. `flagBuildProgress` and
`gatheringProgressForTask` are the current examples. `PopulationPreparationNotice` derives its
percentage from authoritative `completed / total` and shows it only for required visible work.

If total work is unknown, do not invent a percentage, fill the bar as a fake timer, or imply a
completion estimate. Use a pending/loading status instead. A completed bar is authoritative only
after the server reports completion; a locally elapsed deadline is still finalizing. Failed,
cancelled, stale, and degraded work must not be presented as successful 100% progress.

## Pending, paused, completed, and failed states

Every asynchronous surface must distinguish the states its operation can actually enter:

- **Pending/loading:** admitted or requested, with no misleading completion percentage.
- **Active/in progress:** authoritative work is underway and a truthful deadline or determinate
  ratio is available.
- **Paused/reconnecting:** local display cannot currently advance or commit; retain context and say
  that the connection or world is being restored.
- **Completed/ready:** server-confirmed success or availability; enable dependent actions only here.
- **Failed/unavailable:** terminal or retryable failure with a concise reason and an explicit retry or
  recovery action when one exists.
- **Stale/degraded:** authority or required content is no longer current; show recovery or reduced
  availability, never a fabricated ready state.

`PlannedUpdateStatus` is the canonical passive, nonmodal status for a planned service restart
signaled by WebSocket close code 1012: a compact top-center `ConnectionStatusPill` (Server updating…)
while the retained world remains visible and interactive. If authoritative presentation is still
unavailable after the 10-second planned grace period, `ConnectionRecoveryScreen` takes over.
Unexpected disconnects remain visually quiet for their shorter 2.5-second grace. Its reconnecting and
offline states keep the world visible under a light scrim that holds input, with the same pill
(Reconnecting… or Offline · Waiting for network) as the only explanation—never a full-screen card.
An ended reconnect window and startup failures use the entry `BootScreen` with one clear action.
Pills use polite status; ended and startup failure use an alert. `PopulationPreparationNotice` uses
its operation reason and stale callback rather than inventing an ETA. Preserve the domain's explicit state through
reconnect and do not collapse pending, paused, completed, and failed into one spinner.

Runtime PNG artwork updates run before the game session mounts. Use `ConnectionRecoveryScreen` for
the manifest check, byte-counted download progress, retry, and the option to continue with verified
installed or bundled art. Player-facing copy calls this an update and never names artwork. Activate a
pack only after every listed PNG passes size, SHA-256, and image decode checks; keep the selected
pack fixed for that session.

## Entry path and client updates

Every loading step between launch and the first world frame—the static first frame in `index.html`,
native update checks and downloads, runtime PNG downloads, the session check, native compatibility
checks, world preparation, and a store install's one-time first-run download (`first_run_ready`
shows the size, a Wi-Fi hint, and Download before anything downloads; `first_run_loading` shows
byte progress)—renders `apps/client/src/ui/BootScreen.tsx`, which shares its markup
and `public/initial-curtain.css` styles with the static first frame. Its warm near-black matches the
native launch screen. Loading steps change only the status line, so entry reads as one screen;
action-required states (sign-in, onboarding, access, failures) keep their own cards.

A published client update shows its version and download size (web: the build's
`client-update.json`; native: `readNativeUpdateDownloadBytes`, the files whose checksums differ from
the installed bundle's manifest, or the zip's `sizeBytes`). In game it is `UpdateBanner`: a compact,
nonmodal banner placed just under the measured chat bar, with a 15-second countdown ring derived from
its `autoApplyAt` deadline and Update now. Native launch, before play, uses `ConnectionRecoveryScreen`
state `update_ready` (full-screen, 10 seconds) before the bundle downloads. Either applies exactly
once, at the deadline or on the button. An update found by the web launch check (the "Checking for
updates…" boot screen) applies before play without a banner. When the server has already refused
the build (protocol-incompatible close, `update_required`, or a required native bundle), the update
applies immediately on the `update_applying` screen, and a failure shows `bundle_failed` with Try
again. The client polls the release every 10 seconds. A native app keeps checking for its bundle on
every poll while it runs a different build than the release publishes for its platform
(`nativeBundleBehindRelease`), because the OTA pointer goes live after the release switch and
server restart; if the server refuses the build before the bundle is downloadable, the failure
screen keeps retrying in the background. The server admits only the published client build per
platform (`apps/server/src/realtime/clientReleaseGate.ts`) after a 90-second grace from when that
server process first observes the new build: identified outdated clients, including those
reconnecting after the deploy's server restart, may play through the grace so the banner can
finish; afterwards new connections from other builds and connected outdated clients (swept every
5 seconds) close with the protocol-incompatible code. Clients that send no build identity are never
given the grace.

## Accessibility and placement

Nonblocking changes use `role="status"` and `aria-live="polite"` where the current component does
so; terminal or action-required failures use `role="alert"`. Determinate bars expose their numeric
range and current value. Prompts and buttons provide an accessible name and disabled reason. A
decorative number may be `aria-hidden` only when the surrounding control or status still exposes the
truthful state; a timer must never be the sole accessible indication of readiness, progress, or
failure.

Place status at the surface that owns the operation:

- world gathering/build work stays with its world marker or compact world prompt;
- player health, XP, resource, cooldown, and combat effects stay in the desktop HUD or phone dock;
- app-specific deadlines stay in the app's selector or card, such as the weekly leaderboard period;
- connection and startup recovery stay in the top-level recovery surface;
- short notices and reward feedback use the notice lane and loot feed ([HUD lanes](HUD_LANES.md)); the bottom-centre slot above the dock is reserved for activity timers.

Desktop and phone may reflow the same status and action data, but must not create separate timer
truth, separate retry semantics, or a phone-only completion path. Preserve safe areas, focus, and
scroll ownership from the applicable shell or compact interaction standard.

## Prohibited timer and status patterns

- decrementing a local counter and treating it as authoritative;
- using local `Date.now()` or a guessed duration as gameplay truth when server time/deadline data is
  available;
- committing success, reward, readiness, lock release, or completion from `setTimeout`, interval
  expiry, hidden-tab elapsed time, or a stale snapshot;
- showing a determinate percentage when total work is unknown or failed;
- hiding reconnect, stale, paused, or failed state behind a spinner that implies progress;
- making the timer or progress bar the only accessible state description;
- creating a feature-private countdown, retry loop, or desktop/phone timer variant when the owning
  helper or status surface already exists.
