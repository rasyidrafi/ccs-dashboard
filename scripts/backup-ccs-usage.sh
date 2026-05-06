#!/usr/bin/env bash
set -euo pipefail

CCS_DIR="${CCS_DIR:-$HOME/.ccs}"
STAMP="$(date +%Y-%m-%dT%H-%M-%S)"
BACKUP_ROOT="${CCS_USAGE_BACKUP_DIR:-$HOME/ccs-usage-backups}"
TARGET_DIR="$BACKUP_ROOT/$STAMP"

mkdir -p "$TARGET_DIR"

copy_if_exists() {
  local source="$1"
  local target_name="$2"
  if [[ -f "$source" ]]; then
    cp "$source" "$TARGET_DIR/$target_name"
  fi
}

copy_if_exists "$CCS_DIR/cache/cliproxy-usage/latest.json" "cliproxy-latest.json"
copy_if_exists "$CCS_DIR/cache/usage.json" "usage.json"
copy_if_exists "$CCS_DIR/cache/codex-native-usage-v1.json" "codex-native-usage-v1.json"

# Keep the newest 168 backup directories (roughly 7 days at hourly cadence).
if [[ -d "$BACKUP_ROOT" ]]; then
  find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d | sort | head -n -168 | xargs -r rm -rf
fi
