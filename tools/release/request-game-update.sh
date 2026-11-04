#!/usr/bin/env bash
set -euo pipefail

# Mac request surface for the server/web-only Game Update action. Credentials
# and protected deployment state remain in the private control repository.
control_repository="${ASH_ATLAS_GAME_UPDATE_CONTROL_REPOSITORY:-${ASH_ATLAS_COORDINATED_CONTROL_REPOSITORY:-}}"
control_workflow="${ASH_ATLAS_GAME_UPDATE_CONTROL_WORKFLOW:-game-update-control.yml}"
source_remote="${ASH_ATLAS_GAME_UPDATE_SOURCE_REMOTE:-${ASH_ATLAS_COORDINATED_SOURCE_REMOTE:-}}"
action="${1:-start}"
operation_id="${2:-}"

case "$action" in
  start)
    [[ $# -le 1 ]] || { echo "ACTION_REQUIRED: start does not accept an operation ID" >&2; exit 2; }
    ;;
  inspect|resume)
    [[ $# -eq 2 ]] || { echo "ACTION_REQUIRED: inspect/resume requires one operation ID" >&2; exit 2; }
    [[ "$operation_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$ ]] || {
      echo "ACTION_REQUIRED: operation ID is not in the accepted format" >&2; exit 2;
    }
    ;;
  *)
    echo "ACTION_REQUIRED: action must be start, inspect, or resume" >&2
    exit 2
    ;;
esac

if [[ -z "$control_repository" ]]; then
  echo "ACTION_REQUIRED: set ASH_ATLAS_GAME_UPDATE_CONTROL_REPOSITORY to the provisioned private control repository" >&2
  exit 2
fi
if [[ ! "$control_repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "ACTION_REQUIRED: private control repository must use OWNER/REPOSITORY form" >&2
  exit 2
fi
if [[ -z "$source_remote" ]]; then
  source_remote="$(git remote get-url origin 2>/dev/null || true)"
fi
if [[ -z "$source_remote" ]]; then
  source_repository="${ASH_ATLAS_COORDINATED_SOURCE_REPOSITORY:-example-org/game}"
  source_remote="https://github.com/${source_repository}.git"
fi
command -v gh >/dev/null 2>&1 || {
  echo "ACTION_REQUIRED: GitHub CLI (gh) is required for the Mac request surface" >&2
  exit 2
}

arguments=(workflow run "$control_workflow" --repo "$control_repository" --ref main -f "action=$action")
if [[ "$action" == start ]]; then
  remote_refs="$(git ls-remote "$source_remote" refs/heads/integration/test 'refs/tags/test/t*' 2>&1)" || {
    echo "ACTION_REQUIRED: could not resolve the remote integration/test candidate from $source_remote" >&2
    exit 2
  }
  candidate_sha="$(printf '%s\n' "$remote_refs" |
    awk '$2 == "refs/heads/integration/test" { print tolower($1) }' | sort -u)"
  if [[ ! "$candidate_sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "ACTION_REQUIRED: remote integration/test did not resolve to one canonical 40-character SHA" >&2
    exit 2
  fi

  candidate_generation_tags=()
  while IFS= read -r generation_tag; do
    [[ -n "$generation_tag" ]] && candidate_generation_tags+=("$generation_tag")
  done < <(
    printf '%s\n' "$remote_refs" |
      awk -v target="$candidate_sha" '
        {
          sha = tolower($1)
          ref = $2
          sub(/\^\{\}$/, "", ref)
          if (sha == target && ref ~ /^refs\/tags\/test\/t[0-9]{3,4}$/) {
            sub(/^refs\/tags\//, "", ref)
            print ref
          }
        }
      ' | sort -u
  )
  if ((${#candidate_generation_tags[@]} != 1)); then
    echo "ACTION_REQUIRED: remote integration/test must match exactly one generation tag; found: ${candidate_generation_tags[*]:-(none)}" >&2
    exit 2
  fi

  candidate_generation_tag="${candidate_generation_tags[0]}"
  printf 'Game Update candidate: %s@%s\n' "$candidate_generation_tag" "$candidate_sha"
  printf 'This publishes the accepted server/web update.\n'
  read -r -p 'Start the displayed Game Update? [y/N] ' confirmation
  case "$confirmation" in
    y|Y|yes|YES) ;;
    *)
      echo "Game Update request cancelled."
      exit 1
    ;;
  esac
  arguments+=(
    -f "expected_generation=$candidate_generation_tag"
    -f "expected_candidate_sha=$candidate_sha"
    -f 'confirm_exact_publish=true'
  )
else
  arguments+=(-f "operation_id=$operation_id")
fi

gh "${arguments[@]}"
echo "Game Update request submitted to $control_repository ($action)."
