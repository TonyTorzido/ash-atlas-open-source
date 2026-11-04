#!/usr/bin/env bash
set -euo pipefail

test_root=$(mktemp -d /tmp/ash-atlas-client-asset-retention.XXXXXXXX)
trap 'rm -rf --one-file-system "$test_root"' EXIT
script_root=$(cd "$(dirname "$0")" && pwd)

export ASH_ATLAS_DEPLOY_MODE=activate
export ASH_ATLAS_DEPLOY_UPDATE_SOURCE_ONLY=true
export ASH_ATLAS_CLIENT_RELEASE_ROOT="$test_root/releases"
export ASH_ATLAS_CLIENT_CURRENT_LINK="$test_root/current"
export ASH_ATLAS_OPERATION_ROOT="$test_root/operations"
export ASH_ATLAS_NODE_BIN=${ASH_ATLAS_NODE_BIN:-$(command -v node)}
mkdir -p "$ASH_ATLAS_CLIENT_RELEASE_ROOT" "$ASH_ATLAS_OPERATION_ROOT"
# shellcheck source=deploy-test-update.sh
source "$script_root/deploy-test-update.sh"

current=1111111111111111111111111111111111111111
current_root="$ASH_ATLAS_CLIENT_RELEASE_ROOT/$current"
mkdir -p "$current_root/assets/dungeons/shared"
printf 'old-hash\n' > "$current_root/assets/main-ABCDEFGH.js"
printf 'old-public-png\n' > "$current_root/assets/dungeons/shared/orc-cave-entrance.png"
printf '%s\n' '{"schema_version":1,"assets":[{"path":"assets/main-ABCDEFGH.js","retention":3},{"path":"assets/dungeons/shared/orc-cave-entrance.png","retention":3}]}' \
  > "$current_root/.ash-atlas-client-assets.json"
ln -s "$current_root" "$ASH_ATLAS_CLIENT_CURRENT_LINK"

candidate="$test_root/candidate"
mkdir -p "$candidate/assets/dungeons/shared"
printf 'new-hash\n' > "$candidate/assets/main-ZZZZZZZZ.js"
printf 'optimized-public-png\n' > "$candidate/assets/dungeons/shared/orc-cave-entrance.png"
seed_client_asset_retention_from_destination "$candidate"
copy_previous_hashed_client_assets "$candidate" >/dev/null
write_client_asset_manifest "$candidate"
prune_client_assets_to_manifest "$candidate"
[[ $(<"$candidate/assets/dungeons/shared/orc-cave-entrance.png") = optimized-public-png ]]
[[ $(<"$current_root/assets/dungeons/shared/orc-cave-entrance.png") = old-public-png ]]
[[ -f "$candidate/assets/main-ABCDEFGH.js" ]]
[[ -f "$candidate/assets/main-ZZZZZZZZ.js" ]]
! grep -Fq 'orc-cave-entrance.png' "$candidate/.ash-atlas-client-assets.json"

fallback="$test_root/fallback"
mkdir -p "$fallback/assets/dungeons/shared"
printf 'old-hash\n' > "$fallback/assets/main-ABCDEFGH.js"
printf 'old-public-png\n' > "$fallback/assets/dungeons/shared/orc-cave-entrance.png"
[[ $(client_asset_manifest_entries "$fallback") = $'assets/main-ABCDEFGH.js\t3' ]]

collision="$test_root/collision"
mkdir -p "$collision/assets"
printf 'different-bytes\n' > "$collision/assets/main-ABCDEFGH.js"
if (copy_previous_hashed_client_assets "$collision" >"$test_root/collision.out" 2>&1); then
  printf 'same-name generated hashed assets must not be overwritten\n' >&2
  exit 1
fi
grep -Fq 'hashed public asset collision differs: assets/main-ABCDEFGH.js' "$test_root/collision.out"
[[ $(<"$current_root/assets/main-ABCDEFGH.js") = old-hash ]]
[[ $(<"$collision/assets/main-ABCDEFGH.js") = different-bytes ]]

grep -Fq '^/play/assets/[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$' \
  "$script_root/game-cache-policy.caddy"
grep -Fq '^/play/assets/[^/]+/.+$' "$script_root/game-cache-policy.caddy"
grep -Fq 'header @ashAtlasPlayMutableNestedAsset Cache-Control "no-cache, max-age=0, must-revalidate"' \
  "$script_root/game-cache-policy.caddy"
printf 'client-asset-retention.tests.sh: passed\n'
