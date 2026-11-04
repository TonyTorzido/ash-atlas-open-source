#!/usr/bin/env bash
# Five-anims: Jacket B on the three locked front clips (01 idle, 02 walk down-right R15, 03 walk down-left L15).
# Run from packages/animator AFTER bash scripts/views/five-anims-rigs.sh (it needs the refined rig/stock-front):
#   bash scripts/views/five-anims-jacketb-rigs.sh
# 1. stock_jacketb.py: the certified Jacket B (jacket-b/jacket/rig, its existing front art) dressed onto the refined
#    stock (black pants, brown silhouette ink, polished fists/feet, template walk, idle breath); tank hidden; jacket
#    silhouette ink in body brown (design review).
# 2. turnfront.py at 0 and 15 (the same transform as the stock clips; no new drawings).
# 3. turnfront_face.py: the same face combo A and flags as five-anims-rigs.sh (dash-h nose, blink, mirrored inputs).
set -euo pipefail
D=../../docs/plans/atlas-animator-demos
S=$D/views/turned-front/five-anims/rig
R=$D/views/turned-front/five-anims/jacketb/rig
python scripts/views/stock_jacketb.py $S/stock-front.anim.json $D/jacket-b/jacket/rig/template7-shoulder-legs-jacketb.anim.json $R stock-front-jacketb
python scripts/views/turnfront.py $R/stock-front-jacketb.anim.json $R front --angles 0,15
A="--eyes almond-calm --brows almond-calm --nose dash-h --mouth smile-line --hair soldier-crop-hair"
python scripts/views/turnfront_face.py $R/front-turn00.anim.json $R front-turn00-faceA --deg 0 $A --blink
python scripts/views/turnfront_face.py $R/front-turn15.anim.json $R front-turn15-faceA --deg 15 $A --blink
python scripts/views/turnfront_face.py $R/front-turn15.anim.json $R front-turn15-faceA-mirin --deg 15 $A --mirror-inputs --blink
