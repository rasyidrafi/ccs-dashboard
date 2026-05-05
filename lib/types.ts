export type DatePreset = '24h' | '7d' | '30d' | 'custom';
export type TrendGranularity = 'hourly' | 'daily';
export type RowSourceState = 'live' | 'fallback' | 'config';

export interface DashboardQuery {
  preset: DatePreset;
  from?: string;
  to?: string;
}

export interface DashboardSourceBadge {
  label: string;
  kind: 'live' | 'config' | 'fallback' | 'warning';
}

export interface DashboardTrendPoint {
  bucketStart: string;
  label: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  cost: number;
}

export interface DashboardKeyRow {
  id: string;
  displayName: string;
  fingerprint: string;
  maskedKey: string;
  providerLabel: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
  cost: number;
  modelsUsed: string[];
  lastUsed: string | null;
  sourceState: RowSourceState;
}

export interface DashboardModelRow {
  model: string;
  requests: number;
  tokens: number;
  cost: number;
}

export interface DashboardPayload {
  generatedAt: string;
  range: {
    label: string;
    from: string;
    to: string;
    granularity: TrendGranularity;
  };
  summary: {
    totalRequests: number;
    totalTokens: number;
    totalCost: number;
    activeKeys: number;
  };
  source: {
    mode: 'live' | 'fallback' | 'mixed';
    managementUrl: string;
    discoveredKeyCount: number;
    note: string | null;
    badges: DashboardSourceBadge[];
  };
  trend: DashboardTrendPoint[];
  keys: DashboardKeyRow[];
  models: DashboardModelRow[];
}

export type AppView = 'dashboard' | 'limits';
export type AlertSeverity = 'info' | 'warning' | 'urgent';

export interface LimitsQuotaWindow {
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetAt: string | null;
  resetAfterSeconds: number | null;
}

export interface LimitsAlert {
  id: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  accountLabel: string;
}

export interface LimitsAccountRow {
  id: string;
  email: string;
  displayName: string;
  planType: string | null;
  status: 'active' | 'expired' | 'error';
  sourceLabel: string;
  successCount: number;
  failureCount: number;
  updatedAt: string | null;
  fiveHour: LimitsQuotaWindow | null;
  weekly: LimitsQuotaWindow | null;
  alert: LimitsAlert | null;
  error: string | null;
}

export interface LimitsPayload {
  generatedAt: string;
  summary: {
    totalAccounts: number;
    activeAccounts: number;
    resetSoonCount: number;
    exhaustedWeeklyCount: number;
  };
  alerts: LimitsAlert[];
  accounts: LimitsAccountRow[];
}
