import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Duplex } from 'node:stream';
import { openUnixDesktopTransport, type DesktopIpcTransportFactory } from './desktop_ipc_transport.js';

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

interface IpcMessage {
  type: string;
  requestId?: string;
  method?: string;
  resultType?: string;
  error?: string;
  handledByClientId?: string;
  result?: {
    clientId?: unknown;
    supportsUntrustedAppInput?: unknown;
    result?: { turn?: { id?: unknown } };
  };
}

export interface DesktopTurnSubmitter {
  submitTurn(threadId: string, prompt: string, signal?: AbortSignal): Promise<{ turnId: string }>;
  probeThreadOwner?(threadId: string, signal?: AbortSignal): Promise<{ clientId: string }>;
  ensureThreadOwner?(threadId: string, signal?: AbortSignal): Promise<{ clientId: string }>;
}

export class DesktopIpcSubmissionError extends Error {
  constructor(message: string, readonly outcomeUnknown = false) {
    super(message);
    this.name = 'DesktopIpcSubmissionError';
  }
}

class MissingDesktopThreadOwnerError extends DesktopIpcSubmissionError {}

/** Connects to the desktop owner; it never starts a server or becomes a writer. */
export class CodexDesktopIpcClient implements DesktopTurnSubmitter {
  private readonly timeoutMs: number;
  private readonly hostId: string;
  private readonly openTransport: DesktopIpcTransportFactory;
  private readonly recoverThreadOwner?: (threadId: string, signal?: AbortSignal) => Promise<void>;
  private readonly ownerRecoveryTimeoutMs: number;
  private readonly ownerRecoveryPollIntervalMs: number;

  constructor({
    socketPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'ipc', 'ipc.sock'),
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    hostId = 'local',
    transportFactory,
    recoverThreadOwner,
    ownerRecoveryTimeoutMs = 10_000,
    ownerRecoveryPollIntervalMs = 250,
  }: {
    socketPath?: string; timeoutMs?: number; hostId?: string; transportFactory?: DesktopIpcTransportFactory;
    recoverThreadOwner?: (threadId: string, signal?: AbortSignal) => Promise<void>;
    ownerRecoveryTimeoutMs?: number; ownerRecoveryPollIntervalMs?: number;
  } = {}) {
    if (!path.isAbsolute(socketPath)) { throw new Error('Desktop IPC socket path must be absolute'); }
    if (hostId !== 'local' && !/^remote-wsl:[A-Za-z0-9_.!~*'()%:-]{1,384}$/u.test(hostId)) { throw new Error('Invalid desktop host id'); }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) { throw new Error('Invalid desktop IPC timeout'); }
    if (![ownerRecoveryTimeoutMs, ownerRecoveryPollIntervalMs].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new Error('Invalid desktop owner recovery timing');
    }
    this.timeoutMs = timeoutMs;
    this.hostId = hostId;
    this.openTransport = transportFactory ?? (signal => openUnixDesktopTransport(socketPath, timeoutMs, signal));
    this.recoverThreadOwner = recoverThreadOwner;
    this.ownerRecoveryTimeoutMs = ownerRecoveryTimeoutMs;
    this.ownerRecoveryPollIntervalMs = ownerRecoveryPollIntervalMs;
  }

  async probeThreadOwner(threadId: string, signal?: AbortSignal): Promise<{ clientId: string }> {
    validateThreadId(threadId);
    return this.withConnection(async (connection) => ({ clientId: await this.findOwner(connection, threadId) }), signal);
  }

  /** Entry may wake the existing desktop owner, but never submits input. */
  async ensureThreadOwner(threadId: string, signal?: AbortSignal): Promise<{ clientId: string }> {
    validateThreadId(threadId);
    return this.withConnection(async connection => ({ clientId: await this.findOwnerWithRecovery(connection, threadId, signal) }), signal);
  }

  async submitTurn(threadId: string, prompt: string, signal?: AbortSignal): Promise<{ turnId: string }> {
    validateThreadId(threadId);
    if (!prompt.trim() || prompt.length > 16_000) { throw new Error('Invalid desktop IPC prompt'); }
    return this.withConnection(async (connection) => {
      const owner = await this.findOwnerWithRecovery(connection, threadId, signal);
      let response: IpcMessage;
      try {
        response = await connection.request('thread-follower-start-turn', {
          conversationId: threadId,
          turnStart: {
            request: {
              threadId,
              input: [{ type: 'text', text: prompt, text_elements: [] }],
              clientUserMessageId: randomUUID(),
            },
            context: { inheritThreadSettings: true },
          },
        }, this.hostId === 'local' ? 2 : 3, owner, this.hostId === 'local' ? undefined : this.hostId);
      } catch (error) {
        if (error instanceof DesktopIpcRequestError && !error.dispatched) {
          throw new DesktopIpcSubmissionError('共享消息尚未提交，桌面连接已断开；请重新连接会话。');
        }
        // A disconnect/timeout can happen after desktop acceptance. Never resubmit.
        throw new DesktopIpcSubmissionError('共享消息可能已提交，但未收到桌面确认；请先查看会话输出，不要重复发送。', true);
      }
      if (response.resultType !== 'success') {
        const ambiguous = /timeout|disconnected|closed|outcome.unknown/iu.test(response.error ?? '');
        throw new DesktopIpcSubmissionError(ambiguous
          ? '共享消息可能已提交，但桌面确认中断；请先查看会话输出，不要重复发送。'
          : `桌面拒绝共享消息：${safeProtocolError(response.error)}`, ambiguous);
      }
      const turnId = response.result?.result?.turn?.id;
      if (response.handledByClientId !== owner || typeof turnId !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(turnId)) {
        throw new DesktopIpcSubmissionError('桌面返回了不兼容的提交确认；消息可能已提交，请勿重复发送。', true);
      }
      return { turnId };
    }, signal);
  }

  private async findOwner(connection: DesktopIpcConnection, threadId: string): Promise<string> {
    validateThreadId(threadId);
    const response = await connection.request('thread-owner-discovery', { hostId: this.hostId, conversationId: threadId }, 1);
    if (response.resultType === 'error' && response.error === 'no-client-found') {
      throw new MissingDesktopThreadOwnerError('未找到兼容的桌面会话持有者；请保持桌面端运行，并在桌面打开该会话后重试。');
    }
    if (response.resultType !== 'success' || typeof response.handledByClientId !== 'string'
      || !response.handledByClientId || response.result?.supportsUntrustedAppInput !== true) {
      throw new DesktopIpcSubmissionError('未找到兼容的桌面会话持有者；请保持桌面端运行，并在桌面打开该会话后重试。');
    }
    return response.handledByClientId;
  }

  private async findOwnerWithRecovery(connection: DesktopIpcConnection, threadId: string, signal?: AbortSignal): Promise<string> {
    try { return await this.findOwner(connection, threadId); }
    catch (error) {
      // Only a definite missing owner is recoverable. Protocol errors and
      // ambiguous submissions must never launch a fallback or resend input.
      if (!(error instanceof MissingDesktopThreadOwnerError) || !this.recoverThreadOwner) { throw error; }
    }
    signal?.throwIfAborted();
    try { await this.recoverThreadOwner(threadId, signal); }
    catch {
      signal?.throwIfAborted();
      throw new DesktopIpcSubmissionError('桌面会话自动唤醒失败，未提交消息；请在电脑打开该会话，再重新 /enter 选择。');
    }
    const deadline = Date.now() + this.ownerRecoveryTimeoutMs;
    while (true) {
      signal?.throwIfAborted();
      try { return await this.findOwner(connection, threadId); }
      catch (error) { if (!(error instanceof MissingDesktopThreadOwnerError)) { throw error; } }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new DesktopIpcSubmissionError('桌面会话暂未恢复，未提交消息；请在电脑打开该会话，再重新 /enter 选择。');
      }
      await delay(Math.min(this.ownerRecoveryPollIntervalMs, remainingMs), undefined, { signal });
    }
  }

  private async withConnection<T>(operation: (connection: DesktopIpcConnection) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const transport = await this.openTransport(signal);
    const connection = new DesktopIpcConnection(transport.stream, this.timeoutMs);
    const abort = () => connection.close();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      await connection.connect();
      return await operation(connection);
    } finally {
      signal?.removeEventListener('abort', abort);
      connection.close();
      await transport.close();
    }
  }
}

class DesktopIpcConnection {
  private readonly socket: Duplex;
  private readonly pending = new Map<string, {
    resolve: (response: IpcMessage) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    method: string;
    dispatched: boolean;
  }>();
  private buffer = Buffer.alloc(0);
  private clientId = 'initializing-client';
  private closed = false;

  constructor(socket: Duplex, private readonly timeoutMs: number) {
    this.socket = socket;
    this.socket.on('data', (chunk: Buffer) => this.readFrames(chunk));
    this.socket.on('error', () => this.fail(new Error('Desktop IPC connection failed')));
    this.socket.on('close', () => this.fail(new Error('Desktop IPC connection closed')));
  }

  async connect(): Promise<void> {
    const response = await this.request('initialize', { clientType: 'codexbridge' }, 0);
    if (response.resultType !== 'success' || typeof response.result?.clientId !== 'string' || !response.result.clientId) {
      throw new DesktopIpcSubmissionError('桌面 IPC 初始化失败或协议不兼容。');
    }
    this.clientId = response.result.clientId;
  }

  request(method: string, params: Record<string, unknown>, version: number, targetClientId?: string, hostId?: string): Promise<IpcMessage> {
    if (this.closed || !this.socket.writable) { return Promise.reject(new DesktopIpcRequestError('Desktop IPC is closed', false)); }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('Desktop IPC request timed out')), this.timeoutMs);
      const pending = { resolve, reject, timer, method, dispatched: false };
      this.pending.set(requestId, pending);
      try {
        pending.dispatched = true;
        this.write({ type: 'request', requestId, sourceClientId: this.clientId,
          method, params, version, targetClientId, hostId, timeoutMs: this.timeoutMs });
      } catch {
        this.fail(new Error('Desktop IPC write failed'));
      }
    });
  }

  close(): void { this.fail(new Error('Desktop IPC closed')); }

  private fail(error: Error): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new DesktopIpcRequestError(error.message, pending.dispatched));
    }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
    this.socket.destroy();
  }

  private write(message: Record<string, unknown>): void {
    const payload = Buffer.from(JSON.stringify(message));
    if (payload.length > MAX_FRAME_BYTES) { throw new Error('Desktop IPC frame exceeds limit'); }
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length);
    this.socket.write(Buffer.concat([header, payload]));
  }

  private readFrames(chunk: Buffer): void {
    if (this.closed) { return; }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (this.buffer.length >= 4) {
        const size = this.buffer.readUInt32LE(0);
        if (size === 0 || size > MAX_FRAME_BYTES) { throw new Error('Invalid desktop IPC frame size'); }
        if (this.buffer.length < size + 4) { return; }
        const message = JSON.parse(this.buffer.subarray(4, size + 4).toString('utf8')) as IpcMessage;
        this.buffer = this.buffer.subarray(size + 4);
        if (!message || typeof message !== 'object' || Array.isArray(message)) { throw new Error('Invalid desktop IPC message'); }
        if (message.type === 'client-discovery-request') {
          this.write({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
        } else if (message.type === 'response') {
          const pending = this.pending.get(message.requestId ?? '');
          if (!pending) { continue; }
          if (message.resultType !== 'error' && (message.resultType !== 'success' || message.method !== pending.method)) {
            throw new Error('Desktop IPC response protocol mismatch');
          }
          clearTimeout(pending.timer);
          this.pending.delete(message.requestId!);
          pending.resolve(message);
        }
      }
    } catch {
      this.fail(new Error('Invalid desktop IPC response'));
    }
  }
}

class DesktopIpcRequestError extends Error {
  constructor(message: string, readonly dispatched: boolean) { super(message); }
}

function validateThreadId(threadId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(threadId)) { throw new Error('Invalid desktop thread id'); }
}

function safeProtocolError(value: unknown): string {
  // Desktop errors can include task paths/text. Only expose recognized protocol codes.
  const code = String(value ?? '');
  return ['request-version-mismatch', 'no-client-found', 'no-handler-for-request', 'client-not-found'].includes(code)
    ? code : '会话暂不可用，请在桌面检查状态后重试。';
}
