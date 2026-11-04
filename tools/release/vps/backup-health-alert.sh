#!/usr/bin/env bash
# Post a private Discord alert when Ash Atlas backups need attention.
#
# The VPS is always on, so it is the one place that can notice when the home
# copy stops arriving or the backup disk is heading toward full. It reuses the
# existing database-health report and adds one rule the report does not gate
# on: the home (2 TB) copy must have been verified within the last day.
#
# Posts on a change of state or reasons, repeats at most every 12 hours while a
# problem lasts, and posts once when backups are healthy again. Without a
# webhook configured it only logs, so installing it is always safe.
set -euo pipefail
umask 077

alert_env="${ASH_ATLAS_BACKUP_ALERT_ENV:-/etc/ash-atlas/backup-alert.env}"
state_file="${ASH_ATLAS_BACKUP_ALERT_STATE:-/var/lib/ash-atlas/backup-health-alert.json}"
proof_max_minutes="${ASH_ATLAS_BACKUP_ALERT_PROOF_MAX_MINUTES:-1440}"
repeat_seconds="${ASH_ATLAS_BACKUP_ALERT_REPEAT_SECONDS:-43200}"

if [[ "${ASH_ATLAS_BACKUP_ALERT_TEST_MODE:-false}" == true ]]; then
  health_json="$(bash "${ASH_ATLAS_BACKUP_ALERT_TEST_HEALTH_COMMAND:?}")"
else
  health_json="$(runuser -u ash-telemetry-pull -- env SSH_ORIGINAL_COMMAND=database-health \
    /usr/local/libexec/ash-atlas-telemetry-pull-command)"
fi

webhook=''
if [[ -f "$alert_env" && ! -L "$alert_env" ]]; then
  webhook="$(sed -n 's/^ASH_ATLAS_BACKUP_ALERT_WEBHOOK_URL=//p' "$alert_env" | tail -1)"
fi

# One line per reason; empty means healthy. An unreadable report is itself a problem.
reasons="$(jq -r --argjson proofMax "$proof_max_minutes" '
  [ (if .status != "ok" then "backup health is \(.status) (\(.failureReason // "unknown"))" else empty end),
    (if .capacityAlert != "ok" then
       "backup disk \(.capacityAlert): \((.availableBytes / 1e9 * 10 | floor) / 10) GB free, about \(.projectedHoursUntilExhaustion) hours of backups left"
     else empty end),
    (if .proofAgeMinutes < 0 then "no home (2 TB) copy has ever been verified"
     elif .proofAgeMinutes > $proofMax then "home (2 TB) copy last verified \(.proofAgeMinutes / 60 | floor) hours ago"
     else empty end)
  ] | .[]' <<<"$health_json" 2>/dev/null)" || reasons='backup health report could not be read'

state=ok
[[ -z "$reasons" ]] || state=problem
now="$(date -u +%s)"
previous_state=ok previous_reasons='' last_sent=0
if [[ -f "$state_file" && ! -L "$state_file" ]]; then
  previous_state="$(jq -r '.state // "ok"' "$state_file" 2>/dev/null || echo ok)"
  previous_reasons="$(jq -r '.reasons // ""' "$state_file" 2>/dev/null || true)"
  last_sent="$(jq -r '.lastSentEpoch // 0' "$state_file" 2>/dev/null || echo 0)"
fi

message=''
if [[ "$state" == problem ]]; then
  if [[ "$previous_state" != problem || "$reasons" != "$previous_reasons" ||
        $(( now - last_sent )) -ge "$repeat_seconds" ]]; then
    message="⚠️ Ash Atlas backups need attention:"$'\n'"$(sed 's/^/• /' <<<"$reasons")"
  fi
elif [[ "$previous_state" == problem ]]; then
  message='✅ Ash Atlas backups are healthy again.'
fi

printf 'backup health: %s%s\n' "$state" "${reasons:+ — $(tr '\n' ';' <<<"$reasons")}"
sent="$last_sent"
if [[ -n "$message" ]]; then
  if [[ -z "$webhook" ]]; then
    echo 'backup alert not sent: no webhook configured in '"$alert_env"
  elif jq -cn --arg content "$message" '{content:$content,allowed_mentions:{parse:[]}}' |
       curl -fsS -m 20 -H 'Content-Type: application/json' --data-binary @- "$webhook" >/dev/null; then
    sent="$now"
    echo 'backup alert sent'
  else
    echo 'backup alert delivery failed; will retry next run' >&2
    # Keep the previous state so the next run retries the same transition.
    exit 1
  fi
fi

install -d -m 0700 "$(dirname "$state_file")"
jq -cn --arg state "$state" --arg reasons "$reasons" --argjson lastSentEpoch "$sent" \
  '{state:$state,reasons:$reasons,lastSentEpoch:$lastSentEpoch}' >"$state_file.partial"
mv -f -- "$state_file.partial" "$state_file"
