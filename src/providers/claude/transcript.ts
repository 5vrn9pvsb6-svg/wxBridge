import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { ProviderDesktopThreadEvent } from '../../types/provider.js';
import { parseRecords, visibleText } from './session_catalog.js';

const READ_LIMIT = 512 * 1024;
const SNAPSHOT_LIMIT = 8 * 1024 * 1024;
export class ClaudeTranscriptReader {
  private offset = 0;
  private pending = '';
  private decoder = new StringDecoder('utf8');
  private identity = '';
  private seen = new Set<string>();
  private turnId: string | null = null;
  private startedAt = 0;
  private finalText = '';
  private active: ProviderDesktopThreadEvent[] = [];
  private initialized = false;

  constructor(readonly file: string, readonly sessionId: string, readonly minTimestamp = 0) {}
  get activeTurnId(): string | null { return this.turnId; }
  get activeEvents(): ProviderDesktopThreadEvent[] { return [...this.active]; }

  async read(): Promise<ProviderDesktopThreadEvent[]> {
    let handle;
    try { handle = await fs.open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; } throw error; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) { throw new Error('Claude transcript is not a regular file.'); }
      const identity = `${stat.dev}:${stat.ino}`;
      if (identity !== this.identity || stat.size < this.offset) {
        this.identity = identity; this.pending = ''; this.decoder = new StringDecoder('utf8');
        this.offset = Math.max(0, stat.size - SNAPSHOT_LIMIT); this.seen.clear();
        this.turnId = null; this.active = []; this.finalText = ''; this.initialized = false;
        if (this.offset) {
          const prefix = Buffer.alloc(READ_LIMIT);
          const { bytesRead } = await handle.read(prefix, 0, prefix.length, this.offset);
          const newline = prefix.subarray(0, bytesRead).indexOf(10);
          this.offset += newline < 0 ? bytesRead : newline + 1;
        }
      }
      const events: ProviderDesktopThreadEvent[] = [];
      // At most 512 KiB per poll; offsets and UTF-8 decoder preserve split records.
      const buffer = Buffer.alloc(Math.min(this.initialized ? READ_LIMIT : SNAPSHOT_LIMIT, Math.max(0, stat.size - this.offset)));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset);
      this.offset += bytesRead;
      this.pending += this.decoder.write(buffer.subarray(0, bytesRead));
      const end = this.pending.lastIndexOf('\n');
      if (end >= 0) {
        for (const record of parseRecords(this.pending.slice(0, end))) { events.push(...this.consume(record)); }
        this.pending = this.pending.slice(end + 1);
      }
      if (this.pending.length > 1024 * 1024) { throw new Error('Claude transcript record exceeds size limit.'); }
      if (!this.initialized) {
        this.initialized = true;
        // Start at the unfinished current turn, never replay completed history.
        return this.activeEvents;
      }
      return events;
    } finally { await handle.close(); }
  }

  private consume(record: any): ProviderDesktopThreadEvent[] {
    if (record.isSidechain || (record.sessionId && record.sessionId !== this.sessionId)) { return []; }
    const text = visibleText(record);
    const timestamp = Date.parse(record.timestamp ?? '');
    const channelInput = record.origin?.kind === 'channel' || /^<channel\s+source=["']codexbridge-weixin["']/u.test(text);
    if (record.type === 'user' && (!record.isMeta || channelInput) && text && !record.toolUseResult) {
      if (Number.isFinite(timestamp) && timestamp < this.minTimestamp) { return []; }
      const requestId = channelInput ? /<channel\b[^>]*\bcodex_request_id=["']([0-9a-f-]{36})["']/iu.exec(text)?.[1] : undefined;
      const id = requestId ?? record.uuid;
      if (typeof id !== 'string' || id === this.turnId) { return []; }
      this.turnId = id; this.startedAt = Number.isFinite(timestamp) ? timestamp : Date.now();
      this.finalText = ''; this.seen.clear();
      const event: ProviderDesktopThreadEvent = { kind: 'started', turnId: id, text: '' };
      this.active = [event]; return [event];
    }
    if (!this.turnId) { return []; }
    if (record.type === 'assistant' && text) {
      const key = `${record.message?.id ?? record.uuid}:${text}`;
      if (this.seen.has(key)) { return []; }
      this.seen.add(key);
      if (this.seen.size > 2000) { this.seen.delete(this.seen.values().next().value!); }
      const outputKind = record.message?.stop_reason === 'end_turn' ? 'final_answer' : 'commentary';
      if (outputKind === 'final_answer') { this.finalText += `${this.finalText ? '\n\n' : ''}${text}`; }
      const event: ProviderDesktopThreadEvent = { kind: 'progress', turnId: this.turnId, text, outputKind };
      this.active.push(event);
      if (this.active.reduce((size, item) => size + item.text.length, 0) > 1024 * 1024) {
        throw new Error('Claude active turn exceeds synchronization size limit.');
      }
      return [event];
    }
    if (record.type === 'system' && record.subtype === 'turn_duration') {
      const event: ProviderDesktopThreadEvent = { kind: 'complete', turnId: this.turnId, text: this.finalText,
        durationMs: typeof record.durationMs === 'number' && record.durationMs >= 0
          ? record.durationMs : Math.max(0, (Number.isFinite(timestamp) ? timestamp : Date.now()) - this.startedAt) };
      this.turnId = null; this.active = []; this.finalText = ''; return [event];
    }
    return [];
  }
}

export function waitForPoll(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) { return Promise.resolve(); }
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms); signal?.addEventListener('abort', finish, { once: true });
  });
}
