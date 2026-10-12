import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type WeixinDeliveryPurpose = 'progress' | 'final' | 'completion';
export const WEIXIN_REPLY_LIMIT = 10;
export const WEIXIN_FINAL_RESERVE = 3;
const MAX_RECORDS = 256;
const HASH = /^[a-f0-9]{64}$/u;

interface Budget { sent: string[]; warned: boolean; updatedAt: number }
const digest = (...values: string[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex');

/** Conservative local estimate of the observed per-context quota, not a server guarantee. */
export class WeixinReplyBudget {
  private records: Record<string, Budget> = {};

  constructor(private readonly filePath?: string | null) {
    if (!filePath || !fs.existsSync(filePath)) { return; }
    if (fs.statSync(filePath).size > 3 * 1024 * 1024) { throw new Error('WeChat reply budget exceeds size limit'); }
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (saved?.version !== 1 || !saved.records || Array.isArray(saved.records)
      || Object.keys(saved.records).length > MAX_RECORDS) { throw new Error('Invalid WeChat reply budget'); }
    for (const [key, value] of Object.entries(saved.records)) {
      const entry = value as Budget;
      if (!HASH.test(key) || !Array.isArray(entry?.sent) || entry.sent.length > 128
        || !entry.sent.every(id => typeof id === 'string' && HASH.test(id))
        || typeof entry.warned !== 'boolean' || !Number.isFinite(entry.updatedAt)) {
        throw new Error('Invalid WeChat reply budget entry');
      }
      this.records[key] = entry;
    }
  }

  remaining(scope: string, context: string | null): number {
    return Math.max(0, WEIXIN_REPLY_LIMIT - this.get(scope, context).sent.length);
  }

  canSend(scope: string, context: string | null, purpose?: WeixinDeliveryPurpose): boolean {
    // Ordinary command/independent replies retain their existing behavior, but are counted.
    // Critical completion/remainder sends still probe the server after a local estimate reaches zero.
    // Its real allowance may recover independently; the estimate must not disable durable retries.
    if (!purpose || purpose === 'completion') { return true; }
    const reserve = purpose === 'progress' ? WEIXIN_FINAL_RESERVE : 1;
    return this.remaining(scope, context) > reserve;
  }

  shouldWarn(scope: string, context: string | null, purpose?: WeixinDeliveryPurpose): boolean {
    return purpose === 'progress' && this.remaining(scope, context) <= 5 && !this.get(scope, context).warned;
  }

  acknowledge(scope: string, context: string | null, clientId: string, warned = false): void {
    if (!context) { return; }
    const previous = this.get(scope, context);
    const id = digest(clientId);
    this.records[digest(scope, context)] = {
      sent: previous.sent.includes(id) ? previous.sent : [...previous.sent, id].slice(-128),
      warned: previous.warned || warned, updatedAt: Date.now(),
    };
    this.records = Object.fromEntries(Object.entries(this.records).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, MAX_RECORDS));
    if (!this.filePath) { return; }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ version: 1, records: this.records })); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.filePath);
    } finally { if (fs.existsSync(temporary)) { fs.unlinkSync(temporary); } }
  }

  private get(scope: string, context: string | null): Budget {
    return this.records[digest(scope, context ?? '')] ?? { sent: [], warned: false, updatedAt: 0 };
  }
}
