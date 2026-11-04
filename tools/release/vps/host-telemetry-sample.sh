#!/usr/bin/env bash
set -euo pipefail

[[ "${TELEMETRY_HOST_ENABLED:-false}" == "true" ]] || exit 0
: "${TELEMETRY_DATABASE_URL:?telemetry writer URL is required}"
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-1}"
export PGOPTIONS="${PGOPTIONS:--c statement_timeout=500}"

for command in systemctl ps awk df psql sleep tr; do
  command -v "$command" >/dev/null || {
    echo "required command is missing: $command" >&2
    exit 1
  }
done

read_host_cpu() {
  local label user nice system idle iowait irq softirq steal guest guest_nice
  read -r label user nice system idle iowait irq softirq steal guest guest_nice </proc/stat
  printf '%s %s\n' \
    "$((user + nice + system + idle + iowait + irq + softirq + steal))" \
    "$((idle + iowait))"
}

read -r cpu_total_before cpu_idle_before < <(read_host_cpu)
sleep 0.1
read -r cpu_total_after cpu_idle_after < <(read_host_cpu)
cpu_total_delta=$((cpu_total_after - cpu_total_before))
cpu_idle_delta=$((cpu_idle_after - cpu_idle_before))
host_cpu_percent="$(
  awk -v total="$cpu_total_delta" -v idle="$cpu_idle_delta" \
    'BEGIN { print (total > 0 ? (total-idle)*100/total : 0) }'
)"

service_unit="${TELEMETRY_GAME_SERVICE_UNIT:-ash-atlas.service}"
main_pid="$(systemctl show "$service_unit" --property MainPID --value)"
if [[ "$main_pid" =~ ^[1-9][0-9]*$ ]]; then
  process_cpu_percent="$(LC_ALL=C ps -p "$main_pid" -o %cpu= 2>/dev/null | awk '{print $1+0}')"
  process_rss_bytes="$(
    awk '/VmRSS:/ {printf "%.0f\n", $2*1024}' "/proc/${main_pid}/status" 2>/dev/null || true
  )"
else
  main_pid=""
  process_cpu_percent="0"
  process_rss_bytes="0"
fi
host_available_memory_bytes="$(
  awk '/MemAvailable:/ {printf "%.0f\n", $2*1024}' /proc/meminfo
)"
read -r host_load_1m host_load_5m host_load_15m _ </proc/loadavg
read -r service_uptime_seconds _ </proc/uptime
swap_used_bytes="$(awk '
  /SwapTotal:/ {total=$2}
  /SwapFree:/ {free=$2}
  END {printf "%.0f\n", (total-free)*1024}
' /proc/meminfo)"
disk_free_bytes="$(df -PB1 "${TELEMETRY_DISK_PATH:-/var/lib/ash-atlas}" | awk 'NR==2 {print $4}')"
disk_read_bytes="$(awk '$3 ~ /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme[0-9]+n[0-9]+)$/ {sum += $6*512} END {printf "%.0f\n", sum+0}' /proc/diskstats)"
disk_write_bytes="$(awk '$3 ~ /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme[0-9]+n[0-9]+)$/ {sum += $10*512} END {printf "%.0f\n", sum+0}' /proc/diskstats)"
host_network_receive_bytes="$(awk -F'[: ]+' 'NR>2 {sum += $3} END {printf "%.0f\n", sum+0}' /proc/net/dev)"
host_network_transmit_bytes="$(awk -F'[: ]+' 'NR>2 {sum += $11} END {printf "%.0f\n", sum+0}' /proc/net/dev)"
restart_boot_identifier="$(tr -d '\n' </proc/sys/kernel/random/boot_id)"

psql "$TELEMETRY_DATABASE_URL" -Xq -v ON_ERROR_STOP=1 \
  -v host_cpu_percent="${host_cpu_percent:-0}" \
  -v process_rss_bytes="${process_rss_bytes:-0}" \
  -v host_available_memory_bytes="$host_available_memory_bytes" \
  -v host_load_1m="$host_load_1m" \
  -v host_load_5m="$host_load_5m" \
  -v host_load_15m="$host_load_15m" \
  -v process_pid="${main_pid:-}" \
  -v process_cpu_percent="${process_cpu_percent:-0}" \
  -v swap_used_bytes="$swap_used_bytes" \
  -v disk_free_bytes="$disk_free_bytes" \
  -v disk_read_bytes="$disk_read_bytes" \
  -v disk_write_bytes="$disk_write_bytes" \
  -v network_receive_bytes="$host_network_receive_bytes" \
  -v network_transmit_bytes="$host_network_transmit_bytes" \
  -v service_uptime_seconds="$service_uptime_seconds" \
  -v boot_id="$restart_boot_identifier" <<'SQL'
WITH active_run AS (
  SELECT * FROM telemetry.test_runs
  WHERE status='active'
    AND (segment_end_at IS NULL OR clock_timestamp() < segment_end_at)
  ORDER BY started_at DESC LIMIT 1
), inserted AS (
  INSERT INTO telemetry.server_samples (
    telemetry_schema_version, run_id, release_sha, release_generation,
    world_release_id, population_plan_version, population_spawn_rules_version,
    balance_version, server_instance_id, recorded_at, sample_source,
    host_cpu_percent, host_load_1m, host_load_5m, host_load_15m,
    process_pid, process_cpu_percent, process_rss_bytes, host_available_memory_bytes,
    swap_used_bytes, disk_free_bytes, disk_read_bytes, disk_write_bytes,
    host_network_receive_bytes, host_network_transmit_bytes,
    service_uptime_seconds, restart_boot_identifier
  )
  SELECT
    telemetry_schema_version, run_id, release_sha, release_generation,
    world_release_id, population_plan_version, population_spawn_rules_version,
    balance_version, server_instance_id || ':host', clock_timestamp(), 'host_agent',
    :'host_cpu_percent'::double precision,
    :'host_load_1m'::double precision, :'host_load_5m'::double precision,
    :'host_load_15m'::double precision,
    NULLIF(:'process_pid','')::integer, :'process_cpu_percent'::double precision,
    :'process_rss_bytes'::bigint,
    :'host_available_memory_bytes'::bigint, :'swap_used_bytes'::bigint,
    :'disk_free_bytes'::bigint, :'disk_read_bytes'::bigint,
    :'disk_write_bytes'::bigint, :'network_receive_bytes'::bigint,
    :'network_transmit_bytes'::bigint,
    :'service_uptime_seconds'::double precision, :'boot_id'
  FROM active_run
)
UPDATE telemetry.telemetry_health
SET host_sampler_last_seen_at=clock_timestamp(),
    disk_free_bytes=:'disk_free_bytes'::bigint
WHERE run_id IN (SELECT run_id FROM active_run);
SQL
