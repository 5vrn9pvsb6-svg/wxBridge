import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { ProviderPluginContract, ProviderProfile, ProviderTurnEvent, ProviderTurnResult,
  ProviderDesktopThreadEvent, ProviderThreadTurn } from '../../types/provider.js';
import { ClaudeChannelClient } from './channel_client.js';
import { ClaudeSessionCatalog, requireSessionId } from './session_catalog.js';
import { ClaudeTranscriptReader, waitForPoll } from './transcript.js';

export function createClaudeCodeProfile(): ProviderProfile {
  return { id: 'claude-code', providerKind: 'claude-code', displayName: 'Claude Code',
    config: { sharedOnly: true }, createdAt: 0, updatedAt: 0 };
}

export class ClaudeCodeProviderPlugin implements ProviderPluginContract {
  readonly kind = 'claude-code';
  readonly displayName = 'Claude Code';
  readonly catalog: ClaudeSessionCatalog;
  readonly channel: ClaudeChannelClient;
  private readonly ownedTurns = new Set<string>();
  private readonly ownedThreads = new Set<string>();
  private readonly interruptedTurns = new Set<string>();
  private readonly pendingInterrupts = new Map<string, Promise<unknown>>();
  private readonly turnStates = new Map<string, ProviderThreadTurn>();
  private readonly pollMs: number;
  private readonly correlationTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly shutdown = new AbortController();
  private readonly stateDir: string;

  constructor(options: { stateDir?: string; projectsDir?: string;
    pollMs?: number; correlationTimeoutMs?: number; turnTimeoutMs?: number } = {}) {
    this.catalog = new ClaudeSessionCatalog(options.projectsDir);
    this.stateDir = options.stateDir ?? path.join(os.homedir(), '.codexbridge');
    this.channel = new ClaudeChannelClient(path.join(this.stateDir, 'claude-channels'));
    this.pollMs = options.pollMs ?? 400;
    this.correlationTimeoutMs = options.correlationTimeoutMs ?? 60000;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 30 * 60 * 1000;
  }
  isDesktopThreadRelayAvailable(event: ProviderTurnEvent): boolean { return event.platform === 'weixin'; }
  async stop(): Promise<void> { this.shutdown.abort(); }

  async prepareDesktopThreadSharing({ threadId }: { threadId: string }): Promise<void> {
    if (!await this.catalog.read(threadId)) { throw new Error('找不到这个本地 Claude Code 会话。'); }
    try { await this.channel.request(threadId, { op: 'probe', requestId: randomUUID() }); }
    catch {
      const cliFile = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../../cli.ts' : '../../cli.js', import.meta.url));
      const quote = (value: string) => `'${value.replace(/'/gu, `'\\''`)}'`;
      const loader = fileURLToPath(import.meta.resolve('tsx'));
      throw new Error(`这个 Claude Code 会话尚未启用微信通道。请在电脑终端运行：\n${quote(process.execPath)} --import ${quote(loader)} ${quote(cliFile)} claude share ${requireSessionId(threadId)} --state-dir ${quote(this.stateDir)}\n如果原会话仍在运行，先结束该进程再恢复；确认 Claude 的通道启用提示后，再在微信 /enter <序号>。会恢复原会话，不新建副本。`);
    }
  }
  async startThread(_params: Parameters<ProviderPluginContract['startThread']>[0]): Promise<never> {
    throw new Error('Claude Code 适配器用于共享电脑会话。请发送 /enter claude 选择会话；退出后返回微信原来的独立会话。');
  }
  async readThread({ threadId, includeTurns }: Parameters<ProviderPluginContract['readThread']>[0]) {
    const session = await this.catalog.read(threadId);
    if (!session || !includeTurns) { return session; }
    const localTurn = this.turnStates.get(threadId);
    const turns = localTurn ? [localTurn] : [];
    if (localTurn?.status !== 'inProgress') {
      try {
        const owner = await this.channel.request(threadId, { op: 'probe', requestId: randomUUID() });
        if (owner.activeTurnId && owner.activeTurnId !== localTurn?.id) {
          turns.push({ id: owner.activeTurnId, status: 'inProgress', error: null, items: [] });
        }
      } catch { /* An unavailable owner cannot accept another message. */ }
    }
    return { ...session, turns };
  }
  async listThreads({ limit = 10, cursor = null, searchTerm = null, archived = false }: Parameters<ProviderPluginContract['listThreads']>[0]) {
    if (archived) { return { items: [], nextCursor: null }; }
    const term = searchTerm?.toLowerCase();
    const sessions = (await this.catalog.list()).filter((session) => !term
      || `${session.title} ${session.cwd} ${session.threadId}`.toLowerCase().includes(term));
    const start = cursor && /^\d+$/u.test(cursor) ? Number(cursor) : 0;
    const count = Math.min(100, Math.max(1, limit));
    const items = sessions.slice(start, start + count);
    return { items, nextCursor: start + count < sessions.length ? String(start + count) : null };
  }

  async observeDesktopThread({ threadId, signal, onEvent }: {
    threadId: string; signal: AbortSignal; onEvent: (event: ProviderDesktopThreadEvent) => Promise<void> | void;
  }): Promise<void> {
    const session = await this.catalog.read(threadId);
    if (!session?.path) { throw new Error('Claude 会话记录不存在。'); }
    const owner = await this.channel.request(threadId, { op: 'probe', requestId: randomUUID() });
    const reader = new ClaudeTranscriptReader(session.path, threadId, owner.connectedAt ?? 0);
    let pending: ProviderDesktopThreadEvent[] = [];
    while (!signal.aborted) {
      if (this.ownedThreads.has(threadId)) { await waitForPoll(this.pollMs, signal); continue; }
      if (!pending.length) { pending = await reader.read(); }
      // Submission can begin during the asynchronous file read. Retain the batch
      // until its outcome is known rather than dropping possibly accepted output.
      if (this.ownedThreads.has(threadId)) { continue; }
      for (const event of pending) {
        if (signal.aborted) { return; }
        if (this.ownedTurns.has(event.turnId)) { continue; }
        if (event.kind === 'complete') {
          await this.pendingInterrupts.get(event.turnId)?.catch(() => {});
          if (this.interruptedTurns.delete(event.turnId)) {
            await onEvent({ ...event, kind: 'failed', text: 'Claude 回合已请求中断。' }); continue;
          }
        }
        await onEvent(event);
      }
      pending = [];
      await waitForPoll(this.pollMs, signal);
    }
  }

  async startTurn(params: Parameters<ProviderPluginContract['startTurn']>[0]): Promise<ProviderTurnResult> {
    const { event, bridgeSession, inputText } = params;
    if ((event.attachments ?? []).some((attachment) => attachment.kind !== 'voice' || !attachment.transcriptText?.trim())) {
      throw new Error('Claude Code 目前支持文字和已转写语音；发送图片或文件前请先 /exit。');
    }
    if ((event.metadata?.codexbridge as any)?.executionMode !== 'desktop_shared') {
      throw new Error('请先使用 /enter claude 和 /enter <序号> 进入 Claude 共享会话。');
    }
    const threadId = requireSessionId(bridgeSession.codexThreadId);
    const session = await this.catalog.read(threadId);
    if (!session?.path) { throw new Error('Claude 会话记录不存在。'); }
    const reader = new ClaudeTranscriptReader(session.path, threadId);
    await reader.read();
    if (this.ownedThreads.has(threadId)) { throw new Error('这个 Claude 会话有微信回复正在进行，请等待完成。'); }
    this.ownedThreads.add(threadId);
    const turnId = randomUUID();
    this.ownedTurns.add(turnId);
    this.turnStates.set(threadId, { id: turnId, status: 'inProgress', error: null, items: [] });
    if (this.turnStates.size > 256) { this.turnStates.delete(this.turnStates.keys().next().value!); }
    if (this.ownedTurns.size > 4096) { this.ownedTurns.delete(this.ownedTurns.values().next().value!); }
    try {
      // Shared execution sends to the existing owner only. Never spawn --resume here.
      await this.channel.request(threadId, { op: 'submit', requestId: turnId, text: inputText });
      await params.onTurnStarted?.({ threadId, turnId, providerProfileId: params.providerProfile.id, bridgeSessionId: bridgeSession.id });
      const started = Date.now(); let correlated = false; let finalText = '';
      while (!this.shutdown.signal.aborted && Date.now() - started < this.turnTimeoutMs) {
        for (const event of await reader.read()) {
          if (event.turnId !== turnId) { continue; }
          correlated = true;
          if (event.kind === 'progress') {
            if (event.outputKind === 'final_answer') { finalText += `${finalText ? '\n\n' : ''}${event.text}`; }
            await params.onProgress?.({ text: event.outputKind === 'final_answer' ? finalText : event.text,
              delta: `${event.outputKind === 'final_answer' && finalText !== event.text ? '\n\n' : ''}${event.text}`,
              outputKind: event.outputKind ?? 'commentary' });
          }
          if (event.kind === 'complete' || event.kind === 'failed') {
            await this.pendingInterrupts.get(turnId)?.catch(() => {});
            const interrupted = this.interruptedTurns.delete(turnId);
            this.turnStates.set(threadId, { id: turnId, status: interrupted ? 'interrupted' : event.kind === 'complete' ? 'completed' : 'failed', error: null, items: [] });
            return { outputText: event.text || finalText, threadId, turnId, durationMs: event.durationMs,
              status: interrupted ? 'interrupted' : event.kind === 'complete' ? 'completed' : 'failed',
              outputState: interrupted ? 'interrupted' : event.kind === 'complete' ? 'complete' : 'failed',
              finalSource: 'claude_shared_transcript' };
          }
        }
        if (!correlated && Date.now() - started >= this.correlationTimeoutMs) {
          this.ownedTurns.delete(turnId); // A late accepted turn can still be observed normally.
          throw new Error('消息已写入 Claude 通道，但尚未确认会话收到。请检查电脑上的通道启用提示和组织策略，不要重复发送。');
        }
        await waitForPoll(this.pollMs, this.shutdown.signal);
      }
      this.ownedTurns.delete(turnId);
      if (this.shutdown.signal.aborted) { throw new Error('微信桥接已停止等待，Claude 原会话继续运行。'); }
      throw new Error('等待 Claude 回合结束超时；任务可能仍在电脑运行，请检查原会话。');
    } catch (error) {
      // If delivery fails or acknowledgment is lost, the read-only observer can
      // still deliver later output using the same persisted deduplication key.
      this.turnStates.set(threadId, { id: turnId, status: 'failed', error: null, items: [] });
      this.ownedTurns.delete(turnId); this.interruptedTurns.delete(turnId); throw error;
    } finally {
      this.ownedThreads.delete(threadId);
    }
  }

  async interruptTurn({ threadId, turnId }: Parameters<NonNullable<ProviderPluginContract['interruptTurn']>>[0]) {
    const operation = this.channel.request(threadId, { op: 'stop', requestId: randomUUID(), turnId });
    this.pendingInterrupts.set(turnId, operation);
    try {
      await operation; this.interruptedTurns.add(turnId);
      if (this.interruptedTurns.size > 1024) { this.interruptedTurns.delete(this.interruptedTurns.values().next().value!); }
    } finally { this.pendingInterrupts.delete(turnId); }
  }
  async interruptDesktopThread({ threadId }: { threadId: string }): Promise<boolean> {
    const owner = await this.channel.request(threadId, { op: 'probe', requestId: randomUUID() });
    if (!owner.activeTurnId) { return false; }
    await this.interruptTurn({ threadId, turnId: owner.activeTurnId, providerProfile: createClaudeCodeProfile() });
    return true;
  }
}
