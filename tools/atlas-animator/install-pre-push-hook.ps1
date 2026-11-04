# Opt-in git pre-push hook for Atlas Animator.  Run once per checkout:
#   powershell -File tools\atlas-animator\install-pre-push-hook.ps1            install
#   powershell -File tools\atlas-animator\install-pre-push-hook.ps1 -Remove    uninstall
# When a push changes packages/animator or packages/animator-editor, the hook runs `pnpm animator:verify --fast` (tsc + vitest for both
# packages) and blocks the push if it fails.  Set ANIMATOR_VERIFY_FULL=1 to include the browser suites, SKIP_ANIMATOR_VERIFY=1 or
# `git push --no-verify` to skip it once.  The hook never touches the live editor on :5211 (the browser suites use their own sandbox).
param([switch]$Remove)
$ErrorActionPreference = "Stop"
$hooks = (& git rev-parse --git-path hooks).Trim()
if (-not [System.IO.Path]::IsPathRooted($hooks)) { $hooks = Join-Path (& git rev-parse --show-toplevel).Trim() $hooks }
New-Item -ItemType Directory -Force $hooks | Out-Null
$hook = Join-Path $hooks "pre-push"
$marker = "# atlas-animator-pre-push"
if ($Remove) {
  if ((Test-Path $hook) -and (Select-String -Path $hook -SimpleMatch $marker -Quiet)) { Remove-Item $hook; Write-Host "Removed $hook" } else { Write-Host "No Atlas Animator hook at $hook" }
  exit 0
}
if ((Test-Path $hook) -and -not (Select-String -Path $hook -SimpleMatch $marker -Quiet)) { throw "$hook already exists and is not ours; not overwriting it." }
$script = @'
#!/bin/sh
# atlas-animator-pre-push (installed by tools/atlas-animator/install-pre-push-hook.ps1)
[ -n "$SKIP_ANIMATOR_VERIFY" ] && exit 0
zero=0000000000000000000000000000000000000000
changed=0
while read -r local_ref local_sha remote_ref remote_sha; do
  [ "$local_sha" = "$zero" ] && continue
  if [ "$remote_sha" = "$zero" ]; then range="$local_sha" ; files=$(git diff --name-only "$(git merge-base "$local_sha" origin/main 2>/dev/null || echo "$local_sha~1")" "$local_sha" 2>/dev/null)
  else files=$(git diff --name-only "$remote_sha" "$local_sha" 2>/dev/null); fi
  echo "$files" | grep -Eq '^(packages/animator/|packages/animator-editor/|pnpm-lock.yaml)' && changed=1
done
[ "$changed" = 1 ] || exit 0
echo "pre-push: animator files changed, running pnpm animator:verify (SKIP_ANIMATOR_VERIFY=1 to skip once)"
if [ -n "$ANIMATOR_VERIFY_FULL" ]; then pnpm animator:verify; else pnpm animator:verify --fast; fi
'@
[System.IO.File]::WriteAllText($hook, ($script -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Installed $hook"
