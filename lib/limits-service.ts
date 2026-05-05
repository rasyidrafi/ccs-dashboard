import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import type { LimitsAccountRow, LimitsAlert, LimitsPayload, LimitsQuotaWindow } from '@/lib/types';

const DEFAULT_MANAGEMENT_SECRET = 'ccs';
const DEFAULT_PORT = 8097;
const CODEX_API_BASE = 'https://chatgpt.com/backend-api';
const CODEX_USER_AGENT = 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal';
const LIMITS_CACHE_TTL_MS = 90_000;

type UnifiedConfig = {
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
};

type CliproxyConfig = {
  port?: number;
  ['auth-dir']?: string;
};

type AuthFileApiEntry = {
  account?: string;
  email?: string;
  label?: string;
  name?: string;
  path?: string;
  provider?: string;
  success?: number;
  failed?: number;
  updated_at?: string;
  status?: string;
};

type AuthFileRecord = {
  access_token?: string;
  account_id?: string;
  email?: string;
  expired?: string;
};

type CodexUsageWindow = {
  used_percent?: number;
  usedPercent?: number;
  reset_after_seconds?: number | null;
  resetAfterSeconds?: number | null;
};

type CodexUsageResponse = {
  plan_type?: string;
  planType?: string;
  rate_limit?: {
    primary_window?: CodexUsageWindow;
    primaryWindow?: CodexUsageWindow;
    secondary_window?: CodexUsageWindow;
    secondaryWindow?: CodexUsageWindow;
  } | null;
  rateLimit?: {
    primary_window?: CodexUsageWindow;
    primaryWindow?: CodexUsageWindow;
    secondary_window?: CodexUsageWindow;
    secondaryWindow?: CodexUsageWindow;
  } | null;
};

type LimitsContext = {
  ccsDir: string;
  managementUrl: string;
  managementSecret: string;
  authDir: string;
};

type CacheEntry = {
  expiresAt: number;
  payload: LimitsPayload;
};

let limitsCache: CacheEntry | null = null;

async function readUtf8(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function parseYamlText<T>(value: string | null): T | null {
  if (!value) return null;
  return YAML.parse(value) as T;
}

async function resolveContext(): Promise<LimitsContext> {
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

  const authDir =
    cliproxyConfig?.['auth-dir']?.trim() || path.join(ccsDir, 'cliproxy', 'auth');

  return {
    ccsDir,
    managementUrl:
      process.env.CLIPROXY_MANAGEMENT_URL?.trim()?.replace(/\/$/, '') ||
      `http://127.0.0.1:${port}`,
    managementSecret:
      process.env.CLIPROXY_MANAGEMENT_SECRET?.trim() ||
      unifiedConfig?.cliproxy?.auth?.management_secret?.trim() ||
      DEFAULT_MANAGEMENT_SECRET,
    authDir,
  };
}

async function fetchManagementAuthFiles(ctx: LimitsContext): Promise<AuthFileApiEntry[]> {
  try {
    const response = await fetch(`${ctx.managementUrl}/v0/management/auth-files`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${ctx.managementSecret}`,
      },
      cache: 'no-store',
    });
    if (!response.ok) {
      return [];
    }
    const body = (await response.json()) as { files?: AuthFileApiEntry[] };
    return Array.isArray(body.files) ? body.files.filter((entry) => entry.provider === 'codex') : [];
  } catch {
    return [];
  }
}

async function scanLocalCodexAuthFiles(authDir: string): Promise<AuthFileApiEntry[]> {
  try {
    const names = await readdir(authDir);
    return names
      .filter((name) => name.startsWith('codex') && name.endsWith('.json'))
      .map((name) => ({
        name,
        path: path.join(authDir, name),
        provider: 'codex',
      }));
  } catch {
    return [];
  }
}

function isExpired(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) return false;
  const value = new Date(expiresAt).getTime();
  return Number.isFinite(value) && value <= Date.now();
}

function resolveWindow(label: string, raw: CodexUsageWindow | undefined | null): LimitsQuotaWindow | null {
  if (!raw) return null;
  const usedPercentRaw = raw.used_percent ?? raw.usedPercent ?? 0;
  const usedPercent = Math.max(0, Math.min(100, Number(usedPercentRaw) || 0));
  const resetAfterSecondsRaw = raw.reset_after_seconds ?? raw.resetAfterSeconds ?? null;
  const resetAfterSeconds =
    typeof resetAfterSecondsRaw === 'number' && Number.isFinite(resetAfterSecondsRaw)
      ? Math.max(0, resetAfterSecondsRaw)
      : null;

  return {
    label,
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    resetAfterSeconds,
    resetAt:
      resetAfterSeconds !== null ? new Date(Date.now() + resetAfterSeconds * 1000).toISOString() : null,
  };
}

async function fetchCodexQuota(auth: AuthFileRecord): Promise<{
  planType: string | null;
  fiveHour: LimitsQuotaWindow | null;
  weekly: LimitsQuotaWindow | null;
}> {
  if (!auth.access_token || !auth.account_id) {
    throw new Error('Missing Codex auth token or account id');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);

  try {
    const response = await fetch(`${CODEX_API_BASE}/wham/usage`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${auth.access_token}`,
        'ChatGPT-Account-Id': auth.account_id,
        'User-Agent': CODEX_USER_AGENT,
      },
    });

    if (!response.ok) {
      throw new Error(`Quota request failed with HTTP ${response.status}`);
    }

    const payload = (await response.json()) as CodexUsageResponse;
    const rateLimit = payload.rate_limit || payload.rateLimit;
    return {
      planType: (payload.plan_type || payload.planType || null)?.toString() ?? null,
      fiveHour: resolveWindow('5 hour', rateLimit?.primary_window || rateLimit?.primaryWindow),
      weekly: resolveWindow('Weekly', rateLimit?.secondary_window || rateLimit?.secondaryWindow),
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildAlert(account: {
  id: string;
  displayName: string;
  weekly: LimitsQuotaWindow | null;
  fiveHour: LimitsQuotaWindow | null;
}): LimitsAlert | null {
  const weekly = account.weekly;
  const fiveHour = account.fiveHour;
  if (!weekly || !fiveHour) return null;
  if (weekly.remainingPercent <= 0 || fiveHour.remainingPercent <= 0) return null;
  if (weekly.resetAfterSeconds === null || weekly.resetAfterSeconds > 86_400) return null;

  const urgent = weekly.resetAfterSeconds <= 21_600;
  return {
    id: `alert-${account.id}`,
    severity: urgent ? 'urgent' : 'warning',
    accountLabel: account.displayName,
    title: urgent ? 'Weekly reset is close' : 'Weekly window resets within a day',
    message: urgent
      ? 'This account still has weekly quota and an open 5-hour window. Spend it before the weekly reset clears the remaining headroom.'
      : 'This account still has weekly quota left and can still be used now. Consider burning the remaining weekly capacity before reset.',
  };
}

function sortAccounts(accounts: LimitsAccountRow[]): LimitsAccountRow[] {
  return accounts.sort((left, right) => {
    const leftAlert = left.alert ? 1 : 0;
    const rightAlert = right.alert ? 1 : 0;
    if (rightAlert !== leftAlert) return rightAlert - leftAlert;
    const leftWeekly = left.weekly?.remainingPercent ?? -1;
    const rightWeekly = right.weekly?.remainingPercent ?? -1;
    if (rightWeekly !== leftWeekly) return rightWeekly - leftWeekly;
    return left.displayName.localeCompare(right.displayName);
  });
}

export async function getLimitsPayload(forceRefresh = false): Promise<LimitsPayload> {
  if (!forceRefresh && limitsCache && limitsCache.expiresAt > Date.now()) {
    return limitsCache.payload;
  }

  const ctx = await resolveContext();
  const discovered = await fetchManagementAuthFiles(ctx);
  const sourceFiles = discovered.length > 0 ? discovered : await scanLocalCodexAuthFiles(ctx.authDir);

  const accounts = await Promise.all(
    sourceFiles.map(async (entry): Promise<LimitsAccountRow> => {
      const filePath = entry.path || path.join(ctx.authDir, entry.name || '');
      const raw = await readUtf8(filePath);
      const auth = raw ? (JSON.parse(raw) as AuthFileRecord) : null;
      const displayName = entry.label || entry.email || auth?.email || entry.name || 'Codex account';
      const sourceLabel = entry.name || path.basename(filePath);

      if (!auth) {
        return {
          id: sourceLabel,
          email: entry.email || '',
          displayName,
          planType: null,
          status: 'error',
          sourceLabel,
          successCount: entry.success ?? 0,
          failureCount: entry.failed ?? 0,
          updatedAt: entry.updated_at ?? null,
          fiveHour: null,
          weekly: null,
          alert: null,
          error: 'Failed to read auth file',
        };
      }

      if (isExpired(auth.expired)) {
        return {
          id: sourceLabel,
          email: entry.email || auth.email || '',
          displayName,
          planType: null,
          status: 'expired',
          sourceLabel,
          successCount: entry.success ?? 0,
          failureCount: entry.failed ?? 0,
          updatedAt: entry.updated_at ?? null,
          fiveHour: null,
          weekly: null,
          alert: null,
          error: 'Token expired. Re-authenticate this Codex account.',
        };
      }

      try {
        const quota = await fetchCodexQuota(auth);
        const rowBase = {
          id: sourceLabel,
          email: entry.email || auth.email || '',
          displayName,
          planType: quota.planType,
          status: 'active' as const,
          sourceLabel,
          successCount: entry.success ?? 0,
          failureCount: entry.failed ?? 0,
          updatedAt: entry.updated_at ?? null,
          fiveHour: quota.fiveHour,
          weekly: quota.weekly,
          error: null,
        };
        return {
          ...rowBase,
          alert: buildAlert({
            id: rowBase.id,
            displayName: rowBase.displayName,
            fiveHour: rowBase.fiveHour,
            weekly: rowBase.weekly,
          }),
        };
      } catch (error) {
        return {
          id: sourceLabel,
          email: entry.email || auth.email || '',
          displayName,
          planType: null,
          status: 'error',
          sourceLabel,
          successCount: entry.success ?? 0,
          failureCount: entry.failed ?? 0,
          updatedAt: entry.updated_at ?? null,
          fiveHour: null,
          weekly: null,
          alert: null,
          error: error instanceof Error ? error.message : 'Quota request failed',
        };
      }
    })
  );

  const sortedAccounts = sortAccounts(accounts);
  const alerts = sortedAccounts.flatMap((account) => (account.alert ? [account.alert] : []));
  const payload: LimitsPayload = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalAccounts: sortedAccounts.length,
      activeAccounts: sortedAccounts.filter((account) => account.status === 'active').length,
      resetSoonCount: alerts.length,
      exhaustedWeeklyCount: sortedAccounts.filter(
        (account) => account.weekly && account.weekly.remainingPercent <= 0
      ).length,
    },
    alerts,
    accounts: sortedAccounts,
  };

  limitsCache = {
    expiresAt: Date.now() + LIMITS_CACHE_TTL_MS,
    payload,
  };

  return payload;
}
