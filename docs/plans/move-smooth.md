# Move smooth: local-player walking stutter (iPhone)

Branch `feature/move-smooth--from-t1538`. Follows `crisp-smooth.md` and `map-shake.md`.

## Symptom

On the owner's iPhone (60 Hz, one map render per frame, no layer mismatch), the sprite or the map stutters a little
while walking with the joystick. One 5 s device sample showed `leadCapFrames 312` in 301 frames,
`playerOffsetReversals 73`, `playerOffsetMaxPx 6.6` and `camBackSteps 94`, with no corrections and no snaps.

## Root cause

Two read-only audits agree on the cause:

1. **The prediction was not free-running.** On nearly every frame the lead cap in `playerRenderSmoothing.ts`
   hard-clamped the rendered position to `leadOrigin + maxLead`. The lead origin is the last authority sample,
   dead-reckoned from its packet **arrival** time, which was stamped with `frameClockNow()`. Network jitter and frame
   quantization went straight into the origin, so the rendered position followed a sawtooth of about ±1 to 6 px at
   20 Hz. A clamp is not counted as a correction, so `corrections 0` did not mean the motion was continuous.
2. **The cap was permanent because the client was always faster.** The client predicted at WELCOME's base speed. The
   server tick walks at `PLAYER_SPEED_MPS × clamp(0.2..2, playerMovementMultiplier × water segment)`, and that
   multiplier includes armour, shield, boots, class, kingdom and slows.
3. **Joystick resends disturbed the prediction.** `beginLocalAnticipation` overwrote the prediction clock with the
   resend's `performance.now()`, which shortened the next frame's step. Resends also dropped the water speed profile,
   and acceptance turned the cap back on against an authority sample from before the acceptance.
4. **The camera follows a filtered target and the sprite uses the raw prediction**, so whichever layer did not absorb
   the sawtooth showed it.

## Changes

1. **Effective speed to the client.** The server's `GameState` caches the multiplier the tick applied
   (`noteMovementMultiplier`, never persisted) and exposes `effectiveSpeedMps`. `MOVE_ACCEPTED` and the owner's own
   movement upsert carry `speedMps`. The client uses it for prediction, dead reckoning, the lead budget and the
   joystick lookahead (`localSpeedMps()`). It applies the server's 0.2..2 clamp together with the water segment
   multipliers. If the field is absent (older server), the client falls back to the base speed. Mid-walk slows and
   gear swaps arrive with the next self delta.
2. **Dead reckoning by server time.** The authority's age is now `clientNow − serverToClientOffset − sample.serverTimeMs`,
   clamped. The offset estimator (minimum observed offset) now uses the real packet receipt time
   (`ReplicationContext.receivedAtMs`) and creeps up by 0.5 ms/s so clock drift cannot strand it. The age falls back to
   receipt time when there is no offset or the age falls outside −50 ms to 1 s.
3. **Soft lead limit.** Beyond `maxLead + 1 tick`, the prediction is eased back toward the origin as a decaying error
   (time constant 400 ms) at no more than 15% of the walking speed. Steps therefore stay even and forward. A hard
   clamp happens only beyond `2 × maxLead` (a real desync). The lead budget is now 4 ticks with a 250 ms floor
   (600 ms ceiling), and the RTT is an EMA (α 0.2) instead of one PONG sample. A sample older than the accepted
   revision does not limit the lead while it is fresh (≤ 300 ms). The dash exemption, the 100 ms landing grace,
   pending timeout and rejection handling, and relocation snaps are unchanged.
4. **The prediction clock belongs to the frames.** Requests no longer rewrite or rewind the clock; only an idle
   prediction (no frame for more than 100 ms) restarts it. The water profile survives resends until the resend's own
   `MOVE_ACCEPTED`. A read at an already-rendered time does not change state, so the camera, the sprite and input
   handlers see one position per frame. The App.tsx movement, dash and swing call sites, `useWorldFrameHandler`
   (snapshot, delta, raft rejection) and `rejectLocalAnticipation` pass `frameClockNow()`. Traces and trackers keep
   wall time.
5. **Camera: unchanged, with a decision point.** The overlay driver and the target filter stay on by default. In
   overlay mode the camera (`externalFrame(now)`) and the sprite (`renderPosition(id, frameNowMs)`) read at the same
   frame time, and with reads now side-effect free they see the same presentation position. Use
   `ash-atlas:camera-filter=off` for the device A/B. If steady walking meets the targets below with the filter off,
   the filter can be removed from ordinary walking.
6. **Telemetry** (`motionReport.ts`, plus a server log line). See the next section.

## Telemetry fields (client motion report)

| Field | Meaning |
|---|---|
| `leadCapFrames` | Unique display frames where the lead limit acted (soft pull or hard clamp). Before this change it counted calls. |
| `leadHardClampFrames` | Unique frames clamped at `2 × maxLead` |
| `leadNudgePxSum` | Total soft pull in CSS px |
| `authorityJumpMaxPx` / `authorityJumpMaxM` | Largest distance between a new authority sample and where the previous one dead-reckons at the new server time |
| `authorityServerSpeedMps`, `serverSpeedRatio` | Server walking speed measured from Δposition / ΔserverTime, and its ratio to the client's predicted speed |
| `rttMs`, `maxLeadMs` | Smoothed RTT and the current lead budget |
| `speedMps`, `baseSpeedMps`, `speedVsBase` | Effective prediction speed compared with WELCOME's base speed |
| `camBackSteps`, `camReversals`, `playerOffsetReversals` | Now measured against a local heading (an EMA of step direction) instead of the whole sample's net axis, so turns no longer count |

On the server, the world scheduler now logs `droppedBacklogSteps` and `backlogResetEvents` in production when they
are non-zero ("world fixed-step scheduler dropped backlog").

## Device verification targets

Measure steady straight walks after warm-up, on the same route, loadout and network, including one loadout with a
speed penalty:

- `leadHardClampFrames`: single digits
- `playerOffsetP95Px` ≤ 1 px, `playerOffsetMaxPx` ≤ 2.5 px
- `camStepCv` ≤ 0.08
- `serverSpeedRatio` ≈ 1.00 (`speedVsBase` shows the loadout's multiplier)
- No regression in `movingFramesMap1`, `layerMismatchFrames` or frame pacing

Then repeat with `ash-atlas:camera-filter=off` for the A/B.

## Risks to watch

- **Dash.** The cap exemption and landing grace are unchanged. Dash prediction uses the frame clock.
- **Water and shore.** Profiles now persist across resends. Distance from the old leg's origin is approximate after a
  sharp turn on water, and is replaced by the next `MOVE_ACCEPTED`.
- **Real stalls.** The prediction can now run to `2 × maxLead` (instead of `1 × maxLead`) before it holds.
