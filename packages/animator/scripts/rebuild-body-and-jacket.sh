#!/bin/sh
# Atlas Animator, /: rebuilds the whole body (phase-4d4m/body) and the kung-fu
# jacket on it (phase-4d4n/jacket) from the committed inputs. Run from anywhere:
#   sh packages/animator/scripts/rebuild-body-and-jacket.sh [--body-only|--jacket-only|--jacket-b-only|--shortcuff-only|--long-hem-only|--shirt-only|--leather-only] [--no-render]
# --long-hem-only: the longer-hem variant, the same
# domain and art with the hem moved LONG_HEM canvas px (default 24) down the body (--lengthen-hem).
# Inputs (committed): the leg half rig (phase-4d4m/leg/rig, preset fixtures/canonical/template7-leg),
# the merged upper body (phase-4d4m/upper/rig/template7-shoulder-body, preset template7-shoulder).
# Art (outside the repo, ART_DROPS, default C:/Users/dev/Documents/art-drops): the jacket
# art and the template7-clean body art (rest composite and source margin checks).
# Reconstructed 2026-10-15: the body step reproduces the committed body rig byte for byte
# (anim, bare anim, atlas json and png) with the code before the bare-skin bake change. The
# committed body was built WITHOUT `--walk`, so the walk_in_place it carries is legsBody's LEGACY 30 f walk (the
# one called "stomping"), not the template walk; `--walk fixtures/clips/walk-front-chibi.json` adds
# walk_flat / walk_v1 and replaces walk_in_place (five-anims refine: scripts/views/refine_clips.py).
# --stock-only [--stock-item <leather|cloth|chainmail|breastplate>]: the 4 stock armours on the simple template
# into docs/plans/atlas-animator-demos/stock-armour/<item>: domains fixtures/garments/stock-<item>.domain.json,
# art ART_DROPS/swag-stock-<item>-01/final/garment.png (the certified art; leather = the jerkin art).
# --medium-only: the medium-template padded gambeson into docs/plans/atlas-animator-demos/medium-template/gambeson:
# domain fixtures/garments/medium-gambeson.domain.json, art ART_DROPS/swag-medium-gambeson-01/final/garment.png.
# --clean-only: the cleaned standard jacket into docs/plans/atlas-animator-demos/jacket-clean/jacket: the default
# long-cuff domain, art ART_DROPS/swag-kungfu-01/v4-clean/kungfu-jacket-a-clean.png written by scripts/kungfu-clean.py.
# --premium-only: the premium Dragon Silk Jacket (ARCHIVED: preferred the standard jacket) into docs/plans/atlas-animator-demos/premium-jacket/dragon-silk:
# domain fixtures/garments/kungfu-jacket.domain.json (unchanged), art ART_DROPS/swag-premium-dragon-silk-02/final/garment.png.
# --chinese-only [--chinese-item <wrap|jade-guard|mirror-plate>]: the Chinese swag set into
# docs/plans/atlas-animator-demos/chinese-set/<item>: domains fixtures/garments/chinese-<item>.domain.json (wrap = simple,
# long cuff; jade-guard and mirror-plate = medium), art ART_DROPS/swag-chinese-01/<item>/final/garment.png (the certified
# art after scripts/polish-seam-ink.py polish).
# --chinese-only --chinese-v2 [--chinese-item <...>]: the chosen concepts (wrap = Wrap C Jade-Trim Ronin,
# jade-guard = Jade C Mail Mantle Coat, mirror-plate = Mirror B Great Mirror) into docs/plans/atlas-animator-demos/
# chinese-set-v2/<item>, same domains, art ART_DROPS/swag-chinese-concepts-01/<concept>/final/garment.png (the concept's
# gen-2 after that folder's tools/polish.py: registration, waist fit, plain flank strip, skin-safe highlights).
# --jacket-b-only: the chosen Jacket B "tonal cloud brocade" (swag-kungfu-02 kf-B, drawn on the simple
# template, polished by that folder's tools/polish_kf.py, cuffs extended by scripts/swag/extend-cuffs.py) into
# docs/plans/atlas-animator-demos/jacket-b/jacket: domain fixtures/garments/kungfu-jacket.domain.json, art ART_DROPS/swag-kungfu-02/kf-B/final/garment.png.
# --leather-only: the leather jerkin (swag-leather-cuirass-05 try-1 art with the interior arm/torso seam ink repainted, polish/garment.png + scripts/polish-seam-ink.py, domain fixtures/garments/stock-leather.domain.json = the test-shirt template)
# into phase-4d4n/leather-armor-r14 (the capCut caps, tools/garmentCaps.ts, are abandoned).
# Jacket default = LONG CUFFS (approved 2026-10-16: the longer cuffs down to the edge of the wrist): domain
# fixtures/garments/kungfu-jacket.domain.json (written by scripts/kungfu-longcuff.ts from the short-cuff jacket: cuffs
# moved down the forearm to just above the fist) and, since approved the cleaned jacket (2026-10-16), art
# swag-kungfu-01/v4-clean (scripts/kungfu-clean.py from v3-longcuff, which is kept).
# --shortcuff-only: the former default, short cuffs (fixtures/garments/kungfu-jacket-shortcuff.domain.json, v3 art)
# into phase-4d4n/jacket-shortcuff. --longcuff-only is kept as an alias of --jacket-only.
# Jacket (construction pass 1): the body-derived surface of the committed domain
# fixtures/garments/kungfu-jacket-shortcuff.domain.json (recorded from the v3 art with --derive-domain, cut details
# with --derive-details), painted with the art (pass 2; --flat for flat fabric).
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)
cd "$HERE"
D=../../docs/plans/atlas-animator-demos
ART_DROPS=${ART_DROPS:-C:/Users/dev/Documents/art-drops}
MODE=all
RENDER=""
for a in "$@"; do
  case "$a" in
    --body-only) MODE=body ;;
    --jacket-only) MODE=jacket ;;
    --long-hem-only) MODE=long ;;
    --shirt-only) MODE=shirt ;;
    --leather-only) MODE=leather ;;
    --longcuff-only) MODE=jacket ;;
    --shortcuff-only) MODE=shortcuff ;;
    --stock-only) MODE=stock ;;
    --medium-only) MODE=medium ;;
    --premium-only) MODE=premium ;;
    --clean-only) MODE=clean ;;
    --jacket-b-only) MODE=jacketb ;;
    --chinese-only) MODE=chinese ;;
    --chinese-v2) CHINESE_V2=1 ;;
    --no-render) RENDER="--no-render" ;;
  esac
done
STOCK_ITEMS="leather cloth chainmail breastplate"
CHINESE_ITEMS="wrap jade-guard mirror-plate"
prev=""
for a in "$@"; do [ "$prev" = "--stock-item" ] && STOCK_ITEMS="$a"; [ "$prev" = "--chinese-item" ] && CHINESE_ITEMS="$a"; prev="$a"; done
if [ "$MODE" = all ] || [ "$MODE" = body ]; then
  npx tsx src/cli/legsBody.ts "$D/phase-4d4m/leg/rig" fixtures/canonical/template7-leg.preset.json \
    "$D/phase-4d4m/upper/rig/template7-shoulder-body.anim.json" fixtures/canonical/template7-shoulder.preset.json \
    "$D/phase-4d4m/body" $RENDER
fi
if [ "$MODE" = all ] || [ "$MODE" = jacket ]; then
  npx tsx src/cli/garmentImport.ts "$D/phase-4d4m/body/rig/template7-shoulder-legs.anim.json" \
    "$ART_DROPS/swag-kungfu-01/v4-clean/kungfu-jacket-a-clean.png" "$D/phase-4d4n/jacket" --hides tank --domain fixtures/garments/kungfu-jacket.domain.json \
    --base "$ART_DROPS/player-smooth-01/final/bodies/template7-clean.png" $RENDER
fi
if [ "$MODE" = all ] || [ "$MODE" = long ]; then
  npx tsx src/cli/garmentImport.ts "$D/phase-4d4m/body/rig/template7-shoulder-legs.anim.json"     "$ART_DROPS/swag-kungfu-01/v3/output/kungfu-jacket-a.png" "$D/phase-4d4n/jacket-long" --hides tank --domain fixtures/garments/kungfu-jacket-shortcuff.domain.json     --base "$ART_DROPS/player-smooth-01/final/bodies/template7-clean.png" --lengthen-hem "${LONG_HEM:-24}" $RENDER
fi
if [ "$MODE" = all ] || [ "$MODE" = shirt ]; then
  # the test shirt (swag-rules-test-01/try-1, drawn on the kung-fu guide) with its own domain file
  npx tsx src/cli/garmentImport.ts "$D/phase-4d4m/body/rig/template7-shoulder-legs.anim.json"     "$ART_DROPS/swag-rules-test-01/try-1/output/garment.png" "$D/swag-shirt-test" --name shirt --hides tank --domain fixtures/garments/test-shirt.domain.json     --base "$ART_DROPS/player-smooth-01/final/bodies/template7-clean.png" $RENDER
fi
if [ "$MODE" = all ] || [ "$MODE" = leather ]; then
  npx tsx src/cli/garmentImport.ts "$D/phase-4d4m/body/rig/template7-shoulder-legs.anim.json" "$ART_DROPS/swag-leather-cuirass-05/polish/garment.png" "$D/phase-4d4n/leather-armor-r14" --name leather --hides tank,tank_armhole,tank_armhole_r --domain fixtures/garments/stock-leather.domain.json --base "$ART_DROPS/player-smooth-01/final/bodies/template7-clean.png" $RENDER
fi
if [ "$MODE" = all ] || [ "$MODE" = shortcuff ]; then
  npx tsx src/cli/garmentImport.ts "$D/phase-4d4m/body/rig/template7-shoulder-legs.anim.json" "$ART_DROPS/swag-kungfu-01/v3/output/kungfu-jacket-a.png" "$D/phase-4d4n/jacket-shortcuff" --hides tank --domain fixtures/garments/kungfu-jacket-shortcuff.domain.json --base "$ART_DROPS/player-smooth-01/final/bodies/template7-clean.png" $RENDER
fi
if [ "$MODE" = stock ]; then
  for it in $STOCK_ITEMS; do
    art="$ART_DROPS/swag-stock-$it-01/final/garment.png"
    [ "$it" = leather ] && art="$ART_DROPS/swag-leather-cuirass-05/polish/garment.png"
    npx tsx src/cli/garmentImport.ts "$D/phase-4d4m/body/rig/template7-shoulder-legs.anim.json" "$art" "$D/stock-armour/$it" --name "$it" --hides tank,tank_armhole,tank_armhole_r --domain "fixtures/garments/stock-$it.domain.json" --base "$ART_DROPS/player-smooth-01/final/bodies/template7-clean.png" $RENDER
  done
fi
if [ "$MODE" = clean ]; then
  #: the long-cuff jacket, domain unchanged, art v4-clean
  # (scripts/kungfu-clean.py: placket up to the collar band, fold streaks removed; v3-longcuff kept)
  npx tsx src/cli/garmentImport.ts "$D/phase-4d4m/body/rig/template7-shoulder-legs.anim.json" "$ART_DROPS/swag-kungfu-01/v4-clean/kungfu-jacket-a-clean.png" "$D/jacket-clean/jacket" --hides tank --domain fixtures/garments/kungfu-jacket.domain.json --base "$ART_DROPS/player-smooth-01/final/bodies/template7-clean.png" $RENDER
fi
if [ "$MODE" = jacketb ]; then
  npx tsx src/cli/garmentImport.ts "$D/phase-4d4m/body/rig/template7-shoulder-legs.anim.json" "$ART_DROPS/swag-kungfu-02/kf-B/final/garment.png" "$D/jacket-b/jacket" --name jacketb --hides tank,tank_armhole,tank_armhole_r --domain fixtures/garments/kungfu-jacket.domain.json --base "$ART_DROPS/player-smooth-01/final/bodies/template7-clean.png" $RENDER
fi
if [ "$MODE" = premium ]; then
  #: the premium Dragon Silk Jacket = the long-cuff jacket domain unchanged, premium art only
  npx tsx src/cli/garmentImport.ts "$D/phase-4d4m/body/rig/template7-shoulder-legs.anim.json" "$ART_DROPS/swag-premium-dragon-silk-02/final/garment.png" "$D/premium-jacket/dragon-silk" --name dragonsilk --hides tank --domain fixtures/garments/kungfu-jacket.domain.json --base "$ART_DROPS/player-smooth-01/final/bodies/template7-clean.png" $RENDER
fi
if [ "$MODE" = medium ]; then
  npx tsx src/cli/garmentImport.ts "$D/phase-4d4m/body/rig/template7-shoulder-legs.anim.json" "$ART_DROPS/swag-medium-gambeson-01/final/garment.png" "$D/medium-template/gambeson" --name gambeson --hides tank,tank_armhole,tank_armhole_r --domain fixtures/garments/medium-gambeson.domain.json --base "$ART_DROPS/player-smooth-01/final/bodies/template7-clean.png" $RENDER
fi
if [ "$MODE" = chinese ]; then
  for it in $CHINESE_ITEMS; do
    art="$ART_DROPS/swag-chinese-01/$it/final/garment.png"; out="$D/chinese-set/$it"
    if [ -n "$CHINESE_V2" ]; then
      case "$it" in wrap) c=wrap-C ;; jade-guard) c=jade-C ;; mirror-plate) c=mirror-B ;; esac
      art="$ART_DROPS/swag-chinese-concepts-01/$c/final/garment.png"; out="$D/chinese-set-v2/$it"
    fi
    npx tsx src/cli/garmentImport.ts "$D/phase-4d4m/body/rig/template7-shoulder-legs.anim.json" "$art" "$out" --name "$(echo "$it" | tr -d -)" --hides tank,tank_armhole,tank_armhole_r --domain "fixtures/garments/chinese-$it.domain.json" --base "$ART_DROPS/player-smooth-01/final/bodies/template7-clean.png" $RENDER
  done
fi
