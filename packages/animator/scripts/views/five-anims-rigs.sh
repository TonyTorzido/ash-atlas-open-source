#!/usr/bin/env bash
# Five stock-body animations: rigs (docs/plans/atlas-animator-demos/views/turned-front/five-anims/five-anims-PLAN.md).
# Run from packages/animator: bash scripts/views/five-anims-rigs.sh
# 1. stock_pants.py (refine P1): the FRONT stock body = the certified black pants rig (pants/black/rig, brought over
#    from feature/atlas-animator-pants--from-t1511 e558f2a22) with silhouette garment ink in body brown (owner D2).
#    stock_shorts.py: the BACK stock body keeps the charcoal shorts stand-in (clips 04/05 are parked).
#    polish_extremities.py (refine P5 item 4): fists and feet lose the flat pale highlight stickers and ink specks
#    (colour only, inside the existing alpha; report in rig/stock-front.extremities.json).
# 1a. refine_clips.py apply (refine P2, owner D1): the front walk_in_place = the template light-step walk (flat, 28 f)
#    with the stronger front arm read (fixtures/clips/walk-front-chibi-stock.json); the back keeps the legacy walk.
#    refine_clips.py idle (refine P3): idle_weight_shift = one breath per loop + a lagged head settle.
#    turnfront_face.py --blink (refine P3): face_blink_half / face_blink_closed on the face slot + the idle blink keys.
# 1b. back_drawn.py rig (round 2): the DRAWN back body (views/body-back-drawn) pasted into a copy of stock-back
#    -> stock-back-drawn (stock-back is kept for the before/after).
# 2. turnfront.py: front at 0 and 15; back (the drawn body) at 0 and 15 with --back-feet toe (owner, round 2: the foot
#    extends toward the facing side) + the feet strip (heel = round 1 default, 0 = no shear; toe = the clips).
# 3. turnfront_face.py: face combo A (nose dash-tick, a procedural dash; owner picks among dash-v / dash-tick / dash-h / none), face mode 2c. front 0 (idle), front L15, front L15 with mirrored inputs (the
#    walk down-right clip is an image flip of its render).
# 4. turnback_hair.py: the DRAWN back hair (--style drawn, default) at 0 and 15, back L15 with mirrored inputs (walk
#    up-right); plus, for the before/after sheets, round 1's generated fill hair on the drawn body (before/*-hair-fill)
#    and round 1's whole back (old body + fill hair, toe feet) at 0 / 15 (before/back-old-turn*-hair).
set -euo pipefail
D=../../docs/plans/atlas-animator-demos
R=$D/views/turned-front/five-anims/rig
python scripts/views/stock_pants.py $D/pants/black/rig/template7-shoulder-legs-pants.anim.json $R stock-front
python scripts/views/polish_extremities.py $R/stock-front.anim.json
python scripts/views/refine_clips.py apply $R/stock-front.anim.json fixtures/clips/walk-front-chibi-stock.walk_in_place.json
python scripts/views/refine_clips.py idle $R/stock-front.anim.json
python scripts/views/stock_shorts.py $D/views/body-back/rig/template7-shoulder-legs-back.anim.json $R stock-back
python scripts/views/turnfront.py $R/stock-front.anim.json $R front --angles 0,15
python scripts/views/back_drawn.py rig $R/stock-back.anim.json $R stock-back-drawn
python scripts/views/turnfront.py $R/stock-back-drawn.anim.json $R back --angles 0,15 --back --back-feet toe
python scripts/views/turnfront.py $R/stock-back-drawn.anim.json $R/feet back-heel --angles 15 --back --back-feet heel
python scripts/views/turnfront.py $R/stock-back-drawn.anim.json $R/feet back-flat --angles 15 --back --feet 0
python scripts/views/turnfront.py $R/stock-back.anim.json $R/before back-old --angles 0,15 --back --back-feet toe
A="--eyes almond-calm --brows almond-calm --nose dash-h --mouth smile-line --hair soldier-crop-hair"
python scripts/views/turnfront_face.py $R/front-turn00.anim.json $R front-turn00-faceA --deg 0 $A --blink
python scripts/views/turnfront_face.py $R/front-turn15.anim.json $R front-turn15-faceA --deg 15 $A --blink
python scripts/views/turnfront_face.py $R/front-turn15.anim.json $R front-turn15-faceA-mirin --deg 15 $A --mirror-inputs --blink
python scripts/views/turnback_hair.py $R/back-turn00.anim.json $R back-turn00-hair --deg 0
python scripts/views/turnback_hair.py $R/back-turn15.anim.json $R back-turn15-hair --deg 15
python scripts/views/turnback_hair.py $R/back-turn15.anim.json $R back-turn15-hair-mirin --deg 15 --mirror-inputs
for d in 00 15; do
  python scripts/views/turnback_hair.py $R/back-turn$d.anim.json $R/before back-turn$d-hair-fill --deg $d --style fill
  python scripts/views/turnback_hair.py $R/before/back-old-turn$d.anim.json $R/before back-old-turn$d-hair --deg $d --style fill
done
for f in heel flat; do
  python scripts/views/turnback_hair.py $R/feet/back-$f-turn15.anim.json $R/feet back-$f-turn15-hair --deg 15
done
