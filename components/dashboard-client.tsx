'use client';

import { startTransition, useEffect, useMemo, useState } from 'react';
import type {
  AppView,
  DashboardPayload,
  DashboardSourceBadge,
  DashboardTrendPoint,
  DatePreset,
  LimitsAccountRow,
  LimitsAlert,
  LimitsPayload,
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

function formatRelativeSeconds(seconds: number | null): string {
  if (seconds === null) return 'Unknown';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(seconds < 21600 ? 1 : 0)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
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

function LimitBar({ label, window }: { label: string; window: LimitsAccountRow['fiveHour'] }) {
  if (!window) {
    return (
      <div className="limitBarGroup">
        <div className="limitBarHeader">
          <span>{label}</span>
          <strong>Unavailable</strong>
        </div>
        <div className="quotaTrack">
          <div className="quotaFill quotaFill-empty" style={{ width: '0%' }} />
        </div>
      </div>
    );
  }

  return (
    <div className="limitBarGroup">
      <div className="limitBarHeader">
        <span>{label}</span>
        <strong>{window.remainingPercent.toFixed(0)}% left</strong>
      </div>
      <div className="quotaTrack">
        <div className="quotaFill" style={{ width: `${window.remainingPercent}%` }} />
      </div>
      <div className="limitBarMeta">
        <span>{window.usedPercent.toFixed(0)}% used</span>
        <span>Resets in {formatRelativeSeconds(window.resetAfterSeconds)}</span>
      </div>
    </div>
  );
}

function LimitsAlertStrip({ alert }: { alert: LimitsAlert }) {
  return (
    <article className={`alertCard alertCard-${alert.severity}`}>
      <div>
        <p className="alertEyebrow">{alert.accountLabel}</p>
        <h3>{alert.title}</h3>
        <p>{alert.message}</p>
      </div>
    </article>
  );
}

function LimitsAccountCard({ account }: { account: LimitsAccountRow }) {
  return (
    <article className={`limitCard limitCard-${account.status}`}>
      <div className="limitCardHeader">
        <div>
          <p className="eyebrow">Codex account</p>
          <h3>{account.displayName}</h3>
          <p className="limitCardSubline">{account.email || account.sourceLabel}</p>
        </div>
        <div className="limitCardMeta">
          <span className={`inlineBadge inlineBadge-${account.status}`}>
            {account.status}
          </span>
          <span className="planPill">{account.planType || 'unknown plan'}</span>
        </div>
      </div>

      {account.alert ? (
        <div className={`inlineAlert inlineAlert-${account.alert.severity}`}>
          {account.alert.message}
        </div>
      ) : null}

      {account.error ? <div className="quotaErrorPanel">{account.error}</div> : null}

      <div className="limitGrid">
        <div className="limitGridMain">
          <LimitBar label="5 hour window" window={account.fiveHour} />
          <LimitBar label="Weekly window" window={account.weekly} />
        </div>
        <div className="limitGridSide">
          <div className="statMini">
            <span>Recent success</span>
            <strong>{formatNumber(account.successCount)}</strong>
          </div>
          <div className="statMini">
            <span>Recent failures</span>
            <strong>{formatNumber(account.failureCount)}</strong>
          </div>
          <div className="statMini">
            <span>Last activity</span>
            <strong>{formatDateTime(account.updatedAt)}</strong>
          </div>
        </div>
      </div>
    </article>
  );
}

export function DashboardClient() {
  const [view, setView] = useState<AppView>('dashboard');
  const [preset, setPreset] = useState<DatePreset>(DEFAULT_PRESET);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [refreshToken, setRefreshToken] = useState(0);

  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(true);

  const [limits, setLimits] = useState<LimitsPayload | null>(null);
  const [limitsError, setLimitsError] = useState<string | null>(null);
  const [limitsLoading, setLimitsLoading] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setDashboardLoading(true);
    setDashboardError(null);

    fetch(`/api/dashboard?${buildQuery(preset, from, to)}&refresh=${refreshToken}`, {
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
      .then((data) => setDashboard(data))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setDashboardError(error instanceof Error ? error.message : 'Failed to load dashboard');
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setDashboardLoading(false);
        }
      });

    return () => controller.abort();
  }, [preset, from, to, refreshToken]);

  useEffect(() => {
    if (view !== 'limits' && limits) return;
    const controller = new AbortController();
    setLimitsLoading(true);
    setLimitsError(null);

    fetch(`/api/limits?refresh=${refreshToken}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Request failed with ${response.status}`);
        }
        return response.json() as Promise<LimitsPayload>;
      })
      .then((data) => setLimits(data))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLimitsError(error instanceof Error ? error.message : 'Failed to load limits');
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLimitsLoading(false);
        }
      });

    return () => controller.abort();
  }, [view, refreshToken, limits]);

  const dashboardCards = useMemo(() => {
    if (!dashboard) return [];
    return [
      { label: 'Total requests', value: formatNumber(dashboard.summary.totalRequests) },
      { label: 'Total tokens', value: formatTokenCount(dashboard.summary.totalTokens) },
      { label: 'Total cost', value: formatCost(dashboard.summary.totalCost) },
      { label: 'Active API keys', value: formatNumber(dashboard.summary.activeKeys) },
    ];
  }, [dashboard]);

  const limitsCards = useMemo(() => {
    if (!limits) return [];
    return [
      { label: 'Registered Codex accounts', value: formatNumber(limits.summary.totalAccounts) },
      { label: 'Active quota sessions', value: formatNumber(limits.summary.activeAccounts) },
      { label: 'Weekly reset opportunities', value: formatNumber(limits.summary.resetSoonCount) },
      { label: 'Weekly exhausted', value: formatNumber(limits.summary.exhaustedWeeklyCount) },
    ];
  }, [limits]);

  return (
    <main className="pageShell">
      <nav className="topNav">
        <div className="navBrand">
          <span className="brandChip">CCS</span>
          <div>
            <strong>Manager Console</strong>
            <span>Live CLIProxy usage and Codex limit intelligence</span>
          </div>
        </div>
        <div className="navTabs">
          <button
            type="button"
            className={view === 'dashboard' ? 'navTab active' : 'navTab'}
            onClick={() => setView('dashboard')}
          >
            Dashboard
          </button>
          <button
            type="button"
            className={view === 'limits' ? 'navTab active' : 'navTab'}
            onClick={() => setView('limits')}
          >
            Limits
          </button>
        </div>
        <button type="button" className="refreshButton" onClick={() => setRefreshToken((value) => value + 1)}>
          Refresh
        </button>
      </nav>

      {view === 'dashboard' ? (
        <>
          <section className="hero">
            <div>
              <p className="eyebrow">CLIProxy Manager</p>
              <h1>API-key usage dashboard</h1>
              <p className="heroText">
                Manager-facing live usage analytics for shared API-key traffic, model spend, and activity trends.
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
            </div>
          </section>

          {dashboard ? <StatusBadges badges={dashboard.source.badges} /> : null}
          {dashboard?.source.note ? <div className="notice">{dashboard.source.note}</div> : null}
          {dashboardError ? <div className="errorPanel">{dashboardError}</div> : null}

          <section className="cardGrid">
            {dashboardCards.map((card) => (
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
                  {dashboard?.range.label ?? 'Loading'} · Updated{' '}
                  {dashboard ? formatDateTime(dashboard.generatedAt) : '...'}
                </p>
              </div>
            </div>
            {dashboardLoading && !dashboard ? <div className="emptyPanel">Loading trend data…</div> : null}
            {dashboard ? <TrendChart points={dashboard.trend} /> : null}
          </section>

          <section className="panel">
            <div className="panelHeader">
              <div>
                <h2>Per-key usage</h2>
                <p>Alias-first display with fingerprint, masked key, token mix, models, and last activity.</p>
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
                  {dashboard?.keys.map((row) => (
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
                  {!dashboard?.keys.length && !dashboardLoading ? (
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
                    {dashboard?.models.map((row) => (
                      <tr key={row.model}>
                        <td>{row.model}</td>
                        <td>{formatNumber(row.requests)}</td>
                        <td>{formatTokenCount(row.tokens)}</td>
                        <td>{formatCost(row.cost)}</td>
                      </tr>
                    ))}
                    {!dashboard?.models.length && !dashboardLoading ? (
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
              {dashboard ? (
                <div className="sourceList">
                  <div>
                    <span>Management URL</span>
                    <strong>{dashboard.source.managementUrl}</strong>
                  </div>
                  <div>
                    <span>Data mode</span>
                    <strong>{dashboard.source.mode}</strong>
                  </div>
                  <div>
                    <span>Configured keys discovered</span>
                    <strong>{formatNumber(dashboard.source.discoveredKeyCount)}</strong>
                  </div>
                  <div>
                    <span>Trend granularity</span>
                    <strong>{dashboard.range.granularity}</strong>
                  </div>
                </div>
              ) : (
                <div className="emptyPanel">Loading source details…</div>
              )}
            </section>
          </section>
        </>
      ) : (
        <>
          <section className="hero hero-limits">
            <div>
              <p className="eyebrow">Codex Limits</p>
              <h1>Weekly reset intelligence</h1>
              <p className="heroText">
                Track every registered Codex account, see remaining 5-hour and weekly quota, and catch accounts
                that should be used before the weekly window resets.
              </p>
            </div>
          </section>

          {limitsError ? <div className="errorPanel">{limitsError}</div> : null}

          <section className="cardGrid">
            {limitsCards.map((card) => (
              <article key={card.label} className="metricCard">
                <span>{card.label}</span>
                <strong>{card.value}</strong>
              </article>
            ))}
          </section>

          <section className="panel">
            <div className="panelHeader">
              <div>
                <h2>Priority alerts</h2>
                <p>
                  Accounts with remaining weekly quota that will reset in under one day while a 5-hour window is still available.
                </p>
              </div>
            </div>
            {limitsLoading && !limits ? <div className="emptyPanel">Loading limit alerts…</div> : null}
            {limits && limits.alerts.length === 0 ? (
              <div className="emptyPanel">No weekly reset opportunities right now.</div>
            ) : null}
            <div className="alertsGrid">
              {limits?.alerts.map((alert) => (
                <LimitsAlertStrip key={alert.id} alert={alert} />
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="panelHeader">
              <div>
                <h2>Registered accounts</h2>
                <p>
                  Updated {limits ? formatDateTime(limits.generatedAt) : '...'} · every Codex auth file is listed here.
                </p>
              </div>
            </div>
            <div className="limitsStack">
              {limits?.accounts.map((account) => (
                <LimitsAccountCard key={account.id} account={account} />
              ))}
              {!limits?.accounts.length && !limitsLoading ? (
                <div className="emptyPanel">No Codex accounts were discovered.</div>
              ) : null}
            </div>
          </section>
        </>
      )}
    </main>
  );
}
