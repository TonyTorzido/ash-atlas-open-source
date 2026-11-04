#!/usr/bin/env bash
set -euo pipefail

vps_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
namespace="$(mktemp -d /tmp/ash-atlas-backup-alert-test.XXXXXXXX)"
trap 'rm -rf -- "$namespace"' EXIT
mkdir -p "$namespace/bin"

cat >"$namespace/bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "${ALERT_TEST_CURL_FAIL:-false}" != true ]] || exit 22
cat >>"${ALERT_TEST_POSTS:?}"
SH
chmod +x "$namespace/bin/curl"
cat >"$namespace/health.sh" <<'SH'
cat "${ALERT_TEST_HEALTH_FILE:?}"
SH

export PATH="$namespace/bin:$PATH"
export ASH_ATLAS_BACKUP_ALERT_TEST_MODE=true
export ASH_ATLAS_BACKUP_ALERT_TEST_HEALTH_COMMAND="$namespace/health.sh"
export ASH_ATLAS_BACKUP_ALERT_ENV="$namespace/backup-alert.env"
export ASH_ATLAS_BACKUP_ALERT_STATE="$namespace/state/alert.json"
export ALERT_TEST_HEALTH_FILE="$namespace/health.json"
export ALERT_TEST_POSTS="$namespace/posts.jsonl"
: >"$ALERT_TEST_POSTS"
printf 'ASH_ATLAS_BACKUP_ALERT_WEBHOOK_URL=https://discord.invalid/api/webhooks/test\n' >"$ASH_ATLAS_BACKUP_ALERT_ENV"

health() {
  jq -cn --arg status "$1" --arg capacity "$2" --argjson proof "$3" '
    {version:1,status:$status,failureReason:(if $status=="ok" then "none" else "capacity" end),
     capacityAlert:$capacity,availableBytes:25031069696,projectedHoursUntilExhaustion:9,
     proofAgeMinutes:$proof}' >"$ALERT_TEST_HEALTH_FILE"
}
posts() { grep -c . "$ALERT_TEST_POSTS" || true; }
run() { bash "$vps_dir/backup-health-alert.sh" >"$namespace/out.txt" 2>&1; }

# Healthy: nothing is posted.
health ok ok 30
run
[[ "$(posts)" == 0 ]]
grep -Fq 'backup health: ok' "$namespace/out.txt"

# The home copy stops arriving: one alert naming the reason.
health ok ok 2000
run
[[ "$(posts)" == 1 ]]
tail -1 "$ALERT_TEST_POSTS" | jq -e '.content | contains("home (2 TB) copy last verified 33 hours ago")' >/dev/null
tail -1 "$ALERT_TEST_POSTS" | jq -e '.allowed_mentions.parse == []' >/dev/null

# The same problem an hour later is not re-posted.
run
[[ "$(posts)" == 1 ]]

# A new reason is posted immediately.
health problem critical 2000
run
[[ "$(posts)" == 2 ]]
tail -1 "$ALERT_TEST_POSTS" | jq -e '.content | contains("backup disk critical: 25 GB free")' >/dev/null

# While it lasts, it repeats after the repeat window.
ASH_ATLAS_BACKUP_ALERT_REPEAT_SECONDS=0 run
[[ "$(posts)" == 3 ]]

# Recovery is announced once, then silence.
health ok ok 30
run
[[ "$(posts)" == 4 ]]
tail -1 "$ALERT_TEST_POSTS" | jq -e '.content | contains("healthy again")' >/dev/null
run
[[ "$(posts)" == 4 ]]

# A failed delivery keeps the old state so the next run retries it.
health ok ok -1
if ALERT_TEST_CURL_FAIL=true run; then echo 'expected delivery failure' >&2; exit 1; fi
jq -e '.state == "ok"' "$ASH_ATLAS_BACKUP_ALERT_STATE" >/dev/null
run
[[ "$(posts)" == 5 ]]
tail -1 "$ALERT_TEST_POSTS" | jq -e '.content | contains("no home (2 TB) copy has ever been verified")' >/dev/null

# An unreadable report is itself a problem.
printf 'not json' >"$ALERT_TEST_HEALTH_FILE"
run
[[ "$(posts)" == 6 ]]
tail -1 "$ALERT_TEST_POSTS" | jq -e '.content | contains("could not be read")' >/dev/null

# Without a webhook it only logs, and never fails.
rm "$ASH_ATLAS_BACKUP_ALERT_ENV" "$ASH_ATLAS_BACKUP_ALERT_STATE"
health ok ok 2000
run
[[ "$(posts)" == 6 ]]
grep -Fq 'no webhook configured' "$namespace/out.txt"

echo 'backup health alert tests passed'
