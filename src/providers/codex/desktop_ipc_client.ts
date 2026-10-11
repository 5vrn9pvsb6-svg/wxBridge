import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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
  submitTurn(threadId: string, prompt: string): Promise<{ turnId: string }>;
}

export class DesktopIpcSubmissionError extends Error {
  constructor(message: string, readonly outcomeUnknown = false) {
    super(message);
    this.name = 'DesktopIpcSubmissionError';
  }
}

/** Connects to the desktop owner; it never starts a server or becomes a writer. */
export class CodexDesktopIpcClient implements DesktopTurnSubmitter {
  private readonly socketPath: string;
  private readonly timeoutMs: number;

  constructor({
    socketPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'ipc', 'ipc.sock'),
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  }: { socketPath?: string; timeoutMs?: number } = {}) {
    if (!path.isAbsolute(socketPath)) { throw new Error('Desktop IPC socket path must be absolute'); }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) { throw new Error('Invalid desktop IPC timeout'); }
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  async probeThreadOwner(threadId: string): Promise<{ clientId: string }> {
    return this.withConnection(async (connection) => ({ clientId: await this.findOwner(connection, threadId) }));
  }

  async submitTurn(threadId: string, prompt: string): Promise<{ turnId: string }> {
    validateThreadId(threadId);
    if (!prompt.trim() || prompt.length > 16_000) { throw new Error('Invalid desktop IPC prompt'); }
    return this.withConnection(async (connection) => {
      const owner = await this.findOwner(connection, threadId);
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
        }, 2, owner);
      } catch {
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
    });
  }

  private async findOwner(connection: DesktopIpcConnection, threadId: string): Promise<string> {
    validateThreadId(threadId);
    const response = await connection.request('thread-owner-discovery', { hostId: 'local', conversationId: threadId }, 1);
    if (response.resultType !== 'success' || typeof response.handledByClientId !== 'string'
      || !response.handledByClientId || response.result?.supportsUntrustedAppInput !== true) {
      throw new DesktopIpcSubmissionError('未找到兼容的桌面会话持有者；请保持桌面端运行，并在桌面打开该会话后重试。');
    }
    return response.handledByClientId;
  }

  private async withConnection<T>(operation: (connection: DesktopIpcConnection) => Promise<T>): Promise<T> {
    assertPrivateSocket(this.socketPath);
    const connection = new DesktopIpcConnection(this.socketPath, this.timeoutMs);
    try {
      await connection.connect();
      return await operation(connection);
    } finally {
      connection.close();
    }
  }
}

class DesktopIpcConnection {
  private readonly socket: net.Socket;
  private readonly pending = new Map<string, {
    resolve: (response: IpcMessage) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    method: string;
  }>();
  private buffer = Buffer.alloc(0);
  private clientId = 'initializing-client';
  private closed = false;

  constructor(socketPath: string, private readonly timeoutMs: number) {
    this.socket = net.createConnection(socketPath);
    this.socket.on('data', (chunk: Buffer) => this.readFrames(chunk));
    this.socket.on('error', () => this.fail(new Error('Desktop IPC connection failed')));
    this.socket.on('close', () => this.fail(new Error('Desktop IPC connection closed')));
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.off('connect', connected);
        this.socket.off('error', failed);
        this.socket.off('close', failed);
      };
      const connected = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new DesktopIpcSubmissionError('无法连接桌面共享服务；请保持桌面端运行。')); };
      const timer = setTimeout(failed, this.timeoutMs);
      this.socket.once('connect', connected);
      this.socket.once('error', failed);
      this.socket.once('close', failed);
    });
    const response = await this.request('initialize', { clientType: 'codexbridge' }, 0);
    if (response.resultType !== 'success' || typeof response.result?.clientId !== 'string' || !response.result.clientId) {
      throw new DesktopIpcSubmissionError('桌面 IPC 初始化失败或协议不兼容。');
    }
    this.clientId = response.result.clientId;
  }

  request(method: string, params: Record<string, unknown>, version: number, targetClientId?: string): Promise<IpcMessage> {
    if (this.closed || !this.socket.writable) { return Promise.reject(new Error('Desktop IPC is closed')); }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('Desktop IPC request timed out')), this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, method });
      try {
        this.write({ type: 'request', requestId, sourceClientId: this.clientId,
          method, params, version, targetClientId, timeoutMs: this.timeoutMs });
      } catch {
        this.fail(new Error('Desktop IPC write failed'));
      }
    });
  }

  close(): void { this.fail(new Error('Desktop IPC closed')); }

  private fail(error: Error): void {
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
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

function validateThreadId(threadId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(threadId)) { throw new Error('Invalid desktop thread id'); }
}

function assertPrivateSocket(socketPath: string): void {
  const uid = process.getuid?.();
  try {
    const socket = fs.lstatSync(socketPath);
    const directory = fs.lstatSync(path.dirname(socketPath));
    if (uid === undefined || !socket.isSocket() || socket.uid !== uid || socket.mode & 0o022
      || !directory.isDirectory() || directory.uid !== uid || directory.mode & 0o022) {
      throw new Error('Unsafe socket ownership or permissions');
    }
  } catch {
    throw new DesktopIpcSubmissionError('桌面 IPC 入口不存在或权限不安全；请保持桌面端运行。');
  }
}

function safeProtocolError(value: unknown): string {
  // Desktop errors can include task paths/text. Only expose recognized protocol codes.
  const code = String(value ?? '');
  return ['request-version-mismatch', 'no-client-found', 'no-handler-for-request', 'client-not-found'].includes(code)
    ? code : '会话暂不可用，请在桌面检查状态后重试。';
}
