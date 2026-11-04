#!/usr/bin/env bash
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo 'run as root' >&2; exit 1; }

echo '=== ASH ATLAS BACKUP RECOVERY ==='
date --iso-8601=seconds

# The internal intake remains authoritative even when the removable mirror is absent.
systemctl enable --now ash-atlas-telemetry-pull.timer
systemctl enable --now ash-atlas-seagate-mount.timer
systemctl enable --now ash-atlas-backup-mirror.timer
systemctl enable --now ash-atlas-backup-scrub.timer

echo 'Running the outage-safe internal pull.'
systemctl start ash-atlas-telemetry-pull.service

seagate_status='unavailable'
if systemctl start ash-atlas-seagate-mount.service; then
  seagate_status='mounted'
  systemctl start ash-atlas-backup-mirror.service
  seagate_status='mirrored'
else
  echo 'Seagate is unavailable or not normally mountable; internal intake remains active.' >&2
fi

systemctl start ha-stack-health-check.service 2>/dev/null || true
echo 'Internal intake: active'
echo "Seagate mirror: $seagate_status"
echo 'Home intake cap: fixed 50,000,000,000 decimal bytes (warning at 40,000,000,000); no automatic increase.'
echo 'Portable PostgreSQL retention is independent and preserves current VPS-live IDs plus two newest safety pins.'
echo 'No force-mount, migration deletion, or pruning was performed by recovery.'
echo 'Legacy cutover remains explicit: run ash-atlas-backup-migration --audit, review its plan, complete the disposable restore proof, then apply that exact plan.'
