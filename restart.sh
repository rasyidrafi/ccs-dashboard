#!/usr/bin/env bash
set -euo pipefail

systemctl --user restart ccs-dashboard.service
systemctl --user --no-pager --full status ccs-dashboard.service
