#!/usr/bin/env bash
set -euo pipefail

# MacBook request surface.  It sends one request to the private control
# repository; it never receives or handles store/VPS credentials.
control_repository="${ASH_ATLAS_COORDINATED_CONTROL_REPOSITORY:-}"
control_workflow="${ASH_ATLAS_COORDINATED_CONTROL_WORKFLOW:-coordinated-release-control.yml}"
action="${1:-start}"
operation_id="${2:-}"
batch_request_input="${3:-${ASH_ATLAS_COORDINATED_BATCH_REQUEST:-}}"
source_remote="${ASH_ATLAS_COORDINATED_SOURCE_REMOTE:-}"

case "$action" in
  start|inspect|resume) ;;
  *) echo "ACTION_REQUIRED: action must be start, inspect, or resume" >&2; exit 2 ;;
esac
if [[ -z "$control_repository" ]]; then
  echo "ACTION_REQUIRED: set ASH_ATLAS_COORDINATED_CONTROL_REPOSITORY to the provisioned private control repository" >&2
  exit 2
fi
if [[ -z "$source_remote" ]]; then
  source_remote="$(git remote get-url origin 2>/dev/null || true)"
fi
if [[ -z "$source_remote" ]]; then
  source_repository="${ASH_ATLAS_COORDINATED_SOURCE_REPOSITORY:-example-org/game}"
  source_remote="https://github.com/$source_repository.git"
fi
if [[ "$action" != start && -z "$operation_id" ]]; then
  echo "ACTION_REQUIRED: inspect/resume requires the durable coordinated operation ID" >&2
  exit 2
fi
if [[ "$action" != start && -n "$batch_request_input" ]]; then
  echo "ACTION_REQUIRED: batch_request is valid only for start" >&2
  exit 2
fi
batch_request=""
if [[ "$action" == start && -n "$batch_request_input" ]]; then
  if [[ -f "$batch_request_input" ]]; then
    batch_request="$(cat -- "$batch_request_input")"
  else
    batch_request="$batch_request_input"
  fi
  [[ "$batch_request" == \[*\] ]] || {
    echo "ACTION_REQUIRED: batch_request must be an ordered JSON array" >&2
    exit 2
  }
fi
command -v gh >/dev/null 2>&1 || {
  echo "ACTION_REQUIRED: GitHub CLI (gh) is required for the Mac request surface" >&2
  exit 2
}

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
candidate_generations=()
while IFS= read -r generation; do
  [[ -n "$generation" ]] && candidate_generations+=("$generation")
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
if ((${#candidate_generations[@]} != 1)); then
  echo "ACTION_REQUIRED: remote integration/test must match exactly one generation tag; found: ${candidate_generations[*]:-(none)}" >&2
  exit 2
fi
candidate_generation_tag="${candidate_generations[0]}"
candidate_generation="${candidate_generation_tag#test/}"
printf 'Coordinated release candidate: %s@%s\n' "$candidate_generation_tag" "$candidate_sha"
printf 'LIVE tester target: iOS TestFlight + Google Play internal testing (coordinated server/web).\n'

arguments=(workflow run "$control_workflow" --repo "$control_repository" --ref main -f "action=$action" -f 'dry_run=false')
if [[ -n "$operation_id" ]]; then
  arguments+=(-f "operation_id=$operation_id")
fi
if [[ "$action" == start && -z "$batch_request" ]]; then
  arguments+=(-f "expected_generation=$candidate_generation" -f "expected_candidate_sha=$candidate_sha" -f 'delivery_mode=daily-testers')
fi
if [[ -n "$batch_request" ]]; then
  arguments+=(-f "batch_request=$batch_request")
fi
gh "${arguments[@]}"
echo "Coordinated release request submitted to $control_repository ($action)."
