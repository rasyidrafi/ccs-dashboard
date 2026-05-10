import path from 'node:path';
import { mkdir } from 'node:fs/promises';

export interface UsageStoreRequest {
  keyId: string;
  model: string;
  timestamp: string;
  timestampMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  requestCount: number;
  cost: number;
  failed: boolean;
  sourceState: 'live' | 'fallback';
}

interface CountRow {
  count: number;
}

interface ChangeRow {
  changes: number;
}

interface StoredRow {
  event_key: string;
  key_id: string;
  model: string;
  timestamp: string;
  timestamp_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  request_count: number;
  cost: number;
  failed: number;
  source_state: string;
}

interface TimestampRow {
  timestamp_ms: number | null;
}

interface SummaryRow {
  total_requests: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  total_cost: number | null;
  active_keys: number | null;
}

interface TrendRow {
  bucket_start: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  total_cost: number;
}

interface KeyAggregateRow {
  key_id: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  total_tokens: number;
  cost: number;
  models_used: string | null;
  last_used: string | null;
  source_rank: number;
}

interface ModelAggregateRow {
  model: string;
  requests: number;
  tokens: number;
  cost: number;
}

export interface UsageSummary {
  totalRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  activeKeys: number;
}

export interface UsageTrendBucket {
  bucketStartLocal: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalCost: number;
}

export interface UsageKeyAggregate {
  keyId: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
  cost: number;
  modelsUsed: string[];
  lastUsed: string | null;
  sourceState: 'live' | 'fallback';
}

export interface UsageModelAggregate {
  model: string;
  requests: number;
  tokens: number;
  cost: number;
}

type BunSqliteDatabase = import('bun:sqlite').Database;

const DB_FILENAME = 'usage.db';

let sqliteModulePromise: Promise<typeof import('bun:sqlite')> | null = null;
const storeCache = new Map<string, UsageStore>();

function buildEventKey(request: UsageStoreRequest): string {
  return [
    request.keyId,
    request.model,
    request.timestamp,
    request.inputTokens,
    request.outputTokens,
    request.cacheReadTokens,
    request.requestCount,
    request.failed ? '1' : '0',
  ].join('|');
}

async function loadSqliteModule(): Promise<typeof import('bun:sqlite')> {
  if (!sqliteModulePromise) {
    sqliteModulePromise = import('bun:sqlite');
  }
  return sqliteModulePromise;
}

function createSchema(db: BunSqliteDatabase): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS usage_events (
      event_key TEXT PRIMARY KEY,
      key_id TEXT NOT NULL,
      model TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      request_count INTEGER NOT NULL,
      cost REAL NOT NULL,
      failed INTEGER NOT NULL DEFAULT 0,
      source_state TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_usage_events_timestamp_ms ON usage_events (timestamp_ms);
    CREATE INDEX IF NOT EXISTS idx_usage_events_key_id ON usage_events (key_id);
    CREATE INDEX IF NOT EXISTS idx_usage_events_model ON usage_events (model);
  `);
}

function mapRow(row: StoredRow): UsageStoreRequest {
  return {
    keyId: row.key_id,
    model: row.model,
    timestamp: row.timestamp,
    timestampMs: row.timestamp_ms,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    requestCount: row.request_count,
    cost: row.cost,
    failed: row.failed === 1,
    sourceState: row.source_state === 'live' ? 'live' : 'fallback',
  };
}

function resolveBucketExpression(granularity: 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly'): string {
  const localDateTime = "datetime(timestamp_ms / 1000, 'unixepoch', 'localtime')";
  if (granularity === 'hourly') {
    return `strftime('%Y-%m-%dT%H:00:00', ${localDateTime})`;
  }
  if (granularity === 'daily') {
    return `strftime('%Y-%m-%dT00:00:00', ${localDateTime})`;
  }
  if (granularity === 'monthly') {
    return `strftime('%Y-%m-01T00:00:00', ${localDateTime})`;
  }
  if (granularity === 'yearly') {
    return `strftime('%Y-01-01T00:00:00', ${localDateTime})`;
  }

  return `strftime(
    '%Y-%m-%dT00:00:00',
    datetime(
      timestamp_ms / 1000,
      'unixepoch',
      'localtime',
      printf(
        '-%d days',
        (
          CAST(strftime('%w', datetime(timestamp_ms / 1000, 'unixepoch', 'localtime')) AS INTEGER) + 6
        ) % 7
      )
    )
  )`;
}

class UsageStore {
  private readonly db: BunSqliteDatabase;

  constructor(db: BunSqliteDatabase) {
    this.db = db;
    createSchema(this.db);
  }

  countEvents(): number {
    const row = this.db.query<CountRow>('SELECT COUNT(*) as count FROM usage_events').get();
    return row?.count ?? 0;
  }

  listRequests(): UsageStoreRequest[] {
    return this.db
      .query<StoredRow>(
        `SELECT
          event_key,
          key_id,
          model,
          timestamp,
          timestamp_ms,
          input_tokens,
          output_tokens,
          cache_read_tokens,
          request_count,
          cost,
          failed,
          source_state
        FROM usage_events
        ORDER BY timestamp_ms ASC`
      )
      .all()
      .map(mapRow);
  }

  getFirstTimestampMs(): number | null {
    const row = this.db
      .query<TimestampRow>('SELECT MIN(timestamp_ms) as timestamp_ms FROM usage_events')
      .get();
    return row?.timestamp_ms ?? null;
  }

  getFirstTimestampMsInRange(fromMs: number, toMs: number): number | null {
    const row = this.db
      .query<TimestampRow>(
        `SELECT MIN(timestamp_ms) as timestamp_ms
        FROM usage_events
        WHERE timestamp_ms BETWEEN ? AND ?`
      )
      .get([fromMs, toMs]);
    return row?.timestamp_ms ?? null;
  }

  summarizeRange(fromMs: number, toMs: number): UsageSummary {
    const row = this.db
      .query<SummaryRow>(
        `SELECT
          SUM(request_count) as total_requests,
          SUM(input_tokens) as input_tokens,
          SUM(output_tokens) as output_tokens,
          SUM(cache_read_tokens) as cache_read_tokens,
          SUM(cost) as total_cost,
          COUNT(DISTINCT key_id) as active_keys
        FROM usage_events
        WHERE timestamp_ms BETWEEN ? AND ?`
      )
      .get([fromMs, toMs]);

    const inputTokens = row?.input_tokens ?? 0;
    const outputTokens = row?.output_tokens ?? 0;
    const cacheReadTokens = row?.cache_read_tokens ?? 0;
    return {
      totalRequests: row?.total_requests ?? 0,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      totalTokens: inputTokens + outputTokens + cacheReadTokens,
      totalCost: row?.total_cost ?? 0,
      activeKeys: row?.active_keys ?? 0,
    };
  }

  listTrendBuckets(
    fromMs: number,
    toMs: number,
    granularity: 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly'
  ): UsageTrendBucket[] {
    const bucketExpr = resolveBucketExpression(granularity);
    return this.db
      .query<TrendRow>(
        `SELECT
          ${bucketExpr} as bucket_start,
          SUM(request_count) as requests,
          SUM(input_tokens) as input_tokens,
          SUM(output_tokens) as output_tokens,
          SUM(cache_read_tokens) as cache_read_tokens,
          SUM(cost) as total_cost
        FROM usage_events
        WHERE timestamp_ms BETWEEN ? AND ?
        GROUP BY bucket_start
        ORDER BY bucket_start ASC`
      )
      .all([fromMs, toMs])
      .map((row) => ({
        bucketStartLocal: row.bucket_start,
        requests: row.requests,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        totalCost: row.total_cost,
      }));
  }

  listKeyAggregates(fromMs: number, toMs: number): UsageKeyAggregate[] {
    return this.db
      .query<KeyAggregateRow>(
        `SELECT
          key_id,
          SUM(request_count) as requests,
          SUM(input_tokens) as input_tokens,
          SUM(output_tokens) as output_tokens,
          SUM(cache_read_tokens) as cache_tokens,
          SUM(input_tokens + output_tokens + cache_read_tokens) as total_tokens,
          SUM(cost) as cost,
          GROUP_CONCAT(DISTINCT model) as models_used,
          MAX(timestamp) as last_used,
          MAX(CASE source_state WHEN 'live' THEN 2 ELSE 1 END) as source_rank
        FROM usage_events
        WHERE timestamp_ms BETWEEN ? AND ?
        GROUP BY key_id
        ORDER BY cost DESC, requests DESC`
      )
      .all([fromMs, toMs])
      .map((row) => ({
        keyId: row.key_id,
        requests: row.requests,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheTokens: row.cache_tokens,
        totalTokens: row.total_tokens,
        cost: row.cost,
        modelsUsed: row.models_used ? row.models_used.split(',').filter(Boolean).sort() : [],
        lastUsed: row.last_used,
        sourceState: row.source_rank >= 2 ? 'live' : 'fallback',
      }));
  }

  listModelAggregates(fromMs: number, toMs: number): UsageModelAggregate[] {
    return this.db
      .query<ModelAggregateRow>(
        `SELECT
          model,
          SUM(request_count) as requests,
          SUM(input_tokens + output_tokens + cache_read_tokens) as tokens,
          SUM(cost) as cost
        FROM usage_events
        WHERE timestamp_ms BETWEEN ? AND ?
        GROUP BY model
        ORDER BY cost DESC, requests DESC`
      )
      .all([fromMs, toMs])
      .map((row) => ({
        model: row.model,
        requests: row.requests,
        tokens: row.tokens,
        cost: row.cost,
      }));
  }

  insertRequests(requests: UsageStoreRequest[]): number {
    if (requests.length === 0) return 0;

    const insert = this.db.query(
      `INSERT INTO usage_events (
        event_key,
        key_id,
        model,
        timestamp,
        timestamp_ms,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        request_count,
        cost,
        failed,
        source_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_key) DO UPDATE SET
        source_state = CASE
          WHEN excluded.source_state = 'live' THEN 'live'
          ELSE usage_events.source_state
        END`
    );

    let inserted = 0;
    const readChanges = this.db.query<ChangeRow>('SELECT changes() as changes');
    const runBatch = this.db.transaction((rows: UsageStoreRequest[]) => {
      for (const request of rows) {
        insert.run([
          buildEventKey(request),
          request.keyId,
          request.model,
          request.timestamp,
          request.timestampMs,
          request.inputTokens,
          request.outputTokens,
          request.cacheReadTokens,
          request.requestCount,
          request.cost,
          request.failed ? 1 : 0,
          request.sourceState,
        ]);
        if ((readChanges.get()?.changes ?? 0) > 0) inserted += 1;
      }
    });

    runBatch(requests);
    return inserted;
  }
}

export async function getUsageStore(ccsDir: string): Promise<UsageStore> {
  const existing = storeCache.get(ccsDir);
  if (existing) return existing;

  await mkdir(path.join(ccsDir, 'cache', 'ccs-dashboard-usage-v1'), { recursive: true });
  const sqlite = await loadSqliteModule();
  const dbPath = path.join(ccsDir, 'cache', 'ccs-dashboard-usage-v1', DB_FILENAME);
  const db = new sqlite.Database(dbPath, { create: true });
  const store = new UsageStore(db);
  storeCache.set(ccsDir, store);
  return store;
}
