import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ConversationStore } from './conversation-store';

function formatPrompt(body: any): string {
  if (!body) return 'Unknown Prompt';
  if (body.messages && Array.isArray(body.messages)) {
    return body.messages.map((m: any) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return `${m.role.toUpperCase()}: ${content}`;
    }).join('\n\n');
  }
  if (body.prompt) return String(body.prompt);
  if (body.instructions) return `[System Instructions Only]\n${body.instructions}`;
  return JSON.stringify(body);
}

let isSyncing = false;

export async function syncLogsToStore(store: ConversationStore) {
  if (isSyncing) return;
  isSyncing = true;

  const cliproxyLogDir = join(homedir(), '.ccs', 'cliproxy', 'logs');
  
  try {
    const files = await readdir(cliproxyLogDir);
    
    // v1-responses are best because they have prompt + reply
    // api-provider-codex files are good for prompts if v1-responses is missing
    const logFiles = files.filter(f => (f.startsWith('v1-responses-') || f.startsWith('api-provider-')) && f.endsWith('.log'));

    // Sort by mtime to process older files first
    const stats = await Promise.all(logFiles.map(async f => {
      const s = await stat(join(cliproxyLogDir, f));
      return { name: f, size: s.size, mtime: s.mtimeMs };
    }));
    stats.sort((a, b) => a.mtime - b.mtime);

    for (const file of stats) {
      // Skip if already processed and size hasn't changed
      if (store.isFileProcessed(file.name, file.size)) continue;

      const content = await readFile(join(cliproxyLogDir, file.name), 'utf8');
      const parts = content.split('=== REQUEST INFO ===').filter(Boolean);
      
      for (const part of parts) {
        const lines = part.trim().split('\n');
        
        // API Key Extraction
        const authLine = lines.find(l => l.startsWith('Authorization: Bearer '));
        const apiKey = authLine ? authLine.split('Authorization: Bearer ')[1].trim() : null;
        
        // Session ID Extraction (multi-variant)
        const sessionLine = lines.find(l => 
          l.startsWith('Session_id:') || 
          l.includes('X-Claude-Code-Session-Id:') ||
          l.includes('X-Client-Request-Id:')
        );
        const sessionId = sessionLine ? sessionLine.split(':').pop()?.trim() : null;
        
        // Timestamp Extraction
        const timestampLine = lines.find(l => l.startsWith('Timestamp:'));
        const timestamp = timestampLine ? timestampLine.split('Timestamp:')[1].trim() : new Date().toISOString();
        const timestampMs = new Date(timestamp).getTime();

        // Prompt Extraction
        const bodyIdx = part.indexOf('=== REQUEST BODY ===');
        const responseIdx = part.indexOf('data: {"type":"response.completed"');
        
        let prompt: string | undefined;
        let model = 'unknown';
        
        if (bodyIdx !== -1) {
          const bodyEndIdx = responseIdx !== -1 ? responseIdx : part.length;
          const bodyStr = part.slice(bodyIdx + '=== REQUEST BODY ==='.length, bodyEndIdx).trim();
          try {
            const body = JSON.parse(bodyStr);
            model = body.model || model;
            prompt = formatPrompt(body);
          } catch {
            prompt = bodyStr.slice(0, 2000);
          }
        }

        // Response Extraction
        let response: string | undefined;
        if (responseIdx !== -1) {
          const dataStr = part.slice(responseIdx + 5).trim();
          try {
            const data = JSON.parse(dataStr);
            if (data.response && data.response.output) {
              response = data.response.output.map((o: any) => o.text).join('');
            }
          } catch {}
        }

        if (sessionId) {
          store.upsertConversation({
            sessionId,
            apiKey: apiKey ?? undefined,
            timestamp,
            timestampMs,
            model,
            prompt,
            response,
            statusCode: response ? 200 : undefined,
            source: 'cliproxy'
          });
        }
      }
      
      store.markFileProcessed(file.name, file.size);
    }
  } catch (error) {
    console.error('E2E Ingestion Error:', error);
  } finally {
    isSyncing = false;
  }
}

let syncInterval: any = null;

export function startAutoSync(store: ConversationStore) {
  if (syncInterval) return;
  
  // Immediate cold start sync
  syncLogsToStore(store).catch(err => console.error('Initial sync failed', err));
  
  // Regular background sync
  syncInterval = setInterval(() => {
    syncLogsToStore(store).catch(err => console.error('Interval sync failed', err));
  }, 30000);
  
  if (syncInterval.unref) syncInterval.unref();
}
