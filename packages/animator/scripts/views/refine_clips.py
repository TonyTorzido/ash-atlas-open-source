# Atlas Animator five-anims refine: the locked clips use the
# default template light-step walk instead of legsBody's legacy 30 f walk_in_place ("stomping"). The arm read is raised for the front view in
# fixtures/clips/walk-front-chibi-stock.json (elbow 4 -> 8, hand 2 -> 4; refine P6: arm 3 deg, elbow 7, hand 4; refine P5 was: shoulder swing arm 2 -> 5 deg,
# elbow 8 -> 12, hand 4 -> 6, since +-2 deg barely read at view 0.4); lift and bob are as the user saw them.
#
# legsBody takes ~8 min, so the generated clip is extracted once and committed; the rig build only transplants it:
#   1. npx tsx src/cli/legsBody.ts ../../docs/plans/atlas-animator-demos/phase-4d4m/leg/rig \
#        fixtures/canonical/template7-leg.preset.json \
#        ../../docs/plans/atlas-animator-demos/phase-4d4m/upper/rig/template7-shoulder-body.anim.json \
#        fixtures/canonical/template7-shoulder.preset.json <scratch dir> --no-render --walk fixtures/clips/walk-front-chibi-stock.json
#   2. python scripts/views/refine_clips.py extract <scratch dir>/rig/template7-shoulder-legs.anim.json fixtures/clips/walk-front-chibi-stock.walk_in_place.json
#   3. (five-anims-rigs.sh) python scripts/views/refine_clips.py apply <rig.anim.json> fixtures/clips/walk-front-chibi-stock.walk_in_place.json
#   4. (five-anims-rigs.sh, refine P3) python scripts/views/refine_clips.py idle <rig.anim.json>
# `idle` rewrites idle_weight_shift's breath and adds a head settle (REFINE-PLAN item 3): one breath per loop (it was
# two), chest scale along the spine 1 -> 1 + BREATH_SPINE and across 1 -> 1 + BREATH_WIDTH on 0.5 - 0.5 cos(2 pi t / T),
# peaking at mid-loop (t = T / 2, the pelvis passing the centre of its shift); the neck and clavicles are noScale, so the
# head and shoulders rise by the spine scale x their offsets (~5.7 / ~5.5 canvas px, ~2.3 px at view 0.4); and the head
# rotates with the chest's own sway at half its amplitude (+-1 deg) lagging it by HEAD_LAG frames. The blink is a slot
# attachment timeline added by turnfront_face.py --blink (the face slot only exists on the face rigs).
# `apply` replaces animations.walk_in_place in place, after checking the bones and ik match the source the clip was
# generated on (same skeleton; turnfront.py never touches animations, so the turned rigs inherit the walk).
import argparse
import hashlib
import json
import math
from pathlib import Path

BREATH_SPINE, BREATH_WIDTH = 0.022, 0.015
HEAD_GAIN, HEAD_LAG = 0.5, 4  # head rotate = HEAD_GAIN x chest rotate (HEAD_LAG frames earlier)


def idle(doc) -> dict:
    a = doc["animations"]["idle_weight_shift"]
    T, fps = a["duration"], a.get("fps", 30)
    n = round(T * fps)
    times = [round(i / fps, 5) for i in range(n + 1)]
    breath = [0.5 - 0.5 * math.cos(2 * math.pi * i / n) for i in range(n + 1)]
    ch = a["bones"]["chest"]
    ch["scale"] = [{"time": t, "x": round(1 + BREATH_SPINE * b, 5), "y": round(1 + BREATH_WIDTH * b, 5)} for t, b in zip(times, breath)]
    rot = {round(k["time"] * fps): k["value"] for k in ch["rotate"]}
    assert sorted(rot) == list(range(n + 1)), "chest rotate must be keyed every frame"
    a["bones"].setdefault("head", {})["rotate"] = [
        {"time": t, "value": round(HEAD_GAIN * rot[(i - HEAD_LAG) % n], 4)} for i, t in enumerate(times)]
    return {"frames": n, "breathPeakFrame": n // 2, "spine": BREATH_SPINE, "width": BREATH_WIDTH, "headGain": HEAD_GAIN, "headLag": HEAD_LAG}


def h(o) -> str:
    return hashlib.sha256(json.dumps(o, sort_keys=True).encode()).hexdigest()[:16]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("verb", choices=("extract", "apply", "idle"))
    ap.add_argument("rig")
    ap.add_argument("clip", nargs="?")
    a = ap.parse_args()
    rig = Path(a.rig)
    doc = json.loads(rig.read_text(encoding="utf-8"))
    if a.verb == "idle":
        info = idle(doc)
        rig.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
        print(rig.name, "idle_weight_shift <- one breath + head settle", json.dumps(info))
        return
    if a.verb == "extract":
        walk = doc["animations"]["walk_in_place"]
        out = {"source": "legsBody --walk fixtures/clips/walk-front-chibi-stock.json (flat, depthScale 0)",
               "bonesHash": h(doc["bones"]), "ikHash": h(doc["ik"]), "walk_in_place": walk}
        Path(a.clip).write_text(json.dumps(out, separators=(",", ":")) + "\n", encoding="utf-8")
        print("extracted walk_in_place", walk["duration"], "s,", len(walk["bones"]), "bones")
        return
    clip = json.loads(Path(a.clip).read_text(encoding="utf-8"))
    assert h(doc["bones"]) == clip["bonesHash"], "skeleton differs from the clip's source"
    assert h(doc["ik"]) == clip["ikHash"], "ik differs from the clip's source"
    doc["animations"]["walk_in_place"] = clip["walk_in_place"]
    rig.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    print(rig.name, "walk_in_place <- template light-step walk", clip["walk_in_place"]["duration"], "s")


if __name__ == "__main__":
    main()
