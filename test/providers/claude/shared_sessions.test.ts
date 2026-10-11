import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { startClaudeChannel } from '../../../src/providers/claude/channel_server.js';
import { ClaudeChannelClient, channelSocketPath } from '../../../src/providers/claude/channel_client.js';
import { ClaudeSessionCatalog } from '../../../src/providers/claude/session_catalog.js';
import { ClaudeTranscriptReader, waitForPoll } from '../../../src/providers/claude/transcript.js';
import { ClaudeCodeProviderPlugin, createClaudeCodeProfile } from '../../../src/providers/claude/plugin.js';
import { buildClaudeShareArgs } from '../../../src/providers/claude/launcher.js';
import { createCodexBridgeRuntime } from '../../../src/runtime/bootstrap.js';

const posixChannelOptions = {
  skip: process.platform === 'win32' ? 'Claude channel transport requires Unix sockets and POSIX UID permissions.' : false,
};

async function fixture(t: any) {
  // Keep POSIX socket paths short enough for the transport's 100-byte limit.
  const tempRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const dir = await fs.mkdtemp(path.join(tempRoot, 'cbc-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const projectsDir = path.join(dir, 'projects');
  const project = path.join(projectsDir, 'project');
  await fs.mkdir(project, { recursive: true });
  const id = randomUUID(); const file = path.join(project, `${id}.jsonl`);
  const record = (type: string, extra: Record<string, unknown> = {}) => ({ type, sessionId: id, cwd: dir,
    uuid: randomUUID(), timestamp: new Date().toISOString(), ...extra });
  const append = (...records: any[]) => fs.appendFile(file, records.map((item) => JSON.stringify(item)).join('\n') + '\n');
  await append(record('user', { timestamp: new Date(Date.now() - 60000).toISOString(), message: { role: 'user', content: 'original PC conversation' } }),
    record('assistant', { message: { id: 'old', stop_reason: 'end_turn', content: [{ type: 'text', text: 'old completed answer' }] } }),
    record('system', { subtype: 'turn_duration', durationMs: 1000 }));
  const provider = new ClaudeCodeProviderPlugin({ stateDir: dir, projectsDir, pollMs: 5, correlationTimeoutMs: 80, turnTimeoutMs: 500 });
  const client = new ClaudeChannelClient(path.join(dir, 'claude-channels'), 500);
  const user = (text: string, requestId?: string) => record('user', { isMeta: Boolean(requestId),
    ...(requestId ? { origin: { kind: 'channel', server: 'codexbridge-weixin' } } : {}),
    message: { role: 'user', content: requestId ? `<channel source="codexbridge-weixin" codex_request_id="${requestId}">\n${text}\n</channel>` : text } });
  const answer = (text: string, final = true) => record('assistant', { message: { id: randomUUID(), stop_reason: final ? 'end_turn' : 'tool_use', content: [{ type: 'text', text }] } });
  const end = (durationMs = 2400) => record('system', { subtype: 'turn_duration', durationMs });
  const params = (text = 'message from WeChat') => ({ providerProfile: createClaudeCodeProfile(),
    bridgeSession: { id: randomUUID(), providerProfileId: 'claude-code', codexThreadId: id, cwd: dir, title: 'existing', createdAt: 0, updatedAt: 0 },
    sessionSettings: null, event: { platform: 'weixin', externalScopeId: 'wx-user', text,
      metadata: { codexbridge: { executionMode: 'desktop_shared' } } }, inputText: text });
  return { dir, projectsDir, project, file, id, record, append, provider, client, user, answer, end, params };
}

test('Claude transcript excludes completed history, tools and reasoning; joins an active turn and keeps UTF-8 fragments', async (t) => {
  const f = await fixture(t);
  const reader = new ClaudeTranscriptReader(f.file, f.id);
  assert.deepEqual(await reader.read(), []);
  const requestId = randomUUID();
  await f.append(f.user('hello', requestId), f.record('assistant', { message: { content: [{ type: 'thinking', thinking: 'private reasoning' }] } }),
    f.record('user', { message: { role: 'user', content: [{ type: 'tool_result', content: 'secret tool output' }] } }), f.answer('progress rc.129', false));
  const updates = await reader.read();
  assert.deepEqual(updates.map((event) => event.kind), ['started', 'progress']);
  assert.equal(updates[0].turnId, requestId);
  const joined = new ClaudeTranscriptReader(f.file, f.id);
  assert.deepEqual((await joined.read()).map((event) => event.text), ['', 'progress rc.129']);
  const encoded = Buffer.from(JSON.stringify(f.answer('中文答案')) + '\n');
  const split = encoded.indexOf(Buffer.from('中')) + 1;
  await fs.appendFile(f.file, encoded.subarray(0, split));
  assert.deepEqual(await reader.read(), []);
  await fs.appendFile(f.file, encoded.subarray(split)); await f.append(f.end(72000));
  const final = await reader.read();
  assert.equal(final[0].text, '中文答案'); assert.equal(final[1].durationMs, 72000);
  assert.equal(final[1].turnId, requestId); assert.equal(reader.activeTurnId, null);
});

test('session inventory is bounded, ignores sidechain files and symlinks, and uses names and project cwd', async (t) => {
  const f = await fixture(t);
  await f.append(f.record('custom-title', { customTitle: 'named session' }));
  await fs.mkdir(path.join(f.project, f.id, 'subagents'), { recursive: true });
  await fs.writeFile(path.join(f.project, f.id, 'subagents', `${randomUUID()}.jsonl`), '{}\n');
  await fs.symlink(f.file, path.join(f.project, `${randomUUID()}.jsonl`));
  const sessions = await new ClaudeSessionCatalog(f.projectsDir).list();
  assert.equal(sessions.length, 1); assert.equal(sessions[0].title, 'named session'); assert.equal(sessions[0].cwd, f.dir);
  await assert.rejects(() => f.provider.readThread({ providerProfile: createClaudeCodeProfile(), threadId: '../../bad' }), /UUID/);
});

test('shared turn reaches its existing channel, correlates meta input and streams once with duration', posixChannelOptions, async (t) => {
  const f = await fixture(t); const notifications: any[] = [];
  const server = await startClaudeChannel({ root: f.client.root, sessionId: f.id, projectsDir: f.projectsDir,
    notify: async (text, meta) => { notifications.push({ text, meta }); await f.append(f.user(text, meta.codex_request_id), f.answer('working', false), f.answer('done'), f.end()); } });
  t.after(() => server.close());
  await f.provider.prepareDesktopThreadSharing({ threadId: f.id });
  const progress: any[] = []; const started: any[] = [];
  const result = await f.provider.startTurn({ ...f.params(), onProgress: (event) => { progress.push(event); }, onTurnStarted: (event) => { started.push(event); } });
  assert.equal(notifications.length, 1); assert.equal(result.threadId, f.id); assert.equal(result.outputText, 'done');
  assert.equal(result.turnId, notifications[0].meta.codex_request_id); assert.equal(result.durationMs, 2400);
  assert.deepEqual(progress.map((event) => event.delta), ['working', 'done']); assert.equal(started[0].turnId, result.turnId);
  const controller = new AbortController(); const observed: any[] = [];
  const watching = f.provider.observeDesktopThread({ threadId: f.id, signal: controller.signal, onEvent: (event) => { observed.push(event); } });
  await waitForPoll(25); controller.abort(); await watching; assert.deepEqual(observed, []);
});

test('unconfirmed channel event reports uncertainty, blocks another submit and never starts a fallback writer', posixChannelOptions, async (t) => {
  const f = await fixture(t); let calls = 0;
  const server = await startClaudeChannel({ root: f.client.root, sessionId: f.id, projectsDir: f.projectsDir, notify: async () => { calls += 1; } });
  t.after(() => server.close());
  await assert.rejects(() => f.provider.startTurn(f.params()), /尚未确认.*不要重复发送/);
  await assert.rejects(() => f.provider.startTurn(f.params('second')), /正在回复或消息尚未确认/);
  assert.equal(calls, 1);
});

test('observer syncs PC-origin output and completion, ignores own output and cancels cleanly', posixChannelOptions, async (t) => {
  const f = await fixture(t);
  const server = await startClaudeChannel({ root: f.client.root, sessionId: f.id, projectsDir: f.projectsDir, notify: async () => {} });
  t.after(() => server.close());
  const controller = new AbortController(); const events: any[] = [];
  const watching = f.provider.observeDesktopThread({ threadId: f.id, signal: controller.signal, onEvent: (event) => { events.push(event); } });
  await waitForPoll(30); await f.append(f.user('PC prompt'), f.answer('PC progress', false), f.answer('PC final'), f.end(35000));
  for (let i = 0; i < 50 && !events.some((event) => event.kind === 'complete'); i++) { await waitForPoll(5); }
  controller.abort(); await watching;
  assert.deepEqual(events.map((event) => event.kind), ['started', 'progress', 'progress', 'complete']);
  assert.equal(events.at(-1).durationMs, 35000);
});

test('a possibly accepted turn remains observable after channel acknowledgment fails', posixChannelOptions, async (t) => {
  const f = await fixture(t);
  const server = await startClaudeChannel({ root: f.client.root, sessionId: f.id, projectsDir: f.projectsDir,
    notify: async (text, meta) => {
      await f.append(f.user(text, meta.codex_request_id), f.answer('accepted despite lost acknowledgement'), f.end());
      throw new Error('synthetic acknowledgement failure');
    } });
  t.after(() => server.close());
  const controller = new AbortController(); const observed: any[] = [];
  const watching = f.provider.observeDesktopThread({ threadId: f.id, signal: controller.signal, onEvent: (event) => { observed.push(event); } });
  await waitForPoll(25);
  await assert.rejects(() => f.provider.startTurn(f.params()), /可能已提交.*不要重复发送/);
  for (let i = 0; i < 50 && !observed.some((event) => event.kind === 'complete'); i++) { await waitForPoll(5); }
  controller.abort(); await watching;
  assert.deepEqual(observed.map((event) => event.kind), ['started', 'progress', 'complete']);
  assert.equal(observed[1].text, 'accepted despite lost acknowledgement');
});

test('shutdown stops waiting without interrupting the Claude owner', posixChannelOptions, async (t) => {
  const f = await fixture(t); let stops = 0;
  const server = await startClaudeChannel({ root: f.client.root, sessionId: f.id, projectsDir: f.projectsDir,
    notify: async (text, meta) => { await f.append(f.user(text, meta.codex_request_id)); }, interrupt: async () => { stops += 1; } });
  t.after(() => server.close());
  let started!: () => void;
  const initialized = new Promise<void>((resolve) => { started = resolve; });
  const turn = f.provider.startTurn({ ...f.params(), onTurnStarted: started });
  const rejected = assert.rejects(turn, /原会话继续运行/);
  await initialized; await f.provider.stop(); await rejected;
  assert.equal(stops, 0);
});

test('channel rejects unsafe permissions, duplicate owners, oversized input and stale stop; only interrupts current turn', posixChannelOptions, async (t) => {
  const f = await fixture(t); let stops = 0;
  const server = await startClaudeChannel({ root: f.client.root, sessionId: f.id, projectsDir: f.projectsDir,
    notify: async () => {}, interrupt: async () => { stops += 1; } });
  t.after(() => server.close());
  await assert.rejects(() => startClaudeChannel({ root: f.client.root, sessionId: f.id, notify: async () => {} }), /第二个持有者/);
  await assert.rejects(() => f.client.request(f.id, { op: 'submit', requestId: randomUUID(), text: 'x'.repeat(300000) }), /过长/);
  await fs.chmod(channelSocketPath(f.client.root, f.id), 0o666);
  await assert.rejects(() => f.client.request(f.id, { op: 'probe', requestId: randomUUID() }), /权限/);
  await fs.chmod(channelSocketPath(f.client.root, f.id), 0o600);
  await assert.rejects(() => f.client.request(f.id, { op: 'stop', requestId: randomUUID(), turnId: randomUUID() }), /已经结束/);
  assert.equal(stops, 0);
  const input = f.user('PC active'); await f.append(input);
  await f.client.request(f.id, { op: 'stop', requestId: randomUUID(), turnId: input.uuid }); assert.equal(stops, 1);
});

test('text and transcribed voice are allowed; binary attachments and standalone execution are rejected', posixChannelOptions, async (t) => {
  const f = await fixture(t);
  const server = await startClaudeChannel({ root: f.client.root, sessionId: f.id, projectsDir: f.projectsDir,
    notify: async (text, meta) => { await f.append(f.user(text, meta.codex_request_id), f.answer('voice reply'), f.end()); } });
  t.after(() => server.close());
  const params = f.params('transcribed voice');
  await f.provider.startTurn({ ...params, event: { ...params.event, attachments: [{ kind: 'voice', localPath: '/tmp/voice', transcriptText: 'transcribed voice' }] } });
  await assert.rejects(() => f.provider.startTurn({ ...params, event: { ...params.event, attachments: [{ kind: 'image', localPath: '/tmp/image' }] } }), /先 \/exit/);
  await assert.rejects(() => f.provider.startTurn({ ...params, event: { ...params.event, metadata: {} } }), /进入 Claude 共享会话/);
});

test('real MCP stdio server advertises channel contract and forwards a socket message as a notification', posixChannelOptions, async (t) => {
  const f = await fixture(t);
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', fileURLToPath(import.meta.resolve('tsx')), fileURLToPath(new URL('../../../src/providers/claude/channel_server.ts', import.meta.url)),
      f.client.root, f.id, f.projectsDir], stderr: 'pipe' });
  const mcp = new Client({ name: 'fixture', version: '1.0.0' });
  t.after(() => mcp.close());
  const received: any[] = [];
  mcp.setNotificationHandler(z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }) }), async (message) => { received.push(message.params); });
  await mcp.connect(transport);
  assert.deepEqual(mcp.getServerCapabilities()?.experimental?.['claude/channel'], {});
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try { await f.client.request(f.id, { op: 'probe', requestId: randomUUID() }); ready = true; } catch { await waitForPoll(10); }
  }
  assert.equal(ready, true);
  const requestId = randomUUID(); await f.client.request(f.id, { op: 'submit', requestId, text: 'same session message' });
  for (let i = 0; i < 50 && !received.length; i++) { await waitForPoll(5); }
  assert.equal(received[0].content, 'same session message'); assert.equal(received[0].meta.codex_request_id, requestId);
});

test('launcher resumes selected session with channel enabled and retains tools and project settings', () => {
  const id = randomUUID();
  const args = buildClaudeShareArgs({ sessionId: id, stateDir: '/tmp/cb', projectsDir: '/tmp/projects' });
  assert.deepEqual(args.slice(0, 2), ['--resume', id]);
  assert.ok(args.includes('--dangerously-load-development-channels'));
  assert.ok(!args.includes('--fork-session')); assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.ok(!args.includes('--strict-mcp-config')); assert.ok(!args.includes('--bare'));
  const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
  assert.equal(config.mcpServers['codexbridge-weixin'].command, process.execPath);
});

test('/enter claude preserves the independent binding, selects from ten-item pages and /exit restores Codex', posixChannelOptions, async (t) => {
  const f = await fixture(t);
  const server = await startClaudeChannel({ root: f.client.root, sessionId: f.id, projectsDir: f.projectsDir,
    notify: async (text, meta) => { await f.append(f.user(text, meta.codex_request_id), f.answer('shared Claude reply'), f.end(3200)); } });
  t.after(() => server.close());
  for (let i = 0; i < 11; i++) { const id = randomUUID(); await fs.writeFile(path.join(f.project, `${id}.jsonl`), JSON.stringify({ type: 'user', sessionId: id, cwd: f.dir, uuid: randomUUID(), message: { content: `other ${i}` } }) + '\n'); }
  // Selected existing session first.
  await f.append(f.record('custom-title', { customTitle: 'selected original' }));
  const selectedTime = new Date(Date.now() + 5000);
  await fs.utimes(f.file, selectedTime, selectedTime);
  const native = { kind: 'openai-native', displayName: 'Codex', async startThread() { return { threadId: 'codex-independent', cwd: f.dir, title: 'own WeChat' }; },
    async readThread() { return { threadId: 'codex-independent', cwd: f.dir, title: 'own WeChat' }; },
    async listThreads() { return { items: [], nextCursor: null }; }, async startTurn() { return { outputText: 'independent reply' }; } };
  const runtime = createCodexBridgeRuntime({ providerPlugins: [native, f.provider], providerProfiles: [createClaudeCodeProfile(),
    { id: 'openai-default', providerKind: 'openai-native', displayName: 'Codex', config: {}, createdAt: 0, updatedAt: 0 }],
    defaultProviderProfileId: 'openai-default' });
  const scope = { platform: 'weixin', externalScopeId: 'wx-owner' }; const coordinator = runtime.services.bridgeCoordinator;
  const original = await runtime.services.bridgeSessions.createSessionForScope(scope, { providerProfileId: 'openai-default' });
  const list = await coordinator.handleInboundEvent({ ...scope, text: '/enter claude' });
  assert.match(list.messages.map((item: any) => item.text).join('\n'), /claude-code/);
  assert.equal(runtime.services.bridgeSessions.resolveScopeSession(scope)?.id, original.id);
  const browser = coordinator.getThreadBrowserState(scope);
  assert.equal(browser.items.length, 10); assert.equal(browser.providerProfileId, 'claude-code');
  const next = await coordinator.handleInboundEvent({ ...scope, text: '/next' });
  assert.equal(coordinator.getThreadBrowserState(scope).items.length, 2); assert.ok(next.messages.length);
  await coordinator.handleInboundEvent({ ...scope, text: '/prev' });
  const index = coordinator.getThreadBrowserState(scope).items.findIndex((item: any) => item.threadId === f.id) + 1;
  assert.ok(index > 0);
  await coordinator.handleInboundEvent({ ...scope, text: `/enter ${index}` });
  assert.equal(runtime.services.bridgeSessions.resolveScopeExecutionMode(scope), 'desktop_shared');
  assert.equal(runtime.services.bridgeSessions.resolveScopeSession(scope)?.codexThreadId, f.id);
  const reply = await coordinator.handleInboundEvent({ ...scope, text: 'WeChat shared prompt' });
  assert.match(reply.messages.map((item: any) => item.text).join('\n'), /shared Claude reply/);
  assert.equal(reply.meta?.codexTurn?.durationMs, 3200);
  await coordinator.handleInboundEvent({ ...scope, text: '/exit' });
  assert.equal(runtime.services.bridgeSessions.resolveScopeSession(scope)?.id, original.id);
  assert.equal(runtime.services.bridgeSessions.resolveScopeExecutionMode(scope), 'standalone');
});

test('missing Claude owner does not change binding; first-time /exit uses the default independent provider', posixChannelOptions, async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => f.provider.prepareDesktopThreadSharing({ threadId: f.id }), /尚未启用微信通道/);
  const native = { kind: 'openai-native', async startThread() { return { threadId: 'new-independent', cwd: f.dir, title: 'WeChat' }; },
    async readThread() { return null; }, async listThreads() { return { items: [], nextCursor: null }; }, async startTurn() { return { outputText: 'ok' }; } };
  const runtime = createCodexBridgeRuntime({ providerPlugins: [native, f.provider], providerProfiles: [createClaudeCodeProfile(),
    { id: 'openai-default', providerKind: 'openai-native', displayName: 'Codex', config: {}, createdAt: 0, updatedAt: 0 }], defaultProviderProfileId: 'openai-default' });
  const scope = { platform: 'weixin', externalScopeId: 'first-contact' }; const coordinator = runtime.services.bridgeCoordinator;
  await coordinator.handleInboundEvent({ ...scope, text: '/enter claude' });
  await assert.rejects(() => coordinator.handleInboundEvent({ ...scope, text: '/enter 1' }), /尚未启用/);
  assert.equal(runtime.services.bridgeSessions.resolveScopeSession(scope), null);
  const server = await startClaudeChannel({ root: f.client.root, sessionId: f.id, projectsDir: f.projectsDir, notify: async () => {} });
  t.after(() => server.close());
  await coordinator.handleInboundEvent({ ...scope, text: '/enter 1' });
  await coordinator.handleInboundEvent({ ...scope, text: '/exit' });
  assert.equal(runtime.services.bridgeSessions.resolveScopeSession(scope)?.providerProfileId, 'openai-default');
});

test('the coordinator retains a pending Claude turn and /stop targets that same owner', posixChannelOptions, async (t) => {
  const f = await fixture(t); let stops = 0;
  const server = await startClaudeChannel({ root: f.client.root, sessionId: f.id, projectsDir: f.projectsDir,
    notify: async (text, meta) => { await f.append(f.user(text, meta.codex_request_id)); },
    interrupt: async () => { stops += 1; await f.append(f.end(1500)); } });
  t.after(() => server.close());
  const runtime = createCodexBridgeRuntime({ providerPlugins: [f.provider], providerProfiles: [createClaudeCodeProfile()], defaultProviderProfileId: 'claude-code' });
  const scope = { platform: 'weixin', externalScopeId: 'stop-claude' }; const coordinator = runtime.services.bridgeCoordinator;
  await coordinator.handleInboundEvent({ ...scope, text: '/enter claude' });
  await coordinator.handleInboundEvent({ ...scope, text: '/enter 1' });
  let started!: () => void; const initialized = new Promise<void>((resolve) => { started = resolve; });
  const turn = coordinator.handleInboundEvent({ ...scope, text: 'work' }, { onTurnStarted: started });
  await initialized;
  const active = await coordinator.reconcileActiveTurn(scope);
  assert.ok(active?.turnId);
  const stop = await coordinator.handleInboundEvent({ ...scope, text: '/stop' });
  assert.match(stop.messages.map((item: any) => item.text).join('\n'), /已请求中断/);
  await turn; assert.equal(stops, 1);
});
