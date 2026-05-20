import { open, readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { MonitorPayload, LogEntry, LogFileItem } from './types';

export async function getMonitorPayload(sourceType: string = 'ccs-core', fileName?: string): Promise<MonitorPayload> {
  const ccsLogDir = join(homedir(), '.ccs', 'logs');
  const cliproxyLogDir = join(homedir(), '.ccs', 'cliproxy', 'logs');
  
  let targetPath = join(ccsLogDir, 'current.jsonl');
  let isJsonl = true;

  if (sourceType === 'cliproxy-traffic') {
    isJsonl = false;
    if (fileName) {
      targetPath = join(cliproxyLogDir, fileName);
    } else {
      // Find most recent log
      const files = await readdir(cliproxyLogDir);
      const logFiles = files.filter(f => f.endsWith('.log'));
      if (logFiles.length > 0) {
        const stats = await Promise.all(logFiles.map(async f => ({
          name: f,
          mtime: (await stat(join(cliproxyLogDir, f))).mtime
        })));
        stats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
        targetPath = join(cliproxyLogDir, stats[0].name);
      }
    }
  }

  const availableFiles: LogFileItem[] = [];
  try {
    const files = await readdir(cliproxyLogDir);
    for (const f of files) {
      if (f.endsWith('.log')) {
        const s = await stat(join(cliproxyLogDir, f));
        availableFiles.push({
          name: f,
          size: s.size,
          mtime: s.mtime.toISOString(),
          path: f
        });
      }
    }
    availableFiles.sort((a, b) => new Date(b.mtime).getTime() - new Date(a.mtime).getTime());
  } catch (e) {
    console.error('Failed to list cliproxy logs', e);
  }

  try {
    const file = await open(targetPath, 'r');
    const stats = await file.stat();
    const size = stats.size;
    
    const bufferSize = Math.min(size, 512 * 1024);
    const buffer = Buffer.alloc(bufferSize);
    
    await file.read(buffer, 0, bufferSize, size - bufferSize);
    await file.close();
    
    const content = buffer.toString('utf8');
    
    let logs: LogEntry[] = [];

    if (isJsonl) {
      const lines = content.trim().split('\n');
      const startIdx = content.startsWith('{') ? 0 : 1;
      logs = lines
        .slice(startIdx)
        .map((line) => {
          try {
            return JSON.parse(line) as LogEntry;
          } catch {
            return null;
          }
        })
        .filter((log): log is LogEntry => log !== null)
        .reverse();
    } else {
      // Split unstructured logs by some delimiter or just chunks
      // cliproxy logs use "=== REQUEST INFO ===" etc.
      const entries = content.split('=== REQUEST INFO ===').filter(Boolean);
      logs = entries.map((entry, idx) => {
        const lines = entry.trim().split('\n');
        const timestampLine = lines.find(l => l.startsWith('Timestamp:'));
        const timestamp = timestampLine ? timestampLine.split('Timestamp:')[1].trim() : new Date().toISOString();
        const urlLine = lines.find(l => l.startsWith('URL:'));
        const url = urlLine ? urlLine.split('URL:')[1].trim() : 'Unknown';
        
        return {
          id: `raw-${idx}`,
          timestamp,
          level: entry.toLowerCase().includes('error') ? 'error' : 'info',
          source: 'cliproxy',
          event: 'traffic',
          message: url,
          raw: '=== REQUEST INFO ===\n' + entry
        } as LogEntry;
      }).reverse();
    }

    return {
      generatedAt: new Date().toISOString(),
      logs,
      availableFiles: availableFiles.slice(0, 50) // Limit to recent 50
    };
  } catch (error) {
    console.error('Failed to read logs:', error);
    return {
      generatedAt: new Date().toISOString(),
      logs: [],
      availableFiles
    };
  }
}
