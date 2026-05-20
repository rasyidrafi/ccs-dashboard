export type DatePreset = 'all' | 'today' | 'week' | 'month' | 'year' | 'custom';
export type TrendGranularity = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly';
export type TrendGranularityInput = TrendGranularity | 'auto';
export type RowSourceState = 'live' | 'fallback' | 'config';

export interface DashboardQuery {
  preset: DatePreset;
  from?: string;
  to?: string;
  granularity?: TrendGranularityInput;
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
    requestedGranularity: TrendGranularityInput | null;
    resolvedGranularity: TrendGranularity;
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

export type AppView = 'dashboard' | 'limits' | 'monitor';
export type AlertSeverity = 'info' | 'warning' | 'urgent';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  source: string;
  event: string;
  message: string;
  processId?: number;
  runId?: string;
  context?: Record<string, any>;
  requestId?: string;
  raw?: string; // For unstructured logs
}

export type LogSourceType = 'ccs-core' | 'cliproxy-traffic';

export interface LogFileItem {
  name: string;
  size: number;
  mtime: string;
  path: string;
}

export interface MonitorPayload {
  generatedAt: string;
  logs: LogEntry[];
  availableFiles?: LogFileItem[];
}

export interface ConversationEntry {
  id: number;
  sessionId: string;
  apiKey: string;
  timestamp: string;
  timestampMs: number;
  model: string;
  prompt: string;
  response: string;
  statusCode?: number;
  durationMs?: number;
  source: string;
  metadata?: any;
  classification?: string;
  projectType?: 'company' | 'outside' | 'unknown';
  confidence?: number;
}

export interface AllLogsPayload {
  generatedAt: string;
  logs: ConversationEntry[];
  total: number;
  uniqueApiKeys?: string[];
}

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
