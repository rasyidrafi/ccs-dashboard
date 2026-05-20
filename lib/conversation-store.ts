import path, { join } from 'node:path';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';

type BunSqliteDatabase = import('bun:sqlite').Database;

const DB_FILENAME = 'conversations.db';

export interface ConversationRow {
  id: number;
  session_id: string;
  api_key: string;
  timestamp: string;
  timestamp_ms: number;
  model: string;
  prompt: string;
  response: string;
  status_code: number | null;
  duration_ms: number | null;
  source: string;
  metadata: string | null;
  classification: string | null;
  project_type: string | null;
  confidence: number | null;
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
}

import { startAutoSync } from './sync-service';

let sqliteModulePromise: Promise<typeof import('bun:sqlite')> | null = null;
const storeCache = new Map<string, ConversationStore>();

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

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT UNIQUE,
      api_key TEXT,
      timestamp TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      model TEXT NOT NULL,
      prompt TEXT,
      response TEXT,
      status_code INTEGER,
      duration_ms INTEGER,
      source TEXT NOT NULL,
      metadata TEXT,
      classification TEXT, -- e.g. 'coding', 'general', 'personal'
      project_type TEXT,   -- 'company' or 'outside'
      confidence REAL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_timestamp_ms ON conversations (timestamp_ms);
    CREATE INDEX IF NOT EXISTS idx_conversations_session_id ON conversations (session_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_api_key ON conversations (api_key);

    CREATE TABLE IF NOT EXISTS processed_logs (
      file_name TEXT PRIMARY KEY,
      last_size INTEGER NOT NULL,
      processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

export class ConversationStore {
  isFileProcessed(fileName: string, currentSize: number): boolean {
    const row = this.db.query<{ last_size: number }>('SELECT last_size FROM processed_logs WHERE file_name = ?').get([fileName]);
    return row !== null && row.last_size >= currentSize;
  }

  markFileProcessed(fileName: string, currentSize: number): void {
    this.db.query('INSERT OR REPLACE INTO processed_logs (file_name, last_size) VALUES (?, ?)')
      .run([fileName, currentSize]);
  }
  private readonly db: BunSqliteDatabase;

  constructor(db: BunSqliteDatabase) {
    this.db = db;
    createSchema(this.db);
  }

  getConversationCount(): number {
    const row = this.db.query<{ count: number }>('SELECT COUNT(*) as count FROM conversations').get();
    return row?.count ?? 0;
  }

  getUniqueApiKeys(): string[] {
    return this.db
      .query<{ api_key: string }>('SELECT DISTINCT api_key FROM conversations WHERE api_key IS NOT NULL ORDER BY api_key ASC')
      .all()
      .map(row => row.api_key);
  }

  listConversations(offset: number = 0, limit: number = 50, apiKey?: string): ConversationEntry[] {
    let query = 'SELECT * FROM conversations';
    const params: any[] = [limit, offset];
    
    if (apiKey) {
      query += ' WHERE api_key = ?';
      params.unshift(apiKey); // Put apiKey at the beginning
    }
    
    query += ' ORDER BY timestamp_ms DESC LIMIT ? OFFSET ?';

    return this.db
      .query<ConversationRow>(query)
      .all(params)
      .map(row => ({
        id: row.id,
        sessionId: row.session_id,
        apiKey: row.api_key,
        timestamp: row.timestamp,
        timestampMs: row.timestamp_ms,
        model: row.model,
        prompt: row.prompt,
        response: row.response,
        statusCode: row.status_code ?? undefined,
        durationMs: row.duration_ms ?? undefined,
        source: row.source,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        classification: row.classification ?? undefined,
        projectType: (row.project_type as any) ?? 'unknown',
        confidence: row.confidence ?? undefined,
      }));
  }

  updateClassification(id: number, classification: string, projectType: string, confidence: number): void {
    this.db.query('UPDATE conversations SET classification = ?, project_type = ?, confidence = ? WHERE id = ?')
      .run([classification, projectType, confidence, id]);
  }

  getUnclassifiedConversations(limit: number = 20): ConversationEntry[] {
    return this.db
      .query<ConversationRow>(
        `SELECT * FROM conversations 
         WHERE (project_type IS NULL OR project_type = 'unknown') 
         AND prompt IS NOT NULL 
         AND response IS NOT NULL
         ORDER BY timestamp_ms DESC 
         LIMIT ?`
      )
      .all([limit])
      .map(row => ({
        id: row.id,
        sessionId: row.session_id,
        apiKey: row.api_key,
        timestamp: row.timestamp,
        timestampMs: row.timestamp_ms,
        model: row.model,
        prompt: row.prompt,
        response: row.response,
        source: row.source,
      }));
  }

  upsertConversation(entry: Partial<ConversationEntry>): void {
    if (!entry.sessionId) return;

    const existing = this.db.query<ConversationRow>('SELECT * FROM conversations WHERE session_id = ?').get([entry.sessionId]);

    if (existing) {
      // Update existing
      const updates: string[] = [];
      const values: any[] = [];

      if (entry.apiKey && !existing.api_key) { updates.push('api_key = ?'); values.push(entry.apiKey); }
      if (entry.prompt && !existing.prompt) { updates.push('prompt = ?'); values.push(entry.prompt); }
      if (entry.response && (!existing.response || entry.response.length > existing.response.length)) { 
        updates.push('response = ?'); values.push(entry.response); 
      }
      if (entry.statusCode !== undefined) { updates.push('status_code = ?'); values.push(entry.statusCode); }
      if (entry.durationMs !== undefined) { updates.push('duration_ms = ?'); values.push(entry.durationMs); }
      
      if (updates.length > 0) {
        values.push(entry.sessionId);
        this.db.query(`UPDATE conversations SET ${updates.join(', ')} WHERE session_id = ?`).run(values);
      }
    } else {
      // Insert new
      this.db.query(
        `INSERT INTO conversations (
          session_id, api_key, timestamp, timestamp_ms, model, prompt, response, status_code, duration_ms, source, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run([
        entry.sessionId,
        entry.apiKey ?? null,
        entry.timestamp ?? new Date().toISOString(),
        entry.timestampMs ?? Date.now(),
        entry.model ?? 'unknown',
        entry.prompt ?? null,
        entry.response ?? null,
        entry.statusCode ?? null,
        entry.durationMs ?? null,
        entry.source ?? 'cliproxy',
        entry.metadata ? JSON.stringify(entry.metadata) : null
      ]);
    }
  }
}

export async function getConversationStore(): Promise<ConversationStore> {
  const ccsDir = join(homedir(), '.ccs');
  const existing = storeCache.get(ccsDir);
  if (existing) return existing;

  const cacheDir = path.join(ccsDir, 'cache', 'ccs-dashboard-logs-v1');
  await mkdir(cacheDir, { recursive: true });
  
  const sqlite = await loadSqliteModule();
  const dbPath = path.join(cacheDir, DB_FILENAME);
  const db = new sqlite.Database(dbPath, { create: true });
  const store = new ConversationStore(db);
  storeCache.set(ccsDir, store);
  
  // Start background E2E auto-sync immediately
  startAutoSync(store);
  
  return store;
}
