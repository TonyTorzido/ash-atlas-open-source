#!/usr/bin/env bash
# Turned-front round 2 rigs (docs/plans/atlas-animator-demos/views/turned-front/round2/README.md). Run from
# packages/animator: bash scripts/views/turnfront-round2-rigs.sh
# 1. turnfront.py (round 2: feet toe toward the facing side) on the bare legs body and the arm-layer legs body;
# 2. turnfront_face.py: face + hair on each (combo A, hair shifted and shifted+flipped);
# 3. the four face/hair combos on the bare body at 0/15/20 (rig/combos, not committed: rebuilt here).
# 4. round 2b (owner pick 2026-10-19): 15 deg, the face PROJECTED on the head surface at the body angle (default
#    --face-mode project), hair shifted as in round 2.
# 5. round 2c (owner 2026-10-19): the projection clamped so nothing widens, the hair shift from the same projection
#    (default --face-mode project-clamped).
set -euo pipefail
D=../../docs/plans/atlas-animator-demos
R=$D/views/turned-front/round2/rig
python scripts/views/turnfront.py $D/phase-4d4m/body/rig/template7-shoulder-legs.anim.json $R body --angles 0,15,20
python scripts/views/turnfront.py $D/attacks/sword-chop/body/rig/template7-armlayer-legs.anim.json $R armlayer --angles 0,15,20
A="--eyes almond-calm --brows almond-calm --nose button --mouth smile-line --hair soldier-crop-hair"
COMBOS=(
  "A|$A"
  "B|--eyes large-round --brows large-round --nose soft-round --mouth smile-open --hair modern-layer-bob-hair"
  "C|--eyes determined --brows determined --nose wedge --mouth gritted --hair spikey-hair"
  "D|--eyes dot-simple --brows dot-simple --nose dash --mouth cat --hair page-cut-hair"
)
for d in 00 15 20; do
  for m in shift flip; do
    python scripts/views/turnfront_face.py $R/body-turn$d.anim.json $R body-turn$d-face-$m --deg $d $A --hair-mode $m --face-mode slide
    python scripts/views/turnfront_face.py $R/armlayer-turn$d.anim.json $R armlayer-turn$d-face-$m --deg $d $A --hair-mode $m --face-mode slide
  done
  for c in "${COMBOS[@]}"; do
    for m in shift flip; do
      python scripts/views/turnfront_face.py $R/body-turn$d.anim.json $R/combos combo${c%%|*}-turn$d-$m --deg $d ${c#*|} --hair-mode $m --face-mode slide
    done
  done
done
python scripts/views/turnfront_face.py $R/body-turn15.anim.json $R body-turn15-faceproj-shift --deg 15 $A --hair-mode shift --face-mode project
for c in "${COMBOS[@]}"; do
  python scripts/views/turnfront_face.py $R/body-turn15.anim.json $R/combos combo${c%%|*}-turn15-proj-shift --deg 15 ${c#*|} --hair-mode shift --face-mode project
done
python scripts/views/turnfront_face.py $R/body-turn15.anim.json $R body-turn15-face2c-shift --deg 15 $A --hair-mode shift
for c in "${COMBOS[@]}"; do
  python scripts/views/turnfront_face.py $R/body-turn15.anim.json $R/combos combo${c%%|*}-turn15-p2c-shift --deg 15 ${c#*|} --hair-mode shift
done
