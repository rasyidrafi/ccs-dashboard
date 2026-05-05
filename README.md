# `ccs-dashboard`

Standalone Next.js dashboard for manager-facing CLIProxy API-key usage analytics.

It is designed to run locally next to CCS and prefers the live CLIProxy management API, with fallback to the CCS snapshot cache when live data is unavailable.

## Features

- Summary cards for requests, tokens, cost, and active API keys
- Presets for `24H`, `7D`, `30D`, plus custom date range
- Trend chart with hourly or daily bucketing
- Per-key usage table with alias, fingerprint, masked key, token mix, models, and last used
- Model breakdown table
- Source badges for live API, config discovery, and fallback mode

## Configuration

Copy `.env.example` if you want explicit overrides:

```bash
CCS_DIR=
CLIPROXY_MANAGEMENT_URL=
CLIPROXY_MANAGEMENT_SECRET=
```

Resolution order:

1. `CLIPROXY_MANAGEMENT_URL`
2. auto-discovered local URL from `~/.ccs/config.yaml` / `~/.ccs/cliproxy/config.yaml`

Management secret resolution:

1. `CLIPROXY_MANAGEMENT_SECRET`
2. `cliproxy.auth.management_secret` from `~/.ccs/config.yaml`
3. CCS default management secret compatibility fallback

## Run

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

## Notes

- The app reads from `~/.ccs` for discovery and fallback only.
- It does not modify `~/.ccs`.
- Live data comes from CLIProxy management endpoints when available.
