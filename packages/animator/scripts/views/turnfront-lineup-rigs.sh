#!/usr/bin/env bash
# Lineup rigs (docs/plans/atlas-animator-demos/views/turned-front/lineup/README.md). Run from packages/animator:
#   bash scripts/views/turnfront-lineup-rigs.sh
# 1. Jacket B front at 0 and 15 (turnfront.py, round 2 feet) + face combo A (turnfront_face.py, round 2c default:
#    projected, clamped, hair shift from the projection).
# 2. BACK at 0 and 15 (turnfront.py --back: the back surface turns the other way, the spine line shifts away from the
#    facing side, the screen-right side is far) for Jacket B's back and the bare back body, + the stand-in back hair
#    (turnback_hair.py: soldier crop mirrored over a cel cap, shifted per the same projection).
set -euo pipefail
D=../../docs/plans/atlas-animator-demos
L=$D/views/turned-front/lineup/rig
python scripts/views/turnfront.py $D/jacket-b/jacket/rig/template7-shoulder-legs-jacketb.anim.json $L jacketb --angles 0,15
python scripts/views/turnfront.py $D/views/jacket-b/back/rig/template7-shoulder-legs-back-jacketb.anim.json $L jacketb-back --angles 0,15 --back
python scripts/views/turnfront.py $D/views/body-back/rig/template7-shoulder-legs-back.anim.json $L body-back --angles 0,15 --back
for d in 00 15; do
  python scripts/views/turnfront_face.py $L/jacketb-turn$d.anim.json $L jacketb-turn$d-faceA --deg $d
  python scripts/views/turnback_hair.py $L/jacketb-back-turn$d.anim.json $L jacketb-back-turn$d-hairA --deg $d
  python scripts/views/turnback_hair.py $L/body-back-turn$d.anim.json $L body-back-turn$d-hairA --deg $d
done
