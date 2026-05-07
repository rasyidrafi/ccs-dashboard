# Dashboard Time-Window Research and Improvement Plan

## Current behavior

The dashboard data flow is:

1. `components/dashboard-client.tsx` sends `preset` to `/api/dashboard`.
2. `app/api/dashboard/route.ts` parses the query and calls `getDashboardPayload()`.
3. `lib/dashboard-service.ts`:
   - resolves CCS config and management endpoint
   - loads fallback snapshot from `~/.ccs/cache/cliproxy-usage/latest.json`
   - fetches live usage from the management API
   - merges live + fallback rows
   - computes the selected date range
   - builds `trend`, `keys`, `models`, and summary metrics

## How each current filter retrieves data

All filters use the same raw data sources. The only difference is the computed time window and trend granularity.

- `all`
  - Range: `2000-01-01` to now
  - Granularity: `daily`
- `today`
  - Range: start of today to now
  - Granularity: `hourly`
- `week`
  - Range: start of current week to now
  - Granularity: `daily`
- `month`
  - Range: first day of current month to now
  - Granularity: `daily`
- `year`
  - Range: first day of current year to now
  - Granularity: `daily`
- `custom`
  - Range: selected `from` and `to`
  - Granularity: `daily`

## Current problems

- Granularity is hardcoded by preset instead of being a separate concern.
- `year` uses daily buckets, which can produce up to 365 bars.
- `custom` always uses daily buckets, which does not scale.
- Missing dates are omitted instead of rendered as zero-value buckets.
- The service rescans the same request data multiple times for trend, keys, and models.
- Every dashboard fetch reloads source data with `no-store`, even when the user is only changing chart presentation.
- The client refetches when `from` or `to` changes even if the selected preset is not `custom`.

## Target behavior

Separate these concepts:

- `window`: the selected date range
- `granularity`: how that range is grouped for the chart

Recommended default preset behavior:

- `today` -> `hourly`
- `week` -> `daily`
- `month` -> `daily`, with optional switch to `weekly`
- `year` -> `monthly`
- `all` -> `monthly` by default, with room to move to `yearly` if history becomes large
- `custom` -> smart automatic granularity, with optional manual override later

## Required smart custom behavior

For `custom`, the chart should choose buckets automatically from the selected date span:

- If selected range is `<= 31 days`
  - show one bar per day
  - granularity: `daily`
- If selected range is `> 31 days` and `<= 365 days`
  - group by month
  - show one bar per month
  - granularity: `monthly`
- If selected range is `> 365 days`
  - group by year
  - show one bar per year
  - granularity: `yearly`

This keeps the chart readable and avoids rendering hundreds of daily buckets for long custom ranges.

## Recommended fixed preset behavior

### All time

- Default chart grouping should not stay daily.
- Recommended default:
  - `monthly` for normal history sizes
  - optionally `yearly` if the historical range becomes very large

### Today

- Keep `hourly`.
- Expected result: one bucket per hour from `00:00` to current hour.

### Weekly

- Keep `daily`.
- Expected result: one bucket per day for the current week.

### Monthly

Support two chart modes:

- `daily`
  - one bucket per date in the month
  - max about 28 to 31 bars
- `weekly`
  - one bucket per week segment within the selected month
  - this should be calendar-aware and clipped to the month boundaries

Example for a month:

- Week 1: May 1 to May 4
- Week 2: May 5 to May 11
- Week 3: May 12 to May 18
- Week 4: May 19 to May 25
- Week 5: May 26 to May 31

The exact label style can be:

- `May 1-4`
- `May 5-11`
- or `W1`, `W2`, `W3`, `W4`, `W5`

### Yearly

- Change default grouping from `daily` to `monthly`.
- Expected result: one bar per month, Jan through Dec.
- This is the correct dashboard shape for yearly trend viewing.

## Backend implementation plan

### 1. Extend query and payload types

Update `lib/types.ts`:

- extend `TrendGranularity` to:
  - `hourly`
  - `daily`
  - `weekly`
  - `monthly`
  - `yearly`
  - optionally `auto` for query input only
- extend `DashboardQuery` with optional `granularity`
- extend `DashboardPayload.range` with:
  - `requestedGranularity`
  - `resolvedGranularity`

Reason:

- the API needs to distinguish user-requested behavior from backend-selected fallback behavior

### 2. Split range selection from bucket selection

Replace current `computeRange()` logic with two steps:

- `resolveWindow(query)`
  - decides `from`, `to`, and label
- `resolveGranularity(query, window)`
  - decides actual chart grouping

Reason:

- time window and grouping are different concerns
- this makes preset defaults and smart custom behavior easy to maintain

### 3. Add smart granularity resolver

Rules:

- `today` -> `hourly`
- `week` -> `daily`
- `month` -> `daily` by default
- `year` -> `monthly`
- `all` -> `monthly` by default
- `custom`
  - `<= 31 days` -> `daily`
  - `> 31 and <= 365 days` -> `monthly`
  - `> 365 days` -> `yearly`

Later, if manual granularity switching is added, explicit user choice should override automatic selection.

### 4. Rebuild trend bucketing

Replace the current two-mode bucket logic with bucket builders for:

- `hourly`
- `daily`
- `weekly`
- `monthly`
- `yearly`

Important details:

- bucket keys should use normalized period starts
- weekly buckets should be deterministic and clipped to the chosen month when monthly view is in weekly mode
- monthly buckets should normalize to the first day of the month
- yearly buckets should normalize to January 1 of each year

### 5. Zero-fill missing buckets

Generate all expected buckets between `from` and `to`, then fill request totals into them.

Reason:

- chart axes stay stable
- empty dates or months still appear as zero bars
- this is important for monthly, yearly, and custom views

### 6. Aggregate in one pass

Instead of scanning requests separately for:

- trend
- keys
- models
- summary totals

Use one filtered pass over requests in range and accumulate all derived outputs together.

Benefits:

- less repeated work
- easier future optimization
- lower latency when history grows

### 7. Normalize timestamps once

When loading or merging raw requests:

- parse timestamp once
- store numeric epoch or precomputed `Date`

Reason:

- current code repeatedly does `new Date(request.timestamp)` in multiple paths
- repeated date parsing is avoidable overhead

### 8. Add short-lived server caching

Introduce a cache layer for raw merged request data, for example:

- cache merged live + fallback rows for 15 to 60 seconds

Then re-aggregate by requested window and granularity from cached raw rows.

Benefits:

- changing chart grouping no longer requires full refetch from disk and live API every time
- reduces pressure on management endpoints
- improves perceived dashboard responsiveness

### 9. Keep source retrieval and chart aggregation separate

Refactor service structure into stages:

1. load raw source data
2. merge and normalize raw events
3. resolve selected window
4. resolve granularity
5. aggregate into chart and table payloads

Reason:

- clearer architecture
- easier testing
- easier later move to persistent cache or pre-aggregated storage

## Frontend implementation plan

### 1. Show actual resolved granularity

The UI currently displays `dashboard.range.granularity`.

After backend changes, show:

- resolved granularity label
- optionally whether it was auto-selected

Example:

- `Daily`
- `Monthly (auto)`
- `Yearly (auto)`

### 2. Add granularity control where useful

Recommended UI behavior:

- `today`
  - no switch, fixed `hourly`
- `week`
  - no switch, fixed `daily`
- `month`
  - switch between `daily` and `weekly`
- `year`
  - fixed `monthly` initially
- `all`
  - fixed `monthly` initially
- `custom`
  - auto by default
  - optional manual switch later

### 3. Avoid unnecessary refetches

Current effect dependencies cause dashboard fetches when `from` and `to` change even if preset is not `custom`.

Improve this by:

- only including `from` and `to` in the effective query when preset is `custom`
- optionally adding an `Apply` button for custom date changes

Benefits:

- fewer network requests
- less server work
- smoother UI

### 4. Adjust chart type by granularity

Recommended visualization:

- `hourly` and `daily`
  - area chart is acceptable
- `weekly`, `monthly`, `yearly`
  - bar chart may communicate grouped periods more clearly

This is especially useful for:

- yearly monthly totals
- custom large-range monthly totals
- custom multi-year yearly totals

### 5. Improve x-axis labels

Suggested labels:

- hourly: `00`, `01`, `02`
- daily: `May 01`
- weekly: `May 1-7`
- monthly: `Jan`, `Feb`, `Mar`
- yearly: `2023`, `2024`, `2025`

## Best-practice recommendations

### Keep smart defaults but preserve override capability

Automatic behavior is good for readability, but manual override should still be possible later for power users.

### Never render extreme point counts by default

Good dashboard practice is to cap buckets to a human-readable count. Daily bars across a full year are too dense for operational scanning.

### Prefer stable zero-filled periods

Sparse charts hide inactivity and distort perceived cadence. Zero-filled periods are more trustworthy for operator dashboards.

### Separate raw event retrieval from presentation granularity

Raw events should be loaded once, then grouped many ways. This is the biggest structural win for both performance and flexibility.

### Optimize for changed filters, not just initial load

The user interaction pattern here is repeated filter switching. That means aggregation reuse and short-lived caching are more important than a one-time optimized fetch.

## Proposed implementation order

### Phase 1: backend foundation

1. Extend types for new granularities.
2. Refactor window resolution and granularity resolution.
3. Implement smart custom rules.
4. Implement monthly and yearly bucket builders.
5. Zero-fill bucket output.

### Phase 2: performance refactor

1. Convert aggregation to a single pass.
2. Normalize timestamps once.
3. Add short-lived cache for merged raw events.

### Phase 3: frontend controls

1. Surface resolved granularity in the UI.
2. Add month toggle for `daily` and `weekly`.
3. Prevent unnecessary refetches for non-custom date edits.
4. Optionally add manual custom granularity override.

### Phase 4: validation

Add tests for:

- today hourly bucketing
- week daily bucketing
- month daily bucketing with 28, 30, and 31 days
- month weekly bucketing clipped to month boundaries
- year monthly bucketing
- custom `<= 31 days` -> daily
- custom `32..365 days` -> monthly
- custom `> 365 days` -> yearly
- empty buckets rendered as zero
- live and fallback deduplication still behaving correctly

## Final recommendation

The main design change should be:

- do not let preset directly decide chart shape forever
- let preset decide the date window
- let backend granularity rules decide the most readable bucket size
- allow selective manual overrides where useful

For your requested custom logic, the exact smart behavior should be:

- `<= 31 days`: daily bars
- `32..365 days`: monthly bars
- `> 365 days`: yearly bars

That rule is simple, predictable, fast to explain, and good for performance and chart readability.
