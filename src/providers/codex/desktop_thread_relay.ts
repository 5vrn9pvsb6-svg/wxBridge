import { execFile, type ExecFileException } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import type { CodexTurnInput } from './app_client.js';
import type { ProviderTurnResult, ProviderTurnProgress, ProviderDesktopThreadEvent } from '../../types/provider.js';
import type { InboundTextEvent } from '../../types/platform.js';
import { CodexDesktopIpcClient, type DesktopTurnSubmitter } from './desktop_ipc_client.js';

const execFileAsync = promisify(execFile);
const DEFAULT_SUBMIT_DELAY_MS = 1_200;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_PROMPT_CHARS = 16_000;
const MAX_ROLLOUT_READ_BYTES = 8 * 1024 * 1024;

type CommandRunner = (file: string, args: string[]) => Promise<void>;

interface RolloutCursor {
  offsets: Map<string, number>;
  remainders: Map<string, string>;
  decoders?: Map<string, StringDecoder>;
  currentTurnId?: string | null;
  currentTurnStartedAtMs?: number;
  activeEvents?: RolloutEvent[];
  completedTurnIds?: Set<string>;
}

interface RolloutEvent {
  kind: 'user' | 'started' | 'progress' | 'complete' | 'failed';
  turnId: string;
  text: string;
  outputKind?: 'commentary' | 'final_answer';
  durationMs?: number;
}

interface DesktopRolloutReader {
  snapshot(threadId: string): Promise<RolloutCursor>;
  readEvents(threadId: string, cursor: RolloutCursor): Promise<RolloutEvent[]>;
}

export interface CodexDesktopThreadRelayOptions {
  enabled?: boolean;
  transport?: 'ipc' | 'gui';
  submitter?: DesktopTurnSubmitter;
  platform?: NodeJS.Platform;
  appName?: string;
  submitDelayMs?: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
  maxPromptChars?: number;
  runCommand?: CommandRunner;
  rolloutReader?: DesktopRolloutReader;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface CodexDesktopThreadRelayStartParams {
  threadId: string;
  inputText: string;
  input: CodexTurnInput[];
  event: InboundTextEvent;
  onTurnStarted?: ((meta: Record<string, unknown>) => Promise<void> | void) | null;
  onProgress?: ((progress: ProviderTurnProgress) => Promise<void> | void) | null;
}

export class CodexDesktopThreadRelay {
  private readonly enabled: boolean;

  private readonly transport: 'ipc' | 'gui';

  private readonly submitter: DesktopTurnSubmitter;

  private readonly platform: NodeJS.Platform;

  private readonly appName: string;

  private readonly submitDelayMs: number;

  private readonly pollIntervalMs: number;

  private readonly timeoutMs: number;

  private readonly maxPromptChars: number;

  private readonly runCommand: CommandRunner;

  private readonly rolloutReader: DesktopRolloutReader;

  private readonly sleep: (ms: number) => Promise<void>;

  private readonly now: () => number;

  private queue: Promise<void> = Promise.resolve();

  private readonly ownedThreads = new Set<string>();

  private readonly ownedTurnIds = new Set<string>();

  constructor({
    enabled = false,
    transport = 'ipc',
    submitter = new CodexDesktopIpcClient(),
    platform = process.platform,
    appName = 'ChatGPT',
    submitDelayMs = DEFAULT_SUBMIT_DELAY_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxPromptChars = DEFAULT_MAX_PROMPT_CHARS,
    runCommand = runCommandFile,
    rolloutReader = new CodexDesktopRolloutReader(),
    sleep = wait,
    now = () => Date.now(),
  }: CodexDesktopThreadRelayOptions = {}) {
    this.enabled = enabled;
    this.transport = transport;
    this.submitter = submitter;
    this.platform = platform;
    this.appName = normalizeNonEmptyString(appName) ?? 'ChatGPT';
    this.submitDelayMs = normalizeNonNegativeInteger(submitDelayMs, DEFAULT_SUBMIT_DELAY_MS);
    this.pollIntervalMs = normalizePositiveInteger(pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    this.timeoutMs = normalizePositiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS);
    this.maxPromptChars = normalizePositiveInteger(maxPromptChars, DEFAULT_MAX_PROMPT_CHARS);
    this.runCommand = runCommand;
    this.rolloutReader = rolloutReader;
    this.sleep = sleep;
    this.now = now;
  }

  shouldRelay({ event, input }: { event: InboundTextEvent; input: CodexTurnInput[] }): boolean {
    return this.isEnabledForEvent(event)
      && hasRelayableAttachments(event)
      && Array.isArray(input)
      && input.length === 1
      && input[0]?.type === 'text';
  }

  isAvailableForEvent(event: InboundTextEvent): boolean {
    return this.enabled && event?.platform === 'weixin';
  }

  isEnabledForEvent(event: InboundTextEvent): boolean {
    return this.isAvailableForEvent(event) && isDesktopSharedThreadEvent(event);
  }

  async startTurn(params: CodexDesktopThreadRelayStartParams): Promise<ProviderTurnResult> {
    return this.runExclusive(async () => {
      try {
        return await this.startTurnExclusive(params);
      } finally {
        this.ownedThreads.delete(params.threadId);
      }
    });
  }

  async observeThread({ threadId, signal, onEvent }: {
    threadId: string;
    signal: AbortSignal;
    onEvent: (event: ProviderDesktopThreadEvent) => Promise<void> | void;
  }): Promise<void> {
    const cursor = await this.rolloutReader.snapshot(threadId);
    const ignored = new Set<string>();
    let events = cursor.activeEvents ?? [];
    const seen = new Set<string>();
    while (!signal.aborted) {
      // Keep the read cursor until submission ownership is known. In particular,
      // a lost IPC acknowledgement must not discard a possibly accepted turn.
      if (this.ownedThreads.has(threadId)) {
        await waitForAbortablePoll(this.pollIntervalMs, signal);
        continue;
      }
      for (const event of events) {
        if (signal.aborted) { break; }
        if (cursor.completedTurnIds?.has(event.turnId)) { continue; }
        const key = `${event.turnId}:${event.kind}:${event.outputKind ?? ''}:${event.text}`;
        if (seen.has(key)) { continue; }
        seen.add(key);
        if (seen.size > 500) { seen.delete(seen.values().next().value!); }
        if (this.ownedTurnIds.has(event.turnId)) {
          ignored.add(event.turnId);
        }
        if (ignored.has(event.turnId)) {
          if (event.kind === 'complete' || event.kind === 'failed') { ignored.delete(event.turnId); }
          continue;
        }
        if (event.kind === 'user') { continue; }
        await onEvent({ ...event, kind: event.kind });
        if (event.kind === 'complete' || event.kind === 'failed') {
          cursor.completedTurnIds ??= new Set();
          cursor.completedTurnIds.add(event.turnId);
          if (cursor.completedTurnIds.size > 2_000) { cursor.completedTurnIds.delete(cursor.completedTurnIds.values().next().value!); }
        }
      }
      if (signal.aborted) { break; }
      await waitForAbortablePoll(this.pollIntervalMs, signal);
      if (!signal.aborted) { events = await this.rolloutReader.readEvents(threadId, cursor); }
    }
  }

  private async startTurnExclusive({
    threadId,
    inputText,
    input,
    event,
    onTurnStarted = null,
    onProgress = null,
  }: CodexDesktopThreadRelayStartParams): Promise<ProviderTurnResult> {
    if (!this.shouldRelay({ event, input })) {
      throw new Error('Codex desktop thread relay cannot handle this turn');
    }
    if (this.platform !== 'darwin') {
      throw new Error('Codex desktop thread relay is only supported on macOS');
    }
    const prompt = resolveRelayPrompt(event, inputText);
    if (!prompt) {
      throw new Error('Codex desktop thread relay requires non-empty text');
    }
    if (prompt.length > this.maxPromptChars) {
      throw new Error(`Codex desktop thread relay prompt exceeds ${this.maxPromptChars} characters`);
    }

    const rolloutCursor = await this.rolloutReader.snapshot(threadId);
    if (rolloutCursor.currentTurnId) {
      throw new Error('该桌面会话仍在运行，请等待当前回复完成后再发送新消息；可用 /exit 返回微信独立会话。');
    }
    this.ownedThreads.add(threadId);
    let submittedTurnId: string | null = null;
    if (this.transport === 'ipc') {
      const submitted = await this.submitter.submitTurn(threadId, prompt);
      submittedTurnId = submitted.turnId;
      this.rememberOwnedTurn(submittedTurnId);
      await onTurnStarted?.({ turnId: submittedTurnId, threadId });
    } else {
      const deepLink = buildCodexDesktopThreadUrl(threadId, prompt);
      await this.runCommand('/usr/bin/open', [deepLink]);
      await this.sleep(this.submitDelayMs);
      await this.runCommand('/usr/bin/osascript', ['-e', buildSubmitAppleScript(this.appName)]);
    }

    return this.waitForRelayedTurn({
      threadId,
      prompt,
      rolloutCursor,
      onTurnStarted,
      onProgress,
      submittedTurnId,
    });
  }

  private async waitForRelayedTurn({
    threadId,
    prompt,
    rolloutCursor,
    onTurnStarted,
    onProgress,
    submittedTurnId = null,
  }: {
    threadId: string;
    prompt: string;
    rolloutCursor: RolloutCursor;
    onTurnStarted?: ((meta: Record<string, unknown>) => Promise<void> | void) | null;
    onProgress?: ((progress: ProviderTurnProgress) => Promise<void> | void) | null;
    submittedTurnId?: string | null;
  }): Promise<ProviderTurnResult> {
    const deadline = this.now() + this.timeoutMs;
    let targetTurnId: string | null = submittedTurnId;
    const seenMessages = new Set<string>();
    let finalText = '';
    while (this.now() < deadline) {
      const events = await this.rolloutReader.readEvents(threadId, rolloutCursor);
      for (const event of events) {
        if (
          event.kind === 'user'
          && !targetTurnId
          && normalizeComparableText(event.text) === normalizeComparableText(prompt)
        ) {
          targetTurnId = event.turnId;
          this.rememberOwnedTurn(event.turnId);
          await onTurnStarted?.({ turnId: event.turnId, threadId });
          continue;
        }
        if (targetTurnId && event.turnId === targetTurnId && event.kind === 'progress') {
          const key = `${event.outputKind}:${event.text}`;
          if (seenMessages.has(key)) { continue; }
          seenMessages.add(key);
          const outputKind = event.outputKind ?? 'commentary';
          const delta = outputKind === 'final_answer'
            ? `${finalText ? '\n\n' : ''}${event.text}`
            : `${event.text}\n\n`;
          if (outputKind === 'final_answer') { finalText += delta; }
          await onProgress?.({ text: outputKind === 'final_answer' ? finalText : event.text, delta, outputKind });
          continue;
        }
        if (targetTurnId && event.turnId === targetTurnId && (event.kind === 'complete' || event.kind === 'failed')) {
          const failed = event.kind === 'failed';
          const outputText = !event.text || finalText.endsWith(event.text) ? finalText : event.text;
          return {
            outputText: failed ? '' : outputText,
            outputState: failed ? 'provider_error' : outputText ? 'complete' : 'missing',
            errorMessage: failed ? event.text || `Codex desktop turn ${event.turnId} failed` : null,
            previewText: failed ? '' : outputText,
            finalSource: 'desktop_rollout',
            durationMs: event.durationMs,
            status: failed ? 'failed' : 'completed',
            turnId: event.turnId,
            threadId,
            title: null,
          };
        }
      }
      await this.sleep(this.pollIntervalMs);
    }
    throw new Error(`Timed out waiting for Codex desktop turn in thread ${threadId}`);
  }

  private rememberOwnedTurn(turnId: string): void {
    this.ownedTurnIds.add(turnId);
    if (this.ownedTurnIds.size > 100) { this.ownedTurnIds.delete(this.ownedTurnIds.values().next().value!); }
  }

  private async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}

function isDesktopSharedThreadEvent(event: InboundTextEvent): boolean {
  const codexBridge = event?.metadata?.codexbridge;
  return Boolean(
    codexBridge
    && typeof codexBridge === 'object'
    && !Array.isArray(codexBridge)
    && (codexBridge as Record<string, unknown>).executionMode === 'desktop_shared',
  );
}

function hasRelayableAttachments(event: InboundTextEvent): boolean {
  const attachments = Array.isArray(event?.attachments) ? event.attachments : [];
  if (attachments.length === 0) {
    return true;
  }
  return attachments.every((attachment) => attachment?.kind === 'voice')
    && Boolean(resolveVoiceTranscript(event));
}

function resolveRelayPrompt(event: InboundTextEvent, inputText: string): string {
  const attachments = Array.isArray(event?.attachments) ? event.attachments : [];
  if (attachments.length > 0 && attachments.every((attachment) => attachment?.kind === 'voice')) {
    return resolveVoiceTranscript(event);
  }
  return normalizePrompt(inputText);
}

function resolveVoiceTranscript(event: InboundTextEvent): string {
  const eventText = normalizePrompt(event?.text);
  if (eventText) {
    return eventText;
  }
  return (Array.isArray(event?.attachments) ? event.attachments : [])
    .filter((attachment) => attachment?.kind === 'voice')
    .map((attachment) => normalizePrompt(attachment?.transcriptText))
    .filter(Boolean)
    .join('\n');
}

export class CodexDesktopRolloutReader implements DesktopRolloutReader {
  private readonly sessionsDir: string;

  private readonly fileCache = new Map<string, { paths: string[]; refreshedAt: number }>();

  constructor(sessionsDir = resolveCodexSessionsDir()) {
    this.sessionsDir = sessionsDir;
  }

  async snapshot(threadId: string): Promise<RolloutCursor> {
    const files = this.resolveFiles(threadId, true);
    if (files.length === 0) {
      throw new Error(`Codex desktop rollout was not found for thread ${threadId}`);
    }
    const offsets = new Map<string, number>();
    const cursor: RolloutCursor = {
      offsets, remainders: new Map(), decoders: new Map(), currentTurnId: null, activeEvents: [],
      completedTurnIds: new Set(),
    };
    for (const filePath of files) {
      const size = readFileSize(filePath);
      const length = Math.min(size, MAX_ROLLOUT_READ_BYTES);
      const start = size - length;
      const handle = await fs.promises.open(filePath, 'r');
      let text = '';
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, start);
        const decoder = new StringDecoder('utf8');
        text = decoder.write(buffer.subarray(0, bytesRead));
        cursor.decoders!.set(filePath, decoder);
        offsets.set(filePath, start + bytesRead);
      } finally {
        await handle.close();
      }
      const lines = text.split(/\r?\n/u);
      if (start > 0) { lines.shift(); }
      cursor.remainders.set(filePath, lines.pop() ?? '');
      for (const line of lines) {
        const event = parseRolloutEvent(line, cursor);
        if (!event) { continue; }
        if (event.kind === 'complete' || event.kind === 'failed') { cursor.completedTurnIds!.add(event.turnId); }
        if (event.kind === 'started' || event.kind === 'user') {
          if (cursor.activeEvents!.at(0)?.turnId !== event.turnId) {
            cursor.activeEvents = [{ kind: 'started', turnId: event.turnId, text: '' }];
          }
        } else if (event.kind === 'progress') {
          if (cursor.activeEvents!.at(0)?.turnId !== event.turnId) {
            cursor.activeEvents = [{ kind: 'started', turnId: event.turnId, text: '' }];
          }
          cursor.activeEvents!.push(event);
        } else if (cursor.activeEvents!.at(0)?.turnId === event.turnId) {
          cursor.activeEvents = [];
        }
      }
    }
    if (!cursor.currentTurnId) {
      cursor.activeEvents = [];
    } else if (cursor.activeEvents?.at(0)?.turnId !== cursor.currentTurnId) {
      cursor.activeEvents = [{ kind: 'started', turnId: cursor.currentTurnId, text: '' }];
    }
    return cursor;
  }

  async readEvents(threadId: string, cursor: RolloutCursor): Promise<RolloutEvent[]> {
    const events: RolloutEvent[] = [];
    for (const filePath of this.resolveFiles(threadId)) {
      let start = cursor.offsets.get(filePath) ?? 0;
      const size = readFileSize(filePath);
      if (size < start) {
        start = 0;
        cursor.offsets.set(filePath, 0);
        cursor.remainders.delete(filePath);
        cursor.decoders?.delete(filePath);
      }
      if (size <= start) {
        continue;
      }
      const length = Math.min(size - start, MAX_ROLLOUT_READ_BYTES);
      const handle = await fs.promises.open(filePath, 'r');
      let text = '';
      try {
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, start);
        cursor.decoders ??= new Map();
        const decoder = cursor.decoders.get(filePath) ?? new StringDecoder('utf8');
        cursor.decoders.set(filePath, decoder);
        text = decoder.write(buffer.subarray(0, bytesRead));
        cursor.offsets.set(filePath, start + bytesRead);
      } finally {
        await handle.close();
      }
      const combined = `${cursor.remainders.get(filePath) ?? ''}${text}`;
      if (Buffer.byteLength(combined, 'utf8') > MAX_ROLLOUT_READ_BYTES * 2) {
        throw new Error('Codex desktop rollout record exceeds the read limit');
      }
      const lines = combined.split(/\r?\n/u);
      cursor.remainders.set(filePath, lines.pop() ?? '');
      for (const line of lines) {
        const event = parseRolloutEvent(line, cursor);
        if (event) {
          events.push(event);
        }
      }
    }
    return events;
  }

  private resolveFiles(threadId: string, refresh = false): string[] {
    const cached = this.fileCache.get(threadId);
    if (!refresh && cached && Date.now() - cached.refreshedAt < 30_000) {
      return cached.paths;
    }
    const paths = findRolloutFiles(this.sessionsDir, threadId);
    this.fileCache.set(threadId, { paths, refreshedAt: Date.now() });
    if (this.fileCache.size > 100) { this.fileCache.delete(this.fileCache.keys().next().value!); }
    return paths;
  }
}

export function createCodexDesktopThreadRelayFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): CodexDesktopThreadRelay | null {
  if (!parseBoolean(env.CODEXBRIDGE_CODEX_DESKTOP_SHARED_THREAD, false)) {
    return null;
  }
  const transport = normalizeNonEmptyString(env.CODEXBRIDGE_CODEX_DESKTOP_TRANSPORT) ?? 'ipc';
  if (transport !== 'ipc' && transport !== 'gui') { throw new Error('Invalid Codex desktop transport; use ipc or gui'); }
  return new CodexDesktopThreadRelay({
    enabled: true,
    transport,
    submitter: new CodexDesktopIpcClient({
      socketPath: normalizeNonEmptyString(env.CODEXBRIDGE_CODEX_DESKTOP_IPC_SOCKET)
        ?? path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'ipc', 'ipc.sock'),
    }),
    platform,
    appName: normalizeNonEmptyString(env.CODEXBRIDGE_CODEX_DESKTOP_APP_NAME) ?? 'ChatGPT',
    submitDelayMs: parseInteger(env.CODEXBRIDGE_CODEX_DESKTOP_SUBMIT_DELAY_MS, DEFAULT_SUBMIT_DELAY_MS),
    pollIntervalMs: parseInteger(env.CODEXBRIDGE_CODEX_DESKTOP_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS),
    timeoutMs: parseInteger(env.CODEXBRIDGE_CODEX_DESKTOP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxPromptChars: parseInteger(env.CODEXBRIDGE_CODEX_DESKTOP_MAX_PROMPT_CHARS, DEFAULT_MAX_PROMPT_CHARS),
  });
}

export function buildCodexDesktopThreadUrl(threadId: string, prompt: string): string {
  const normalizedThreadId = normalizeNonEmptyString(threadId);
  if (!normalizedThreadId || !/^[A-Za-z0-9_-]+$/u.test(normalizedThreadId)) {
    throw new Error('Invalid Codex desktop thread id');
  }
  const url = new URL(`codex://threads/${encodeURIComponent(normalizedThreadId)}`);
  url.searchParams.set('prompt', prompt);
  return url.toString();
}

function buildSubmitAppleScript(appName: string): string {
  const escapedAppName = appName.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
  return [
    `tell application "${escapedAppName}" to activate`,
    'delay 0.2',
    'tell application "System Events"',
    `  tell process "${escapedAppName}"`,
    '    set frontmost to true',
    '    key code 36',
    '  end tell',
    'end tell',
  ].join('\n');
}

function parseRolloutEvent(line: string, cursor: RolloutCursor): RolloutEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  let record: any;
  try {
    record = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const payload = record?.payload;
  if (record?.type === 'response_item' && payload?.type === 'message' && ['user', 'assistant'].includes(payload?.role)) {
    const messageTurnId = normalizeNonEmptyString(payload?.internal_chat_message_metadata_passthrough?.turn_id);
    const turnId = payload.role === 'assistant'
      ? cursor.currentTurnId ?? messageTurnId
      : messageTurnId ?? cursor.currentTurnId;
    if (!turnId) {
      return null;
    }
    const text = Array.isArray(payload.content)
      ? payload.content
        .filter((item: any) => ['input_text', 'output_text', 'text'].includes(item?.type))
        .map((item: any) => String(item?.text ?? ''))
        .join('\n')
      : '';
    if (payload.role === 'user') {
      if (cursor.currentTurnId !== turnId) { cursor.currentTurnStartedAtMs = undefined; }
      cursor.currentTurnId = turnId;
      return { kind: 'user', turnId, text };
    }
    if (payload.phase && !['commentary', 'final_answer'].includes(payload.phase)) { return null; }
    cursor.currentTurnId ??= turnId;
    const visibleText = stripArtifactProtocol(text);
    return visibleText ? {
      kind: 'progress', turnId, text: visibleText,
      outputKind: payload.phase === 'commentary' ? 'commentary' : 'final_answer',
    } : null;
  }
  if (record?.type !== 'event_msg') {
    return null;
  }
  const turnId = normalizeNonEmptyString(payload?.turn_id) ?? cursor.currentTurnId;
  if (!turnId) {
    return null;
  }
  if (payload?.type === 'task_started') {
    cursor.currentTurnId = turnId;
    cursor.currentTurnStartedAtMs = parseEpochSeconds(payload.started_at) ?? parseIsoTimestamp(record.timestamp);
    return { kind: 'started', turnId, text: '' };
  }
  if (payload?.type === 'task_complete') {
    const timing = readTurnTiming(record, cursor, turnId);
    if (cursor.currentTurnId === turnId) { cursor.currentTurnId = null; cursor.currentTurnStartedAtMs = undefined; }
    return {
      kind: 'complete',
      turnId,
      text: stripArtifactProtocol(payload?.last_agent_message),
      ...timing,
    };
  }
  if (payload?.type === 'turn_aborted' || payload?.type === 'task_failed') {
    const timing = readTurnTiming(record, cursor, turnId);
    if (cursor.currentTurnId === turnId) { cursor.currentTurnId = null; cursor.currentTurnStartedAtMs = undefined; }
    return {
      kind: 'failed',
      turnId,
      text: normalizeNonEmptyString(payload?.message ?? payload?.error) ?? '',
      ...timing,
    };
  }
  return null;
}

function parseEpochSeconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    && value <= Number.MAX_SAFE_INTEGER / 1000 ? value * 1000 : undefined;
}

function parseIsoTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/u.test(value)) { return undefined; }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : undefined;
}

function readTurnTiming(record: any, cursor: RolloutCursor, turnId: string): { durationMs?: number } {
  const recorded = record.payload?.duration_ms;
  if (typeof recorded === 'number' && Number.isFinite(recorded) && recorded >= 0) {
    return { durationMs: recorded };
  }
  const start = parseEpochSeconds(record.payload?.started_at)
    ?? (cursor.currentTurnId === turnId ? cursor.currentTurnStartedAtMs : undefined);
  const end = parseEpochSeconds(record.payload?.completed_at) ?? parseIsoTimestamp(record.timestamp);
  return start !== undefined && end !== undefined && end >= start ? { durationMs: end - start } : {};
}

function findRolloutFiles(rootDir: string, threadId: string): string[] {
  const normalizedThreadId = normalizeNonEmptyString(threadId);
  if (!normalizedThreadId || !/^[A-Za-z0-9_-]+$/u.test(normalizedThreadId)) {
    return [];
  }
  const results: Array<{ path: string; mtimeMs: number }> = [];
  const stack = [rootDir];
  let visited = 0;
  while (stack.length > 0 && visited < 5_000) {
    const directory = stack.pop();
    if (!directory) {
      continue;
    }
    visited += 1;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() && entry.name.includes(normalizedThreadId) && entry.name.endsWith('.jsonl')) {
        try {
          results.push({ path: entryPath, mtimeMs: fs.statSync(entryPath).mtimeMs });
        } catch {
          // The desktop may rotate a rollout between directory enumeration and stat.
        }
      }
    }
  }
  return results
    .sort((left, right) => left.mtimeMs - right.mtimeMs)
    .slice(-20)
    .map((entry) => entry.path);
}

function readFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function resolveCodexSessionsDir(): string {
  const codexHome = normalizeNonEmptyString(process.env.CODEX_HOME) ?? path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'sessions');
}

function stripArtifactProtocol(value: unknown): string {
  return String(value ?? '')
    .replace(/\n?```codexbridge-artifacts\s*[\s\S]*?```\n?/giu, '\n')
    .trim();
}

function normalizePrompt(value: unknown): string {
  return String(value ?? '').replace(/\r\n?/gu, '\n').trim();
}

function normalizeComparableText(value: unknown): string {
  return normalizePrompt(value).replace(/[ \t]+/gu, ' ');
}

function normalizeNonEmptyString(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseInteger(value: unknown, fallback: number): number {
  return normalizePositiveInteger(value, fallback);
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

async function runCommandFile(file: string, args: string[]): Promise<void> {
  try {
    await execFileAsync(file, args, {
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    });
  } catch (error) {
    const execError = error as ExecFileException;
    const detail = normalizeNonEmptyString(execError.stderr) ?? normalizeNonEmptyString(execError.message);
    throw new Error(`Codex desktop thread relay command failed: ${file}${detail ? `: ${detail}` : ''}`);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForAbortablePoll(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) { finish(); }
  });
}
