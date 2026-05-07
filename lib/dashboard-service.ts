import { homedir } from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import {
  buildStablePublicId,
  redactSensitiveText,
  redactToken,
  shortUsageHash,
} from '@/lib/redaction';
import type {
  DashboardKeyRow,
  DashboardModelRow,
  DashboardPayload,
  DashboardQuery,
  DashboardSourceBadge,
  DashboardTrendPoint,
  DatePreset,
  RowSourceState,
  TrendGranularity,
} from '@/lib/types';

const DEFAULT_MANAGEMENT_SECRET = 'ccs';
const DEFAULT_PORT = 8097;

interface UnifiedConfig {
  cliproxy?: {
    auth?: {
      management_secret?: string;
    };
  };
  cliproxy_server?: {
    local?: {
      port?: number;
    };
  };
}

interface CliproxyConfig {
  port?: number;
  ['api-keys']?: string[];
  ['api-key-metadata']?: unknown;
}

interface LiveUsageResponse {
  usage?: {
    apis?: Record<
      string,
      {
        models?: Record<
          string,
          {
            details?: Array<{
              timestamp: string;
              source?: string;
              auth_index?: string;
              failed?: boolean;
              tokens?: {
                input_tokens?: number;
                output_tokens?: number;
                cached_tokens?: number;
              };
            }>;
          }
        >;
      }
    >;
  };
}

interface ApiKeyUsageResponse {
  [provider: string]: Record<
    string,
    {
      success: number;
      failed: number;
      recent_requests: Array<{ time: string; success: number; failed: number }>;
    }
  >;
}

interface SnapshotDetail {
  provider: string;
  model: string;
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  requestCount: number;
  cost: number;
  failed: boolean;
}

interface SnapshotPayload {
  details?: SnapshotDetail[];
}

interface KeyMetadata {
  key: string;
  displayName?: string;
  label?: string;
}

interface ResolvedContext {
  ccsDir: string;
  managementUrl: string;
  managementSecret: string;
  configuredKeys: string[];
  keyMetadata: Map<string, KeyMetadata>;
}

interface NormalizedRequest {
  keyId: string;
  model: string;
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  requestCount: number;
  cost: number;
  sourceState: Exclude<RowSourceState, 'config'>;
}

interface NormalizedKeyInfo {
  keyId: string;
  fingerprint: string;
  maskedKey: string;
  displayName: string;
  providerLabel: string;
}

interface LoadedRequests {
  requests: NormalizedRequest[];
  hasSnapshotData: boolean;
}

const PRICING: Record<
  string,
  { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion: number }
> = {
  'claude-sonnet-4-6': { inputPerMillion: 3.0, outputPerMillion: 15.0, cacheReadPerMillion: 0.3 },
  'claude-sonnet-4-6-thinking': {
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cacheReadPerMillion: 0.3,
  },
  'claude-sonnet-4-5': { inputPerMillion: 3.0, outputPerMillion: 15.0, cacheReadPerMillion: 0.3 },
  'claude-opus-4-6': { inputPerMillion: 5.0, outputPerMillion: 25.0, cacheReadPerMillion: 0.5 },
  'gpt-5': { inputPerMillion: 1.25, outputPerMillion: 10.0, cacheReadPerMillion: 0.125 },
  'gpt-5-codex': { inputPerMillion: 1.25, outputPerMillion: 10.0, cacheReadPerMillion: 0.125 },
  'gpt-5.2': { inputPerMillion: 1.25, outputPerMillion: 10.0, cacheReadPerMillion: 0.125 },
  'gpt-5.3-codex': { inputPerMillion: 1.25, outputPerMillion: 10.0, cacheReadPerMillion: 0.125 },
  'gpt-5.4': { inputPerMillion: 3.0, outputPerMillion: 15.0, cacheReadPerMillion: 0.3 },
  'gpt-5.4-mini': { inputPerMillion: 3.0, outputPerMillion: 15.0, cacheReadPerMillion: 0.3 },
  'gpt-5.5': { inputPerMillion: 5.0, outputPerMillion: 25.0, cacheReadPerMillion: 0.5 },
  'gemini-2.5-pro': { inputPerMillion: 1.25, outputPerMillion: 10.0, cacheReadPerMillion: 0.3125 },
  'gemini-2.5-flash': { inputPerMillion: 0.3, outputPerMillion: 2.5, cacheReadPerMillion: 0.075 },
  'gemini-2.5-flash-lite': { inputPerMillion: 0.1, outputPerMillion: 0.4, cacheReadPerMillion: 0.025 },
  'gemini-3-pro-preview': { inputPerMillion: 2.0, outputPerMillion: 12.0, cacheReadPerMillion: 0.0 },
  'gemini-3-flash-preview': { inputPerMillion: 0.3, outputPerMillion: 2.5, cacheReadPerMillion: 0.075 },
};

const PRICING_ALIASES: Record<string, string> = {
  'gemini-3.1-pro-preview': 'gemini-3-pro-preview',
  'gemini-3.1-flash-preview': 'gemini-3-flash-preview',
  'gemini-3-1-pro-preview': 'gemini-3-pro-preview',
  'gemini-3-1-flash-preview': 'gemini-3-flash-preview',
};

export function parseDashboardQuery(params: URLSearchParams): DashboardQuery {
  const preset = params.get('preset');
  if (preset === 'all' || preset === 'today' || preset === 'week' || preset === 'month' || preset === 'year' || preset === 'custom') {
    return {
      preset,
      from: params.get('from') ?? undefined,
      to: params.get('to') ?? undefined,
    };
  }
  return { preset: 'today' };
}

function parseYamlText<T>(value: string | null): T | null {
  if (!value) return null;
  return YAML.parse(value) as T;
}

async function readUtf8(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function resolveContext(): Promise<ResolvedContext> {
  const ccsDir =
    process.env.CCS_DIR ||
    (process.env.CCS_HOME ? path.join(process.env.CCS_HOME, '.ccs') : path.join(homedir(), '.ccs'));

  const unifiedConfigPath = path.join(ccsDir, 'config.yaml');
  const cliproxyConfigPath = path.join(ccsDir, 'cliproxy', 'config.yaml');

  const unifiedConfig = parseYamlText<UnifiedConfig>(await readUtf8(unifiedConfigPath));
  const cliproxyConfig = parseYamlText<CliproxyConfig>(await readUtf8(cliproxyConfigPath));

  const port =
    unifiedConfig?.cliproxy_server?.local?.port ??
    cliproxyConfig?.port ??
    DEFAULT_PORT;

  const configuredKeys = Array.isArray(cliproxyConfig?.['api-keys'])
    ? cliproxyConfig['api-keys'].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];

  const managementUrl =
    process.env.CLIPROXY_MANAGEMENT_URL?.trim() || `http://127.0.0.1:${port}`;

  const managementSecret =
    process.env.CLIPROXY_MANAGEMENT_SECRET?.trim() ||
    unifiedConfig?.cliproxy?.auth?.management_secret?.trim() ||
    DEFAULT_MANAGEMENT_SECRET;

  return {
    ccsDir,
    managementUrl: managementUrl.replace(/\/$/, ''),
    managementSecret,
    configuredKeys,
    keyMetadata: normalizeKeyMetadata(cliproxyConfig?.['api-key-metadata']),
  };
}

function normalizeKeyMetadata(raw: unknown): Map<string, KeyMetadata> {
  const result = new Map<string, KeyMetadata>();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const key = pickString(entry, ['api_key', 'key', 'value']);
      if (!key) continue;
      result.set(key, {
        key,
        displayName: pickString(entry, ['display_name', 'name']),
        label: pickString(entry, ['label']),
      });
    }
  }
  return result;
}

function pickString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  for (const key of keys) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function keyBucketId(key: string): string {
  return `api-key:${shortUsageHash(key).slice(0, 8)}`;
}

function maskKey(key: string): string {
  return redactToken(key);
}

function inferKeyLabel(key: string): string {
  return `API key ${buildStablePublicId(key)}`;
}

function buildKeyInfo(ctx: ResolvedContext): Map<string, NormalizedKeyInfo> {
  const result = new Map<string, NormalizedKeyInfo>();
  for (const key of ctx.configuredKeys) {
    const metadata = ctx.keyMetadata.get(key);
    const keyId = keyBucketId(key);
    const safeDisplayName = redactSensitiveText(metadata?.displayName);
    const safeLabel = redactSensitiveText(metadata?.label);
    const fallbackLabel = inferKeyLabel(key);
    result.set(keyId, {
      keyId,
      fingerprint: keyId.replace('api-key:', ''),
      maskedKey: maskKey(key),
      displayName: safeDisplayName || safeLabel || fallbackLabel,
      providerLabel: safeLabel || fallbackLabel,
    });
  }
  return result;
}

function calculateCost(model: string, inputTokens: number, outputTokens: number, cacheReadTokens: number): number {
  const pricingKey = PRICING_ALIASES[model] ?? model;
  const pricing = PRICING[pricingKey] ?? {
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cacheReadPerMillion: 0.3,
  };
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion +
    (cacheReadTokens / 1_000_000) * pricing.cacheReadPerMillion
  );
}

async function fetchJson<T>(url: string, secret: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${secret}`,
      },
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Management API returned ${response.status}`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLiveRequests(
  ctx: ResolvedContext
): Promise<{
  requests: NormalizedRequest[];
  discoveredConfiguredKeys: string[];
}> {
  const usage = await fetchJson<LiveUsageResponse>(`${ctx.managementUrl}/v0/management/usage`, ctx.managementSecret);
  const apiKeys = await fetchJson<{ ['api-keys']?: string[] }>(
    `${ctx.managementUrl}/v0/management/api-keys`,
    ctx.managementSecret
  );
  let liveKeyUsage: ApiKeyUsageResponse | null = null;
  try {
    liveKeyUsage = await fetchJson<ApiKeyUsageResponse>(
      `${ctx.managementUrl}/v0/management/api-key-usage`,
      ctx.managementSecret
    );
  } catch {
    liveKeyUsage = null;
  }

  const requests: NormalizedRequest[] = [];
  for (const [providerKey, providerData] of Object.entries(usage.usage?.apis ?? {})) {
    if (!providerKey.startsWith('api-key:')) continue;
    for (const [model, modelData] of Object.entries(providerData.models ?? {})) {
      for (const detail of modelData.details ?? []) {
        const inputTokens = detail.tokens?.input_tokens ?? 0;
        const outputTokens = detail.tokens?.output_tokens ?? 0;
        const cacheReadTokens = detail.tokens?.cached_tokens ?? 0;
        requests.push({
          keyId: providerKey,
          model,
          timestamp: detail.timestamp,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          requestCount: 1,
          cost: calculateCost(model, inputTokens, outputTokens, cacheReadTokens),
          sourceState: 'live',
        });
      }
    }
  }

  if (liveKeyUsage) {
    for (const [provider, rows] of Object.entries(liveKeyUsage)) {
      if (!provider.startsWith('api-key:')) continue;
      for (const compositeKey of Object.keys(rows)) {
        const keyPart = compositeKey.split('|').at(-1)?.trim();
        if (keyPart && !ctx.configuredKeys.includes(keyPart)) {
          ctx.configuredKeys.push(keyPart);
        }
      }
    }
  }

  const discoveredConfiguredKeys = Array.isArray(apiKeys['api-keys']) ? apiKeys['api-keys'] : [];
  for (const key of discoveredConfiguredKeys) {
    if (!ctx.configuredKeys.includes(key)) {
      ctx.configuredKeys.push(key);
    }
  }

  return { requests, discoveredConfiguredKeys };
}

async function loadFallbackRequests(ccsDir: string): Promise<LoadedRequests> {
  const snapshotPath = path.join(ccsDir, 'cache', 'cliproxy-usage', 'latest.json');
  const text = await readUtf8(snapshotPath);
  const snapshot = parseYamlText<SnapshotPayload>(text);
  const requests: NormalizedRequest[] = [];

  for (const detail of snapshot?.details ?? []) {
    if (!detail.provider.startsWith('api-key:')) continue;
    requests.push({
      keyId: detail.provider,
      model: detail.model,
      timestamp: detail.timestamp,
      inputTokens: detail.inputTokens,
      outputTokens: detail.outputTokens,
      cacheReadTokens: detail.cacheReadTokens,
      requestCount: detail.requestCount,
      cost: detail.cost,
      sourceState: 'fallback',
    });
  }

  return {
    requests,
    hasSnapshotData: Array.isArray(snapshot?.details) && snapshot.details.length > 0,
  };
}

function requestIdentity(request: NormalizedRequest): string {
  return [
    request.keyId,
    request.model,
    request.timestamp,
    request.inputTokens,
    request.outputTokens,
    request.cacheReadTokens,
    request.requestCount,
  ].join('|');
}

function mergeRequests(
  fallbackRequests: NormalizedRequest[],
  liveRequests: NormalizedRequest[]
): {
  requests: NormalizedRequest[];
  usedFallbackHistory: boolean;
} {
  const merged = new Map<string, NormalizedRequest>();

  for (const request of fallbackRequests) {
    merged.set(requestIdentity(request), request);
  }

  let liveOverlaps = 0;
  for (const request of liveRequests) {
    const key = requestIdentity(request);
    if (merged.has(key)) {
      liveOverlaps += 1;
    }
    // Prefer live rows when the same event exists in both sources.
    merged.set(key, request);
  }

  return {
    requests: Array.from(merged.values()),
    usedFallbackHistory: fallbackRequests.length > 0 && merged.size > Math.max(liveRequests.length, liveOverlaps),
  };
}

function computeRange(query: DashboardQuery): {
  from: Date;
  to: Date;
  granularity: TrendGranularity;
  label: string;
} {
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  if (query.preset === 'all') {
    return {
      from: new Date('2000-01-01T00:00:00.000Z'),
      to: now,
      granularity: 'daily',
      label: 'All time',
    };
  }

  if (query.preset === 'today') {
    return {
      from: startOfToday,
      to: now,
      granularity: 'hourly',
      label: 'Today',
    };
  }

  if (query.preset === 'week') {
    const startOfWeek = new Date(startOfToday);
    const dayOffset = (startOfWeek.getDay() + 6) % 7;
    startOfWeek.setDate(startOfWeek.getDate() - dayOffset);
    return {
      from: startOfWeek,
      to: now,
      granularity: 'daily',
      label: 'This week',
    };
  }

  if (query.preset === 'month') {
    const startOfMonth = new Date(startOfToday);
    startOfMonth.setDate(1);
    return {
      from: startOfMonth,
      to: now,
      granularity: 'daily',
      label: 'This month',
    };
  }

  if (query.preset === 'year') {
    const startOfYear = new Date(startOfToday);
    startOfYear.setMonth(0, 1);
    return {
      from: startOfYear,
      to: now,
      granularity: 'daily',
      label: 'This year',
    };
  }

  const from = query.from ? new Date(`${query.from}T00:00:00`) : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const to = query.to ? new Date(`${query.to}T23:59:59.999`) : now;
  return {
    from,
    to,
    granularity: 'daily',
    label: 'Custom range',
  };
}

function inRange(timestamp: string, from: Date, to: Date): boolean {
  const value = new Date(timestamp).getTime();
  return value >= from.getTime() && value <= to.getTime();
}

function bucketLabel(date: Date, granularity: TrendGranularity): { key: string; label: string } {
  if (granularity === 'hourly') {
    const bucket = new Date(date);
    bucket.setMinutes(0, 0, 0);
    return {
      key: bucket.toISOString(),
      label: new Intl.DateTimeFormat('en-US', { hour: '2-digit', hour12: false }).format(bucket),
    };
  }

  const bucket = new Date(date);
  bucket.setHours(0, 0, 0, 0);
  return {
    key: bucket.toISOString(),
    label: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(bucket),
  };
}

function buildTrend(
  requests: NormalizedRequest[],
  from: Date,
  to: Date,
  granularity: TrendGranularity
): DashboardTrendPoint[] {
  const buckets = new Map<string, DashboardTrendPoint>();

  for (const request of requests) {
    if (!inRange(request.timestamp, from, to)) continue;
    const bucket = bucketLabel(new Date(request.timestamp), granularity);
    const current = buckets.get(bucket.key) ?? {
      bucketStart: bucket.key,
      label: bucket.label,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      cost: 0,
    };
    current.requests += request.requestCount;
    current.inputTokens += request.inputTokens;
    current.outputTokens += request.outputTokens;
    current.cacheReadTokens += request.cacheReadTokens;
    current.totalTokens += request.inputTokens + request.outputTokens + request.cacheReadTokens;
    current.cost += request.cost;
    buckets.set(bucket.key, current);
  }

  return Array.from(buckets.values()).sort((left, right) => left.bucketStart.localeCompare(right.bucketStart));
}

function buildKeyRows(
  requests: NormalizedRequest[],
  keyInfo: Map<string, NormalizedKeyInfo>,
  from: Date,
  to: Date
): DashboardKeyRow[] {
  const rows = new Map<string, DashboardKeyRow>();

  for (const info of keyInfo.values()) {
    rows.set(info.keyId, {
      id: info.keyId,
      displayName: info.displayName,
      fingerprint: info.fingerprint,
      maskedKey: info.maskedKey,
      providerLabel: info.providerLabel,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      totalTokens: 0,
      cost: 0,
      modelsUsed: [],
      lastUsed: null,
      sourceState: 'config',
    });
  }

  for (const request of requests) {
    if (!inRange(request.timestamp, from, to)) continue;
    const info = keyInfo.get(request.keyId) ?? {
      keyId: request.keyId,
      fingerprint: request.keyId.replace('api-key:', ''),
      maskedKey: redactToken(request.keyId),
      displayName: `API key ${request.keyId.replace('api-key:', '').toUpperCase()}`,
      providerLabel: 'Discovered bucket',
    };
    const existing = rows.get(request.keyId) ?? {
      id: request.keyId,
      displayName: info.displayName,
      fingerprint: info.fingerprint,
      maskedKey: info.maskedKey,
      providerLabel: info.providerLabel,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      totalTokens: 0,
      cost: 0,
      modelsUsed: [],
      lastUsed: null,
      sourceState: request.sourceState,
    };

    existing.requests += request.requestCount;
    existing.inputTokens += request.inputTokens;
    existing.outputTokens += request.outputTokens;
    existing.cacheTokens += request.cacheReadTokens;
    existing.totalTokens += request.inputTokens + request.outputTokens + request.cacheReadTokens;
    existing.cost += request.cost;
    existing.sourceState = request.sourceState;
    existing.lastUsed =
      !existing.lastUsed || new Date(request.timestamp) > new Date(existing.lastUsed)
        ? request.timestamp
        : existing.lastUsed;
    if (!existing.modelsUsed.includes(request.model)) {
      existing.modelsUsed.push(request.model);
    }
    rows.set(request.keyId, existing);
  }

  return Array.from(rows.values()).sort((left, right) => right.cost - left.cost || right.requests - left.requests);
}

function buildModelRows(requests: NormalizedRequest[], from: Date, to: Date): DashboardModelRow[] {
  const rows = new Map<string, DashboardModelRow>();

  for (const request of requests) {
    if (!inRange(request.timestamp, from, to)) continue;
    const existing = rows.get(request.model) ?? {
      model: request.model,
      requests: 0,
      tokens: 0,
      cost: 0,
    };
    existing.requests += request.requestCount;
    existing.tokens += request.inputTokens + request.outputTokens + request.cacheReadTokens;
    existing.cost += request.cost;
    rows.set(request.model, existing);
  }

  return Array.from(rows.values()).sort((left, right) => right.cost - left.cost);
}

function buildSourceBadges(mode: 'live' | 'fallback' | 'mixed', hasConfiguredRows: boolean): DashboardSourceBadge[] {
  const badges: DashboardSourceBadge[] = [];
  if (mode === 'live') badges.push({ label: 'Live API', kind: 'live' });
  if (mode === 'fallback') badges.push({ label: 'Fallback snapshot', kind: 'fallback' });
  if (mode === 'mixed') badges.push({ label: 'Live + fallback', kind: 'warning' });
  if (hasConfiguredRows) badges.push({ label: 'Config-discovered', kind: 'config' });
  return badges;
}

export async function getDashboardPayload(query: DashboardQuery): Promise<DashboardPayload> {
  const ctx = await resolveContext();
  const range = computeRange(query);
  let requests: NormalizedRequest[] = [];
  let mode: 'live' | 'fallback' | 'mixed' = 'live';
  let note: string | null = null;
  const fallback = await loadFallbackRequests(ctx.ccsDir);

  try {
    const live = await fetchLiveRequests(ctx);
    const merged = mergeRequests(fallback.requests, live.requests);
    requests = merged.requests;
    if (fallback.requests.length > 0) {
      mode = 'mixed';
      note = merged.usedFallbackHistory
        ? 'Dashboard history is merged from persisted ~/.ccs cache plus live management data. Live data takes precedence when duplicate events overlap.'
        : 'Live management data matched the persisted history snapshot. Duplicate events were deduplicated automatically.';
    }
  } catch {
    requests = fallback.requests;
    mode = 'fallback';
    note =
      'Live management data was unavailable. This view is using ~/.ccs/cache/cliproxy-usage/latest.json as fallback.';
  }

  const fallbackRequests = mode === 'fallback' ? requests : fallback.requests;
  if (requests.length === 0 && fallback.requests.length > 0) {
    requests = fallback.requests;
    if (mode === 'live') {
      mode = 'mixed';
      note = 'Live API responded without usable request details, so fallback snapshot data was used for continuity.';
    }
  }

  const keyInfo = buildKeyInfo(ctx);
  const keys = buildKeyRows(requests, keyInfo, range.from, range.to);
  const models = buildModelRows(requests, range.from, range.to);
  const trend = buildTrend(requests, range.from, range.to, range.granularity);
  const activeKeys = keys.filter((row) => row.requests > 0).length;
  const totalRequests = keys.reduce((sum, row) => sum + row.requests, 0);
  const totalTokens = keys.reduce((sum, row) => sum + row.totalTokens, 0);
  const totalCost = keys.reduce((sum, row) => sum + row.cost, 0);
  const hasConfiguredRows = keys.some((row) => row.sourceState === 'config');

  if ((mode === 'fallback' || mode === 'mixed') && fallbackRequests.length === 0 && !fallback.hasSnapshotData) {
    note =
      'Neither live management usage nor fallback snapshot data returned usable API-key requests.';
  }

  return {
    generatedAt: new Date().toISOString(),
    range: {
      label: range.label,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      granularity: range.granularity,
    },
    summary: {
      totalRequests,
      totalTokens,
      totalCost,
      activeKeys,
    },
    source: {
      mode,
      managementUrl: ctx.managementUrl,
      discoveredKeyCount: ctx.configuredKeys.length,
      note,
      badges: buildSourceBadges(mode, hasConfiguredRows),
    },
    trend,
    keys,
    models,
  };
}
