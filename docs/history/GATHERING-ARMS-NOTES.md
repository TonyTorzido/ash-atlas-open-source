# Gathering and flag-building arms: notes

Every gathering action (chop, bare-hand chop, mine, bare-hand mine, fish) and flag building use one
bendable arm rig. Before this, chop/mine/fish cut the arm out and rotated it rigidly about the
shoulder, and the flag build had its own curved-arm meshes.

## What each animation does

All arm keys are an upper-arm direction (degrees out from straight down) plus a signed elbow bend.
A positive bend folds the forearm up and out; a negative bend folds it in across the body. Every key
stays inside the rig limits:

- the upper arm at most 130 degrees out or 40 in;
- the elbow at most 100 degrees, folding out only (no inward folds).

The tool programs and the flag build stay inside the round 2 range (72 out, 25 in, outward bends
only), so they are unchanged. Cycle lengths and impact moments are unchanged.

- **Chop (axe):** hold with the upper arm 30 degrees out and the elbow at 55, axe level. Wind-up:
  upper arm 66 out, elbow cocked to 100, fist up by the head. The strike snaps the elbow straight
  into the tree side, then a short follow-through and a recoil that bends the elbow again. The
  off arm starts at its exact rest pose and counter-swings a little. 1000 ms, impact at 0.555.
- **Bare-hand chop (round 4: a punch):**
  - Both arms stay close to the rest art between punches (a slight outward elbow bend, fists
    low).
  - Cock-back: the striking upper arm tucks in and down, the forearm cocks out at the side, and
    the body leans away while the off arm swings out.
  - A fast extension drives the fist out to a straight horizontal punch at shoulder height,
    leaning in.
  - A short hold on contact with a small squash, then back to near rest.
  - 560 ms, impact at 0.6.
- **Mine (pickaxe):** raise to 70 out with the elbow at 100, a strike that locks the elbow straight
  into the rock, a short push-through and a bounce back. The off arm counter-swings. 1300 ms,
  impact at 0.64.
- **Bare-hand mine (round 4: a hammer punch):**
  - From near rest, the striking arm swings up nearly straight to a raised fist beside the head
    (upper arm about 130 degrees from down, elbow 15).
  - The body rises high and leans back.
  - It slams down to a straight arm pointing down and out at the rock top, with a deep crouch
    and a big squash, then a brief hold, a recoil and back to near rest.
  - The off arm stays low, swinging out a little for balance.
  - 900 ms, impact at 0.66.
- **Fish:**
  - Ready: 25 out, elbow 50.
  - Cast: the rod goes back with the elbow at 95, then the flick snaps it straight before it
    softens into the hold.
  - Wait: 40 out, elbow 45, small bob.
  - Bite: the elbow flinches with each twitch.
  - Fight: 30 out, elbow 85, tugging with the jitter while the off arm braces out.
  - The off arm otherwise hangs at its exact rest pose.
- **Flag build:** the same beats (heave, hang, ram, settle), re-keyed as arm angles.
  - Hold: upper arm 8 degrees past rest, elbow 45, gripping the pole at the side.
  - Heave: 45 out, elbow 100, fist up by the head.
  - Ram: the arm nearly straight.
  - The off arm swings out for balance.
  - The held flag is the size of the placed Soft Flag (see below).

## Technique

**Cut.** Each arm-covering layer (body, chest armour, gloves, hands) is split once per texture
(canvas 2D, cached and shared across players) into:

- an armless copy;
- one arm piece per side, cropped to its visible pixels plus a transparent border;
- one torso seam outline per side;
- one outline of the piece's cut edge per side.

The cut polygon is `GATHER_TUNING.arm.polygon`, in template body pixels.

- **Seam:** down the middle of the outline the torso and arm share at the shoulder, then through
  the empty gap between them below the armpit. The gap was measured on the template body, cloth,
  leather, chainmail and breastplate. So no arm skin is left on the torso and no torso is carried
  by the arm.
- **Outer side:** reaches far past the body (u up to 940), so arm armour that sticks out
  (pauldrons, vambraces, future gauntlets) is carried whole.
- Both arms are always cut.

**Bend** (`armRig.ts`, round 5 owner rule: the arm pivots only at the shoulder and bends only at
the elbow, at the middle of the arm). Each piece becomes a 3 x 32 mesh (96 vertices, which stays
batched), laid out in the arm's own frame with rows across the arm.

- **Shoulder:** one pivot at the shoulder joint, on the arm's centre line. The whole arm below the
  top of the shoulder dome turns rigidly about it at full width. Only the art above the dome
  (`blendStart` / `blendEnd`, -0.34 to -0.24 arm lengths) blends back to pinned, so nothing of the
  neck or head that falls inside the cut ever moves.
- **Elbow:** one bend at the middle of the drawn arm (template v 851, `elbowAt` 0.55), on the centre
  line. The forearm and fist turn rigidly about it as one piece; only a thin band of rows at the
  joint blends (`elbowBlend` 0.03).
- No wrist, no hinge offsets, no inward folds. Poses are an upper-arm angle plus an elbow bend (no
  IK). Bone lengths never change and angle 0 / bend 0 is exactly the untouched art.
- **Body squash:** the arms undo the body's squash and stretch about the shoulder joint, so a
  squashed body (impacts) never makes an arm thinner or fatter.

**Layering.** Both arms' meshes live in one group *behind* the torso layers, so a turned arm comes
out from under the torso's own edge and its root never shows as a cut stub. Every pose folds the
forearm outward, so no arm crosses in front of the body. The held tool is in the hands layer (in
front), and the held flag pole is drawn over the arms.

**Shoulder cap (round 6).** Because the arms draw behind the torso, the torso's shoulder edge
covered the turned arm's root, and the visible arm narrowed into a stalk.

- While an arm is turned *outward*, the cutter's per-side `caps` texture is shown in front of the
  torso (`arm-rig-caps` group, just below the hands layer). It is the arm's own shoulder: the rest
  art on the root side of the shoulder joint, closed below with a 16 px half-disc round the joint.
- It does not move, so the shoulder keeps its full drawn width, and the turned arm comes out from
  under it.
- It fades in with the seam outlines (2 to 10 degrees of outward turn). At rest, and when an arm
  swings in, it is hidden, so those frames are unchanged.
- Tuning: `GATHER_TUNING.arm.capRadius`.

**Seam outlines.** Only the shared-outline part of the seam is re-outlined, on both sides. Both
outlines are separate textures: the torso one is a sprite in the source layer, and the arm one is
a second mesh that follows the arm. Both fade in as the upper arm turns (`seamFadeDegrees`). At
rest there is no extra line anywhere, and a moving arm shows one line, not two.

**Motion.** Gather programs use `arm` / `bend` / `offArm` / `offBend` tracks (degrees). The flag
program uses `arm` / `bend` / `offArm` / `offBend` as turns away from rest. Reduced motion
compresses toward each program's `hold` as before.

**Round 1 defects (owner reports).** Both were one bug. Pixi maps mesh UVs over a *trimmed*
texture's untrimmed rectangle, so the off-arm mesh sampled the wrong region:

- an armour sleeve showed as a thin detached strip;
- the bare arm showed as a squeezed blob.

Meshes now sample an untrimmed view of the same frame.

**Round 5 defect (owner): thin arm, pinched at the shoulder.** Measured on the rendered arm mesh
(template px, perpendicular to the arm; shoulder root / mid upper arm / mid forearm):

| Frame | Rest | Round 4 | Round 5 |
| --- | --- | --- | --- |
| bare, chop_hand impact | 78 / 88 / 93 | 65 / 84 / 90 | 76 / 87 / 94 |
| bare, mine_hand impact | 78 / 88 / 93 | 71 / 78 / 85 | 76 / 87 / 93 |
| bare, axe impact | 78 / 88 / 93 | 70 / 80 / 88 | 77 / 86 / 94 |
| bare, pick impact | 78 / 88 / 93 | 72 / 83 / 88 | 77 / 87 / 92 |
| shirt, chop_hand impact | 85 / 95 / 98 | 73 / 92 / 94 | 84 / 94 / 97 |
| shirt, mine_hand impact | 85 / 95 / 98 | 76 / 86 / 89 | 85 / 94 / 98 |
| plate, chop_hand impact | 80 / 93 / 98 | 79 / 89 / 94 | 79 / 92 / 97 |
| plate, mine_hand impact | 80 / 93 / 98 | 71 / 80 / 91 | 79 / 93 / 97 |

There were two causes. The shoulder blend turned the rows near the joint by only part of the
arm's turn, which pinched the root into a neck. The body squash also scaled the arms with it. The
two-joint rig and the squash compensation fix both. The cut itself already carried the full drawn
width (checked against the art).

**Round 6 (owner): twig at the shoulder.** Visible root width (template px, measured on screen as
arm pixels in front of everything; at the joint / 0.05 / 0.1 arm lengths down):

| Pose | Rest | Round 5 | Round 6 |
| --- | --- | --- | --- |
| bare, raised (mine_hand 495) | 66 / 71 / 74 | 63 / 70 / 76 | 89 / 103 / 115 |
| bare, punch (chop_hand 340) | 66 / 71 / 74 | 66 / 69 / 76 | 76 / 70 / 76 |
| shirt, raised | 71 / 77 / 81 | 70 / 76 / 83 | 91 / 105 / 117 |
| shirt, punch | 71 / 77 / 81 | 71 / 76 / 82 | 86 / 77 / 82 |
| plate, raised | 73 / 71 / 74 | 74 / 70 / 76 | 93 / 105 / 115 |
| plate, punch | 73 / 71 / 74 | 72 / 72 / 78 | 87 / 80 / 78 |

Before and after frames of every program (flag, chop, chop_hand, mine, mine_hand, all fishing
phases; bare, shirt, plate; both sides; 50 ms steps) were pixel-diffed. Every changed pixel lies
within 80 template px of a shoulder joint, which is the extent of the shoulder art. The elbow,
forearm, fist, tool, flag and legs are unchanged. Arms at rest, and the rest art, have zero
changed pixels.

**Round 3 defects (owner reports).**

- **Green dot or hole in the fist:** this was not a pixel cut out of the fist. It was a bare-hand
  impact chip (a green leaf for chop, a grey stone for mine) that spawned on the fist centre and
  flew back across it. Bare-hand chips now start past the knuckles along the forearm
  (`particles.knuckleReach`) and fly off the far side of the target. Tool chips are unchanged.
- **Limp straight arm (chop) and symmetric biceps flex with mitten fists (mine):** both programs
  were rebuilt as punches.
- **Round 4 (review):** the round 3 inward-fold guard read as clutching the stomach,
  and on plate as hoops. It was removed: the inward fold was capped (round 5: removed) and no program
  rests in a fold. The mine cock-back read as waving, so the arm is now raised nearly straight
  with more body rise and lean.

**Round 2 defects (owner reports).**

- **Skinny arms, stick wrist, claw fist, and the thin forearm on the pickaxe hold:** the old
  curved-elbow mapping squeezed the inner side of the elbow to zero width, and the fist sat partly
  inside that zone. The rotation-only mapping above replaces it.
- **Doubled or glowing outline at the shoulders:** the seam cut 5 to 8 px into the arm skin beside
  the shared outline. That left a light strip plus a second stroke. The seam has been re-fitted,
  and the outlines are hidden at rest.
- **Arms posed past what the art can show:** limits now apply in the rig, and every program was
  re-keyed inside them.

**Flag size.** The client passes the pole canvas height in player root units
(`flagBuildHeightUnits`): Soft Flag piece height x root scale x (flag 37.5 px per 25 structure
units), divided by the player's 28 px per 42 root units. Flags and players share one zoom curve, so
this holds at every zoom. The renderer fallback (`FLAG_BUILD_TUNING.flag.canvasUnits` = 47 layer
units) matches the stock flag at the default body scale, and a client test keeps them in step.
The old 66 units was about 1.4x the placed flag on screen, not 3x. The earlier estimate ignored
the two map scales.

## Files

- `packages/player-renderer/src/armRig.ts` (new) + test: tuning, chain, forward kinematics with
  the two-joint arm, point mapping, `RigMesh`, `ArmRig`.
- `packages/player-renderer/src/gatherAnimation.ts`:
  - polygon and seam;
  - piece crop, torso seam and piece edge textures in the cutter;
  - `bend` / `offBend` tracks and the new program keys;
  - fishing poses;
  - rigid helpers removed.
- `packages/player-renderer/src/renderer.ts`: a single cut-and-bend path, tool parenting, flag arms
  through the rig.
- `packages/player-renderer/src/flagBuildAnimation.ts`: arm code removed, the arm-angle program,
  `heightUnits` on `FlagBuildArt`.
- `apps/client/src/players/gatheringPresentation.ts` (+ test): `flagBuildHeightUnits`.
- `apps/client/src/ui/UiStandardsGallery.tsx`: standard text.

## Tuning entry points

- `ARM_RIG_TUNING` (`armRig.ts`):
  - `blendStart` / `blendEnd`: how far down the shoulder stays pinned.
  - `elbowAt` / `elbowBlend`: where the elbow is and how thin its blend band is.
  - `maxRaiseDegrees` / `maxInwardDegrees` / `maxBendDegrees`: the pose
    limits.
  - mesh grid and seam fade.
- `GATHER_PROGRAMS` (`gatherAnimation.ts`): `arm`, `bend`, `offArm`, `offBend`, `tool`,
  `lean`, `squash`, `lift` and `hold` per program.
- `GATHER_TUNING.fish`: `holdArm` / `holdBend`, `readyArm` / `readyBend`, and the fight values.
- `GATHER_TUNING.arm`: `polygon` and `seam` (template pixels), `outlineUnits` (outline width).
- `FLAG_BUILD_PROGRAM` / `FLAG_BUILD_TUNING` (`flagBuildAnimation.ts`): the flag motion, pole and
  cloth.

## Verification

- Contact sheets of the real renderer and art were rendered in headless Chromium through a
  temporary Vite harness page, which has since been removed.
- Round 2 sheets are in `.arm-rig-refs/round2-results/` (`<animation>-3x.png` and `-1x.png`).
  They cover every animation and fishing phase, both sides, and bare, shirt and breastplate
  bodies. Each row starts with the untouched rest art, followed by rest, wind-up, impact and
  follow-through.
- Round 6 sheets are in `.arm-rig-refs/round6-results/`: every program at 3x, plus 8x shoulder
  close-ups in the raised and punch poses.
- Round 5 sheets are in `.arm-rig-refs/round5-results/`: every program and fishing phase at 3x,
  plate row first, then shirt and bare, for both sides, starting from the rest art.
- Shoulders and elbows were also checked at 8x to 16x.
- `player-renderer` typecheck and tests pass. Touched client tests pass. Client `tsc` shows only
  the two known errors (`App.tsx` ~18332, `inventoryPanelModel.test.ts`).

## Known weak spots

- **Not run in the live game or in DEV -> UI Standards.** The in-app preview uses the same
  renderer, but the client was not run against a server or the feature runtime.
- **On a raised arm the shoulder cap shows the arm's rest shoulder bump** where the arm leaves it.
  It reads as a deltoid, slightly chunkier than the arm below it.
- **The breastplate pauldron is chest armour.** When the arm rises, the arm comes out from under
  it, and a small light wedge of the pauldron's arm-side part can show at the root.
- **Elbow crease at a 100-degree bend:** with the joint on the centre line, the inner side of the
  elbow overlaps itself. On the shirt a short crease line shows there at high zoom.
- **No real guard between punches.** Short chibi arms cannot hold a fist up without folding across
  the body, so the arms rest low.
- **No arm armour art exists yet** (the gloves folder is empty). New arm armour should be checked
  against `polygon` and the seam.
- **Long hair hides most of the elbow work.** Wind-ups tuck the fist under the hair.
- **Remote players do not show the flag build**, because it is not broadcast. Unchanged.

## Harvest (picking) animation

Plays for every non-wood, non-mining collectible (`harvestActivityLabel` = "Harvesting": berries,
plants, herbs, fibre, mushrooms) and for the "resin" action (berries from a Giving Tree, sap from a
Elder Fern). Always bare-handed: the renderer ignores a tool for this program and the client sends
none. Program `GATHER_PROGRAMS.harvest`, 1100 ms, beat at 0.43.

- **Reach (0 to 0.30):** from the pouch pose (upper arm 20, elbow 22, fist low at the hip) the arm
  swings slowly down and out to the plant, nearly straight (68 out, elbow 10). The body leans in
  8 degrees and crouches (squash 0.05, lift -0.4).
- **Grab (0.30 to 0.41):** a small push in (71, elbow 5), then a pause at 70 / 9.
- **Pluck (0.41 to 0.53), the beat:** a fast tug back. The elbow snaps to 52-58 while the upper arm
  drops to 32-36, so the fist comes back to the waist at the side. The body leans away (-2) and rises
  a little. At 0.43, five pieces (light leaf, berry red, dark leaf, yellow-green, leaf) pop off the
  plant and fly away from the player.
- **Return (0.53 to 1):** the hand lowers to the hip (19 / 20) with a small dip as the pick drops in.
- **Off arm:** stays low by the hip (21 to 24 out, elbow 16 to 30) and gives a little with the tug.
  It never swings inward, and every key of both arms stays at or outside the rest direction (17.1),
  so no arm folds across the body.
- **Reduced motion:** compressed toward the hold pose (40 / 25) like the other programs. No particles.

**Particles:** they start `particles.harvestReach` (0.5 arm lengths) past the fist centre along the
forearm, which is at the plant the hand has just let go of, and fly off the far side. The hand is
moving back toward the body at the same time, so they never sit on the fist. A renderer test checks
the spawn point is more than 0.25 arm lengths beyond the fist.

**Wiring:** local player only. `PlayerGatheringActivity.kind` is `chop | mine | fish` in the protocol
schema, and the server only publishes gathering for wood and mines. Showing remote harvesting needs a
protocol and server change (a `harvest` kind), which is out of scope here. DEV -> UI Standards ->
Gathering animations has a "Harvest" row with a berry bush target.

**Verification (2026-10-08):**

- Sheets are in `.harvest-refs/results/`:
  - `harvest-3x.png`: rest art, reach, grab, pluck, return; plate, shirt, bare; both sides.
  - `harvest-shoulder-8x.png`, `harvest-fist-8x.png`, plus 16x versions at reach and pluck.
  - `strip-*.png`: every 50 ms.
- Before/after pixel diff of every existing program: chop, mine, chop_hand, mine_hand, flag, and
  fishing ready/wait/bite/fight. It covered full and reduced motion, plate/shirt/bare, both sides,
  50 ms steps over a cycle plus the ease-in, and the rest art. 3675 frames, 0 differ.
- Visible width (template px, arm pixels in front of everything) at the joint, at 0.1 arm lengths
  down (root), mid upper arm and mid forearm. Measured at 14x the game scale:

| Body, side | Rest art | Reach (0.33) | Pluck (0.50) |
| --- | --- | --- | --- |
| plate, right | 72 / 73 / 89 / 95 | 79 / 75 / 92 / 95 | 73 / 75 / 92 / 94 |
| plate, left | 70 / 72 / 89 / 95 | 80 / 74 / 90 / 95 | 73 / 74 / 90 / 95 |
| shirt, right | 68 / 79 / 92 / 95 | 75 / 82 / 94 / 95 | 71 / 82 / 94 / 94 |
| shirt, left | 71 / 80 / 95 / 96 | 77 / 82 / 97 / 96 | 72 / 82 / 98 / 96 |
| bare, right | 64 / 72 / 86 / 90 | 69 / 73 / 86 / 90 | 65 / 75 / 87 / 91 |
| bare, left | 63 / 72 / 84 / 90 | 69 / 72 / 86 / 89 | 65 / 73 / 86 / 90 |

  The three 1 px lower forearm readings are resampling noise. The forearm is one rigid piece, so its
  cross-section cannot change. The approved programs read the same way: bare mine impact gives a mid
  upper arm of 85 against 86, and bare chop_hand impact a mid forearm of 92 against 90. An early key
  that turned the arm 1 degree inward (return at 16) read 3 px thin at the root, so it was moved to 19.

**Weak spots (honest):**

- **Small, quick motion at game zoom.** At 1x the reach and tug are readable, but the beat is mostly
  the arm snap plus the particle pop. The particles are small (1.6 units). Without the plant reacting,
  green leaves on grass are hard to see.
- **A rigid fist cannot pinch.** "Grab" is only a push-in and pause, so the closed fist reads as
  grabbing a handful, not as a fingertip pick.
- **Elbow crease at the pluck (52-58 bend):** the same inner-elbow overlap as the other programs
  shows a short notch on the plate knit sleeve and the shirt at 16x.
- **Torso seam outline:** while the arm is out, the existing seam outline shows along the torso edge
  (unchanged rig behaviour). At 16x it reads as a thin dark line beside the pauldron.
- **Not run in the live game.** The harness and the DEV preview use the real renderer and art.

## Target reactions (trees, plants, rocks)

On each impact, the worked collectible's map marker reacts on the same frame. The trigger is the
player renderer's `gatherImpactCount` changing in `pixiOverlay.updateRetainedPlayer`, and
`GatherTargetReactions.update` runs right after the players in the same frame. The code is in
`apps/client/src/map/gatherTargetReactions.ts`, tuned by `GATHER_REACTION_TUNING`.

- **Tree (chop, chop_hand):** sways away from the hit with a damped wobble: a 4.5 degree skew about
  the marker's ground point, 2.4 Hz, 850 ms. The base row never moves.
- **Plant (harvest):** a light, bouncy rustle: a 6 degree skew at 6 Hz plus a 6% squash, 460 ms.
- **Rock (mine, mine_hand):** no sway. A 2 px nudge away from the strike that rattles back
  (28 Hz, 140 ms), applied through the marker's pivot so the layer's position is untouched.

Only the struck marker is transformed, and it is restored exactly afterwards. The marker is looked
up each frame, because zoom rebuilds markers; a replaced one is reset. The local target comes from the
harvest task's node id. A remote target is resolved once per action from the snapshot's target
point (nearest collectible within about 2 m), so remote chop and mine react too. Remote harvesting
does not, because it is not broadcast. Nothing runs or allocates while no reaction is active.
Reduced motion gives no reaction: no impacts are counted under reduced motion, and the overlay also
checks it. Fishing and flag building have none. No art or player-renderer changes; the player
programs' pixel diff is still 0 of 3675 frames. Strips (before hit, impact, +50, +100, +250 ms,
settled; hit from each side) are in `.harvest-refs/results/reactions-{tree,plant,giving-tree,rock}.png`.

**Weak spots:** at 1x the tree sway is a few pixels at the top and the rock nudge is 2 px. Both
read, but they are subtle by design. The skew leans the sprite's whole frame, so roots drawn below
the anchor point move a hair the other way. Fruiting Giving Trees use the plant rustle for berry
picking and the tree shake for chopping.

## First-action glitch (fixed)

The owner reported that the first gathering action of a session glitched, and a Elder Fern
"flickered like a png glitch". It was reproduced in a cold-load headless harness and had two causes.

- **Player: a frozen frame, then a snap.** The first gather cut the arm textures. Each cut reads
  pixels back from a canvas, and that read stalls the GPU pipeline. In the harness the first frame
  took 125-175 ms (about 96 ms of it the body art); on a phone it is likely longer. The ease-in then
  jumped by the clamped 100 ms, so the arms and the weapon fade snapped about 70% in one frame.
  With a tool, the held tool's art also loaded lazily, so the first frames swung the arm with no
  tool and it popped in later. Fixes in `renderer.ts`:
  - The local player pre-cuts its arms in an idle callback once its appearance is in, and holds the
    cuts until the art changes. The first action then takes them from the cache (about 2 ms).
  - The cut cache shares one cut for both side orders. Each side is cut independently, so this is
    exact, and one pre-cut covers left and right.
  - The frame after a rig build eases by at most one frame (16.7 ms) instead of the stalled time.
  - While a held tool's art is loading, the action holds its current pose (rest at the start).
- **Elder Fern / Giving Tree marker: a stock-tree flash.** Taking the produce switches the tree's
  biome art (for example `elder-fern-*` to `elder-fern-*-tapped`). That file loaded only when first
  needed, so until it arrived the marker drew the stock fallback tree, `tree.png` or the Giving
  Tree art. That gave a few frames of a pine where the fern stood. This predates the animations.
  The overlay now loads the other produce state's art whenever a tree's art is requested
  (`biomeTreeArtOtherStateName`).
- **Checked, not a cause:** the target reaction's first trigger, the particle layer, and the
  marker's transform reset.
- **Proof:**
  - `.harvest-refs/results/first-action-{before,after}-{harvest,chop}.png` show the first ~300 ms on
    a real-time frame clock.
  - `first-action-{before,after}-elder-fern.png` show the marker swap with a 120 ms art fetch.
  - A steady-state pixel diff of every program, harvest included (full and reduced motion,
    plate/shirt/bare, both sides, plus rest art) found 4131 frames, 0 differ.
- **Remaining:** the pre-cut itself costs one hitch of the same size, but in idle time just after
  the appearance loads (game entry, or right after changing armour). Remote players are not
  pre-cut, so the first time you see an outfit gathering can still stall one frame. That frame now
  eases in instead of snapping. Making the cut itself cheap without any readback would change
  the piece crops by a pixel at the edges (tried: the pixel diff fails), so it was left as it is.
