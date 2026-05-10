#!/usr/bin/env bash
set -euo pipefail

CCS_DIR="${CCS_DIR:-$HOME/.ccs}"
CCS_PORT="${CCS_PORT:-8090}"
CCS_DASHBOARD_PORT="${CCS_DASHBOARD_PORT:-8099}"
CLIPROXY_PORT="${CLIPROXY_PORT:-8097}"
CCS_MANAGEMENT_SECRET="${CCS_MANAGEMENT_SECRET:-ccs}"
CCS_REQUIRE_SYNC="${CCS_REQUIRE_SYNC:-0}"
STAMP="$(date +%Y-%m-%dT%H-%M-%S)"
BACKUP_ROOT="${CCS_USAGE_BACKUP_DIR:-$HOME/ccs-usage-backups}"
TARGET_DIR="$BACKUP_ROOT/$STAMP"

mkdir -p "$TARGET_DIR"

dashboard_ok=0
refresh_ok=0
live_ok=0

persist_dashboard_history() {
  if curl --silent --show-error --fail --max-time 60 \
    "http://127.0.0.1:${CCS_DASHBOARD_PORT}/api/dashboard?preset=all&forceRefresh=1" \
    -o "$TARGET_DIR/dashboard-sync-response.json"; then
    dashboard_ok=1
    return 0
  fi

  rm -f "$TARGET_DIR/dashboard-sync-response.json"
  return 1
}

refresh_usage_cache() {
  if curl --silent --show-error --fail --max-time 60 \
    -X POST "http://127.0.0.1:${CCS_PORT}/api/usage/refresh" \
    -o "$TARGET_DIR/usage-refresh-response.json"; then
    refresh_ok=1
    return 0
  fi

  rm -f "$TARGET_DIR/usage-refresh-response.json"
  return 1
}

capture_live_usage() {
  if curl --silent --show-error --fail --max-time 60 \
    -H "Authorization: Bearer ${CCS_MANAGEMENT_SECRET}" \
    -H "Accept: application/json" \
    "http://127.0.0.1:${CLIPROXY_PORT}/v0/management/usage" \
    -o "$TARGET_DIR/cliproxy-live-usage.json"; then
    live_ok=1
    return 0
  fi

  rm -f "$TARGET_DIR/cliproxy-live-usage.json"
  return 1
}

capture_live_api_keys() {
  curl --silent --show-error --fail --max-time 30 \
    -H "Authorization: Bearer ${CCS_MANAGEMENT_SECRET}" \
    -H "Accept: application/json" \
    "http://127.0.0.1:${CLIPROXY_PORT}/v0/management/api-keys" \
    -o "$TARGET_DIR/cliproxy-live-api-keys.json" || rm -f "$TARGET_DIR/cliproxy-live-api-keys.json"
}

copy_if_exists() {
  local source="$1"
  local target_name="$2"
  if [[ -f "$source" ]]; then
    cp "$source" "$TARGET_DIR/$target_name"
  fi
}

persist_dashboard_history || true
refresh_usage_cache || true
capture_live_usage || true
capture_live_api_keys

copy_if_exists "$CCS_DIR/cache/cliproxy-usage/latest.json" "cliproxy-latest.json"
copy_if_exists "$CCS_DIR/cache/ccs-dashboard-usage-v1/latest.json" "ccs-dashboard-latest.json"
copy_if_exists "$CCS_DIR/cache/usage.json" "usage.json"
copy_if_exists "$CCS_DIR/cache/codex-native-usage-v1.json" "codex-native-usage-v1.json"

if [[ "$CCS_REQUIRE_SYNC" == "1" && "$dashboard_ok" -ne 1 && "$refresh_ok" -ne 1 && "$live_ok" -ne 1 ]]; then
  echo "backup-ccs-usage: required live sync failed before restart" >&2
  exit 1
fi

# Keep the newest 168 backup directories (roughly 7 days at hourly cadence).
if [[ -d "$BACKUP_ROOT" ]]; then
  find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d | sort | head -n -168 | xargs -r rm -rf
fi
