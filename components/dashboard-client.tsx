'use client';

import { startTransition, useDeferredValue, useEffect, useMemo, useState } from 'react';
import type {
  DashboardPayload,
  DashboardSourceBadge,
  DashboardTrendPoint,
  DatePreset,
} from '@/lib/types';

const DEFAULT_PRESET: DatePreset = '24h';

function buildQuery(preset: DatePreset, from: string, to: string): string {
  const params = new URLSearchParams();
  params.set('preset', preset);
  if (preset === 'custom') {
    if (from) params.set('from', from);
    if (to) params.set('to', to);
  }
  return params.toString();
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(value));
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return formatNumber(value);
}

function formatCost(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value < 1 ? 3 : 2,
    maximumFractionDigits: value < 1 ? 3 : 2,
  }).format(value);
}

function formatDateTime(value: string | null): string {
  if (!value) return 'Never';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function StatusBadges({ badges }: { badges: DashboardSourceBadge[] }) {
  return (
    <div className="badgeRow">
      {badges.map((badge) => (
        <span key={`${badge.kind}-${badge.label}`} className={`badge badge-${badge.kind}`}>
          {badge.label}
        </span>
      ))}
    </div>
  );
}

function TrendChart({ points }: { points: DashboardTrendPoint[] }) {
  if (points.length === 0) {
    return <div className="emptyPanel">No usage data in this range.</div>;
  }

  const width = 880;
  const height = 260;
  const padding = 24;
  const innerWidth = width - padding * 2;
  const innerHeight = height - padding * 2;
  const maxRequests = Math.max(...points.map((point) => point.requests), 1);
  const maxCost = Math.max(...points.map((point) => point.cost), 1);

  const barWidth = innerWidth / points.length;
  const costLine = points
    .map((point, index) => {
      const x = padding + barWidth * index + barWidth / 2;
      const y = padding + innerHeight - (point.cost / maxCost) * innerHeight;
      return `${index === 0 ? 'M' : 'L'} ${x} ${y}`;
    })
    .join(' ');

  return (
    <div className="chartShell">
      <div className="chartLegend">
        <span><i className="legend legend-requests" />Requests</span>
        <span><i className="legend legend-cost" />Estimated cost</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="trendChart" role="img" aria-label="Usage trend">
        <defs>
          <linearGradient id="requestsGradient" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgba(245, 158, 11, 0.95)" />
            <stop offset="100%" stopColor="rgba(245, 158, 11, 0.2)" />
          </linearGradient>
        </defs>
        <rect x="0" y="0" width={width} height={height} rx="20" fill="rgba(13, 19, 33, 0.7)" />
        {points.map((point, index) => {
          const barHeight = (point.requests / maxRequests) * innerHeight;
          const x = padding + barWidth * index + Math.max(barWidth * 0.12, 1);
          const y = padding + innerHeight - barHeight;
          return (
            <g key={point.bucketStart}>
              <rect
                x={x}
                y={y}
                width={Math.max(barWidth * 0.76, 2)}
                height={Math.max(barHeight, 2)}
                rx="8"
                fill="url(#requestsGradient)"
              />
            </g>
          );
        })}
        <path d={costLine} fill="none" stroke="#5eead4" strokeWidth="3" strokeLinecap="round" />
        {points.map((point, index) => {
          const x = padding + barWidth * index + barWidth / 2;
          const y = padding + innerHeight - (point.cost / maxCost) * innerHeight;
          return <circle key={`${point.bucketStart}-cost`} cx={x} cy={y} r="3.5" fill="#5eead4" />;
        })}
      </svg>
      <div className="chartLabels">
        {points.map((point) => (
          <span key={point.bucketStart}>{point.label}</span>
        ))}
      </div>
    </div>
  );
}

export function DashboardClient() {
  const [preset, setPreset] = useState<DatePreset>(DEFAULT_PRESET);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [refreshToken, setRefreshToken] = useState(0);
  const [payload, setPayload] = useState<DashboardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const deferredQuery = useDeferredValue(buildQuery(preset, from, to));

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetch(`/api/dashboard?${deferredQuery}&refresh=${refreshToken}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Request failed with ${response.status}`);
        }
        return response.json() as Promise<DashboardPayload>;
      })
      .then((data) => {
        setPayload(data);
      })
      .catch((requestError: unknown) => {
        if (controller.signal.aborted) return;
        setError(requestError instanceof Error ? requestError.message : 'Failed to load dashboard');
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [deferredQuery, refreshToken]);

  const cards = useMemo(() => {
    if (!payload) return [];
    return [
      { label: 'Total requests', value: formatNumber(payload.summary.totalRequests) },
      { label: 'Total tokens', value: formatTokenCount(payload.summary.totalTokens) },
      { label: 'Total cost', value: formatCost(payload.summary.totalCost) },
      { label: 'Active API keys', value: formatNumber(payload.summary.activeKeys) },
    ];
  }, [payload]);

  return (
    <main className="pageShell">
      <section className="hero">
        <div>
          <p className="eyebrow">CLIProxy Manager</p>
          <h1>API-key usage dashboard</h1>
          <p className="heroText">
            Live-first analytics over CLIProxy management data, with local CCS cache fallback when live
            access is unavailable.
          </p>
        </div>
        <div className="controlCluster">
          <div className="presetGroup">
            {(['24h', '7d', '30d'] as DatePreset[]).map((value) => (
              <button
                key={value}
                type="button"
                className={preset === value ? 'preset active' : 'preset'}
                onClick={() => startTransition(() => setPreset(value))}
              >
                {value.toUpperCase()}
              </button>
            ))}
            <button
              type="button"
              className={preset === 'custom' ? 'preset active' : 'preset'}
              onClick={() => startTransition(() => setPreset('custom'))}
            >
              Custom
            </button>
          </div>
          <div className="dateGroup">
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
          <button type="button" className="refreshButton" onClick={() => setRefreshToken((value) => value + 1)}>
            Refresh
          </button>
        </div>
      </section>

      {payload ? <StatusBadges badges={payload.source.badges} /> : null}
      {payload?.source.note ? <div className="notice">{payload.source.note}</div> : null}
      {error ? <div className="errorPanel">{error}</div> : null}

      <section className="cardGrid">
        {cards.map((card) => (
          <article key={card.label} className="metricCard">
            <span>{card.label}</span>
            <strong>{card.value}</strong>
          </article>
        ))}
      </section>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>Trend</h2>
            <p>
              {payload?.range.label ?? 'Loading'} · Updated{' '}
              {payload ? formatDateTime(payload.generatedAt) : '...'}
            </p>
          </div>
        </div>
        {loading && !payload ? <div className="emptyPanel">Loading trend data…</div> : null}
        {payload ? <TrendChart points={payload.trend} /> : null}
      </section>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>Per-key usage</h2>
            <p>Alias-first display with fingerprint, masked key, token mix, and last activity.</p>
          </div>
        </div>
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Alias</th>
                <th>Fingerprint</th>
                <th>Masked key</th>
                <th>Requests</th>
                <th>Input</th>
                <th>Output</th>
                <th>Cache</th>
                <th>Total</th>
                <th>Cost</th>
                <th>Models</th>
                <th>Last used</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {payload?.keys.map((row) => (
                <tr key={row.id}>
                  <td>
                    <div className="tablePrimary">{row.displayName}</div>
                    <div className="tableSecondary">{row.providerLabel}</div>
                  </td>
                  <td className="mono">{row.fingerprint}</td>
                  <td className="mono">{row.maskedKey}</td>
                  <td>{formatNumber(row.requests)}</td>
                  <td>{formatTokenCount(row.inputTokens)}</td>
                  <td>{formatTokenCount(row.outputTokens)}</td>
                  <td>{formatTokenCount(row.cacheTokens)}</td>
                  <td>{formatTokenCount(row.totalTokens)}</td>
                  <td>{formatCost(row.cost)}</td>
                  <td>{row.modelsUsed.join(', ') || '—'}</td>
                  <td>{formatDateTime(row.lastUsed)}</td>
                  <td><span className={`inlineBadge inlineBadge-${row.sourceState}`}>{row.sourceState}</span></td>
                </tr>
              ))}
              {!payload?.keys.length && !loading ? (
                <tr>
                  <td colSpan={12} className="emptyCell">
                    No API-key rows available.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="dualGrid">
        <section className="panel">
          <div className="panelHeader">
            <div>
              <h2>Model breakdown</h2>
              <p>Aggregated cost and token totals across the selected range.</p>
            </div>
          </div>
          <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Requests</th>
                  <th>Tokens</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {payload?.models.map((row) => (
                  <tr key={row.model}>
                    <td>{row.model}</td>
                    <td>{formatNumber(row.requests)}</td>
                    <td>{formatTokenCount(row.tokens)}</td>
                    <td>{formatCost(row.cost)}</td>
                  </tr>
                ))}
                {!payload?.models.length && !loading ? (
                  <tr>
                    <td colSpan={4} className="emptyCell">
                      No model data available.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel">
          <div className="panelHeader">
            <div>
              <h2>Source status</h2>
              <p>How the current view was assembled.</p>
            </div>
          </div>
          {payload ? (
            <div className="sourceList">
              <div>
                <span>Management URL</span>
                <strong>{payload.source.managementUrl}</strong>
              </div>
              <div>
                <span>Data mode</span>
                <strong>{payload.source.mode}</strong>
              </div>
              <div>
                <span>Configured keys discovered</span>
                <strong>{formatNumber(payload.source.discoveredKeyCount)}</strong>
              </div>
              <div>
                <span>Trend granularity</span>
                <strong>{payload.range.granularity}</strong>
              </div>
            </div>
          ) : (
            <div className="emptyPanel">Loading source details…</div>
          )}
        </section>
      </section>
    </main>
  );
}
