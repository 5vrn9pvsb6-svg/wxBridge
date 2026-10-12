import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { InboundTextEvent } from '../types/platform.js';
import type { ProviderDesktopThreadEvent } from '../types/provider.js';
import { desktopSyncKey } from './desktop_sync_checkpoint.js';

export interface DesktopOutputIdentity {
  event: Pick<InboundTextEvent, 'platform' | 'externalScopeId'>;
  bindingKey: string;
  turnId: string;
  cwd: string | null;
}

export interface DesktopOutputTurn extends DesktopOutputIdentity {
  key: string;
  segments: Array<{ phase: 'commentary' | 'final_answer'; text: string }>;
  completion: { kind: 'complete' | 'failed'; text: string; durationMs?: number | null } | null;
  revision: number;
  deliveredRevision: number;
  attempts: number;
  retryAt: number;
}

const MAX_TURNS = 256;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_TURN_BYTES = 1024 * 1024;

/** Bounded durable outbox. Transport failures never escape into the provider's observer. */
export class DesktopOutputQueue {
  private turns: DesktopOutputTurn[] = [];
  private workers = new Map<string, { controller: AbortController; task: Promise<void> }>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private storageRetryAt = new Map<string, number>();
  private stopped = false;

  constructor(private readonly options: {
    filePath?: string | null;
    isCurrent: (turn: DesktopOutputIdentity) => boolean;
    deliver: (turn: DesktopOutputTurn, signal: AbortSignal) => Promise<boolean>;
    onError: (error: unknown) => Promise<void> | void;
    retryBaseMs?: number;
    retryMaxMs?: number;
    progressBatchMs?: number;
  }) {
    if (!options.filePath || !fs.existsSync(options.filePath)) { return; }
    if (fs.statSync(options.filePath).size > MAX_BYTES) { throw new Error('Desktop output queue exceeds size limit'); }
    const saved = JSON.parse(fs.readFileSync(options.filePath, 'utf8'));
    if (saved?.version !== 1 || !Array.isArray(saved.turns) || saved.turns.length > MAX_TURNS
      || !saved.turns.every(validTurn) || new Set(saved.turns.map(turn => turn.key)).size !== saved.turns.length) {
      throw new Error('Invalid desktop output queue');
    }
    this.turns = saved.turns;
  }

  async segment(identity: DesktopOutputIdentity, phase: string, text: string): Promise<void> {
    if (!['commentary', 'final_answer'].includes(phase) || !text.trim() || !this.options.isCurrent(identity)) { return; }
    this.update(identity, turn => {
      if (turn.segments.some(item => item.phase === phase && item.text === text)) { return false; }
      turn.segments.push({ phase: phase as 'commentary' | 'final_answer', text });
      if (phase === 'commentary' && turn.revision === turn.deliveredRevision) {
        turn.retryAt = Date.now() + (this.options.progressBatchMs ?? 0);
      }
      if (phase === 'final_answer') { turn.retryAt = 0; }
      return true;
    });
    await this.flush(scopeKey(identity));
  }

  async complete(identity: DesktopOutputIdentity, update: Pick<ProviderDesktopThreadEvent, 'kind' | 'text' | 'durationMs'>): Promise<void> {
    if (!this.options.isCurrent(identity)) { return; }
    this.update(identity, turn => {
      turn.completion = { kind: update.kind === 'failed' ? 'failed' : 'complete', text: update.text, durationMs: update.durationMs ?? null };
      turn.retryAt = 0;
      return true;
    });
    await this.flush(scopeKey(identity));
  }

  /** Called after a binding command and at startup, before any pending send. */
  reconcile(): void {
    const stale = this.turns.filter(turn => !this.options.isCurrent(turn));
    for (const turn of stale) { this.workers.get(scopeKey(turn))?.controller.abort(); }
    if (stale.length) { this.save(this.turns.filter(turn => !stale.includes(turn))); }
  }

  wake(event?: Pick<InboundTextEvent, 'platform' | 'externalScopeId'>): void {
    if (this.stopped) { return; }
    this.reconcile();
    const scope = event ? scopeKey({ event }) : null;
    this.save(this.turns.map(turn => (!scope || scopeKey(turn) === scope) ? { ...turn, retryAt: 0 } : turn));
    for (const key of new Set(this.turns.map(scopeKey))) {
      if (!scope || key === scope) { void this.flush(key).catch(error => this.report(error)); }
    }
  }

  resume(): void { this.stopped = false; this.wake(); }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) { clearTimeout(timer); }
    this.timers.clear();
    for (const worker of this.workers.values()) { worker.controller.abort(); }
    await Promise.allSettled([...this.workers.values()].map(worker => worker.task));
  }

  private update(identity: DesktopOutputIdentity, change: (turn: DesktopOutputTurn) => boolean): void {
    const key = desktopSyncKey(identity.event.platform, identity.event.externalScopeId, identity.bindingKey, identity.turnId);
    const previous = this.turns.find(turn => turn.key === key);
    const turn: DesktopOutputTurn = previous ? structuredClone(previous) : {
      ...identity, event: { platform: identity.event.platform, externalScopeId: identity.event.externalScopeId }, key,
      segments: [], completion: null, revision: 0, deliveredRevision: 0, attempts: 0, retryAt: 0,
    };
    if (!change(turn)) { return; }
    turn.revision += 1;
    if (Buffer.byteLength(JSON.stringify(turn), 'utf8') > MAX_TURN_BYTES) { throw new Error('Desktop output turn exceeds size limit'); }
    this.save(previous ? this.turns.map(item => item.key === key ? turn : item) : [...this.turns, turn]);
  }

  private async flush(scope: string): Promise<void> {
    if (this.stopped) { return; }
    const active = this.workers.get(scope);
    if (active) { await active.task; return; }
    const timer = this.timers.get(scope);
    if (timer) { clearTimeout(timer); this.timers.delete(scope); }
    const worker = { controller: new AbortController(), task: Promise.resolve() };
    this.workers.set(scope, worker);
    worker.task = Promise.resolve().then(() => this.drain(scope, worker.controller.signal)).catch(async error => {
      // A full disk or failed atomic rename must not create a zero-delay retry loop.
      this.storageRetryAt.set(scope, Date.now() + (this.options.retryMaxMs ?? 60_000));
      await this.report(error);
    }).finally(() => {
      this.workers.delete(scope);
      this.schedule(scope);
    });
    await worker.task;
  }

  private async drain(scope: string, signal: AbortSignal): Promise<void> {
    while (!this.stopped && !signal.aborted) {
      this.reconcile();
      const next = this.pending(scope);
      if (!next || Math.max(next.retryAt, this.storageRetryAt.get(scope) ?? 0) > Date.now() || signal.aborted) { return; }
      const snapshot = structuredClone(next);
      let delivered = false;
      let failure: unknown;
      try { delivered = await this.options.deliver(snapshot, signal); }
      catch (error) { failure = error; }
      if (signal.aborted) { return; }
      const current = this.turns.find(turn => turn.key === snapshot.key);
      if (!current) { continue; }
      if (delivered) {
        this.save(snapshot.completion && current.revision === snapshot.revision
          ? this.turns.filter(turn => turn.key !== snapshot.key)
          : this.turns.map(turn => turn.key === snapshot.key ? {
            ...turn, deliveredRevision: snapshot.revision, attempts: 0, retryAt: 0,
          } : turn));
        this.storageRetryAt.delete(scope);
      } else {
        const attempts = current.attempts + 1;
        // Keep probing independently of inbound messages or foreground notifications.
        // The outbox owns retries; repeated rejections must not stretch the recovery window.
        const delay = Math.max(1, Math.min(this.options.retryMaxMs ?? 60_000, this.options.retryBaseMs ?? 5_000));
        this.save(this.turns.map(turn => turn.key === snapshot.key ? { ...turn, attempts, retryAt: Date.now() + delay } : turn));
        if (failure && (attempts === 1 || attempts % 10 === 0)) { await this.report(failure); }
        return;
      }
    }
  }

  private pending(scope: string): DesktopOutputTurn | undefined {
    return this.turns.find(turn => scopeKey(turn) === scope && turn.revision > turn.deliveredRevision);
  }

  private schedule(scope: string): void {
    if (this.stopped || this.timers.has(scope)) { return; }
    const next = this.pending(scope);
    if (!next) { return; }
    const timer = setTimeout(() => {
      this.timers.delete(scope);
      void this.flush(scope).catch(error => this.report(error));
    }, Math.max(0, Math.max(next.retryAt, this.storageRetryAt.get(scope) ?? 0) - Date.now()));
    timer.unref();
    this.timers.set(scope, timer);
  }

  private async report(error: unknown): Promise<void> {
    try { await this.options.onError(error); } catch { /* Diagnostics must not stop recovery. */ }
  }

  private save(turns: DesktopOutputTurn[]): void {
    const serialized = JSON.stringify({ version: 1, turns });
    if (turns.length > MAX_TURNS || Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) {
      throw new Error('Desktop output queue is full; pending output was retained');
    }
    if (this.options.filePath) {
      const file = this.options.filePath;
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const fd = fs.openSync(temporary, 'wx', 0o600);
        try { fs.writeFileSync(fd, serialized); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(temporary, file);
      } finally { if (fs.existsSync(temporary)) { fs.unlinkSync(temporary); } }
    }
    this.turns = turns;
  }
}

function scopeKey(identity: { event: Pick<InboundTextEvent, 'platform' | 'externalScopeId'> }): string {
  return desktopSyncKey(identity.event.platform, identity.event.externalScopeId);
}

function validTurn(turn: any): boolean {
  return turn && typeof turn.event?.platform === 'string' && typeof turn.event?.externalScopeId === 'string'
    && typeof turn.bindingKey === 'string' && typeof turn.turnId === 'string'
    && (turn.cwd === null || typeof turn.cwd === 'string')
    && turn.key === desktopSyncKey(turn.event.platform, turn.event.externalScopeId, turn.bindingKey, turn.turnId)
    && Array.isArray(turn.segments) && turn.segments.every(item => ['commentary', 'final_answer'].includes(item?.phase) && typeof item?.text === 'string')
    && (turn.completion === null || (['complete', 'failed'].includes(turn.completion?.kind) && typeof turn.completion.text === 'string'
      && (turn.completion.durationMs === null || (Number.isFinite(turn.completion.durationMs) && turn.completion.durationMs >= 0))))
    && ['revision', 'deliveredRevision', 'attempts', 'retryAt'].every(key => Number.isSafeInteger(turn[key]) && turn[key] >= 0)
    && turn.deliveredRevision <= turn.revision && Buffer.byteLength(JSON.stringify(turn), 'utf8') <= MAX_TURN_BYTES;
}
