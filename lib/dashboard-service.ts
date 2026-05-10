import { homedir } from 'node:os';
import path from 'node:path';
import { copyFile, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
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
  TrendGranularityInput,
  TrendGranularity,
} from '@/lib/types';

const DEFAULT_MANAGEMENT_SECRET = 'ccs';
const DEFAULT_PORT = 8097;
const DAY_MS = 24 * 60 * 60 * 1000;
const SOURCE_CACHE_TTL_MS = 30_000;
const DASHBOARD_HISTORY_VERSION = 1;

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
  version?: number;
  timestamp?: number;
  generatedAt?: string;
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
  timestampMs: number;
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

interface DashboardWindow {
  from: Date;
  to: Date;
  label: string;
}

interface ResolvedRange extends DashboardWindow {
  requestedGranularity: TrendGranularityInput | null;
  resolvedGranularity: TrendGranularity;
}

interface LoadedDashboardData {
  ctx: ResolvedContext;
  requests: NormalizedRequest[];
  mode: 'live' | 'fallback' | 'mixed';
  note: string | null;
  fallback: LoadedRequests;
  fallbackRequestCountForMode: number;
}

interface AggregatedDashboardData {
  trend: DashboardTrendPoint[];
  keys: DashboardKeyRow[];
  models: DashboardModelRow[];
  totalRequests: number;
  totalTokens: number;
  totalCost: number;
  activeKeys: number;
  hasConfiguredRows: boolean;
}

let sourceCache: { loadedAt: number; data: LoadedDashboardData } | null = null;
let historyBootstrapPromise: Promise<void> | null = null;

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
  const granularity = parseGranularityInput(params.get('granularity'));
  if (preset === 'all' || preset === 'today' || preset === 'week' || preset === 'month' || preset === 'year' || preset === 'custom') {
    return {
      preset,
      from: params.get('from') ?? undefined,
      to: params.get('to') ?? undefined,
      granularity,
    };
  }
  return { preset: 'today', granularity };
}

function parseGranularityInput(value: string | null): TrendGranularityInput | undefined {
  if (
    value === 'auto' ||
    value === 'hourly' ||
    value === 'daily' ||
    value === 'weekly' ||
    value === 'monthly' ||
    value === 'yearly'
  ) {
    return value;
  }
  return undefined;
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
  const prefix = key.split('-sk-')[0]?.trim();
  return prefix || `API key ${buildStablePublicId(key)}`;
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

function normalizeRequest(
  request: Omit<NormalizedRequest, 'timestampMs'>
): NormalizedRequest | null {
  const timestampMs = new Date(request.timestamp).getTime();
  if (!Number.isFinite(timestampMs)) return null;
  return { ...request, timestampMs };
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
        const request = normalizeRequest({
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
        if (request) requests.push(request);
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

function getCoreSnapshotPath(ccsDir: string): string {
  return path.join(ccsDir, 'cache', 'cliproxy-usage', 'latest.json');
}

function getDashboardHistoryDir(ccsDir: string): string {
  return path.join(ccsDir, 'cache', 'ccs-dashboard-usage-v1');
}

function getDashboardSnapshotPath(ccsDir: string): string {
  return path.join(getDashboardHistoryDir(ccsDir), 'latest.json');
}

function getDashboardArchiveDir(ccsDir: string): string {
  return path.join(getDashboardHistoryDir(ccsDir), 'archive');
}

async function loadSnapshotDetails(filePath: string): Promise<SnapshotDetail[]> {
  try {
    const text = await readUtf8(filePath);
    const snapshot = parseYamlText<SnapshotPayload>(text);
    return Array.isArray(snapshot?.details) ? snapshot.details : [];
  } catch {
    return [];
  }
}

function snapshotDetailIdentity(detail: SnapshotDetail): string {
  return [
    detail.provider,
    detail.model,
    detail.timestamp,
    detail.inputTokens,
    detail.outputTokens,
    detail.cacheReadTokens,
    detail.requestCount,
    detail.failed ? '1' : '0',
  ].join('|');
}

function mergeSnapshotDetails(
  existing: SnapshotDetail[],
  incoming: SnapshotDetail[]
): SnapshotDetail[] {
  const merged = new Map<string, SnapshotDetail>();
  for (const detail of existing) {
    merged.set(snapshotDetailIdentity(detail), detail);
  }
  for (const detail of incoming) {
    merged.set(snapshotDetailIdentity(detail), detail);
  }
  return Array.from(merged.values()).sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

function snapshotDetailsEqual(left: SnapshotDetail[], right: SnapshotDetail[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (snapshotDetailIdentity(left[index]) !== snapshotDetailIdentity(right[index])) {
      return false;
    }
  }
  return true;
}

function snapshotDetailFromRequest(request: NormalizedRequest): SnapshotDetail {
  return {
    provider: request.keyId,
    model: request.model,
    timestamp: request.timestamp,
    inputTokens: request.inputTokens,
    outputTokens: request.outputTokens,
    cacheReadTokens: request.cacheReadTokens,
    requestCount: request.requestCount,
    cost: request.cost,
    failed: false,
  };
}

async function writeJsonAtomic(filePath: string, payload: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, JSON.stringify(payload), 'utf8');
  await rename(tempPath, filePath);
}

async function bootstrapHistoryArchive(ccsDir: string): Promise<void> {
  if (historyBootstrapPromise) {
    await historyBootstrapPromise;
    return;
  }

  historyBootstrapPromise = (async () => {
    const archiveDir = getDashboardArchiveDir(ccsDir);
    await mkdir(archiveDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const startupCopies = [
      { source: getCoreSnapshotPath(ccsDir), target: `${stamp}-startup-core-cliproxy-latest.json` },
      { source: getDashboardSnapshotPath(ccsDir), target: `${stamp}-startup-dashboard-latest.json` },
    ];

    for (const copy of startupCopies) {
      try {
        await copyFile(copy.source, path.join(archiveDir, copy.target));
      } catch {
        // Best-effort startup backups should never block dashboard reads.
      }
    }
  })();

  await historyBootstrapPromise;
}

async function persistDashboardHistory(ccsDir: string, requests: NormalizedRequest[]): Promise<void> {
  if (requests.length === 0) return;

  await bootstrapHistoryArchive(ccsDir);

  const snapshotPath = getDashboardSnapshotPath(ccsDir);
  const archiveDir = getDashboardArchiveDir(ccsDir);
  const existingDetails = await loadSnapshotDetails(snapshotPath);
  const incomingDetails = requests.map(snapshotDetailFromRequest);
  const mergedDetails = mergeSnapshotDetails(existingDetails, incomingDetails);

  if (snapshotDetailsEqual(existingDetails, mergedDetails)) {
    return;
  }

  const snapshot = {
    version: DASHBOARD_HISTORY_VERSION,
    timestamp: Date.now(),
    generatedAt: new Date().toISOString(),
    details: mergedDetails,
  };

  await writeJsonAtomic(snapshotPath, snapshot);

  const archivePath = path.join(
    archiveDir,
    `${new Date(snapshot.timestamp).toISOString().replace(/[:.]/g, '-')}-snapshot.json`
  );
  await writeJsonAtomic(archivePath, snapshot);
}

async function loadFallbackRequests(ccsDir: string): Promise<LoadedRequests> {
  const snapshotDetails = mergeSnapshotDetails(
    await loadSnapshotDetails(getCoreSnapshotPath(ccsDir)),
    await loadSnapshotDetails(getDashboardSnapshotPath(ccsDir))
  );
  const requests: NormalizedRequest[] = [];

  for (const detail of snapshotDetails) {
    if (!detail.provider.startsWith('api-key:')) continue;
    const request = normalizeRequest({
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
    if (request) requests.push(request);
  }

  return {
    requests,
    hasSnapshotData: snapshotDetails.length > 0,
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

function resolveWindow(query: DashboardQuery, requests: NormalizedRequest[] = []): DashboardWindow {
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  if (query.preset === 'all') {
    const firstRequestDate = getFirstRequestDate(requests) ?? now;
    return {
      from: firstRequestDate,
      to: now,
      label: 'All time',
    };
  }

  if (query.preset === 'today') {
    return {
      from: startOfToday,
      to: now,
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
      label: 'This week',
    };
  }

  if (query.preset === 'month') {
    const startOfMonth = new Date(startOfToday);
    startOfMonth.setDate(1);
    return {
      from: startOfMonth,
      to: now,
      label: 'This month',
    };
  }

  if (query.preset === 'year') {
    const startOfYear = new Date(startOfToday);
    startOfYear.setMonth(0, 1);
    const firstRequestDate = getFirstRequestDateInRange(requests, startOfYear, now);
    return {
      from: firstRequestDate ? startOfPreviousMonthOrYearStart(firstRequestDate, startOfYear) : startOfYear,
      to: now,
      label: 'This year',
    };
  }

  const fallbackFrom = new Date(now.getTime() - 7 * DAY_MS);
  fallbackFrom.setHours(0, 0, 0, 0);
  const parsedFrom = query.from ? new Date(`${query.from}T00:00:00`) : fallbackFrom;
  const parsedTo = query.to ? new Date(`${query.to}T23:59:59.999`) : now;
  const from = Number.isFinite(parsedFrom.getTime()) ? parsedFrom : fallbackFrom;
  const to = Number.isFinite(parsedTo.getTime()) ? parsedTo : now;

  if (from.getTime() > to.getTime()) {
    return {
      from: to,
      to: from,
      label: 'Custom range',
    };
  }

  return {
    from,
    to,
    label: 'Custom range',
  };
}

function resolveGranularity(query: DashboardQuery, window: DashboardWindow): ResolvedRange {
  const requestedGranularity = query.granularity ?? null;
  if (query.preset === 'year') {
    return { ...window, requestedGranularity, resolvedGranularity: 'monthly' };
  }

  if (requestedGranularity && requestedGranularity !== 'auto') {
    return {
      ...window,
      from: query.preset === 'all' ? startOfAllTimeBucket(window.from, requestedGranularity) : window.from,
      requestedGranularity,
      resolvedGranularity: requestedGranularity,
    };
  }

  if (query.preset === 'today') {
    return { ...window, requestedGranularity, resolvedGranularity: 'hourly' };
  }

  if (query.preset === 'week' || query.preset === 'month') {
    return { ...window, requestedGranularity, resolvedGranularity: 'daily' };
  }

  const fromDay = startOfLocalDay(window.from);
  const toDay = startOfLocalDay(window.to);
  const selectedDays = Math.floor((toDay.getTime() - fromDay.getTime()) / DAY_MS) + 1;

  if (query.preset === 'all') {
    const resolvedGranularity = selectedDays > 3 * 365 ? 'yearly' : 'monthly';
    return {
      ...window,
      from: startOfAllTimeBucket(window.from, resolvedGranularity),
      requestedGranularity,
      resolvedGranularity,
    };
  }

  if (selectedDays <= 31) {
    return { ...window, requestedGranularity, resolvedGranularity: 'daily' };
  }

  if (selectedDays <= 365) {
    return { ...window, requestedGranularity, resolvedGranularity: 'monthly' };
  }

  return { ...window, requestedGranularity, resolvedGranularity: 'yearly' };
}

function resolveRange(query: DashboardQuery, requests: NormalizedRequest[] = []): ResolvedRange {
  return resolveGranularity(query, resolveWindow(query, requests));
}

function getFirstRequestDate(requests: NormalizedRequest[]): Date | null {
  let firstTimestampMs = Number.POSITIVE_INFINITY;
  for (const request of requests) {
    if (request.timestampMs < firstTimestampMs) {
      firstTimestampMs = request.timestampMs;
    }
  }

  return Number.isFinite(firstTimestampMs) ? new Date(firstTimestampMs) : null;
}

function getFirstRequestDateInRange(requests: NormalizedRequest[], from: Date, to: Date): Date | null {
  let firstTimestampMs = Number.POSITIVE_INFINITY;
  const fromMs = from.getTime();
  const toMs = to.getTime();

  for (const request of requests) {
    if (request.timestampMs < fromMs || request.timestampMs > toMs) continue;
    if (request.timestampMs < firstTimestampMs) {
      firstTimestampMs = request.timestampMs;
    }
  }

  return Number.isFinite(firstTimestampMs) ? new Date(firstTimestampMs) : null;
}

function startOfPreviousMonthOrYearStart(date: Date, startOfYear: Date): Date {
  const bucket = startOfLocalMonth(date);
  if (bucket.getMonth() === 0) return startOfYear;
  bucket.setMonth(bucket.getMonth() - 1);
  return bucket.getTime() < startOfYear.getTime() ? startOfYear : bucket;
}

function startOfAllTimeBucket(date: Date, granularity: TrendGranularity): Date {
  if (granularity === 'yearly') {
    const bucket = startOfLocalYear(date);
    bucket.setFullYear(bucket.getFullYear() - 1);
    return bucket;
  }

  if (granularity === 'monthly') {
    const bucket = startOfLocalMonth(date);
    bucket.setMonth(bucket.getMonth() - 1);
    return bucket;
  }

  return startOfBucket(date, granularity, { from: date, to: date, label: 'All time' });
}

function inRange(timestampMs: number, from: Date, to: Date): boolean {
  return timestampMs >= from.getTime() && timestampMs <= to.getTime();
}

function startOfLocalDay(date: Date): Date {
  const bucket = new Date(date);
  bucket.setHours(0, 0, 0, 0);
  return bucket;
}

function startOfLocalMonth(date: Date): Date {
  const bucket = startOfLocalDay(date);
  bucket.setDate(1);
  return bucket;
}

function startOfLocalYear(date: Date): Date {
  const bucket = startOfLocalDay(date);
  bucket.setMonth(0, 1);
  return bucket;
}

function startOfLocalWeek(date: Date): Date {
  const bucket = startOfLocalDay(date);
  const dayOffset = (bucket.getDay() + 6) % 7;
  bucket.setDate(bucket.getDate() - dayOffset);
  return bucket;
}

function startOfBucket(date: Date, granularity: TrendGranularity, range: DashboardWindow): Date {
  if (granularity === 'hourly') {
    const bucket = new Date(date);
    bucket.setMinutes(0, 0, 0);
    return bucket;
  }
  if (granularity === 'daily') return startOfLocalDay(date);
  if (granularity === 'monthly') return startOfLocalMonth(date);
  if (granularity === 'yearly') return startOfLocalYear(date);

  const weekStart = startOfLocalWeek(date);
  return weekStart.getTime() < range.from.getTime() ? startOfLocalDay(range.from) : weekStart;
}

function formatBucketLabel(bucket: Date, granularity: TrendGranularity, range: DashboardWindow): string {
  if (granularity === 'hourly') {
    return new Intl.DateTimeFormat('en-US', { hour: '2-digit', hour12: false }).format(bucket);
  }

  if (granularity === 'daily') {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(bucket);
  }

  if (granularity === 'monthly') {
    return new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' }).format(bucket);
  }

  if (granularity === 'yearly') {
    return new Intl.DateTimeFormat('en-US', { year: 'numeric' }).format(bucket);
  }

  const end = new Date(nextWeeklyBucketStart(bucket).getTime() - 1);
  const clippedEnd = end.getTime() > range.to.getTime() ? range.to : end;
  const month = new Intl.DateTimeFormat('en-US', { month: 'short' }).format(bucket);
  const startDay = bucket.getDate();
  const endDay = clippedEnd.getDate();
  return `${month} ${startDay}-${endDay}`;
}

function emptyTrendPoint(bucket: Date, granularity: TrendGranularity, range: DashboardWindow): DashboardTrendPoint {
  return {
    bucketStart: bucket.toISOString(),
    label: formatBucketLabel(bucket, granularity, range),
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    cost: 0,
  };
}

function nextBucketStart(bucket: Date, granularity: TrendGranularity): Date {
  const next = new Date(bucket);
  if (granularity === 'hourly') next.setHours(next.getHours() + 1);
  if (granularity === 'daily') next.setDate(next.getDate() + 1);
  if (granularity === 'weekly') return nextWeeklyBucketStart(bucket);
  if (granularity === 'monthly') next.setMonth(next.getMonth() + 1, 1);
  if (granularity === 'yearly') next.setFullYear(next.getFullYear() + 1, 0, 1);
  return next;
}

function nextWeeklyBucketStart(bucket: Date): Date {
  const next = startOfLocalWeek(bucket);
  next.setDate(next.getDate() + 7);
  return next.getTime() <= bucket.getTime() ? new Date(bucket.getTime() + 7 * DAY_MS) : next;
}

function createTrendBuckets(range: ResolvedRange): Map<string, DashboardTrendPoint> {
  const buckets = new Map<string, DashboardTrendPoint>();
  let cursor = startOfBucket(range.from, range.resolvedGranularity, range);
  const end = range.to.getTime();

  while (cursor.getTime() <= end) {
    const point = emptyTrendPoint(cursor, range.resolvedGranularity, range);
    buckets.set(point.bucketStart, point);
    cursor = nextBucketStart(cursor, range.resolvedGranularity);
  }

  return buckets;
}

function createConfiguredKeyRows(keyInfo: Map<string, NormalizedKeyInfo>): Map<string, DashboardKeyRow> {
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

  return rows;
}

function addRequestToTrend(point: DashboardTrendPoint, request: NormalizedRequest): void {
  point.requests += request.requestCount;
  point.inputTokens += request.inputTokens;
  point.outputTokens += request.outputTokens;
  point.cacheReadTokens += request.cacheReadTokens;
  point.totalTokens += request.inputTokens + request.outputTokens + request.cacheReadTokens;
  point.cost += request.cost;
}

function getRequestKeyRow(
  rows: Map<string, DashboardKeyRow>,
  keyInfo: Map<string, NormalizedKeyInfo>,
  request: NormalizedRequest
): DashboardKeyRow {
  const info = keyInfo.get(request.keyId) ?? {
    keyId: request.keyId,
    fingerprint: request.keyId.replace('api-key:', ''),
    maskedKey: redactToken(request.keyId),
    displayName: request.keyId,
    providerLabel: 'Discovered bucket',
  };
  const existing = rows.get(request.keyId);
  if (existing) return existing;

  const row: DashboardKeyRow = {
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
  rows.set(request.keyId, row);
  return row;
}

function aggregateDashboardData(
  requests: NormalizedRequest[],
  keyInfo: Map<string, NormalizedKeyInfo>,
  range: ResolvedRange
): AggregatedDashboardData {
  const trendBuckets = createTrendBuckets(range);
  const keyRows = createConfiguredKeyRows(keyInfo);
  const modelRows = new Map<string, DashboardModelRow>();

  for (const request of requests) {
    if (!inRange(request.timestampMs, range.from, range.to)) continue;

    const bucketDate = startOfBucket(new Date(request.timestampMs), range.resolvedGranularity, range);
    const bucketKey = bucketDate.toISOString();
    const trendPoint =
      trendBuckets.get(bucketKey) ?? emptyTrendPoint(bucketDate, range.resolvedGranularity, range);
    addRequestToTrend(trendPoint, request);
    trendBuckets.set(bucketKey, trendPoint);

    const keyRow = getRequestKeyRow(keyRows, keyInfo, request);
    keyRow.requests += request.requestCount;
    keyRow.inputTokens += request.inputTokens;
    keyRow.outputTokens += request.outputTokens;
    keyRow.cacheTokens += request.cacheReadTokens;
    keyRow.totalTokens += request.inputTokens + request.outputTokens + request.cacheReadTokens;
    keyRow.cost += request.cost;
    keyRow.sourceState = request.sourceState;
    keyRow.lastUsed =
      !keyRow.lastUsed || request.timestampMs > new Date(keyRow.lastUsed).getTime()
        ? request.timestamp
        : keyRow.lastUsed;
    if (!keyRow.modelsUsed.includes(request.model)) {
      keyRow.modelsUsed.push(request.model);
    }

    const modelRow = modelRows.get(request.model) ?? {
      model: request.model,
      requests: 0,
      tokens: 0,
      cost: 0,
    };
    modelRow.requests += request.requestCount;
    modelRow.tokens += request.inputTokens + request.outputTokens + request.cacheReadTokens;
    modelRow.cost += request.cost;
    modelRows.set(request.model, modelRow);
  }

  const keys = Array.from(keyRows.values()).sort((left, right) => right.cost - left.cost || right.requests - left.requests);
  const totalRequests = keys.reduce((sum, row) => sum + row.requests, 0);
  const totalTokens = keys.reduce((sum, row) => sum + row.totalTokens, 0);
  const totalCost = keys.reduce((sum, row) => sum + row.cost, 0);

  return {
    trend: Array.from(trendBuckets.values()).sort((left, right) => left.bucketStart.localeCompare(right.bucketStart)),
    keys,
    models: Array.from(modelRows.values()).sort((left, right) => right.cost - left.cost),
    totalRequests,
    totalTokens,
    totalCost,
    activeKeys: keys.filter((row) => row.requests > 0).length,
    hasConfiguredRows: keys.some((row) => row.sourceState === 'config'),
  };
}

function buildSourceBadges(mode: 'live' | 'fallback' | 'mixed', hasConfiguredRows: boolean): DashboardSourceBadge[] {
  const badges: DashboardSourceBadge[] = [];
  if (mode === 'live') badges.push({ label: 'Live API', kind: 'live' });
  if (mode === 'fallback') badges.push({ label: 'Fallback snapshot', kind: 'fallback' });
  if (mode === 'mixed') badges.push({ label: 'Live + fallback', kind: 'warning' });
  if (hasConfiguredRows) badges.push({ label: 'Config-discovered', kind: 'config' });
  return badges;
}

async function loadDashboardData(forceRefresh: boolean): Promise<LoadedDashboardData> {
  if (!forceRefresh && sourceCache && Date.now() - sourceCache.loadedAt < SOURCE_CACHE_TTL_MS) {
    return sourceCache.data;
  }

  const ctx = await resolveContext();
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

  const data: LoadedDashboardData = {
    ctx,
    requests,
    mode,
    note,
    fallback,
    fallbackRequestCountForMode: fallbackRequests.length,
  };

  await persistDashboardHistory(ctx.ccsDir, requests);

  sourceCache = { loadedAt: Date.now(), data };
  return data;
}

export async function getDashboardPayload(query: DashboardQuery, forceRefresh = false): Promise<DashboardPayload> {
  const { ctx, requests, mode, fallback, note: loadedNote, fallbackRequestCountForMode } = await loadDashboardData(forceRefresh);
  const range = resolveRange(query, requests);
  let note = loadedNote;

  const keyInfo = buildKeyInfo(ctx);
  const aggregate = aggregateDashboardData(requests, keyInfo, range);

  if ((mode === 'fallback' || mode === 'mixed') && fallbackRequestCountForMode === 0 && !fallback.hasSnapshotData) {
    note =
      'Neither live management usage nor fallback snapshot data returned usable API-key requests.';
  }

  return {
    generatedAt: new Date().toISOString(),
    range: {
      label: range.label,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      granularity: range.resolvedGranularity,
      requestedGranularity: range.requestedGranularity,
      resolvedGranularity: range.resolvedGranularity,
    },
    summary: {
      totalRequests: aggregate.totalRequests,
      totalTokens: aggregate.totalTokens,
      totalCost: aggregate.totalCost,
      activeKeys: aggregate.activeKeys,
    },
    source: {
      mode,
      managementUrl: ctx.managementUrl,
      discoveredKeyCount: ctx.configuredKeys.length,
      note,
      badges: buildSourceBadges(mode, aggregate.hasConfiguredRows),
    },
    trend: aggregate.trend,
    keys: aggregate.keys,
    models: aggregate.models,
  };
}
