import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProviderThreadSummary } from '../../types/provider.js';

export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export function requireSessionId(value: string): string {
  if (!SESSION_ID.test(value)) { throw new Error('Claude 会话 ID 必须是 UUID。'); }
  return value.toLowerCase();
}
export function visibleText(record: any): string {
  const content = record?.message?.content;
  if (typeof content === 'string') { return content; }
  return Array.isArray(content)
    ? content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n') : '';
}
export function parseRecords(text: string): any[] {
  return text.split('\n').flatMap((line) => {
    if (!line || line.length > 1024 * 1024) { return []; }
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

/** Reads bounded head/tail samples, never nested subagent transcripts. */
export class ClaudeSessionCatalog {
  constructor(readonly projectsDir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects')) {}

  async list(): Promise<ProviderThreadSummary[]> {
    let dirs;
    try { dirs = await fs.readdir(this.projectsDir, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; } throw error; }
    const sessions: ProviderThreadSummary[] = [];
    projects: for (const dir of dirs.slice(0, 1000)) {
      if (!dir.isDirectory() || dir.isSymbolicLink()) { continue; }
      const projectDir = path.join(this.projectsDir, dir.name);
      for (const entry of (await fs.readdir(projectDir, { withFileTypes: true })).slice(0, 10000)) {
        if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.jsonl')) { continue; }
        const id = entry.name.slice(0, -6);
        if (!SESSION_ID.test(id)) { continue; }
        if (sessions.length >= 5000) { break projects; }
        const file = path.join(projectDir, entry.name);
        const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await handle.stat();
          const head = Buffer.alloc(Math.min(stat.size, 64 * 1024));
          await handle.read(head, 0, head.length, 0);
          const tailStart = Math.max(head.length, stat.size - 128 * 1024);
          const tail = Buffer.alloc(stat.size - tailStart);
          await handle.read(tail, 0, tail.length, tailStart);
          const records = [...parseRecords(head.toString()), ...parseRecords(tail.toString())]
            .filter((record) => !record.isSidechain && (!record.sessionId || record.sessionId === id));
          const firstUser = records.find((record) => record.type === 'user' && !record.isMeta && visibleText(record));
          const lastPrompt = records.findLast((record) => record.type === 'last-prompt')?.lastPrompt;
          const customTitle = records.findLast((record) => record.type === 'custom-title')?.customTitle;
          const prompt = typeof lastPrompt === 'string' ? lastPrompt : visibleText(firstUser);
          const cwd = records.find((record) => typeof record.cwd === 'string')?.cwd ?? null;
          sessions.push({ threadId: id, cwd, path: file, updatedAt: Math.floor(stat.mtimeMs / 1000),
            title: typeof customTitle === 'string' ? customTitle : prompt.slice(0, 80) || id,
            preview: prompt.slice(0, 160) });
        } finally { await handle.close(); }
      }
    }
    return sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.threadId.localeCompare(b.threadId));
  }

  async read(id: string): Promise<ProviderThreadSummary | null> {
    requireSessionId(id);
    return (await this.list()).find((session) => session.threadId === id) ?? null;
  }
}
