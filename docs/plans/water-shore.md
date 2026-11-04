# Water shore: walking stops at the water, tapping the water builds the raft

Branch `feature/water-shore--from-t1524` (base t1524, ec83df88e). Owner request: walking to water
stops the player and, with the joystick, drags smoothly along the shore. Going in needs a tap on
the water (the raft prompt). Design doc: `docs/design/WATER_GAME_PLAN.md` (phase A).

## Behaviour (unrafted player on land)

| Input | Result |
| --- | --- |
| Joystick, keys, pad (MOVE_TO with `walk: true`) | Never a raft prompt. Leg stops at the shore. Held at an angle, the player slides along the shore; straight in just stops. |
| Tap on land whose straight path crosses water | Stops at the shore, no prompt. |
| Tap on open water | Unchanged: `RAFT_REQUIRED`, prompt with cost, `launchRaft`, same transactional op-keyed debit. |
| Dash / combat approach | Unchanged: `planCombatApproach` blocks a path that needs a raft, so it ends at the shore. |
| Afloat | Unchanged (0.5 speed, landing drops the raft). |
| World API failure | Fail-open: unknown surfaces count as land, so nothing stops, but nothing ever floats an unrafted player. |

## Design choice: server probe, client predicts from the server's wall

The client has no reliable water source. The vector water layer is a rendering layer (different
resolution and clipping from the World API), and the bounded water highlight cache is a visual
cache, so predicting from either would disagree with the server at the exact moments it matters.
The server therefore owns the shore:

1. **Stop.** `planFromSurfaces` (mode `walk` or `tap` with a land target) finds the first water
   sample, then scans that 5 m (walk) or 15 m (tap) sample gap in 0.25 m steps against the 1e-4
   degree cell grid and stops 0.3 m before the first water cell edge (`shoreStopDistance`). The
   leg carries land segments only, so the server tick never moves onto water.
2. **Slide.** `probeShore` casts 36 rays (10 degree steps, 0.5 m samples refined to 0.05 m at the
   hit, radius max(leg, 8 m) capped at 24 m) over one batched, cached lookup. For a blocked walk it
   picks the ray within 90 degrees of the input that keeps the most progress along the input
   (clear length times cosine), or stops if less than 12 percent of the leg survives. No shore
   normal is needed for the choice, so concave corners and staircase shores just work.
3. **Wall hint.** The probe also derives a wall (`WaterShoreHint`: position, normal bearing, gap)
   sent with MOVE_ACCEPTED while the player is near water (probing stays on for 2.5 s after a
   contact). The client keeps it (`apps/client/src/movement/shoreSlide.ts`) and slides the next
   walk targets along it before sending (`clipWalkTargetToShore` in shared), so the predicted
   player never enters the water and the server's answer matches: no rubber-band. While sliding,
   the stick resends each frame (`shouldSendJoystickMove`) so it follows curving shores instead
   of freezing when a short slide leg ends. A missing or stale wall (2 s, or 40 m away) just
   means no client prediction; the server still stops and slides.

Protocol: MOVE_TO gains optional `walk`, MOVE_ACCEPTED gains optional `shore`. Old clients omit
`walk` and keep the old prompt behaviour. `packages/shared/src/protocol` is a protocol file, so
the release tool may route this through the careful lane.

## Files

- Server: `apps/server/src/game/waterTravel.ts`, `worldCommandQueue.ts`, `worldRuntime.ts`,
  `apps/server/src/realtime/handlers/worldGameplayHandler.ts`
- Shared: `packages/shared/src/waterTravel.ts`, `protocol/worldSchemas.ts`, `protocol/worldMessages.ts`
- Client: `movement/shoreSlide.ts`, `movement/joystickMovementMath.ts` (resend while sliding),
  `App.tsx` (walk wrapper), `useWorldFrameHandler.ts`, `gameClient.ts`, `worldGameplayClient.ts`.
  `floatingStick`, `flickDash`, `JoystickMovement.tsx` and hud CSS are untouched (the thumb-centering branch).

## Tests

- `apps/server/src/game/waterShoreLeak.test.ts`: free-raft leak measurement (warm and cold World API),
  corner clip, slide past the probe, cold cells, arrival-only free raft, relog at a shore stop, shore guard
  for steps and dashes, exact cell traversal.
- `apps/server/src/game/waterTravel.test.ts`: walk and tap truncation, tap on water still needs a
  raft, slide leg, straight-in stop, repeated resends never creep into water, wall hint, afloat
  unaffected, fail-open.
- `worldGameplayHandler.test.ts`: walk skips `RAFT_REQUIRED`, forwards the wall; launch tests unchanged.
- `apps/client/src/movement/shoreSlide.test.ts`: slide, stop, expiry, resend while sliding.
- `apps/client/full-app-tests/waterShore.spec.ts`: Lake Okeechobee west shore (26.8408, -80.9531),
  keyboard into the water, diagonal slide, water tap shows the prompt. Needs a World API.

## Limits and open items

- Shore precision is the 1e-4 degree (about 11 m) lookup grid: a cell is all land or all water,
  and the World API's own lake and river surface cells are 125 m, so shores are staircases. A
  slide hugs the staircase, so near corners it can look stepped.
- The dev runtime walks at 125 m/s, so client prediction can overshoot the wall by speed times
  round trip (several metres) before the correction. At real speeds that is well under a metre.
  The Playwright bounds are scaled for dev speed.
- Fixed (free-raft leak): a MOVE_TO that started on a water cell made the player afloat for free, and walk
  legs could reach water cells nobody checked: a slide ran the whole 87.5 m dev-speed leg past the 24 m probe,
  corners clipped between 5 m samples were missed, and cells a cold World API left unknown were walked as land.
  Measured with `waterShoreLeak.test.ts` (36 joystick runs at 125 m/s with the real resend cadence): before,
  9 free rafts and 248 unrafted-on-water ticks with a warm cache, 24 and 320 with a cold one; after, 0 and 0.
  Now: legs and probe rays are traced cell by cell (`waterCells.pathCells`), slides stop at the probe radius
  (the client resends while the server reports a wall), standing on water is a free raft only at an arrival
  spot (login, relocation, respawn), and the tick's shore guard never lets an unrafted step or dash enter a
  cached water cell. Unknown cells still pass (fail-open) and are fetched in the background; a player left on
  water that way gets no raft and may wade back to known land within 40 m. The Playwright spec asserts 0
  afloat frames.
- `packages/shared/src/clientMessageSchemaDomainOwnership.test.ts` already fails on the base
  (shop messages), unrelated to this change.
