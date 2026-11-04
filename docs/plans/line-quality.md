# Line quality (leash circle, dashed view ring, zone/border lines)

Owner (iPhone, DPR 3, High): lines look thin and patchy since the perf/optimization work.

## Findings

- No line-specific simplification was missed. `overlayAntialias()` is on in High, overlay and map run at full DPR (e850fe2f5 reverted
  a96ea96a7, 141e080b7, 7b635fdec, 5d39e0e29 to Low mode), static-follow freeze only translates live Graphics (vector, never a cached
  texture), and walking shots stay crisp (`docs/plans/line-quality/*-walk-full.png`).
- What remained: the strokes were 0.75 CSS px (since 80831dff8, Aug 2026). They looked fine only while the soft DPR-capped canvas
  smeared them; crisp full-DPR rendering shows them as hairlines. The leash circle used a fixed 96 points, so a large on-screen radius
  (about 460 px) drew 30 px chords with visible corners; the view ring dashes (8 on / 7 off) were sparse. MapLibre dotted admin lines
  use `line-dasharray [2,2]` scaled by a 0.65-1.4 px width, i.e. 1.3 px dashes, sub-device-pixel patches at DPR 3.

## Fix

- `pixiOverlay.ts`: leash and view ring strokes 1.25 CSS px (view ring alpha 0.85); circle points adapt to the on-screen radius
  (chords of at most 6 px, 96 minimum, 1024 maximum); view ring dashes 9 on / 5 off.
- `worldOverlays.ts`: administrative dashed line widths 1.8 / 1.3 / 1.0; `createMap.ts` globe land outline 1.0.
- Low quality is untouched (still the cheaper canvas settings).

## Evidence

`docs/plans/line-quality/before-*.png` and `after-*.png`, 430x932 DPR 3, prod build, headless GPU, standing and walking
(`apps/client/full-app-tests/lineQuality.spec.ts`, needs `ASH_ATLAS_LINE_SHOTS=<dir>`).
