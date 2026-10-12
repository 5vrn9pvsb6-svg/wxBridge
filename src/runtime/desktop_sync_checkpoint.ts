import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

interface Checkpoint {
  chunks: string[];
  finalDelivered: boolean;
  noticeDelivered: boolean;
  updatedAt: number;
  progressBatch?: { text: string; chunks: string[] } | null;
}

const MAX_TURNS = 256;
const MAX_CHUNKS = 4096;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/u;

export function desktopSyncKey(...parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** Private acknowledgements plus at most one frozen, unacknowledged progress batch per turn. */
export class DesktopSyncCheckpointStore {
  private records: Record<string, Checkpoint> = {};

  constructor(private readonly filePath?: string | null) {
    if (!filePath || !fs.existsSync(filePath)) { return; }
    if (fs.statSync(filePath).size > MAX_FILE_BYTES) { throw new Error('Desktop sync checkpoint exceeds its size limit'); }
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (saved?.version !== 1 || !saved.turns || typeof saved.turns !== 'object' || Array.isArray(saved.turns)) {
      throw new Error('Invalid desktop sync checkpoint');
    }
    for (const [key, value] of Object.entries(saved.turns)) {
      const entry = value as Checkpoint;
      if (!HASH.test(key) || !Array.isArray(entry?.chunks) || entry.chunks.length > MAX_CHUNKS
        || !entry.chunks.every((hash) => typeof hash === 'string' && HASH.test(hash))
        || typeof entry.finalDelivered !== 'boolean' || typeof entry.noticeDelivered !== 'boolean'
        || (entry.progressBatch != null && (typeof entry.progressBatch.text !== 'string'
          || Buffer.byteLength(entry.progressBatch.text, 'utf8') > 64 * 1024
          || !Array.isArray(entry.progressBatch.chunks) || entry.progressBatch.chunks.length > MAX_CHUNKS
          || !entry.progressBatch.chunks.every(hash => typeof hash === 'string' && HASH.test(hash))))
        || !Number.isFinite(entry.updatedAt)) { throw new Error('Invalid desktop sync checkpoint entry'); }
      this.records[key] = entry;
    }
    this.prune();
  }

  get(key: string): Readonly<Checkpoint> {
    return this.records[key] ?? { chunks: [], finalDelivered: false, noticeDelivered: false, updatedAt: 0 };
  }

  acknowledgeChunk(key: string, chunk: string): void {
    if (this.get(key).chunks.includes(chunk)) { return; }
    if (this.get(key).chunks.length >= MAX_CHUNKS) { throw new Error('Desktop sync turn exceeds its checkpoint limit'); }
    this.update(key, { chunks: [...this.get(key).chunks, chunk] });
  }

  markFinalDelivered(key: string): void { this.update(key, { finalDelivered: true }); }
  markNoticeDelivered(key: string): void { this.update(key, { noticeDelivered: true }); }
  setProgressBatch(key: string, progressBatch: Checkpoint['progressBatch']): void { this.update(key, { progressBatch }); }
  acknowledgeProgressBatch(key: string): void {
    const record = this.get(key);
    const chunks = [...new Set([...record.chunks, ...(record.progressBatch?.chunks ?? [])])];
    if (chunks.length > MAX_CHUNKS) { throw new Error('Desktop sync turn exceeds its checkpoint limit'); }
    this.update(key, { chunks, progressBatch: null });
  }

  private update(key: string, fields: Partial<Checkpoint>): void {
    this.records[key] = { ...this.get(key), ...fields, updatedAt: Date.now() };
    this.prune();
    if (!this.filePath) { return; }
    const serialized = `${JSON.stringify({ version: 1, turns: this.records })}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_FILE_BYTES) { throw new Error('Desktop sync checkpoint exceeds its size limit'); }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      const descriptor = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, serialized);
        fs.fsyncSync(descriptor);
      } finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, this.filePath);
    } finally {
      if (fs.existsSync(temporary)) { fs.unlinkSync(temporary); }
    }
  }

  private prune(): void {
    const entries = Object.entries(this.records).sort((left, right) => right[1].updatedAt - left[1].updatedAt);
    this.records = Object.fromEntries(entries.slice(0, MAX_TURNS));
  }
}
