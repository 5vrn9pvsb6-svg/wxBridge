import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProviderThreadListResult, ProviderThreadSummary, ProviderThreadTurn } from '../../types/provider.js';
import type { CodexDesktopTarget } from './desktop_target.js';
import { desktopTargetIdentity, DesktopTargetError } from './desktop_target.js';

const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_PREVIEW_BYTES = 128 * 1024;
const MAX_CANDIDATES = 10_000;
const MAX_DIRECTORIES = 5_000;

export function readDesktopFileSlice(root: string, file: string, maxBytes: number, tail = false): string {
  const canonicalRoot = fs.realpathSync(root);
  const actual = fs.realpathSync(file);
  const relative = path.relative(canonicalRoot, actual);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
    throw new DesktopTargetError('unsafe-storage', '桌面会话文件超出配置目录。');
  }
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink()) { throw new Error('Unsafe desktop session file'); }
  const handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) { throw new Error('Desktop session file changed'); }
    const length = Math.min(stat.size, maxBytes);
    const start = tail ? stat.size - length : 0;
    const buffer = Buffer.alloc(length);
    const count = fs.readSync(handle, buffer, 0, length, start);
    const text = buffer.subarray(0, count).toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally { fs.closeSync(handle); }
}

export function findDesktopRollouts(root: string, threadId?: string): { files: string[]; truncated: boolean } {
  const canonicalRoot = fs.realpathSync(root);
  const stack = [canonicalRoot];
  const files: string[] = [];
  let directories = 0;
  let entries = 0;
  let truncated = false;
  while (stack.length) {
    if (++directories > MAX_DIRECTORIES) { truncated = true; break; }
    const directory = stack.pop()!;
    const iterator = fs.opendirSync(directory);
    try {
      let entry: fs.Dirent | null;
      while ((entry = iterator.readSync())) {
        if (++entries > MAX_CANDIDATES) { truncated = true; break; }
        const name = path.join(directory, entry.name);
        if (entry.isDirectory()) { stack.push(name); }
        else if (entry.isFile() && entry.name.endsWith('.jsonl') && (!threadId || entry.name.includes(threadId))) {
          files.push(name);
        }
      }
    } finally { iterator.closeSync(); }
    if (truncated) { break; }
  }
  return { files, truncated };
}

export function readDesktopRolloutSummary(home: string, file: string): ProviderThreadSummary | null {
  const lines = readDesktopFileSlice(home, file, MAX_HEADER_BYTES).split(/\r?\n/u);
  let metadata: any;
  let preview = '';
  for (const line of lines) {
    let record: any;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.type === 'session_meta' && !metadata) { metadata = record.payload; }
    if (!preview && record.type === 'event_msg' && record.payload?.type === 'user_message') {
      preview = String(record.payload.message ?? '').slice(0, 240);
    }
  }
  if (!metadata || !/^[A-Za-z0-9_-]{1,128}$/u.test(metadata.id)) { return null; }
  return {
    threadId: metadata.id, cwd: typeof metadata.cwd === 'string' ? metadata.cwd : null,
    title: null, preview, updatedAt: fs.statSync(file).mtimeMs, path: file,
  };
}

export class CodexDesktopSessionCatalog {
  private cache: { key: string; token: string; at: number; items: ProviderThreadSummary[]; truncated: boolean } | null = null;
  constructor(readonly target: CodexDesktopTarget) {}

  list({ limit = 10, cursor = null, searchTerm = null }: {
    limit?: number; cursor?: string | null; searchTerm?: string | null;
  } = {}): ProviderThreadListResult {
    const identity = desktopTargetIdentity(this.target);
    const cache = this.inventory(identity.key, Boolean(cursor));
    let offset = 0;
    if (cursor) {
      const parts = cursor.split(':');
      if (parts.length !== 3 || parts[0] !== cache.token || parts[1] !== identity.key || !/^\d+$/u.test(parts[2])) {
        throw new DesktopTargetError('stale-cursor', '会话列表已变化，请重新发送 /enter。');
      }
      offset = Number(parts[2]);
    }
    const query = searchTerm?.toLocaleLowerCase();
    const items = query ? cache.items.filter(item => (item.title + ' ' + item.preview + ' ' + item.threadId).toLocaleLowerCase().includes(query)) : cache.items;
    const pageSize = Math.max(1, Math.min(100, Number.isSafeInteger(limit) ? limit : 10));
    const next = offset + pageSize;
    return {
      items: items.slice(offset, next), nextCursor: next < items.length ? [cache.token, identity.key, next].join(':') : null,
      desktopTarget: identity, truncated: cache.truncated,
    };
  }

  read(threadId: string, includeTurns = false): ProviderThreadSummary | null {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(threadId)) { throw new Error('Invalid desktop thread id'); }
    desktopTargetIdentity(this.target);
    const root = path.join(this.target.home, 'sessions');
    let files: string[];
    try { ({ files } = findDesktopRollouts(root, threadId)); }
    catch { throw new DesktopTargetError('storage-unavailable', '目标桌面 sessions 目录不可读取，请检查共享目录设置。'); }
    const summaries = files.map(file => {
      try { return readDesktopRolloutSummary(this.target.home, file); } catch { return null; }
    })
      .filter(item => item?.threadId === threadId).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const summary = summaries[0] ?? null;
    if (summary) {
      summary.title = this.index().get(threadId)?.title ?? null;
      if (includeTurns) {
        try { summary.turns = readDesktopPreview(this.target.home, summary.path!); }
        catch { throw new DesktopTargetError('stale-rollout', '所选桌面会话记录已变化，请刷新 /enter 后重试。'); }
      }
    }
    return summary;
  }

  private inventory(key: string, retain: boolean) {
    if (this.cache?.key === key && (retain || Date.now() - this.cache.at < 30_000)) { return this.cache; }
    let inventory: ReturnType<typeof findDesktopRollouts>;
    try { inventory = findDesktopRollouts(path.join(this.target.home, 'sessions')); }
    catch { throw new DesktopTargetError('storage-unavailable', '目标桌面 sessions 目录不可读取，请检查共享目录设置。'); }
    const index = this.index();
    const unique = new Map<string, ProviderThreadSummary>();
    for (const file of inventory.files) {
      let summary: ProviderThreadSummary | null;
      try { summary = readDesktopRolloutSummary(this.target.home, file); } catch { continue; }
      if (!summary) { continue; }
      const metadata = index.get(summary.threadId);
      summary.title = metadata?.title ?? null;
      summary.updatedAt = Math.max(summary.updatedAt ?? 0, metadata?.updatedAt ?? 0);
      if (!unique.has(summary.threadId) || (unique.get(summary.threadId)!.updatedAt ?? 0) < (summary.updatedAt ?? 0)) {
        unique.set(summary.threadId, summary);
      }
    }
    this.cache = {
      key, token: randomUUID(), at: Date.now(), truncated: inventory.truncated || this.indexTruncated,
      items: [...unique.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.threadId.localeCompare(b.threadId)),
    };
    return this.cache;
  }

  private indexTruncated = false;
  private index(): Map<string, { title: string; updatedAt: number }> {
    const result = new Map<string, { title: string; updatedAt: number }>();
    const file = path.join(this.target.home, 'session_index.jsonl');
    this.indexTruncated = false;
    let text: string;
    try {
      this.indexTruncated = fs.statSync(file).size > MAX_INDEX_BYTES;
      text = readDesktopFileSlice(this.target.home, file, MAX_INDEX_BYTES, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return result; }
      throw new DesktopTargetError('storage-unavailable', '桌面会话索引不可读取，请检查共享目录设置。');
    }
    const allLines = text.split(/\r?\n/u);
    this.indexTruncated ||= allLines.length > MAX_CANDIDATES + 1;
    const lines = allLines.slice(-MAX_CANDIDATES - 1);
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (typeof record.id === 'string' && typeof record.thread_name === 'string') {
          result.set(record.id, { title: record.thread_name.slice(0, 500), updatedAt: Date.parse(record.updated_at) || 0 });
        }
      } catch { /* An in-flight final index line may be incomplete. */ }
    }
    return result;
  }
}

function readDesktopPreview(home: string, file: string): ProviderThreadTurn[] {
  const turns: ProviderThreadTurn[] = [];
  for (const line of readDesktopFileSlice(home, file, MAX_PREVIEW_BYTES, true).split(/\r?\n/u)) {
    let record: any;
    try { record = JSON.parse(line); } catch { continue; }
    const payload = record.payload;
    const current = turns.at(-1);
    if (record.type === 'event_msg' && current) {
      if (payload?.type === 'task_complete') { current.status = 'completed'; }
      if (payload?.type === 'turn_aborted') { current.status = 'interrupted'; }
      continue;
    }
    if (record.type !== 'response_item' || payload?.type !== 'message' || !['user', 'assistant'].includes(payload.role)
      || (payload.role === 'assistant' && payload.phase && !['commentary', 'final_answer'].includes(payload.phase))) { continue; }
    const text = (Array.isArray(payload.content) ? payload.content : [])
      .filter(item => ['input_text', 'output_text', 'text'].includes(item?.type) && typeof item.text === 'string')
      .map(item => item.text).join('\n').slice(0, 4000);
    if (!text) { continue; }
    if (payload.role === 'user' || !current) {
      turns.push({ id: 'preview-' + turns.length, status: null, error: null, items: [] });
      if (turns.length > 6) { turns.shift(); }
    }
    turns.at(-1)!.items.push({ type: 'message', role: payload.role, phase: payload.phase ?? null, text });
  }
  return turns;
}
